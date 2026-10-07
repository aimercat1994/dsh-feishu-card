/**
 * `/model` — the model picker for one Feishu conversation.
 *
 * Feishu has no autocomplete, so a typed argument is a poor interface for a list
 * of models: the picker is a card whose buttons ARE the models, and a click
 * switches immediately (the deployment asked for direct execution). The typed form
 * still exists for people who know what they want.
 *
 * Selection is SESSION-local (`sessionController.selectModel({sessionId, …})`), so
 * one Feishu conversation can run a different model from the Web UI and from other
 * chats. The current value is read from the session projection rather than cached:
 * the Web UI can change it too, and a cache would then disagree with the harness.
 *
 * @module dsh-feishu-card/model
 */

import { ELEMENTS, TEMPLATE, callbackButton, choiceRows, headerTitle, markdownElement } from './card.js'

const TEXT = {
  zh: {
    title: 'DSH · 模型',
    heading: '**当前模型**',
    defaultHint: '（尚未在本会话选择过，使用部署默认）',
    pick: '**切换模型**',
    empty: '（没有可用模型）',
    failures: (lines) => `**不可用的提供方**\n${lines}`,
    switched: (label) => `✅ 已切换到 \`${label}\``,
    already: (label) => `当前已经是 \`${label}\``,
    unknownQuery: (query) => `找不到模型 \`${query}\`。`,
    ambiguous: (query, options) => `\`${query}\` 匹配到多个模型，请用 \`provider/model\` 指定：\n${options}`,
    catalogFailed: '读取模型列表失败，请稍后重试。',
    noController: '当前部署未提供模型选择接口。',
    usage: '用法：`/model` 查看与切换，或 `/model <provider>/<model>` 直接指定。',
    toastSwitched: (label) => `已切换到 ${label}`,
    settled: '已切换到该模型。需要再换时，重新发送 `/model`。',
  },
  en: {
    title: 'DSH · Model',
    heading: '**Current model**',
    defaultHint: '(nothing selected in this conversation yet; using the deployment default)',
    pick: '**Switch model**',
    empty: '(no models available)',
    failures: (lines) => `**Unavailable providers**\n${lines}`,
    switched: (label) => `✅ Switched to \`${label}\``,
    already: (label) => `Already on \`${label}\``,
    unknownQuery: (query) => `No model matches \`${query}\`.`,
    ambiguous: (query, options) => `\`${query}\` matches several models; name one as \`provider/model\`:\n${options}`,
    catalogFailed: 'Could not read the model list; try again shortly.',
    noController: 'This deployment exposes no model-selection interface.',
    usage: 'Usage: `/model` to browse and switch, or `/model <provider>/<model>`.',
    toastSwitched: (label) => `Switched to ${label}`,
    settled: 'Switched. Send `/model` again to pick another.',
  },
}

/** Text table for one locale. */
export function modelStrings(locale) {
  return TEXT[locale] ?? TEXT.zh
}

/** How a selection reads in one line. */
export function describeSelection(selection) {
  if (!selection?.provider || !selection?.model) return ''
  const base = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort ? `${base} (${selection.reasoningEffort})` : base
}

/** Every model in the catalog, flattened and carrying its provider. */
export function flattenCatalog(catalog) {
  const out = []
  for (const group of catalog?.groups ?? []) {
    for (const model of group.models ?? []) {
      out.push({
        provider: group.id,
        providerName: group.name ?? group.id,
        model: model.id,
        name: model.name ?? model.id,
        description: model.description,
      })
    }
  }
  return out
}

/**
 * Resolve what someone typed into one catalog entry.
 *
 * Accepts `provider/model`, a bare model id, or a model's display name — the last
 * two only when they are unambiguous, because guessing between two providers'
 * identically named models would silently pick one.
 *
 * @returns `{ entry }`, `{ error }` (already localised), or `{ list: true }`.
 */
