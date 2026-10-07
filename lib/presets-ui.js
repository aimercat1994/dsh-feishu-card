/**
 * `/preset` and `/permission` — the two session-scoped choices.
 *
 * They are the same shape: one value out of a small fixed set, applied to the
 * session this conversation is on. So they share one card builder, one select
 * element and one payload convention (`{v: <value>}` in the option, a constant
 * marker in the behavior).
 *
 * The two differ in one way that matters, and it is not cosmetic: a permission
 * preset can be changed at any time, while an agent preset can only be chosen
 * BEFORE the session's first turn — the host refuses the switch afterwards with
 * `agent-preset/locked`. Offering a picker whose every choice fails would be worse
 * than explaining the constraint, so the caller asks {@link presetLocked} first.
 *
 * @module dsh-feishu-card/presets-ui
 */

import { ELEMENTS, TEMPLATE, headerTitle, markdownElement, selectElement } from './card.js'

const TEXT = {
  zh: {
    presetTitle: 'DSH · 模式',
    permissionTitle: 'DSH · 权限',
    presetHeading: '**当前模式**',
    permissionHeading: '**当前权限**',
    presetPlaceholder: '选择模式',
    permissionPlaceholder: '选择权限',
    unknownPreset: '（未设置）',
    unknownPermission: '（未知）',
    settledPreset: (label) => `已切到 **${label}**。重新发送 \`/preset\` 可再调整。`,
    settledPermission: (label) => `已切到 **${label}**。重新发送 \`/permission\` 可再调整。`,
    presetHint: '模式决定这个会话挂载哪些插件与工具。**不选也可以**：直接发消息就用默认模式。',
    newHeading: '**模式**',
    newLead: (sessionId) => `已开始新会话：\`${sessionId}\``,
    newPicked: (label) => `已选择 **${label}**。下一条消息就用它开始；不选则用默认模式。`,
    newDefault: (label) => `${label}（默认）`,
    permissionHint: '权限决定沙箱模式与审批策略；选择后立即生效。',
    broken: (count) => `（另有 ${count} 个模式无法加载，已隐藏）`,
    unknown: (query) => `找不到 \`${query}\`。`,
    ambiguous: (query, options) => `\`${query}\` 匹配到多个：\n${options}`,
    // The lock is the one thing a user cannot guess, so it gets a full sentence and
    // the way out rather than a terse error.
    locked: '**模式只能在会话开始前选择。**\n这个会话已经跑过回合了，宿主会拒绝切换。\n\n先发送 `/new` 开一个新会话，再发送 `/preset` 选择模式。',
    noPresets: '当前部署没有可选模式。',
    noPermission: '当前部署没有可选权限。',
    noService: '当前部署未提供该选择接口。',
    usage: '用法：`/preset [模式]`、`/permission [权限]`。',
    toast: (label) => `已切到 ${label}`,
    toastFailed: '切换失败，详见日志',
    gone: '该操作已失效',
  },
  en: {
    presetTitle: 'DSH · Preset',
    permissionTitle: 'DSH · Permission',
    presetHeading: '**Current preset**',
    permissionHeading: '**Current permission**',
    presetPlaceholder: 'Choose a preset',
    permissionPlaceholder: 'Choose a permission',
    unknownPreset: '(not set)',
    unknownPermission: '(unknown)',
    settledPreset: (label) => `Now on **${label}**. Send \`/preset\` again to adjust.`,
    settledPermission: (label) => `Now on **${label}**. Send \`/permission\` again to adjust.`,
    presetHint: 'The preset decides which plugins and tools this session mounts. **Choosing is optional**: just send a message to start with the default.',
    newHeading: '**Preset**',
    newLead: (sessionId) => `Started a new session: \`${sessionId}\``,
    newPicked: (label) => `Selected **${label}**. The next message starts with it; skip this to use the default.`,
    newDefault: (label) => `${label} (default)`,
    permissionHint: 'The permission decides the sandbox mode and approval policy; it applies immediately.',
    broken: (count) => `(${count} more preset(s) failed to load and are hidden)`,
    unknown: (query) => `No match for \`${query}\`.`,
    ambiguous: (query, options) => `\`${query}\` matches several:\n${options}`,
    locked: '**A preset can only be chosen before the session starts.**\nThis session has already run a turn, and the host refuses the switch.\n\nSend `/new` to start a fresh session, then `/preset`.',
    noPresets: 'This deployment offers no presets.',
    noPermission: 'This deployment offers no permission presets.',
    noService: 'This deployment exposes no such selection interface.',
    usage: 'Usage: `/preset [name]`, `/permission [name]`.',
    toast: (label) => `Now on ${label}`,
    toastFailed: 'Switch failed; see the log',
    gone: 'That action is no longer valid',
  },
}

/**
 * Chinese names for the ids the harness ships.
 *
 * The host supplies ids and, for a custom preset, whatever `name` its author wrote
 * — the built-ins ship NO name at all (the profile config lists ids only), so a
 * picker that showed the raw id would read "standard / ptc / minimal" in an
 * otherwise Chinese UI. The Web UI carries the same names; this mirrors them.
 *
 * A name from the host still wins: a custom preset is entitled to its own.
 */
