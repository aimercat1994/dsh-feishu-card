/**
 * Fan-out visibility: what a workflow or a subagent is doing right now.
 *
 * A workflow turn spends most of its wall time inside child agents, so the parent
 * card would otherwise sit unchanged for minutes while real work happens. These
 * lines narrate that: run open, each member opening and settling, run close.
 *
 * The sources are **session events** (`tool-workflow/*`, declared by
 * `dsh-tool-workflow` through module augmentation), not the process-local
 * `workflow/*` Cordis events. Session events are durable and already attributed
 * to the session that started the run, whereas the Cordis events carry only a run
 * id and no session at all — a surface receiving one could not tell which chat it
 * belongs to.
 *
 * @module dsh-feishu-card/fanout
 */

/** Marker per member outcome. */
const OUTCOME_MARK = { completed: '✅', failed: '❌', cancelled: '⛔' }

/** Marker per run stop reason. */
const STOP_MARK = { completed: '🏁', cancelled: '⛔', error: '❌' }

/** Open a run. */
export function runStartLine({ name }) {
  return `🚀 工作流开始：${String(name ?? '').slice(0, 80)}`
}

/** One member opened. */
export function agentStartLine({ seq, label, phase }) {
  const n = Number.isFinite(seq) ? `#${seq} ` : ''
  const where = phase ? `（${String(phase).slice(0, 40)}）` : ''
  return `🧑‍💻 ${n}${String(label ?? '子任务').slice(0, 80)}${where}`
}

/** One member settled. */
export function agentEndLine({ seq, outcome }, label) {
  const mark = OUTCOME_MARK[outcome] ?? '•'
  const n = Number.isFinite(seq) ? `#${seq} ` : ''
  const what = label ? ` ${String(label).slice(0, 60)}` : ''
  return `${mark} ${n}${String(outcome ?? '结束')}${what}`
}

/** Close a run, with a tally when members were seen. */
export function runEndLine({ stopReason }, stats) {
  const mark = STOP_MARK[stopReason] ?? '🏁'
  const tally = stats && stats.total > 0 ? `（${stats.done}/${stats.total} 完成）` : ''
  const reason = stopReason && stopReason !== 'completed' ? ` · ${stopReason}` : ''
  return `${mark} 工作流结束${tally}${reason}`
}

/**
 * A subagent descriptor line.
 *
 * The descriptor payload is parent-owned and versioned, so only well-known fields
 * are read and unknown shapes degrade to a generic line rather than throwing.
 */
export function subagentLine(data) {
  const label = data?.label ?? data?.name ?? data?.provider ?? '子代理'
  const status = data?.status ?? data?.state
  const mark = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '🧑‍💻'
  return `${mark} 子代理 ${String(label).slice(0, 80)}${status ? ` · ${status}` : ''}`
}

/**
 * Tracks one workflow run per session so the closing line can report a tally and
 * a member's settlement can name the member it refers to.
 */
export class Fanout {
  #logger
  /** sessionId -> { runId, total, done, labels: Map<seq, label> } */
  #runs = new Map()

  constructor({ logger }) {
    this.#logger = logger
  }

  /** Lines for one session event; empty when the event is not narrated. */
  lines(sessionId, type, data) {
    try {
      switch (type) {
        case 'tool-workflow/run-start': {
          this.#runs.set(sessionId, { runId: data?.runId, total: 0, done: 0, labels: new Map() })
          return [runStartLine(data ?? {})]
        }
        case 'tool-workflow/agent-start': {
          const run = this.#runs.get(sessionId)
          if (run) {
            run.total += 1
            if (Number.isFinite(data?.seq)) run.labels.set(data.seq, data?.label)
          }
          return [agentStartLine(data ?? {})]
        }
        case 'tool-workflow/agent-end': {
          const run = this.#runs.get(sessionId)
          const label = run?.labels?.get(data?.seq)
          if (run) run.done += 1
          return [agentEndLine(data ?? {}, label)]
        }
        case 'tool-workflow/run-end': {
          const run = this.#runs.get(sessionId)
          this.#runs.delete(sessionId)
          return [runEndLine(data ?? {}, run)]
        }
        case 'subagent/descriptor':
          return [subagentLine(data)]
        default:
          return []
      }
    } catch (error) {
      // Narration must never break a turn.
      this.#logger?.warn?.('[feishu-card] formatting a fan-out line failed', error)
      return []
    }
  }

  /** Drop a session's run state. */
  forget(sessionId) {
    this.#runs.delete(sessionId)
  }

  /** Drop all run state on unload. */
  dispose() {
    this.#runs.clear()
  }
}