export function resolveModelQuery(query, catalog, locale) {
  const t = modelStrings(locale)
  const raw = String(query ?? '').trim()
  if (raw.length === 0) return { list: true }

  const entries = flattenCatalog(catalog)
  const needle = raw.toLowerCase()

  if (raw.includes('/')) {
    const [provider, ...rest] = raw.split('/')
    const model = rest.join('/')
    const entry = entries.find(
      (item) => item.provider.toLowerCase() === provider.toLowerCase() && item.model.toLowerCase() === model.toLowerCase(),
    )
    return entry ? { entry } : { error: t.unknownQuery(raw) }
  }

  const hits = entries.filter(
    (item) => item.model.toLowerCase() === needle || String(item.name).toLowerCase() === needle,
  )
  if (hits.length === 1) return { entry: hits[0] }
  if (hits.length === 0) return { error: t.unknownQuery(raw) }
  const options = hits.map((item) => `- \`${item.provider}/${item.model}\``).join('\n')
  return { error: t.ambiguous(raw, options) }
}

/** Element ids must be unique, start with a letter and stay within 20 characters. */
function groupElementId(index) {
  return `mprov${index}`
}

/**
 * The picker card.
 *
 * Every model is a button carrying `{k:'model', s, p, m}` — the session it applies
 * to and the selection to install. The session travels in the payload rather than
 * being re-derived from the chat, because the conversation key depends on the
 * configured scope (chat / thread / sender) and the click does not carry a thread.
 *
 * @param catalog   the host's `modelCatalog()` result.
 * @param current   the session's current `ModelSelection`, when known.
 * @param sessionId the session a click should apply to.
 * @param settled   render the outcome only: no picker, no buttons.
 */
export function buildModelCard({ catalog, current, sessionId, locale, settled = false }) {
  const t = modelStrings(locale)
  const elements = []

  const currentLabel = describeSelection(current) || describeSelection(catalog?.default)
  const currentLine = describeSelection(current)
    ? `${currentLabel}`
    : `${currentLabel}${t.defaultHint}`
  elements.push(markdownElement(ELEMENTS.prompt, `${t.heading}\n${currentLine}`))

  // Settled: the choice is made, so the picker goes away rather than staying open.
  // A panel that keeps offering alternatives after a decision reads as "not saved",
  // and the way back is a deliberate gesture (`/model` again) rather than a mis-tap.
  if (settled) {
    elements.push(markdownElement('msettled', t.settled))
    return {
      schema: '2.0',
      config: { update_multi: true, summary: { content: t.title } },
      header: { title: headerTitle(t.title), template: TEMPLATE.neutral },
      body: { elements },
    }
  }

  const groups = catalog?.groups ?? []
  if (groups.length === 0) {
    elements.push(markdownElement('mempty', t.empty))
  } else {
    elements.push(markdownElement('mpick', t.pick))
  }

  // Compared WITHOUT the reasoning effort: a button stands for a model, not for one
  // effort level, so `describeSelection` (which appends " (high)") would never match
  // a selection that carries an effort — and the ✓ would vanish exactly when the
  // session is most specifically configured.
  const active = current?.provider && current?.model ? `${current.provider}/${current.model}` : ''
  groups.forEach((group, index) => {
    elements.push(markdownElement(groupElementId(index), `**${group.name ?? group.id}**`))
    const buttons = (group.models ?? []).map((model) => {
      const label = `${`${group.id}/${model.id}` === active ? '✓ ' : ''}${model.name ?? model.id}`
      return callbackButton(label, 'default', {
        k: 'model',
        s: sessionId,
        p: group.id,
        m: model.id,
      })
    })
    if (buttons.length > 0) elements.push(...choiceRows(buttons))
  })

  const failures = catalog?.failures ?? []
  if (failures.length > 0) {
    elements.push(markdownElement('mfail', t.failures(failures.map((f) => `- ${f.name ?? f.id}：${f.message}`).join('\n'))))
  }

  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: t.title } },
    header: { title: headerTitle(t.title), template: TEMPLATE.neutral },
    body: { elements },
  }
}
