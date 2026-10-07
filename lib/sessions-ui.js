/**
 * `/sessions` and `/switch` — picking which session a Feishu conversation talks to.
 *
 * A conversation normally owns one session (and `/new` rotates it). These commands
 * make that binding visible and reversible: the picker lists the sessions worth
 * offering and a click moves the conversation onto one of them, so `/new` stops
 * being a one-way door and a session started elsewhere can be continued here.
 *
 * Everything here is a pure function of the host's `sessionController.list()` rows,
 * so the filtering rules — which sessions are worth showing, how they are labelled,
 * what a typed id means — are testable without a harness.
 *
 * @module dsh-feishu-card/sessions-ui
 */

import { ELEMENTS, TEMPLATE, headerTitle, markdownElement, selectElement } from './card.js'

/** How many sessions a picker offers. Beyond this the card is a wall of buttons. */
export const SESSION_LIMIT = 6

const TEXT = {
  zh: {
    title: 'DSH · 会话',
    heading: '**当前会话**',
    none: '（本会话还没有绑定）',
    pickPlaceholder: '切换会话',
    empty: '没有可切换的会话。',
    more: (shown, total) => `仅列出最近 ${shown} 个，共 ${total} 个。`,
    hint: '`/switch <id>` 可直接切换到任意会话；`/new` 开新会话。',
    justNow: '刚刚',
    running: '运行中',
    current: '当前',
    switched: (label) => `✅ 已切换到 ${label}`,
    already: (label) => `已经在该会话：${label}`,
    unknown: (query) => `找不到会话 \`${query}\`。`,
    ambiguous: (query, options) => `\`${query}\` 匹配到多个会话：\n${options}`,
    noList: '当前部署未提供会话列表接口。',
    settled: (label) => `已切换到 **${label}**。下一条消息将发往该会话。`,
    usage: '用法：`/sessions` 选择，或 `/switch <会话 id 或前缀>`。',
    toastSwitched: '已切换',
    toastFailed: '切换失败，详见日志',
    gone: '该操作已失效',
  },
  en: {
    title: 'DSH · Sessions',
    heading: '**Current session**',
    none: '(this conversation is not bound yet)',
    pickPlaceholder: 'Switch session',
    empty: 'No sessions to switch to.',
    more: (shown, total) => `Showing the most recent ${shown} of ${total}.`,
    hint: '`/switch <id>` reaches any session; `/new` starts a fresh one.',
    justNow: 'just now',
    running: 'running',
    current: 'current',
    switched: (label) => `✅ Switched to ${label}`,
    already: (label) => `Already on ${label}`,
    unknown: (query) => `No session matches \`${query}\`.`,
    ambiguous: (query, options) => `\`${query}\` matches several sessions:\n${options}`,
    noList: 'This deployment exposes no session list.',
    settled: (label) => `Switched to **${label}**. The next message goes there.`,
    usage: 'Usage: `/sessions` to choose, or `/switch <session id or prefix>`.',
    toastSwitched: 'Switched',
    toastFailed: 'Switch failed; see the log',
    gone: 'That action is no longer valid',
  },
}

/** Text table for one locale. */
export function sessionStrings(locale) {
  return TEXT[locale] ?? TEXT.zh
}

/** The tail of a session id: enough to tell two apart, short enough to read. */
export function shortSessionId(sessionId) {
  return String(sessionId ?? '').slice(-6)
}

/**
 * What to call a session in the UI.
 *
 * Prefers the title the harness folded from `session/title`, which is what a person
 * recognises; falls back to the id tail so a session is never nameless.
 */
export function sessionLabel(summary) {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title.trim() ? title.trim() : shortSessionId(summary?.sessionId)
}

/** Coarse age. This is a picker, not a log: minutes are enough resolution. */
export function relativeTime(updatedAt, now, locale) {
  const t = sessionStrings(locale)
  const stamp = Number(updatedAt)
  if (!Number.isFinite(stamp) || stamp <= 0) return ''
  const seconds = Math.max(0, Math.floor((now - stamp) / 1000))
  if (seconds < 60) return t.justNow
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return locale === 'en' ? `${minutes}m ago` : `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return locale === 'en' ? `${hours}h ago` : `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return locale === 'en' ? `${days}d ago` : `${days} 天前`
}

