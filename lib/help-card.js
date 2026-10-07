/**
 * `/help` — the command card.
 *
 * A text list tells you what exists; a card lets you run it. Feishu has no
 * autocomplete in the composer, so the only way to make a command discoverable is to
 * put it under a finger — and the only way to make it usable is for the tap to
 * actually run it.
 *
 * Every button goes through the SAME dispatcher an inbound message uses (see
 * `runCommand` in index.js), so a command cannot work when typed and fail when
 * tapped.
 *
 * Some commands are deliberately NOT buttons. A mis-tap on `/shutdown` stops the
 * harness, on `/new` silently moves the conversation to a fresh session, and on
 * `/stop` cancels a running turn — none of which the user can undo by looking at the
 * result. They are listed, with the reason stated in the card rather than left as a
 * silent gap.
 *
 * @module dsh-feishu-card/help-card
 */

import { ELEMENTS, TEMPLATE, callbackButton, choiceRows, headerTitle, markdownElement } from './card.js'

/**
 * Commands a single tap must not run.
 *
 * Matched by name, not by description: the registry's text is prose for a human and
 * cannot be relied on to mark danger.
 */
export const DESTRUCTIVE_COMMANDS = new Set(['new', 'stop', 'restart', 'shutdown', 'clear', 'reset', 'delete'])

const TEXT = {
  zh: {
    title: 'DSH · 帮助',
    ownHeading: '**本渠道命令**',
    hostHeading: '**Harness 命令**',
    none: '（没有可用的命令）',
    runHint: '点一下即执行。',
    heldBack: (names) => `⚠️ 以下需要手动输入（避免误触）：${names}`,
  },
  en: {
    title: 'DSH · Help',
    ownHeading: '**Channel commands**',
    hostHeading: '**Harness commands**',
    none: '(no commands available)',
    runHint: 'Tap to run.',
    heldBack: (names) => `⚠️ Type these by hand (a mis-tap would be hard to undo): ${names}`,
  },
}

/** Text table for one locale. */
export function helpStrings(locale) {
  return TEXT[locale] ?? TEXT.zh
}

/** Whether a command is one a single tap must not run. */
export function isDestructive(name) {
  return DESTRUCTIVE_COMMANDS.has(String(name ?? '').toLowerCase())
}

/** One line per command, so the card documents as well as offers. */
function describe(commands) {
  return commands.map((entry) => `\`/${entry.name}\` — ${entry.description ?? '（无说明）'}`).join('\n')
}

/**
 * The help card.
 *
 * @param own      this channel's commands (`{name, description}`).
 * @param host     the host registry's commands.
 * @param sessionId the conversation's session — what a button's click applies to.
 * @param locale   which text table to use.
 */
export function buildHelpCard({ own = [], host = [], sessionId, locale }) {
  const t = helpStrings(locale)
  const elements = []
  const held = []

  const section = (heading, commands) => {
    const runnable = commands.filter((entry) => !isDestructive(entry.name))
    for (const entry of commands) if (isDestructive(entry.name)) held.push(`\`/${entry.name}\``)
    if (commands.length === 0) return
    elements.push(markdownElement(heading === t.ownHeading ? 'hown' : 'hhost', `${heading}\n${describe(commands)}`))
    if (runnable.length === 0) return
    elements.push(markdownElement(heading === t.ownHeading ? 'hownhint' : 'hhosthint', t.runHint))
    elements.push(...choiceRows(runnable.map((entry) => callbackButton(`/${entry.name}`, 'default', {
      k: 'run',
      s: sessionId,
      c: entry.name,
    }))))
  }

  section(t.ownHeading, own)
  section(t.hostHeading, host)
  if (elements.length === 0) elements.push(markdownElement('hnone', t.none))
  // Stated rather than left as a silent omission: a user who cannot find `/new`
  // among the buttons needs to know why.
  if (held.length > 0) elements.push(markdownElement('hheld', t.heldBack(held.join(' '))))

  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: t.title } },
    header: { title: headerTitle(t.title), template: TEMPLATE.neutral },
    body: { elements },
  }
}
