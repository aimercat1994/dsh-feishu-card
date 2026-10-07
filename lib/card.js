/**
 * Feishu card JSON 2.0 builders for the streaming session card.
 *
 * The card is a flat element list on purpose: every element carries a stable
 * `element_id` so CardKit can push incremental content into exactly one of
 * them (`cardkit.v1.cardElement.content`). Element ids are part of the wire
 * contract with the client — do not rename them without a migration.
 *
 * @module dsh-feishu-card/card
 */

/** Stable element ids addressed by incremental CardKit updates. */
export const ELEMENTS = {
  reasoning: 'reasoning',
  activity: 'activity',
  answer: 'answer',
  footer: 'footer',
  actions: 'actions',
  prompt: 'prompt',
  customForm: 'custom_form',
  customInput: 'custom_input',
  hint: 'hint',
  footerSep: 'footer_sep',
  interactionSep: 'interaction_sep',
  process: 'process_panel',
  notice: 'notice',
}

/**
 * Fail fast on an illegal card instead of letting the platform refuse it.
 *
 * The platform's rejection is the worst possible outcome: `card.create` fails, the
 * card never appears, and the user sees *nothing*. Catching it locally converts
 * that silence into an error the caller's fallback can turn into visible text.
 */
export function assertValidCard(card, what = 'card') {
  const bad = invalidElementIds(card)
  if (bad.length > 0) {
    throw new Error(
      `[feishu-card] ${what}: illegal element_id ${bad.map((id) => JSON.stringify(id)).join(', ')} `
        + '(must match [A-Za-z][A-Za-z0-9_]{0,19})',
    )
  }
  return card
}

/**
 * Feishu rejects a card whose `element_id` breaks its rule: it must start with a
 * letter, contain only `[A-Za-z0-9_]`, and be at most 20 characters.
 *
 * This is a hard platform constraint, not a style preference. A hyphenated id
 * makes `cardkit.card.create` fail with `code 300301`, which reaches the user as
 * *no card at all* — so the rule is asserted here rather than trusted.
 */
const ELEMENT_ID_RULE = /^[A-Za-z][A-Za-z0-9_]{0,19}$/

/** @returns every offending `element_id` in a card document; empty when all are legal. */
export function duplicateElementIds(card) {
  const seen = new Set()
  const duplicates = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node === null || typeof node !== 'object') return
    if (typeof node.element_id === 'string') {
      if (seen.has(node.element_id)) duplicates.add(node.element_id)
      seen.add(node.element_id)
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return [...duplicates]
}

export function invalidElementIds(card) {
  const bad = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    if (typeof node.element_id === 'string' && !ELEMENT_ID_RULE.test(node.element_id)) {
      bad.push(node.element_id)
    }
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return bad
}

/**
 * Correlation prefix on a form-submit button's `name`.
 *
 * A form submit reports the button's `name` and the form's `form_value`, not a
 * callback `value`, so the pending interaction id has to travel in the name.
 */
export const CUSTOM_SUBMIT_PREFIX = 'custom_submit_'

/** Header colour per lifecycle state, mirroring the running/waiting/done/failed vocabulary. */
export const TEMPLATE = {
  running: 'blue',
  waiting: 'orange',
  done: 'green',
  failed: 'red',
  neutral: 'grey',
}

/** How CardKit paces a streaming update; the client interpolates the rest. */
const STREAMING_CONFIG = {
  print_frequency_ms: { default: 70 },
  print_step: { default: 1 },
  print_strategy: 'fast',
}

/** One plain-text header title. */
export function headerTitle(text) {
  return { tag: 'plain_text', content: text }
}

/** A markdown element; `text_size` accepts normal/notation, `notation` being the small grey style. */
export function markdownElement(elementId, content = '', textSize = 'normal') {
  return { tag: 'markdown', element_id: elementId, content, text_size: textSize }
}

/** A full-width divider; carries an id so it can be replaced, not streamed. */
export function divider(elementId) {
  return { tag: 'hr', element_id: elementId }
}

/**
 * How each reading preset arranges one turn.
 *
 * The process panel always sits BELOW the answer: the answer is what the reader
 * came for, and a panel that pushes it down makes every reply start with a
 * scroll. What the presets vary is how much of the process is on screen:
 *
 *   * `expandedRunning` — whether the panel is open while the turn runs. A
 *     collapsed panel hides exactly the live tool activity, so the default
 *     opens it and folds it again once the answer exists.
 *   * `expandedDone` — whether it stays open after the turn settles.
 *   * `reasoning` — whether the model's thinking is shown at all.
 */
export const PRESETS = {
  classic: { processFirst: false, expandedRunning: true, expandedDone: false, reasoning: true },
  focused: { processFirst: false, expandedRunning: false, expandedDone: false, reasoning: true },
  detailed: { processFirst: false, expandedRunning: true, expandedDone: true, reasoning: true },
  task: { processFirst: false, expandedRunning: false, expandedDone: false, reasoning: false },
}

