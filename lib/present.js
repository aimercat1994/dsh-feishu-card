/**
 * Tool-call presentation for a chat surface.
 *
 * The harness has a rich internal `ToolCallView` model, but it is consumed by
 * the Web client, which computes it from session events; no Host service hands a
 * chat bridge a ready-made view. This module therefore derives a compact
 * human-readable phrase from a tool name plus its arguments — the same job HFC's
 * `_tool_action_phrase` does — and lifts an inline diff out of the edit tools so
 * a file change is visible in the chat instead of hidden behind a tool name.
 *
 * A phrase must carry the call's own content, not just its name: a bare
 * `` 🔧 `compress` `` tells a reader nothing about what was compressed. Each
 * family therefore knows where its identifying text lives — a path for the file
 * tools, the URL for `web_fetch`, the skill name for `skill`, the range list for
 * `compress`, the task description for `subagent` — and falls back to the bare
 * name when that text is absent or the arguments cannot be parsed.
 *
 * Everything here is presentation only: it never influences execution, and an
 * unrecognised tool must degrade to its plain name rather than throw.
 *
 * @module dsh-feishu-card/present
 */

/** Icon per tool family, mirroring the harness's ToolCallKind vocabulary. */
const KIND_ICON = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⚡',
  fetch: '🌐',
  compress: '🗜️',
  skill: '🧠',
  subagent: '🧑‍💻',
  other: '🔧',
}

/** Tool-name fragments mapped to a kind, checked in order. */
const KIND_HINTS = [
  [/^(read|read_file|fs_read|view|cat)$/i, 'read'],
  [/(edit|write|patch|replace|create_file)/i, 'edit'],
  [/(delete|remove|rm)$/i, 'delete'],
  [/(move|rename)/i, 'move'],
  [/(search|grep|glob|find)/i, 'search'],
  [/(bash|shell|exec|run|terminal|pwsh|powershell)/i, 'execute'],
  [/(web|fetch|http|curl|browse)/i, 'fetch'],
  [/^compress/i, 'compress'],
  [/^skill$/i, 'skill'],
  [/^subagent$/i, 'subagent'],
]

/** Classify a tool name into one presentation kind. */
export function kindOf(name) {
  const tool = String(name ?? '')
  for (const [pattern, kind] of KIND_HINTS) {
    if (pattern.test(tool)) return kind
  }
  return 'other'
}

/** The icon for a tool name. */
export function iconOf(name) {
  return KIND_ICON[kindOf(name)] ?? KIND_ICON.other
}

/** Parse a tool's arguments defensively; a chat must not break on odd JSON. */
function parseArgs(argsJson) {
  if (typeof argsJson !== 'string' || argsJson.length === 0) return undefined
  try {
    const parsed = JSON.parse(argsJson)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** The most useful "what file does this touch" field across tool families. */
function targetOf(args) {
  if (!args) return undefined
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'filename_windows', 'target', 'pattern', 'query', 'command', 'url', 'name']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * The ranges a `compress` call folds, however its arguments express them.
 *
 * The harness sends the range list as structured content (`[{startId, endId,
 * topic, summary}]`) when the caller passes one, and as the literal summary text
 * otherwise; both forms name their ranges at the start of a line.
 *
 * @returns `{ count, first }` for a recognised call, else undefined.
 */
function compressedRanges(args) {
  if (!args) return undefined
  const headers = []
  const { content } = args
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const span = typeof item.startId === 'string' && typeof item.endId === 'string'
        ? `${item.startId}–${item.endId}`
        : undefined
      const topic = typeof item.topic === 'string' && item.topic.length > 0 ? item.topic : undefined
      const head = [span, topic].filter(Boolean).join(' ')
      if (head) headers.push(head)
    }
  } else if (typeof content === 'string') {
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (/^m\d{5}/.test(trimmed)) headers.push(trimmed)
    }
  } else if (typeof args.startId === 'string' && typeof args.endId === 'string') {
    headers.push(`${args.startId}–${args.endId}`)
  }
  if (headers.length === 0) return undefined
  return { count: headers.length, first: headers[0] }
}

/**
 * The label a `subagent` call already carries for exactly this purpose.
 *
 * The tool's own schema documents `description` as "a short (3-5 word)
 * description of the delegated task, for display", so it is what a reader wants
 * on the card — not the tool name. A caller-supplied `label` and the prompt's
 * opening are the fallbacks, in that order.
 *
 * @returns the label, or undefined when the call carries none.
 */
export function subagentLabel(argsJson) {
  const args = parseArgs(argsJson)
  if (!args) return undefined
  for (const key of ['description', 'label', 'prompt']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** Collapse whitespace and bound a phrase so one call cannot dominate the card. */
function bound(text, limit = 90) {
  const flat = String(text).replace(/[\r\n\t]+/g, ' ').replace(/`/g, '').replace(/\s{2,}/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/**
 * Describe one tool call in a few words.
 *
 * @returns the icon-prefixed phrase shown in the card's process panel.
 */
export function describeCall(name, argsJson) {
  const kind = kindOf(name)
  const icon = KIND_ICON[kind]
  const args = parseArgs(argsJson)
  const label = kind === 'other' ? String(name ?? 'tool') : kind
  // `compress` carries no single target field: its content is a list of ranges,
  // so the count and the first range are what identify the call.
  if (kind === 'compress') {
    const ranges = compressedRanges(args)
    return ranges
      ? `${icon} \`${label}\` ${ranges.count} 段 · ${bound(ranges.first, 60)}`
      : `${icon} \`${label}\``
  }
  // `subagent` names its task in `description`; the tool name alone says nothing
  // about who is running what.
  if (kind === 'subagent') {
    const described = subagentLabel(argsJson)
    return described ? `${icon} \`${label}\` ${bound(described, 60)}` : `${icon} \`${label}\``
  }
  const target = targetOf(args)
  return target ? `${icon} \`${label}\` ${bound(target)}` : `${icon} \`${label}\``
}

/** Argument pairs that mean "replace this text with that text". */
const DIFF_PAIRS = [
  ['old_str', 'new_str'],
  ['old_string', 'new_string'],
  ['oldText', 'newText'],
  ['old_text', 'new_text'],
]

/**
 * Render a unified-diff block when a call edits a file.
 *
 * @returns a fenced ```diff block, or undefined when the call is not an edit
 *   this surface can show.
 */
export function describeDiff(name, argsJson, { maxLines = 40 } = {}) {
  if (kindOf(name) !== 'edit') return undefined
  const args = parseArgs(argsJson)
  if (!args) return undefined

  for (const [oldKey, newKey] of DIFF_PAIRS) {
    const before = args[oldKey]
    const after = args[newKey]
    if (typeof before !== 'string' || typeof after !== 'string') continue
    const removed = before.split('\n').slice(0, maxLines).map((line) => `- ${line}`)
    const added = after.split('\n').slice(0, maxLines).map((line) => `+ ${line}`)
    return ['```diff', ...removed, ...added, '```'].join('\n')
  }

  // A whole-file write has no "before": show the head of the new content.
  const content = args.content ?? args.text ?? args.file_text
  if (typeof content === 'string' && content.length > 0) {
    const lines = content.split('\n').slice(0, maxLines)
    return ['```', ...lines, '```'].join('\n')
  }
  return undefined
}

/** Format a token count compactly (1234 -> 1.2k). */
export function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
