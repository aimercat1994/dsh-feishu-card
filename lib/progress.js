/**
 * Long-lived progress cards: the agent's todo list, its goal, and the subagents
 * it delegated to.
 *
 * These differ from the turn card in one decisive way — they outlive a turn. A
 * goal can stay active across many turns and even across restarts, so a card
 * that only updates while a turn is streaming would go stale exactly when the
 * reader needs it.
 *
 * Each is therefore its own card entity, created on first sight of a session and
 * updated in place afterwards. A cleared goal (a tombstone with no snapshot) is
 * left on screen as the historical record rather than deleted: the reader
 * already saw it, and silently removing a card is worse than showing its end.
 *
 * @module dsh-feishu-card/progress
 */

import { TEMPLATE, assertValidCard, headerTitle, markdownElement } from './card.js'
import { SUBAGENT_STATE } from './subagents.js'

/** Element ids inside a progress card. */
export const PROGRESS_ELEMENTS = {
  body: 'progress_body',
  actions: 'progress_actions',
}

/** A row marker per todo status. */
const TODO_MARK = { pending: '⚪', in_progress: '🔵', completed: '✅' }

/** The phase marker and colour per goal phase. */
const GOAL_PHASE = {
  active: { icon: '🎯', label: '进行中', template: TEMPLATE.running },
  paused: { icon: '⏸️', label: '已暂停', template: TEMPLATE.waiting },
  blocked: { icon: '🚧', label: '受阻', template: TEMPLATE.failed },
  complete: { icon: '✅', label: '已完成', template: TEMPLATE.done },
}

/** Cap on rendered rows, so a huge list cannot blow the card's element limit. */
const MAX_ROWS = 12

/** A row marker and label per subagent state. */
const SUBAGENT_MARK = {
  [SUBAGENT_STATE.running]: { mark: '⏳', label: '进行中' },
  [SUBAGENT_STATE.completed]: { mark: '✅', label: '完成' },
  [SUBAGENT_STATE.failed]: { mark: '❌', label: '失败' },
}

/** Cap on rendered subagent rows (a fan-out of ten children is already a wall). */
const MAX_SUBAGENT_ROWS = 8

/** The body elements of a todo card. */
export function todoElements(todos) {
  const list = Array.isArray(todos) ? todos : []
  const done = list.filter((t) => t?.status === 'completed').length
  const rows = list.slice(0, MAX_ROWS).map((item) => {
    const mark = TODO_MARK[item?.status] ?? '⚪'
    const text = String(item?.content ?? '').replace(/[\r\n]+/g, ' ').slice(0, 160)
    return `${mark} ${text}`
  })
  if (list.length > MAX_ROWS) rows.push(`…还有 ${list.length - MAX_ROWS} 项`)
  return {
    title: `📋 任务进度 ${done}/${list.length}`,
    template: done === list.length && list.length > 0 ? TEMPLATE.done : TEMPLATE.running,
    body: rows.length > 0 ? rows.join('\n') : '（暂无任务）',
  }
}

/** The body elements of a goal card, including its control buttons. */
export function goalElements(goal) {
  const phase = GOAL_PHASE[goal?.phase] ?? GOAL_PHASE.active
  const lines = [`**目标** ${String(goal?.objective ?? '').slice(0, 400)}`, '', `${phase.icon} ${phase.label}`]
  if (goal?.blockedReason?.message) lines.push('', `🚧 ${String(goal.blockedReason.message).slice(0, 200)}`)
  if (Number.isFinite(goal?.maxGoalRounds)) lines.push('', `最大轮次：${goal.maxGoalRounds}`)

  const elements = [markdownElement(PROGRESS_ELEMENTS.body, lines.join('\n'))]
  if (goal?.phase !== 'complete') {
    const value = (operation) => ({ k: 'goal', id: goal?.id, revision: goal?.revision, op: operation })
    const button = (label, type, operation) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      behaviors: [{ type: 'callback', value: value(operation) }],
    })
    const actions = []
    if (goal?.phase === 'paused') actions.push(button('▶️ 继续', 'primary', 'resume'))
    else if (goal?.phase !== 'blocked') actions.push(button('⏸️ 暂停', 'default', 'pause'))
    actions.push(button('⏹ 清除', 'danger', 'clear'))
    // A button row is a body element in card JSON V2 — never an `action` wrapper.
    elements.push(...actions)
  }
  return { title: `🎯 目标 · ${phase.label}`, template: phase.template, elements }
}

/** One full card document for a todo snapshot. */
export function todoCard(todos) {
  const { title, template, body } = todoElements(todos)
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template },
    body: { elements: [markdownElement(PROGRESS_ELEMENTS.body, body)] },
  }
}

/** One full card document for a goal snapshot. */
export function goalCard(goal) {
  const { title, template, elements } = goalElements(goal)
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template },
    body: { elements },
  }
}

/**
 * The body elements of a subagent roster card.
 *
 * A settled child stays on the card: the roster is the record of what this chat
 * delegated, so a finished row answers "did it work" rather than cluttering.
 */