/** The panel's collapsed/expanded title, following HFC's "point to open" hint. */
function panelTitle({ expanded, toolCount, reasoning }) {
  const parts = []
  if (reasoning) parts.push('思考')
  if (toolCount > 0) parts.push(`${toolCount} 个工具`)
  const what = parts.length > 0 ? parts.join(' + ') : '过程'
  return expanded ? `▾ ${what}` : `▸ ${what}（点开查看）`
}

/**
 * The collapsible process panel: thinking and the tool timeline, folded away so
 * the card reads as its answer first.
 *
 * The element shape is copied from a live-verified card rather than composed
 * from the documentation — notably it carries no header `icon`, because an
 * unverified token would reject the whole card (see `invalidElementIds` for the
 * same class of failure).
 */
function processPanel({ title, expanded, reasoning, activity, showReasoning, sizes }) {
  const inner = []
  if (showReasoning) inner.push(markdownElement(ELEMENTS.reasoning, reasoning, sizes.reasoning))
  inner.push(markdownElement(ELEMENTS.activity, activity, sizes.activity))
  return {
    tag: 'collapsible_panel',
    element_id: ELEMENTS.process,
    expanded: expanded === true,
    header: { title: { tag: 'plain_text', content: title }, vertical_align: 'center' },
    border: { color: 'grey', corner_radius: '8px' },
    padding: '8px 8px 8px 8px',
    elements: inner,
  }
}

/**
 * The one card a turn owns.
 *
 * Elements are always present so a later streaming update never has to insert a
 * node — insertion changes the client's layout mid-stream. Empty elements render
 * as nothing.
 *
 * @param opts - header state, the preset arrangement, and the accumulated parts.
 */
export function buildTurnCard(opts) {
  const {
    title = 'DSH',
    subtitle = '',
    template = TEMPLATE.running,
    summary = '',
    preset = 'classic',
    reasoning = '',
    activity = '',
    answer = '',
    footer = '',
    showProcess = true,
    expanded,
    toolCount = 0,
    streamingMode = true,
    interaction,
    widthMode = 'default',
    textSizes,
  } = opts

  const layout = PRESETS[preset] ?? PRESETS.classic
  const sizes = { reasoning: 'notation', activity: 'notation', answer: 'normal', footer: 'notation', ...(textSizes ?? {}) }
  const open = expanded ?? layout.expandedRunning
  const panel = showProcess
    ? processPanel({
        title: panelTitle({ expanded: open, toolCount, reasoning: layout.reasoning }),
        expanded: open,
        reasoning,
        activity,
        showReasoning: layout.reasoning,
        sizes,
      })
    : undefined

  const elements = [markdownElement(ELEMENTS.answer, answer, sizes.answer)]
  if (showProcess) elements.push(panel)
  // A pending decision rides inside the turn card so the conversation stays in
  // one place; it sits above the footer where the reader already is.
  if (interaction) {
    elements.push(divider(ELEMENTS.interactionSep))
    elements.push(...(interaction.settled ? settledDecisionElements(interaction) : decisionElements(interaction)))
  }
  elements.push(divider(ELEMENTS.footerSep))
  elements.push(markdownElement(ELEMENTS.footer, footer, sizes.footer))

  const header = { title: headerTitle(title), template }
  // A live one-line action under the title is what makes a long turn feel alive.
  if (subtitle) header.subtitle = { tag: 'plain_text', content: subtitle }

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      streaming_mode: streamingMode,
      streaming_config: STREAMING_CONFIG,
      summary: { content: summary || title },
      ...(widthMode && widthMode !== 'default' ? { width_mode: widthMode } : {}),
    },
    header,
    body: { elements },
  }
}

/** One callback button; the value round-trips through `card.action.trigger`. */
export function callbackButton(label, type, value) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  }
}

/**
 * A decision card. `id` is a plugin-local correlation token: the click returns
 * it verbatim, so the card carries no session or approval identity itself.
 *
 * Two shapes share this builder:
 *   * a boolean decision (`approveLabel` / `denyLabel`), used for approvals;
 *   * a choice list (`options`), used for user questions, where every option is
 *     its own button so a user can pick the second answer without typing.
 *
 * @param opts - prompt text, the correlation id, and the affordances to show.
 */
export function buildDecisionCard(opts) {
  const { title = '需要确认', template = TEMPLATE.waiting, body = '' } = opts
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template },
    body: { elements: decisionElements(opts) },
  }
}

/**
 * The elements that express one decision: the prompt, the affordances, and
 * either a free-text form (opt-in) or a hint to answer in the chat.
 *
 * Shared with the in-turn card so an approval can appear inside the same card
 * that is streaming the turn, instead of arriving as a second message.
 */
