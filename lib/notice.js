/**
 * Turn notices: what the agent is doing when it is not producing text.
 *
 * A chat surface has one problem the Web UI does not: the process panel only
 * shows what the turn itself produces, so a long model retry, a context that is
 * about to overflow, or a background job finishing elsewhere is invisible. This
 * module turns those DSH-native signals into one-line notices.
 *
 * Every signal here is a **pure observer**: the retry and compaction handlers sit
 * in waterfalls they do not own, so they must delegate with `next()` and must
 * never throw into the host's error path.
 *
 * @module dsh-feishu-card/notice
 */

/** Format one failed model attempt. */
export function retryLine(failure, attempt) {
  const detail = failure?.message ? ` · ${String(failure.message).slice(0, 120)}` : ''
  const nth = attempt && attempt > 1 ? `（第 ${attempt} 次）` : ''
  const code = failure?.status ? ` [${failure.status}]` : failure?.code ? ` [${failure.code}]` : ''
  return `⚠️ 模型请求失败，正在重试${nth}${code}${detail}`
}

/**
 * Format a context-usage notice.
 *
 * @returns undefined while usage is below the threshold, so the caller can post
 *   only on the crossing.
 */
export function pressureLine({ inputTokens, contextWindow, threshold }) {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return undefined
  if (Number.isFinite(threshold) && threshold > 0 && inputTokens < threshold) return undefined
  const used = `${Math.round(inputTokens / 1000)}k`
  const window = Number.isFinite(contextWindow) && contextWindow > 0
    ? ` / ${Math.round(contextWindow / 1000)}k`
    : ''
  return `📦 上下文已用 ${used}${window}`
}

/** Format a failed compaction. */
export function compactionFailedLine(error) {
  const detail = error?.message ? ` · ${String(error.message).slice(0, 120)}` : ''
  return `⚠️ 上下文压缩失败${detail}`
}

/** How much of a job label a one-line notice will show. */
const NOTICE_LABEL_LIMIT = 60

/**
 * The job's own name, bounded to one line.
 *
 * A background job's label is the command that started it, which is routinely a
 * whole shell script spanning dozens of lines. A notice is one line in a process
 * panel, so the label is flattened and cut here rather than being allowed to
 * dominate the card; the full text stays available from the job itself.
 */
function jobLabel(job) {
  const raw = String(job?.label ?? job?.kind ?? '后台任务')
  const flat = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  const bounded = flat.length > NOTICE_LABEL_LIMIT ? `${flat.slice(0, NOTICE_LABEL_LIMIT - 1)}…` : flat
  return bounded === '' ? '后台任务' : bounded
}

/** Format a settled background job. */
export function jobLine(job) {
  const label = jobLabel(job)
  // The id tells two jobs with the same command apart; skip it when the label
  // already opens with it, so a job can never read "bash-7 · bash-7 ...".
  const id = typeof job?.id === 'string' && job.id.length > 0 && !label.startsWith(job.id) ? `${job.id} · ` : ''
  switch (job?.status) {
    case 'completed':
      return `✅ 后台任务完成：${id}${label}`
    case 'failed':
      return `❌ 后台任务失败：${id}${label}`
    case 'killed':
      return `⛔ 后台任务已终止：${id}${label}`
    default:
      return `ℹ️ 后台任务结束：${id}${label}`
  }
}

/**
 * Turns notices into chat output.
 *
 * A notice belongs to a session, and lands in that session's live card when one
 * is open; otherwise it is sent as its own small card so it is not lost.
 */
export class Notices {
  #renderer
  #transport
  #sessions
  #logger
  #threshold
  /** sessionId -> whether a pressure notice was already posted for this climb. */
  #pressured = new Map()
  /** sessionId -> attempt counter for the current retry burst. */
  #retries = new Map()

  constructor({ renderer, transport, sessions, logger, pressureThreshold }) {
    this.#renderer = renderer
    this.#transport = transport
    this.#sessions = sessions
    this.#logger = logger
    this.#threshold = pressureThreshold
  }

  /**
   * Deliver one line for a session.
   *
   * Inside a live turn it joins the process panel, which is where a reader looks
   * for progress. Outside one it becomes a small card, because a line with no
   * card to hold it would otherwise vanish.
   */
  async post(sessionId, line, { title = 'DSH', template } = {}) {
    if (!sessionId || !line) return
    // Only a card that actually HAS a process panel can take an activity line;
    // with `showProcess: false` there is no such element, so the notice must go
    // out as its own card instead of being written into nothing.
    if (this.#renderer.acceptsActivity(sessionId)) {
      this.#renderer.addActivity(sessionId, line)
      return
    }
    const routing = this.#sessions.routingFor(sessionId)
    if (!routing) return
    try {
      const { buildNoticeCard } = await import('./card.js')
      await this.#transport.sendCardOnce(buildNoticeCard({ title, template, body: line }), {
        chatId: routing.chatId,
        replyToMessageId: routing.replyToMessageId,
      })
    } catch (error) {
      this.#logger?.warn?.('[feishu-card] sending a notice failed', error)
    }
  }

  /** One failed model attempt; counted so a retry storm reads as a sequence. */
  async modelRetry(sessionId, failure) {
    const attempt = (this.#retries.get(sessionId) ?? 0) + 1
    this.#retries.set(sessionId, attempt)
    await this.post(sessionId, retryLine(failure, attempt))
  }

  /** Clear the retry counter once a turn moves past its request errors. */
  clearRetries(sessionId) {
    this.#retries.delete(sessionId)
  }

  /**
   * Report context usage, but only on the crossing of the threshold.
   *
   * Re-armed once usage falls back below it, so a compacted session can warn
   * again on its next climb instead of staying silent forever.
   */
  async contextUsage(sessionId, { inputTokens, contextWindow } = {}) {
    const line = pressureLine({ inputTokens, contextWindow, threshold: this.#threshold })
    if (!line) {
      if (Number.isFinite(inputTokens) && inputTokens > 0) this.#pressured.delete(sessionId)
      return
    }
    if (this.#pressured.get(sessionId) === true) return
    this.#pressured.set(sessionId, true)
    await this.post(sessionId, line)
  }

  /** A compaction that failed — the turn will likely fail with it. */
  async compactionFailed(sessionId, error) {
    await this.post(sessionId, compactionFailedLine(error))
  }

  /** A background job that settled, announced where its owner is being read. */
  async jobSettled(job) {
    const owner = job?.owner
    if (!owner) return
    await this.post(owner, jobLine(job))
  }

  /** Forget per-session state when a session leaves. */
  forget(sessionId) {
    this.#pressured.delete(sessionId)
    this.#retries.delete(sessionId)
  }

  /** Drop all per-session state on plugin unload. */
  dispose() {
    this.#pressured.clear()
    this.#retries.clear()
  }
}
