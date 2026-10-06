/**
 * Long-lived progress cards: the agent's todo list and its goal.
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
 * Owns the per-session progress cards.
 *
 * The first snapshot of a kind is created and sent; later ones update that same
 * card, so a chat shows one todo card and one goal card per conversation rather
 * than a new message per change.
 */
export class ProgressCards {
  #transport
  #sessions
  #logger
  /** sessionId -> { todo?: cardId, goal?: cardId } */
  #cards = new Map()

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

  /** Forget a session's card ids, e.g. after `/new`. */
  forget(sessionId) {
    this.#cards.delete(sessionId)
  }

  /** Drop all bookkeeping on unload. Cards already sent stay in the chat. */
  dispose() {
    this.#cards.clear()
  }
}