const PRESET_LABELS = {
  standard: '标准模式',
  ptc: 'PTC 模式',
  minimal: '极简模式',
}

/** Same idea for the permission presets, which are ids only as well. */
const PERMISSION_LABELS = {
  'read-only': '只读',
  'workspace-write': '可写工作区',
  'danger-full-access': '完全访问（危险）',
}

/** The Chinese name for an id, or undefined when this build has none. */
export function localizedPresetName(value) {
  return PRESET_LABELS[value]
}

export function localizedPermissionName(value) {
  return PERMISSION_LABELS[value]
}

/** Text table for one locale. */
export function presetStrings(locale) {
  return TEXT[locale] ?? TEXT.zh
}

/** The option value for a choice; the intent travels here, not in the behavior. */
export function choiceOptionValue(value) {
  return JSON.stringify({ v: value })
}

/**
 * Whether an agent preset can still be chosen.
 *
 * Mirrors the host's own guard exactly (`openTurnStartSeq !== null || lastTurn > 0`)
 * rather than approximating it: the check exists to predict a refusal, so being
 * wrong in either direction is a bug.
 */
export function presetLocked(boundary) {
  if (boundary === undefined || boundary === null) return false
  return boundary.openTurnStartSeq !== null || (boundary.lastTurn ?? 0) > 0
}

/** Preset rows from the registry, as select options; broken ones are dropped. */
export function presetOptions(presets) {
  return (Array.isArray(presets) ? presets : [])
    .filter((preset) => preset && typeof preset.id === 'string' && !preset.broken)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    // The host's own name wins; the Chinese map fills in for the built-ins, which
    // ship without one.
    .map((preset) => ({
      value: preset.id,
      name: preset.name ?? localizedPresetName(preset.id) ?? preset.id,
      description: preset.description,
    }))
}

/** Permission rows from the catalog, as select options. */
export function permissionOptions(catalog) {
  return (Array.isArray(catalog?.options) ? catalog.options : [])
    // An empty value is dropped rather than offered: the action refuses it, so the
    // entry could only ever be a dead end.
    .filter((option) => option && typeof option.value === 'string' && option.value.length > 0)
    .map((option) => ({
      value: option.value,
      name: option.name ?? localizedPermissionName(option.value) ?? option.value,
      description: option.description,
    }))
}

/**
 * Resolve what someone typed into one option.
 *
 * Accepts the value or the display name, case-insensitively, and refuses an
 * ambiguous name rather than guessing — applying the wrong preset to a session is
 * not something the user can see happened.
 */
export function resolveOptionQuery(query, options, locale) {
  const t = presetStrings(locale)
  const raw = String(query ?? '').trim()
  if (raw.length === 0) return { list: true }
  const needle = raw.toLowerCase()
  const exact = options.find((option) => option.value.toLowerCase() === needle)
  if (exact) return { option: exact }
  const hits = options.filter((option) => String(option.name).toLowerCase() === needle)
  if (hits.length === 1) return { option: hits[0] }
  if (hits.length === 0) return { error: t.unknown(raw) }
  return { error: t.ambiguous(raw, hits.map((option) => `- \`${option.value}\``).join('\n')) }
}

/**
 * The picker card, shared by both choices.
 *
 * @param currentLabel prose naming the current choice (never an object: it is
 *                     concatenated into markdown, and an object renders as
 *                     "[object Object]").
 * @param currentValue the value to preselect; must match an option exactly.
 * @param behavior the constant marker the callback returns (`{k, s}`).
 * @param settled  render the outcome only: no picker.
 */
export function buildChoiceCard({
  title,
  heading,
  currentLabel,
  currentValue,
  placeholder,
  options,
  behavior,
  hint,
  settledText,
  emptyText,
  elementId = 'cselect',
  lead = '',
  settled = false,
}) {
  // Label and value are separate on purpose: the label is prose for the reader, the
  // value must match an option exactly or the preselect silently does nothing.
  const elements = []
  if (lead) elements.push(markdownElement(ELEMENTS.notice, lead))
  elements.push(markdownElement(ELEMENTS.prompt, `${heading}\n${currentLabel}`))
  if (settled) {
    elements.push(markdownElement('csettled', settledText))
    return shell(title, elements)
  }
  if (options.length === 0) {
    elements.push(markdownElement('cempty', emptyText))
    return shell(title, elements)
  }
  elements.push(selectElement(elementId, {
    placeholder,
    options: options.map((option) => ({
      // The value is the identity; the name is what a person reads.
      label: option.name,
      value: choiceOptionValue(option.value),
    })),
    behavior,
    initialOption: choiceOptionValue(currentValue),
  }))
  if (hint) elements.push(markdownElement('chint', hint))
  return shell(title, elements)
}

function shell(title, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template: TEMPLATE.neutral },
    body: { elements },
  }
}