export function decisionElements(opts) {
  const {
    body = '',
    id,
    approveLabel = '允许一次',
    denyLabel = '拒绝',
    options,
    allowCustom = false,
    customPlaceholder = '其他…',
    cardInput = false,
  } = opts

  const choices = Array.isArray(options) ? options.filter((o) => o?.label) : []
  const elements = [markdownElement(ELEMENTS.prompt, body)]

  // Card JSON V2 dropped the `action` container that V1 used to group buttons:
  // a button is a body element in its own right, and an `action` wrapper makes
  // the whole card uncreatable (`code 200861`, "unsupported tag action").
  if (choices.length > 0) {
    const buttons = choices.map((option, index) =>
      callbackButton(option.label, index === 0 ? 'primary' : 'default', {
        k: 'option',
        id,
        v: option.value ?? option.label,
      }),
    )
    elements.push(...choiceRows(buttons))
    // A choice list carries a skip affordance; a boolean decision does not,
    // because its deny button already is the negative answer.
    elements.push(callbackButton('跳过', 'default', { k: 'deny', id }))
  } else {
    elements.push(callbackButton(approveLabel, 'primary', { k: 'approve', id }))
    elements.push(callbackButton(denyLabel, 'danger', { k: 'deny', id }))
  }

  if (allowCustom) {
    elements.push(
      cardInput
        ? customForm(id, customPlaceholder)
        : markdownElement(ELEMENTS.hint, '或直接在会话里回复文字作答（可多选时用逗号分隔）', 'notation'),
    )
  }
  return elements
}

/** The one-line receipt left in place of a claimed decision. */
export function settledDecisionElements(outcome) {
  const { label, operator } = outcome
  const who = operator ? ` · ${operator}` : ''
  return [{ tag: 'markdown', element_id: ELEMENTS.actions, content: `**${label}**${who}`, text_size: 'notation' }]
}

/**
 * Lay buttons out in rows of four.
 *
 * A long option list as one inline run reads as a wall of bars; `column_set` with
 * `flex_mode: "flow"` keeps four small buttons on a line and wraps the rest.
 */
/**
 * A dropdown, which Feishu renders as a bottom-sheet list ("drawer").
 *
 * A wall of buttons does not scale: six sessions is already a tall card, and a
 * deployment with thirty models is unusable. A select keeps the card to a fixed
 * height whatever the list holds.
 *
 * The chosen value arrives in the callback as `action.option` (NOT `action.value`,
 * which carries the behavior's own payload), so the intent travels as a JSON string
 * in the option value — the behavior value stays constant for the whole card.
 *
 * Verified against the live API: in card JSON 2.0 a `select_static` is a DIRECT body
 * element. The `action` container that card 1.0 wrapped it in is gone from V2
 * (using it fails the whole card with 200861).
 *
 * @param options `{ label, value }` pairs; both must be non-empty or the platform rejects it.
 * @param initialOption the `value` to preselect — the current state, when there is one.
 */
export function selectElement(elementId, { placeholder, options, behavior, initialOption } = {}) {
  const usable = options.filter((option) => option?.label && option?.value)
  const element = {
    tag: 'select_static',
    element_id: elementId,
    placeholder: { tag: 'plain_text', content: String(placeholder ?? '') },
    options: usable.map((option) => ({
      text: { tag: 'plain_text', content: String(option.label).slice(0, 80) },
      value: option.value,
    })),
  }
  if (behavior) element.behaviors = [{ type: 'callback', value: behavior }]
  // Only when it names a real option: an unmatched initial value is not a preselect.
  if (initialOption && usable.some((option) => option.value === initialOption)) {
    element.initial_option = initialOption
  }
  return element
}

export function choiceRows(buttons, perRow = 4) {
  const rows = []
  for (let offset = 0; offset < buttons.length; offset += perRow) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: '8px',
      horizontal_align: 'left',
      columns: buttons.slice(offset, offset + perRow).map((button) => ({
        tag: 'column',
        width: 'auto',
        vertical_align: 'top',
        elements: [{ ...button, width: 'default' }],
      })),
    })
  }
  return rows
}

/**
 * The free-text fallback: an input plus a submit button.
 *
 * Form submits report `action.name` and `action.form_value` rather than a
 * callback `value`, so the correlation id travels in the button name and the
 * submit button deliberately carries no `behaviors`.
 */
function customForm(id, customPlaceholder) {
  return {
    tag: 'form',
    name: 'custom_form',
    elements: [
      {
        tag: 'input',
        element_id: ELEMENTS.customInput,
        name: 'custom',
        input_type: 'text',
        placeholder: { tag: 'plain_text', content: customPlaceholder },
        width: 'fill',
      },
      {
        tag: 'button',
        name: `${CUSTOM_SUBMIT_PREFIX}${id}`,
        text: { tag: 'plain_text', content: '✏️ 提交自定义答案' },
        type: 'primary',
        width: 'default',
        form_action_type: 'submit',
      },
    ],
  }
}

/** A card that only reports something, used for refusals and errors. */
export function buildNoticeCard(opts) {
  const { title = 'DSH', template = TEMPLATE.neutral, body = '' } = opts
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template },
    body: { elements: [markdownElement(ELEMENTS.prompt, body)] },
  }
}
