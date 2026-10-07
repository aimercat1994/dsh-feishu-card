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
    usage: '用法：`/model` 查看与切换，或 `/model <provider>/<model> [档位]` 直接指定。',
    toastSwitched: (label) => `已切换到 ${label}`,
    settled: '已切换到该模型。需要再换时，重新发送 `/model`。',
    effortTitle: 'DSH · 推理档位',
    effortHeading: '**模型**',
    effortPick: '**选择推理档位**',
    effortCurrent: (label) => `当前：${label}`,
    effortDefault: '默认',
    effortSettled: (label) => `已切到 **${label}**。重新发送 \`/model\` 可再调整。`,
    effortAdjust: '调整推理档位',
    noEfforts: (label) => `\`${label}\` 不支持推理档位。`,
    unknownEffort: (query, options) => `找不到推理档位 \`${query}\`，可用：\n${options}`,
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
    usage: 'Usage: `/model` to browse and switch, or `/model <provider>/<model> [effort]`.',
    toastSwitched: (label) => `Switched to ${label}`,
    settled: 'Switched. Send `/model` again to pick another.',
    effortTitle: 'DSH · Reasoning effort',
    effortHeading: '**Model**',
    effortPick: '**Choose a reasoning effort**',
    effortCurrent: (label) => `Current: ${label}`,
    effortDefault: 'default',
    effortSettled: (label) => `Now on **${label}**. Send \`/model\` again to adjust.`,
    effortAdjust: 'Adjust reasoning effort',
    noEfforts: (label) => `\`${label}\` offers no reasoning efforts.`,
    unknownEffort: (query, options) => `No reasoning effort matches \`${query}\`. Available:\n${options}`,
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
        // Carried through, because the picker has to know whether choosing this
        // model still leaves a decision to make.
        reasoning: model.reasoning,
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

  // `provider/model [effort]`: the effort is a separate word, so a model id that
  // itself contains a space stays addressable through the provider/model form.
  const [selector, effortToken] = splitEffort(raw)
  const withEffort = (found) => (effortToken === undefined ? found : checkEffort(found, effortToken, t))

  if (selector.includes('/')) {
    const [provider, ...rest] = selector.split('/')
    const model = rest.join('/')
    const entry = entries.find(
      (item) => item.provider.toLowerCase() === provider.toLowerCase() && item.model.toLowerCase() === model.toLowerCase(),
    )
    return entry ? withEffort({ entry }) : { error: t.unknownQuery(raw) }
  }

  const hits = entries.filter(
    (item) => item.model.toLowerCase() === selector.toLowerCase() || String(item.name).toLowerCase() === selector.toLowerCase(),
  )
  if (hits.length === 1) return withEffort({ entry: hits[0] })
  if (hits.length === 0) return { error: t.unknownQuery(raw) }
  const options = hits.map((item) => `- \`${item.provider}/${item.model}\``).join('\n')
  return { error: t.ambiguous(raw, options) }
}

/** The catalogue entry for one provider/model, or undefined. */
export function catalogEntry(catalog, provider, model) {
  return flattenCatalog(catalog).find(
    (entry) => entry.provider === provider && entry.model === model,
  )
}

/**
 * The reasoning efforts a model offers, and which one it defaults to.
 *
 * A model with no `reasoning` block simply has no such choice: it is not an error,
 * and offering an empty picker would be a dead end.
 */
export function effortsFor(catalog, provider, model) {
  const reasoning = catalogEntry(catalog, provider, model)?.reasoning
  return {
    efforts: Array.isArray(reasoning?.efforts) ? reasoning.efforts : [],
    defaultEffort: reasoning?.defaultEffort,
  }
}

/** Split `model [effort]`, keeping the selector intact when no effort is given. */
function splitEffort(raw) {
  const parts = raw.split(/\s+/)
  if (parts.length < 2) return [raw, undefined]
  return [parts.slice(0, -1).join(' '), parts[parts.length - 1]]
}

/**
 * Attach an effort to a resolved model, or explain why it cannot apply.
 *
 * Checked against the model's own list: an effort the model does not offer would be
 * accepted by nothing downstream, and silently dropping it would look like it took.
 */
function checkEffort(found, effortToken, t) {
  const offered = found.entry.reasoning?.efforts ?? []
  if (offered.length === 0) return { error: t.noEfforts(describeSelection(found.entry)) }
  const match = offered.find(
    (effort) => effort.id.toLowerCase() === effortToken.toLowerCase()
      || String(effort.name).toLowerCase() === effortToken.toLowerCase(),
  )
  if (!match) {
    return { error: t.unknownEffort(effortToken, offered.map((e) => `- \`${e.id}\``).join('\n')) }
  }
  return { entry: found.entry, effort: match.id }
}

/** Element ids must be unique, start with a letter and stay within 20 characters. */
function groupElementId(index) {
  return `mprov${index}`
}

/**
 * The reasoning-effort picker for one model.
 *
 * Reached from the model picker when the chosen model still leaves a decision — a
 * model that offers efforts has no single "the model" answer, and applying the
 * default silently would be choosing on the user's behalf.
 *
 * Every button carries `{k:'model', s, p, m, e}`. The `e` is what distinguishes
 * "apply this effort" from "still choosing" in the action handler, so no second
 * action kind is needed. An empty `e` means "let the model default apply", which is
 * a real choice and therefore has its own button.
 */
export function buildEffortCard({ catalog, current, provider, model, sessionId, locale }) {
  const t = modelStrings(locale)
  const { efforts, defaultEffort } = effortsFor(catalog, provider, model)
  const label = describeSelection({ provider, model })
  const elements = [
    markdownElement(ELEMENTS.prompt, `${t.effortHeading}\n${label}`),
    markdownElement('epick', t.effortPick),
  ]

  const active = current?.provider === provider && current?.model === model ? current.reasoningEffort : undefined
  const buttons = efforts.map((effort) => callbackButton(
    `${effort.id === active ? '✓ ' : ''}${effort.name ?? effort.id}${effort.id === defaultEffort ? ` (${t.effortDefault})` : ''}`,
    'default',
    { k: 'model', s: sessionId, p: provider, m: model, e: effort.id },
  ))
  // A model default is a distinct outcome from "no effort recorded", and the user
  // should be able to ask for it explicitly.
  buttons.push(callbackButton(
    `${active === undefined ? '✓ ' : ''}${t.effortDefault}`,
    'default',
    { k: 'model', s: sessionId, p: provider, m: model, e: '' },
  ))
  elements.push(...choiceRows(buttons))

  const shown = describeSelection(current?.provider === provider && current?.model === model ? current : undefined)
  if (shown) elements.push(markdownElement('ecur', t.effortCurrent(shown)))
  return shellCard(t.effortTitle, elements)
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
    return shellCard(t.title, elements)
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

  // Changing only the effort should not require re-picking the model, so the
  // current model gets its own way in when it has efforts to offer.
  if (current?.provider && effortsFor(catalog, current.provider, current.model).efforts.length > 0) {
    elements.push(...choiceRows([
      callbackButton(t.effortAdjust, 'default', {
        k: 'model',
        s: sessionId,
        p: current.provider,
        m: current.model,
      }),
    ], 1))
  }

  const failures = catalog?.failures ?? []
  if (failures.length > 0) {
    elements.push(markdownElement('mfail', t.failures(failures.map((f) => `- ${f.name ?? f.id}：${f.message}`).join('\n'))))
  }

  return shellCard(t.title, elements)
}

/** Both pickers share one envelope. */
function shellCard(title, elements) {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: title } },
    header: { title: headerTitle(title), template: TEMPLATE.neutral },
    body: { elements },
  }
}
