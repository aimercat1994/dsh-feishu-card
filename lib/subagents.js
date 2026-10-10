/**
 * The roster of subagents a conversation has delegated to.
 *
 * A subagent's own session never reaches this plugin: `ConversationSessions`
 * serves only the chats it is bound to, and a child session is not one of them,
 * so the child's `subagent/descriptor` events are dropped before they render.
 * The delegating session's own tool events are not: a `subagent` call names its
 * task in the arguments and its result carries the same `callId`, which is
 * enough to keep a roster without subscribing to anything new.
 *
 * A background or continuable subagent answers its call immediately with
 * "started …" while the child keeps working, so such a row is never settled from
 * the result — it stays running rather than claiming a child that is still
 * thinking has finished. Two facts this same session owns close that loop later:
 * the durable `subagent/catalog` entry names the child by id, and the notice the
 * child's own ending produces arrives here as a user message whose source
 * (`subagent-settled`) carries the same id. The row then reports the ending the
 * platform actually recorded instead of guessing one.
 *
 * @module dsh-feishu-card/subagents
 */

import { kindOf, subagentLabel } from './present.js'

/** Row states a roster entry can be in. */
export const SUBAGENT_STATE = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
}

/** The opening a delegating result uses while its child is still working. */
const STILL_RUNNING = /^started\b/i

/** The child id that opening names, e.g. `started subagent <id>`. */
const STARTED_CHILD = /^started\s+(?:background\s+)?subagent(?:\s+job)?\s+(\S+)/i

/**
 * How a settlement notice ends, and what the row can call that ending.
 *
 * `settlementSummary()` in @deepseek-ai/dsh-subagent/lib/types/continuation-messages.js
 * writes exactly one of these sentences, so the row can name the ending instead
 * of collapsing every non-success into the same word.
 */
const SETTLEMENT_ENDINGS = [
  [/finished and will do no further work/i, undefined],
  [/was stopped before it finished/i, '已中止'],
  [/ran out of room before it finished/i, '超出长度'],
  [/declined the task/i, '拒绝执行'],
  [/failed before it finished/i, '执行失败'],
  [/ended abnormally/i, '异常结束'],
]

/**
 * Read one settlement notice.
 *
 * @param summary - the notice's `source.summary`, or any text from it.
 * @returns the state the row should take and the short reason to show with it.
 */
export function settlementOutcome(summary) {
  const text = String(summary ?? '')
  for (const [pattern, reason] of SETTLEMENT_ENDINGS) {
    if (pattern.test(text)) {
      return reason === undefined
        ? { state: SUBAGENT_STATE.completed, note: undefined }
        : { state: SUBAGENT_STATE.failed, note: reason }
    }
  }
  // An ending this build does not name is still an ending: never claim success.
  return { state: SUBAGENT_STATE.failed, note: '未完成' }
}

/** The child id a still-running delegating result names, if it names one. */
export function childIdIn(text) {
  const match = STARTED_CHILD.exec(String(text ?? '').trim())
  return match ? match[1] : undefined
}

/**
 * Tracks one row per delegating call, per served session.
 *
 * Rows are keyed by the call id the harness assigns, which is what lets a result
 * settle exactly the call it belongs to even when several subagents run at once.
 */
export class SubagentRoster {
  /** sessionId -> Map(callId -> row) */
  #bySession = new Map()
  #anonymous = 0

  /** The row map for one session, created on first use. */
  #rows(sessionId) {
    let rows = this.#bySession.get(sessionId)
    if (rows === undefined) {
      rows = new Map()
      this.#bySession.set(sessionId, rows)
    }
    return rows
  }

  /**
   * Track one call.
   *
   * @param sessionId - the served session that made the call.
   * @param callId - the harness call id its result will echo.
   * @param name - the tool name.
   * @param argsJson - the raw argument string, for the display label.
   * @returns true when the call was a subagent call and the roster changed.
   */
  note(sessionId, callId, name, argsJson) {
    if (!sessionId || kindOf(name) !== 'subagent') return false
    const key = typeof callId === 'string' && callId.length > 0 ? callId : `anon-${(this.#anonymous += 1)}`
    const rows = this.#rows(sessionId)
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        label: subagentLabel(argsJson) ?? '子代理',
        state: SUBAGENT_STATE.running,
        note: undefined,
        childId: undefined,
      })
    }
    return true
  }

  /**
   * Settle one tracked call from its result.
   *
   * @param sessionId - the served session.
   * @param callId - the result's `toolCallId`.
   * @param outcome - `{ text, failed }`: the result's text and whether it errored.
   * @returns true when a row changed.
   */
  settle(sessionId, callId, { text, failed } = {}) {
    const row = this.#bySession.get(sessionId)?.get(typeof callId === 'string' ? callId : '')
    if (!row) return false
    if (failed) {
      row.state = SUBAGENT_STATE.failed
      return true
    }
    if (STILL_RUNNING.test(String(text ?? '').trim())) {
      // The call returned but the child did not. Keep the row running and, when
      // the platform named the child, remember which child this row waits for.
      const childId = childIdIn(text)
      if (childId !== undefined) row.childId = childId
      row.note = '后台运行中'
      return true
    }
    row.state = SUBAGENT_STATE.completed
    row.note = undefined
    return true
  }

  /**
   * Attach the child id a catalog entry names to the row that created it.
   *
   * The catalog entry is the parent's own durable fact about a direct child, so
   * it links a row even if a result's wording ever changes; the entry carries the
   * same label the delegation was described with.
   *
   * @param sessionId - the served session that owns the catalog.
   * @param childId - the child session id the entry names.
   * @param label - the label frozen with the child, when it has one.
   * @returns true when a row now waits for that child.
   */
  linkChild(sessionId, childId, label) {
    if (!sessionId || typeof childId !== 'string' || childId.length === 0) return false
    const waiting = [...(this.#bySession.get(sessionId)?.values() ?? [])].filter(
      (row) => row.state === SUBAGENT_STATE.running && row.childId === undefined,
    )
    if (waiting.length === 0) return false
    const row = waiting.find((candidate) => candidate.label === label) ?? waiting[waiting.length - 1]
    row.childId = childId
    return true
  }

  /**
   * Settle the row waiting for one child from the notice that child's ending produced.
   *
   * @param sessionId - the served session the notice was delivered to.
   * @param childId - the settled child, as the notice's sender.
   * @param summary - the notice's own opening sentence.
   * @returns true when a row changed and the card needs rewriting.
   */
  finishChild(sessionId, childId, summary) {
    if (!sessionId || typeof childId !== 'string' || childId.length === 0) return false
    const row = [...(this.#bySession.get(sessionId)?.values() ?? [])].find(
      (candidate) => candidate.childId === childId,
    )
    if (!row) return false
    const outcome = settlementOutcome(summary)
    if (row.state === outcome.state && row.note === outcome.note) return false
    row.state = outcome.state
    row.note = outcome.note
    return true
  }

  /** The roster for one session, oldest first. */
  list(sessionId) {
    return [...(this.#bySession.get(sessionId)?.values() ?? [])]
  }

  /** Forget one session, e.g. after `/new`. */
  forget(sessionId) {
    this.#bySession.delete(sessionId)
  }

  /** Drop all bookkeeping on unload. Cards already sent stay in the chat. */
  dispose() {
    this.#bySession.clear()
  }
}