/**
 * The sessions worth offering, newest first.
 *
 * Subagent sessions are machinery and a blank one was never used, so neither is
 * something a person means to switch to. The CURRENT session is always kept even
 * when it would be filtered out, because a picker that omits where you are is
 * confusing.
 *
 * @returns `{ items, total }` — `items` is capped, `total` is not.
 */
export function selectableSessions({ summaries = [], currentId, limit = SESSION_LIMIT } = {}) {
  const items = (Array.isArray(summaries) ? summaries : [])
    .filter((row) => row && typeof row.sessionId === 'string')
    .filter((row) => row.sessionId === currentId
      || (row.origin !== 'subagent' && !row.parentSessionId && !row.blank))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
  return { items: items.slice(0, Math.max(1, limit)), total: items.length }
}

/**
 * Resolve what someone typed into one session.
 *
 * A full id, or a prefix long enough to be unique. Prefixes are accepted because
 * ids are long and the UI shows only their tail; an ambiguous prefix is refused
 * rather than guessed, since binding a conversation to the wrong session is not
 * something the user can see happened.
 */
export function resolveSessionQuery(query, summaries, locale) {
  const t = sessionStrings(locale)
  const raw = String(query ?? '').trim()
  if (raw.length === 0) return { list: true }
  const rows = (Array.isArray(summaries) ? summaries : []).filter((row) => row && typeof row.sessionId === 'string')
  const exact = rows.find((row) => row.sessionId === raw)
  if (exact) return { item: exact }
  const hits = rows.filter((row) => row.sessionId.endsWith(raw) || row.sessionId.includes(raw))
  if (hits.length === 1) return { item: hits[0] }
  if (hits.length === 0) return { error: t.unknown(raw) }
  return { error: t.ambiguous(raw, hits.slice(0, 5).map((row) => `- \`${row.sessionId}\``).join('\n')) }
}

/**
 * The picker card.
 *
 * One dropdown rather than a row per session: a chat usually has several sessions
 * and a list of buttons grows without bound, while a select keeps the card a fixed
 * height. Feishu renders it as a bottom-sheet list.
 *
 * The behavior carries the conversation's CURRENT session — that is what identifies
 * the conversation, since re-deriving its key from the chat would need the
 * configured scope and a click carries no thread. The chosen target travels in the
 * option value as JSON.
 *
 * @param items     rows from {@link selectableSessions}.
 * @param total     how many there were before the cap.
 * @param currentId the session this conversation is on now.
 * @param sessionId the conversation's current session (the behavior's `s`).
 * @param settled   render the outcome only: no picker.
 */
export function buildSessionsCard({ items = [], total = 0, currentId, sessionId, locale, settled = false }) {
  const t = sessionStrings(locale)
  const current = items.find((row) => row.sessionId === currentId)
  const currentLine = current ? sessionLabel(current) : t.none
  const elements = [markdownElement(ELEMENTS.prompt, `${t.heading}\n${currentLine}`)]

  if (settled) {
    elements.push(markdownElement('ssettled', t.settled(currentLine)))
    return shell(t.title, elements)
  }
  if (items.length === 0) {
    elements.push(markdownElement('sempty', t.empty))
    return shell(t.title, elements)
  }

  const now = Date.now()
  elements.push(selectElement('sselect', {
    placeholder: t.pickPlaceholder,
    options: items.map((row) => ({
      // Title first (that is what a person recognises), then the id tail to tell
      // equal titles apart, then the age.
      label: [sessionLabel(row), shortSessionId(row.sessionId), relativeTime(row.updatedAt, now, locale)]
        .filter(Boolean).join(' · '),
      value: JSON.stringify({ t: row.sessionId }),
    })),
    behavior: { k: 'session', s: sessionId },
    initialOption: JSON.stringify({ t: currentId }),
  }))

  if (total > items.length) elements.push(markdownElement('smore', t.more(items.length, total)))
  elements.push(markdownElement('shint', t.hint))
  return shell(t.title, elements)
}

function shell(title, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template: TEMPLATE.neutral },
    body: { elements },
  }
}