export function subagentElements(records) {
  const list = Array.isArray(records) ? records : []
  const settled = list.filter((record) => record?.state !== SUBAGENT_STATE.running).length
  const failed = list.filter((record) => record?.state === SUBAGENT_STATE.failed).length
  const rows = list.slice(0, MAX_SUBAGENT_ROWS).map((record) => {
    const state = SUBAGENT_MARK[record?.state] ?? SUBAGENT_MARK[SUBAGENT_STATE.running]
    const label = String(record?.label ?? '子代理').replace(/[\r\n]+/g, ' ').slice(0, 120)
    const note = typeof record?.note === 'string' && record.note.length > 0 ? ` · ${record.note}` : ''
    return `${state.mark} **${label}** · ${state.label}${note}`
  })
  if (list.length > MAX_SUBAGENT_ROWS) rows.push(`…还有 ${list.length - MAX_SUBAGENT_ROWS} 个`)
  const template = list.length > 0 && settled === list.length
    ? (failed > 0 ? TEMPLATE.failed : TEMPLATE.done)
    : TEMPLATE.running
  return {
    title: `🤖 子代理 ${settled}/${list.length}`,
    template,
    body: rows.length > 0 ? rows.join('\n') : '（暂无子代理）',
  }
}

/** One full card document for a subagent roster. */
export function subagentCard(records) {
  const { title, template, body } = subagentElements(records)
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template },
    body: { elements: [markdownElement(PROGRESS_ELEMENTS.body, body)] },
  }
}

/**
 * Owns the per-session progress cards.
 *
 * The first snapshot of a kind is created and sent; later ones update that same
 * card, so a chat shows one todo card, one goal card and one subagent roster per
 * conversation rather than a new message per change. Writes to one card are
 * chained, so two snapshots arriving inside one create round trip still produce
 * exactly one card.
 */
export class ProgressCards {
  #transport
  #sessions
  #logger
  /** sessionId -> { todo?: cardId, goal?: cardId, subagent?: cardId } */
  #cards = new Map()
  /** `${sessionId}\0${kind}` -> tail of that card's write chain */
  #chains = new Map()

  constructor({ transport, sessions, logger }) {
    this.#transport = transport
    this.#sessions = sessions
    this.#logger = logger
  }

  /** The card entity this session uses for one kind, if it has one. */
  cardId(sessionId, kind) {
    return this.#cards.get(sessionId)?.[kind]
  }

  async #publish(sessionId, kind, card) {
    // Serialize the writes of ONE card. A create takes a round trip, and the
    // events that feed a card arrive far closer together than that: the subagent
    // roster is created by `tool/call` and rewritten by the `started …` result
    // ~50 ms later (observed on the real API, 2026-10-10), which without this
    // chain found no card id yet and created a SECOND card whose twin then froze
    // on the first snapshot. One card per (session, kind), always.
    const key = `${sessionId}\u0000${kind}`
    const previous = this.#chains.get(key) ?? Promise.resolve()
    const run = previous.then(
      () => this.#write(sessionId, kind, card),
      () => this.#write(sessionId, kind, card),
    )
    this.#chains.set(key, run.then(() => undefined, () => undefined))
    return run
  }

  async #write(sessionId, kind, card) {
    const routing = this.#sessions.routingFor(sessionId)
    if (!routing) return
    const existing = this.cardId(sessionId, kind)
    try {
      if (existing) {
        await this.#transport.updateCard(existing, card)
        return
      }
      const cardId = await this.#transport.createCard(assertValidCard(card, `${kind} card`))
      await this.#transport.sendCard(cardId, {
        chatId: routing.chatId,
        replyToMessageId: routing.replyToMessageId,
      })
      this.#cards.set(sessionId, { ...(this.#cards.get(sessionId) ?? {}), [kind]: cardId })
    } catch (error) {
      // A stale entity (the platform expires them) must not wedge the session:
      // forget it so the next snapshot starts a fresh card.
      this.#logger?.warn?.(`[feishu-card] publishing the ${kind} card failed`, error)
      const current = this.#cards.get(sessionId)
      if (current) delete current[kind]
    }
  }

  /** Publish a todo snapshot. */
  async showTodos(sessionId, todos) {
    await this.#publish(sessionId, 'todo', todoCard(todos))
  }

  /** Publish a goal snapshot. A clear tombstone leaves the last card standing. */
  async showGoal(sessionId, change) {
    if (!change?.goal) return
    await this.#publish(sessionId, 'goal', goalCard(change.goal))
  }

  /** Publish a subagent roster. */
  async showSubagents(sessionId, records) {
    await this.#publish(sessionId, 'subagent', subagentCard(records))
  }

  /** Forget a session's card ids, e.g. after `/new`. */
  forget(sessionId) {
    this.#cards.delete(sessionId)
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.#chains.keys()]) if (key.startsWith(prefix)) this.#chains.delete(key)
  }

  /** Drop all bookkeeping on unload. Cards already sent stay in the chat. */
  dispose() {
    this.#cards.clear()
    this.#chains.clear()
  }
}
