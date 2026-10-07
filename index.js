/**
 * dsh-feishu-card — a Feishu/Lark IM channel for DeepSeek Harness that renders
 * each turn as one continuously updating interactive card.
 *
 * Everything runs in-process through Host services and events: no sidecar, no
 * source patching, and no public callback URL (inbound events arrive over the
 * app's WebSocket long connection). Conversation identity is derived from the
 * chat facet, so restart continuity comes from the host session store rather
 * than a plugin-owned binding file.
 *
 * @module dsh-feishu-card
 */

import {
  Config,
  SETTINGS_NAMESPACE,
  hasCredentials,
  resolveConfig,
  withStoredCredentials,
} from './lib/config.js'
import { FeishuTransport, readCardAction, readInboundMessage } from './lib/feishu.js'
import { TurnRenderer } from './lib/turn.js'
import { ConversationSessions, conversationKey, makeWorkspaceFiler } from './lib/session.js'
import { CredentialStore, beginOnboarding, resolveStateDir } from './lib/onboarding.js'
import { commandName, helpText, isCommandLine, ownCommands, runCommandLine, strings } from './lib/commands.js'
import { createLogger } from './lib/log.js'
import { ReactionTracker } from './lib/react.js'
import { Notices } from './lib/notice.js'
import { ProgressCards } from './lib/progress.js'
import { Fanout } from './lib/fanout.js'
import { installToolGuard } from './lib/guard.js'
import { buildSendFileTool, resolveSendablePath } from './lib/outbound.js'
import { DROP, admit, isPolicyDrop } from './lib/access.js'
import { buildHelpCard } from './lib/help-card.js'
import {
  buildEffortCard,
  buildModelCard,
  describeSelection,
  effortsFor,
  modelStrings,
  resolveModelQuery,
} from './lib/model.js'
import {
  buildChoiceCard,
  choiceOptionValue,
  permissionOptions,
  presetLocked,
  presetOptions,
  presetStrings,
  resolveOptionQuery,
} from './lib/presets-ui.js'
import {
  buildSessionsCard,
  resolveSessionQuery,
  selectableSessions,
  sessionLabel,
  sessionStrings,
} from './lib/sessions-ui.js'
import { applyPanelSync, desiredPanelEntries, planPanelSync } from './lib/command-panel.js'
import { failureNote, promptContent, resolveImages } from './lib/images.js'
import { describeCall, describeDiff, formatTokens } from './lib/present.js'
import { dirname, sep } from 'node:path'
import {
  CUSTOM_SUBMIT_PREFIX,
  ELEMENTS,
  TEMPLATE,
  buildDecisionCard,
  buildNoticeCard,
  settledDecisionElements,
} from './lib/card.js'

/** Cordis plugin name; keep stable. */
export const name = 'dsh-feishu-card'

/** Host services that must exist before this plugin can be applied. */
export const inject = ['sessionController']

export { Config }

/** Human-readable elapsed time. */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`
}

/** Drop the `@_user_N` placeholders Feishu leaves in group-chat text. */
function stripMentionPlaceholders(text) {
  return text.replace(/@_\w+\s*/g, '').trim()
}

/** Text and reasoning carried by one committed assistant message. */
function readAssistantContent(message) {
  let text = ''
  let reasoning = ''
  for (const block of message?.content ?? []) {
    if (block?.type === 'text') text += block.text ?? ''
    else if (block?.type === 'reasoning') reasoning += block.text ?? ''
  }
  return { text, reasoning }
}

/**
 * Apply the plugin.
 *
 * Activation is fail-open by design: a plugin that cannot reach Feishu reports
 * why and stays inert instead of failing the profile. When no credentials exist
 * yet, onboarding runs instead.
 */
export async function apply(ctx, config = {}) {
  let resolved = resolveConfig(config)

  const stateDir = resolveStateDir(resolved.stateDir)
  const store = new CredentialStore({ dir: stateDir, logger: ctx.logger })
  // Every line also lands in a file: the harness console is a pipe this
  // deployment's supervisor owns, so stdout alone is not inspectable.
  const logger = createLogger(ctx.logger, stateDir)

  // The default workspace for new conversations. `process.cwd()` is the harness
  // installation directory, so falling back to it silently would point the
  // agent at the running harness itself; resolve a real workspace instead.
  // The raw configured value is kept alongside the resolved one: a live change to
  // `cwd` must be told apart from the resolved path we derived when it was empty.
  let configuredCwd = resolved.cwd
  const cwd = await resolveWorkspaceCwd(ctx, configuredCwd, logger)
  resolved = { ...resolved, cwd }

  // Credentials: entry config (patch/env) wins, then the stored app, then the
  // QR flow. A half-configured pair is treated as unconfigured.
  /**
   * Credentials the profile config did NOT supply, kept so that re-reading the
   * config cannot drop them.
   *
   * `resolved` is not just the config: it is the config layered over the stored
   * app and the resolved workspace. Re-reading the config alone therefore looks
   * like "the credentials disappeared", and acting on that difference tears down
   * a working connection. (It did: the first inbound message reconnected with an
   * empty app id and the channel went silent.)
   */
  let storedCredentials
  if (!hasCredentials(resolved)) {
    const stored = await store.load()
    if (stored) {
      storedCredentials = stored
      resolved = withStoredCredentials(resolved, storedCredentials)
    }
  }

  // Every host call that takes a cancellation signal gets this one. Omitting it
  // is NOT "no cancellation": the Remote implementations call
  // `signal.throwIfAborted()`, so `undefined` fails the entire call.
  const lifetime = new AbortController()

  // Built once: the filer caches the workspace lookup and the sessions it has
  // already attached, so a per-call instance would redo both every message.
  let fileSession = makeWorkspaceFiler(ctx, resolved.cwd, logger)
  const sessions = new ConversationSessions({
    sessionController: ctx.sessionController,
    cwd: resolved.cwd,
    stateDir,
    logger,
    onSession: async (sessionId, agent) => {
      // Both ladder rungs land here, so this is where per-agent setup belongs.
      ensureToolGuard(agent)
      void syncCommandPanel(agent)
      await fileSession(sessionId)
    },
  })
  await sessions.load()
  // Group conversations that already exist, without waiting for their next message.
  void sessions
    .adoptExisting(lifetime.signal)
    .catch((error) => logger?.warn?.('[feishu-card] adopting existing sessions failed', error))

  const transport = new FeishuTransport({ appId: resolved.appId, appSecret: resolved.appSecret, domain: resolved.domain || undefined, logger })
  const renderer = new TurnRenderer({
    transport,
    logger,
    flushIntervalMs: resolved.flushIntervalMs,
    reasoningTail: resolved.reasoningTail,
    preset: resolved.readingPreset,
    showProcess: resolved.showProcess,
    hideProcessWhenDone: resolved.hideProcessWhenDone,
    widthMode: resolved.widthMode,
    textSizes: resolved.textSizes,
  })
  const reactions = new ReactionTracker({
    transport,
    logger,
    enabled: resolved.reactionFeedback,
  })
  const notices = new Notices({
    renderer,
    transport,
    sessions,
    logger,
    pressureThreshold: resolved.pressureWarnTokens,
  })
  /** sessionId -> the context window reported by the last model request. */
  const contextWindows = new Map()
  // Todo and goal cards outlive a turn, so they are separate card entities that
  // get updated in place instead of being rewritten by the turn renderer.
  const progress = new ProgressCards({ transport, sessions, logger })
  // Workflow and subagent narration lands in the live turn's process panel.
  const fanout = new Fanout({ logger })

  const t = strings(resolved.locale)
  /** correlation id -> a card interaction waiting for a click. */
  const pending = new Map()
  /**
   * chatId -> correlation id of a QUESTION waiting for a free-text answer.
   *
   * Only questions are listed: the next text message in that chat answers it
   * instead of starting a new turn. Approvals are deliberately excluded, because
   * "allowed once" is not something a prose reply can express unambiguously.
   */
  const pendingByChat = new Map()
  /** agentId -> disposer for that agent's own registrations. */
  /** sessionId -> disposers for every per-agent registration this plugin made. */
  const agentRegistrations = new Map()
  let counter = 0
  const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

  // --- inbound: a Feishu message drives one conversation -------------------

  /**
   * Answer one slash line for a conversation.
   *
   * Shared by an inbound message and a `/help` button: both end up running the same
   * command for the same conversation, and they differ only in where the card goes.
   * Keeping one implementation is what stops the two entry points from drifting —
   * a command that works when typed but not when tapped is a bug users report as
   * "the button does nothing".
   */
  const runCommand = async ({ name, text, key, agent, sessionId, chatId, replyToMessageId }) => {
      let reply
      if (name === 'new') {
        // Rotating the session orphans every per-session structure keyed by the
        // old id, so they are dropped with it rather than leaking until unload.
        const previous = sessions.idFor(key)
        progress.forget(previous)
        notices.forget(previous)
        fanout.forget(previous)
        const rotated = await sessions.rotate(key)
        // Bound here so the picker's callback is accepted: `serves()` is what
        // authorises a card action, and it reads the routing that `bind` sets.
        sessions.bind(key, { chatId, messageId: replyToMessageId })

        // The preset is part of starting a session, not a separate command: it can
        // only be chosen before the first turn, so the moment after `/new` is the
        // only moment it is freely available.
        const registry = ctx.get('agentPresets')
        const options = registry && typeof registry.list === 'function'
          ? presetOptions(await registry.list(), resolved.locale)
          : []
        if (options.length === 0) {
          reply = { text: `${t.newSession}\n\n\`${rotated}\`` }
        } else {
          // Defaulted NOW rather than on the next message: "start without choosing"
          // has to mean the default, and the promise must not depend on the user
          // touching the picker.
          const fallback = registry.defaultId && options.some((o) => o.value === registry.defaultId)
            ? registry.defaultId
            : options[0].value
          pendingPresets.set(key, fallback)
          const label = presetStrings(resolved.locale)
          const fallbackName = options.find((o) => o.value === fallback)?.name ?? fallback
          await transport.sendCardOnce(
            buildChoiceCard({
              title: label.presetTitle,
              lead: label.newLead(rotated),
              heading: label.newHeading,
              currentLabel: label.newDefault(fallbackName),
              currentValue: fallback,
              placeholder: label.presetPlaceholder,
              options,
              behavior: { k: 'preset', s: rotated },
              hint: label.presetHint,
              emptyText: label.noPresets,
              locale: resolved.locale,
            }),
            { chatId: chatId, replyToMessageId: replyToMessageId },
          )
          return
        }
      } else if (name === 'status') {        } else if (name === 'status') {
        reply = {
          text: `\`${sessionId}\`\n卡片：${renderer.has(sessionId) ? t.statusBusy : t.statusIdle}`,
        }
      } else if (name === 'permission') {
        const t = presetStrings(resolved.locale)
        const service = ctx.get('permissionPresets')
        if (!service || typeof service.catalog !== 'function') {
          reply = { error: true, text: t.noService }
        } else {
          const query = text.replace(/^\/permission\b/, '').trim()
          const options = permissionOptions(service.catalog())
          const outcome = resolveOptionQuery(query, options, resolved.locale)
          if (outcome.list) {
            if (options.length === 0) {
              reply = { error: true, text: t.noPermission }
            } else {
              const currentName = service.current(agent.session)
              await transport.sendCardOnce(
                buildChoiceCard({
                  title: t.permissionTitle,
                  heading: t.permissionHeading,
                  currentLabel: options.find((o) => o.value === currentName)?.name ?? (currentName || t.unknownPermission),
                  currentValue: currentName,
                  placeholder: t.permissionPlaceholder,
                  options,
                  behavior: { k: 'permission', s: sessionId },
                  hint: t.permissionHint,
                  emptyText: t.noPermission,
                  locale: resolved.locale,
                }),
                { chatId: chatId, replyToMessageId: replyToMessageId },
              )
              return
            }
          } else if (outcome.error) {
            reply = { error: true, text: `${outcome.error}\n\n${t.usage}` }
          } else {
            service.set(agent.session, outcome.option.value)
            reply = { text: t.toast(outcome.option.name) }
          }
        }
      } else if (name === 'sessions') {
        const t = sessionStrings(resolved.locale)
        const rows = await listSessions()
        const { items, total } = selectableSessions({ summaries: rows, currentId: sessionId })
        if (rows.length === 0 && items.length === 0) {
          reply = { error: true, text: t.noList }
        } else {
          await transport.sendCardOnce(
            buildSessionsCard({
              items,
              total,
              currentId: sessionId,
              sessionId,
              locale: resolved.locale,
            }),
            { chatId: chatId, replyToMessageId: replyToMessageId },
          )
          return
        }
      } else if (name === 'switch') {
        const t = sessionStrings(resolved.locale)
        const query = text.replace(/^\/switch\b/, '').trim()
        const outcome = resolveSessionQuery(query, await listSessions(), resolved.locale)
        if (outcome.list || outcome.error) {
          reply = { error: true, text: `${outcome.error ?? t.usage}` }
        } else {
          const target = outcome.item.sessionId
          const result = await switchConversation(key, target, inbound)
          const label = `${sessionLabel(outcome.item)} · \`${target}\``
          reply = { text: result.unchanged ? t.already(label) : t.switched(label) }
        }
      } else if (name === 'model') {
        const t = modelStrings(resolved.locale)
        const catalog = await readModelCatalog()
        if (!catalog) {
          reply = { error: true, text: t.noController }
        } else {
          const query = text.replace(/^\/model\b/, '').trim()
          const outcome = resolveModelQuery(query, catalog, resolved.locale)
          if (outcome.list) {
            // The picker IS the interface: Feishu has no autocomplete, so the
            // models are buttons rather than something to type.
            await transport.sendCardOnce(
              buildModelCard({
                catalog,
                current: currentModelSelection(agent),
                sessionId,
                locale: resolved.locale,
              }),
              { chatId: chatId, replyToMessageId: replyToMessageId },
            )
            return
          }
          if (outcome.error) {
            reply = { error: true, text: `${outcome.error}\n\n${t.usage}` }
          } else {
            const requested = {
              sessionId,
              provider: outcome.entry.provider,
              model: outcome.entry.model,
            }
            // Absent means "leave the effort alone"; the host keeps whatever the
            // session already had, so only send it when one was asked for.
            if (outcome.effort !== undefined) requested.reasoningEffort = outcome.effort
            const value = await ctx.get('sessionController').selectModel(requested)
            reply = { text: t.switched(describeSelection(value?.selected ?? requested)) }
          }
        }
      } else if (name === 'help') {
        // A card, because a text list tells you what exists while a card lets you run
        // it — and Feishu has no autocomplete to fall back on.
        const registry = ctx.get('commands')
        let host = []
        try {
          host = [...(registry?.list?.(agent) ?? [])]
        } catch (error) {
          logger.warn('[feishu-card] listing harness commands failed', error)
        }
        try {
          await transport.sendCardOnce(
            buildHelpCard({
              own: ownCommands(resolved.locale),
              host: host.map((entry) => ({ name: entry.name, description: entry.description })),
              sessionId,
              locale: resolved.locale,
            }),
            { chatId, replyToMessageId },
          )
        } catch (error) {
          // The text form stays as the fallback: a help command that answers nothing
          // is worse than one that answers without buttons.
          logger.warn('[feishu-card] help card failed; falling back to text', error)
          await transport.sendText(
            await helpText({ commands: registry, agent, locale: resolved.locale, logger }),
            { chatId, replyToMessageId },
          )
        }
        return
      } else {
        reply = await runCommandLine({
          commands: ctx.get('commands'),
          agent,
          line: text,
          locale: resolved.locale,
          logger,
          signal: lifetime.signal,
        })
      }
      await transport.sendCardOnce(
        buildNoticeCard({
          title: `DSH · /${name}`,
          template: reply.error ? TEMPLATE.failed : TEMPLATE.neutral,
          body: reply.text,
        }),
        { chatId: chatId, replyToMessageId: replyToMessageId },
      )
      return
  }


  async function onMessage(data) {
    const inbound = readInboundMessage(data)
    if (!inbound) return
    // Pick up any settings change before using the values it affects.
    refreshSettings('inbound message')

    const text = stripMentionPlaceholders(inbound.text)
    const imageKeys = (inbound.imageKeys ?? []).slice(0, resolved.maxImagesPerMessage)
    const decision = admit(inbound, resolved, text, imageKeys.length)
    if (!decision.allow) {
      // An unsupported type is the sender's problem to fix, so say so — but only
      // after the policy gates admitted them, so another bot gets no reply.
      if (decision.reason === DROP.unsupported) {
        await transport.sendText(t.unsupportedMessageType(inbound.unsupported), {
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
        })
        return
      }
      // A policy rejection is worth a log line: without it, an operator whose
      // messages are being dropped has nothing to look at. Ordinary traffic
      // (an unmentioned group message, an empty body) is not logged.
      if (isPolicyDrop(decision.reason)) {
        logger.info(
          `[feishu-card] dropped a message (${decision.reason}) `
            + `chat=${inbound.chatId} sender=${inbound.senderId}`,
        )
      }
      return
    }
    const isGroup = inbound.chatType === 'group'

    const key = conversationKey(resolved.sessionScope, inbound)
    const sessionId = sessions.idFor(key)

    try {
      const agent = await sessions.reach(key)
      // Before the first prompt, which is the only moment the host accepts a preset.
      await applyPendingPreset(key, agent)
      sessions.bind(key, inbound)
      sessions.refreshReplyAnchor(sessionId, inbound.messageId)

      // `/stop` is answered before anything else can be admitted, so it works
      // even while a turn is running — which is exactly when it is wanted.
      if (isCommandLine(text) && commandName(text) === 'stop') {
        agent.cancel({ kind: 'user' })
        await transport.sendCardOnce(buildNoticeCard({ title: 'DSH', template: TEMPLATE.neutral, body: t.stopped }), {
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
        })
        return
      }

      if (isCommandLine(text)) {
        await runCommand({
          name: commandName(text),
          text,
          key,
          agent,
          sessionId,
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
        })
        return
      }

      // `autoResumeGoals` sits on the inbound path: a goal the harness disarmed
      // while the conversation was idle is re-armed by the next message.
      // A question awaiting a free-text answer consumes this message instead of
      // opening a new turn: answering in the ordinary chat box is the natural
      // gesture, and it avoids the card input's native editor panel entirely.
      const waitingId = pendingByChat.get(inbound.chatId)
      if (waitingId !== undefined) {
        const waiting = pending.get(waitingId)
        if (waiting) {
          waiting.settle({ kind: 'custom', custom: text, operator: { openId: inbound.senderId } })
          await transport.sendCardOnce(
            buildNoticeCard({ title: 'DSH', template: TEMPLATE.neutral, body: `✅ 已收到回答：${text}` }),
            { chatId: inbound.chatId, replyToMessageId: inbound.messageId },
          )
          return
        }
        pendingByChat.delete(inbound.chatId)
      }

      if (resolved.autoResumeGoals) resumeGoalIfNeeded(ctx, agent, logger)

      // A message admitted while a turn is already running is queued, not
      // started; its card opens on its own `turn/start`, so never settle the
      // running turn's card here. `begin` is idempotent.
      if (!renderer.has(sessionId)) {
        logger?.info?.(`[feishu-card] opening a card for ${sessionId} in ${inbound.chatId}`)
        await renderer.begin(sessionId, {
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
          title: 'DSH · 思考中',
        })
        logger?.info?.(`[feishu-card] card opened for ${sessionId}`)
      }

      // Acknowledge on the user's own message before the turn even starts: a
      // chat that goes silent for a minute looks broken.
      await reactions.show(inbound.messageId, 'ack')

      // Images are resolved just before prompting: a failure here costs only the
      // image, never the user's text.
      const images = resolved.images
        ? await resolveImages({
            imageKeys,
            messageId: inbound.messageId,
            transport,
            attachments: ctx.get('attachments'),
            limit: resolved.maxImagesPerMessage,
            logger,
          })
        : { parts: [], failures: [] }
      const content = promptContent(text, images.parts)
      const imageNote = failureNote(images.failures)
      if (imageNote) void transport.sendText(imageNote, { chatId: inbound.chatId, replyToMessageId: inbound.messageId })
      if (content.length === 0) {
        // An image-only message whose images all failed would otherwise prompt
        // with nothing, and the controller refuses that with a raw internal
        // message ("must include non-whitespace text or an attachment"). Say it
        // in the chat's own terms instead.
        await transport.sendText(t.nothingToSend, {
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
        })
        return
      }
      // Counted BEFORE the dispatch: `turn/start` can arrive while this await is
      // still settling, and an un-counted turn would then render nothing.
      channelTurns.set(sessionId, (channelTurns.get(sessionId) ?? 0) + 1)
      try {
        await ctx.sessionController.prompt(
          {
            requestId: nextId(),
            sessionId,
            mode: 'queue',
            content,
          },
          lifetime.signal,
        )
      } catch (error) {
        // The turn never started, so it owes nothing. Leaving the count raised would
        // make the NEXT turn in this session render a card even when it came from
        // another frontend — exactly the broadcast this counter exists to prevent.
        const owed = channelTurns.get(sessionId) ?? 0
        if (owed <= 1) channelTurns.delete(sessionId)
        else channelTurns.set(sessionId, owed - 1)
        throw error
      }
    } catch (error) {
      logger?.error?.(`[feishu-card] handling an inbound message failed (${key})`, error)
      void reactions.show(inbound.messageId, 'fail')
      // Plain text, deliberately: a card-shaped fallback would fail for the same
      // reason the first attempt did, and the user would see nothing at all.
      await transport
        .sendText(`⚠️ 无法处理这条消息：${error?.message ?? error}`, {
          chatId: inbound.chatId,
          replyToMessageId: inbound.messageId,
        })
        .catch((fallbackError) => logger?.error?.('[feishu-card] text fallback also failed', fallbackError))
    }
  }

  // --- inbound: a card button answers a pending interaction ----------------

  async function onCardAction(data) {
    const { action, name, operator, formValue, chatId, messageId, option } = readCardAction(data)

    // A form submit carries the submit button's `name` and the form's values, not
    // a callback `value` — so the correlation id is recovered from the name.
    const submitId =
      typeof name === 'string' && name.startsWith(CUSTOM_SUBMIT_PREFIX)
        ? name.slice(CUSTOM_SUBMIT_PREFIX.length)
        : undefined
    // A `/help` button runs a command. It goes through the SAME dispatcher an inbound
    // message uses, so a command cannot work when typed and fail when tapped.
    if (action.k === 'run') {
      const operatorId = operator?.openId ?? operator
      if (resolved.approvers.length > 0 && (!operatorId || !resolved.approvers.includes(operatorId))) {
        logger?.warn?.(`[feishu-card] refused a command tap from a non-approver (${operatorId})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
      const command = String(action.c ?? '')
      const key = typeof action.s === 'string' ? sessions.keyOf(action.s) : undefined
      // Only commands the card actually offered, and only for a live conversation:
      // the payload is a name, so anything that trusted it blindly could run an
      // arbitrary line.
      const offered = ownCommands(resolved.locale).some((entry) => entry.name === command)
      if (!offered || key === undefined) {
        return { toast: { type: 'info', content: '该操作已失效' } }
      }
      const agent = await agentFor(action.s)
      if (!agent) return { toast: { type: 'warning', content: '当前部署未提供该接口' } }
      const routing = sessions.routingFor(action.s) ?? { chatId, messageId }
      await runCommand({
        name: command,
        text: `/${command}`,
        key,
        agent,
        sessionId: action.s,
        chatId: routing.chatId,
        replyToMessageId: routing.replyToMessageId ?? messageId,
      })
      return { toast: { type: 'success', content: `已执行 /${command}` } }
    }

    // The two session-scoped choices share one branch: the behavior names the
    // conversation and the kind, the option names the value.
    // The two session-scoped choices share one branch: the behavior names the
    // conversation and the kind, the option names the value.
    if (action.k === 'preset' || action.k === 'permission') {
      const t = presetStrings(resolved.locale)
      const operatorId = operator?.openId ?? operator
      if (resolved.approvers.length > 0 && (!operatorId || !resolved.approvers.includes(operatorId))) {
        logger?.warn?.(`[feishu-card] refused a ${action.k} click from a non-approver (${operatorId})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
      if (typeof action.s !== 'string' || !sessions.serves(action.s)) {
        return { toast: { type: 'info', content: t.gone } }
      }
      const value = parseChoice(option, action)?.v
      if (typeof value !== 'string' || value.length === 0) {
        return { toast: { type: 'info', content: t.gone } }
      }
      try {
        if (action.k === 'preset') {
          const registry = ctx.get('agentPresets')
          if (!registry || typeof registry.select !== 'function') {
            return { toast: { type: 'warning', content: t.noService } }
          }
          // REMEMBERED, not applied: right after `/new` the session does not exist
          // yet, and the host only accepts a preset before its first turn — which is
          // when it is created. Applying here would fail for the only case this card
          // exists for.
          const key = sessions.keyOf(action.s)
          if (key === undefined) return { toast: { type: 'info', content: t.gone } }
          pendingPresets.set(key, value)
          const label = presetOptions(await registry.list(), resolved.locale)
            .find((entry) => entry.value === value)?.name ?? value
          logger.info(`[feishu-card] preset ${value} queued for ${action.s}`)
          const card = buildChoiceCard({
            title: t.presetTitle,
            lead: t.newLead(action.s),
            heading: t.newHeading,
            currentLabel: label,
            currentValue: value,
            placeholder: t.presetPlaceholder,
            options: [],
            behavior: {},
            settledText: t.newPicked(label),
            emptyText: '',
            settled: true,
          })
          return { toast: { type: 'success', content: t.toast(label) }, card: { type: 'raw', data: card } }
        }
        // Permissions are not deferred: they can be changed at any time, so the
        // session existing or not makes no difference to when they apply.
        const agent = await agentFor(action.s)
        if (!agent) return { toast: { type: 'warning', content: t.noService } }
        const service = ctx.get('permissionPresets')
        if (!service || typeof service.set !== 'function') {
          return { toast: { type: 'warning', content: t.noService } }
        }
        service.set(agent.session, value)
        const label = permissionOptions(service.catalog()).find((entry) => entry.value === value)?.name ?? value
        logger.info(`[feishu-card] permission switched to ${value} for ${action.s}`)
        const card = buildChoiceCard({
          title: t.permissionTitle,
          heading: t.permissionHeading,
          currentLabel: label,
          currentValue: value,
          placeholder: t.permissionPlaceholder,
          options: [],
          behavior: {},
          settledText: t.settledPermission(label),
          emptyText: '',
          settled: true,
        })
        return { toast: { type: 'success', content: t.toast(label) }, card: { type: 'raw', data: card } }
      } catch (error) {
        logger.warn(`[feishu-card] could not switch the ${action.k}`, error)
        return { toast: { type: 'error', content: t.toastFailed } }
      }
    }

    // An effort select carries its model in the behavior and its choice in the
    // option, so the two halves of the decision arrive together.
    if (action.k === 'effort') {
      const t = modelStrings(resolved.locale)
      const operatorId = operator?.openId ?? operator
      if (resolved.approvers.length > 0 && (!operatorId || !resolved.approvers.includes(operatorId))) {
        logger?.warn?.(`[feishu-card] refused an effort click from a non-approver (${operatorId})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
      if (typeof action.s !== 'string' || !sessions.serves(action.s)) {
        return { toast: { type: 'info', content: t.gone } }
      }
      const choice = parseChoice(option, action)
      const effort = choice?.e
      if (typeof action.p !== 'string' || typeof action.m !== 'string' || typeof effort !== 'string') {
        return { toast: { type: 'info', content: t.gone } }
      }
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.selectModel !== 'function') {
        return { toast: { type: 'warning', content: t.noController } }
      }
      try {
        const requested = { sessionId: action.s, provider: action.p, model: action.m }
        // An empty effort means "let the model default apply" — a real choice, so it
        // is sent as an explicit absence rather than dropped.
        if (effort !== '') requested.reasoningEffort = effort
        const value = await controller.selectModel(requested)
        const selected = value?.selected ?? requested
        const label = describeSelection(selected)
        logger.info(`[feishu-card] model switched to ${label} for ${action.s}`)
        const catalog = await readModelCatalog()
        const card = catalog
          ? buildModelCard({ catalog, current: selected, sessionId: action.s, locale: resolved.locale, settled: true })
          : undefined
        return card
          ? { toast: { type: 'success', content: t.toastSwitched(label) }, card: { type: 'raw', data: card } }
          : { toast: { type: 'success', content: t.toastSwitched(label) } }
      } catch (error) {
        logger.warn('[feishu-card] could not switch the reasoning effort', error)
        return { toast: { type: 'error', content: '切换失败，详见日志' } }
      }
    }

    // A session button is STATELESS too: it names the conversation by the session
    // that conversation is on, so no correlation entry is needed and the card stays
    // live for as long as it is in the chat.
    if (action.k === 'session') {
      const t = sessionStrings(resolved.locale)
      const operatorId = operator?.openId ?? operator
      if (resolved.approvers.length > 0 && (!operatorId || !resolved.approvers.includes(operatorId))) {
        logger?.warn?.(`[feishu-card] refused a session click from a non-approver (${operatorId})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
      const choice = parseChoice(option, action)
      const target = choice?.t ?? action.t
      const key = typeof action.s === 'string' ? sessions.keyOf(action.s) : undefined
      if (key === undefined || typeof target !== 'string') {
        return { toast: { type: 'info', content: t.gone } }
      }
      try {
        // Where this conversation already answers; the clicked card is not an anchor.
        const routing = sessions.routingFor(action.s) ?? { chatId, messageId }
        const result = await switchConversation(key, target, routing)
        const row = (await listSessions()).find((item) => item.sessionId === target)
        const label = row ? `${sessionLabel(row)} · \`${target}\`` : `\`${target}\``
        const card = buildSessionsCard({
          items: row ? [row] : [],
          total: 1,
          currentId: target,
          sessionId: target,
          locale: resolved.locale,
          settled: true,
        })
        return {
          toast: { type: 'success', content: result.unchanged ? t.already(label) : t.toastSwitched },
          card: { type: 'raw', data: card },
        }
      } catch (error) {
        logger.warn('[feishu-card] could not switch the conversation', error)
        return { toast: { type: 'error', content: t.toastFailed } }
      }
    }

    // A model button is STATELESS: it carries the session it applies to, so it
    // needs no correlation entry and stays live for as long as the card does. It
    // is handled before the lookup below, which would otherwise reject it.
    if (action.k === 'model') {
      const t = modelStrings(resolved.locale)
      const operatorId = operator?.openId ?? operator
      if (resolved.approvers.length > 0 && (!operatorId || !resolved.approvers.includes(operatorId))) {
        logger?.warn?.(`[feishu-card] refused a model click from a non-approver (${operatorId})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
      // The payload names a session, so it is only honoured for one this channel
      // owns — a card from elsewhere must not steer an arbitrary session.
      if (typeof action.s !== 'string' || !sessions.serves(action.s)) {
        return { toast: { type: 'info', content: '该操作已失效' } }
      }
      const controller = ctx.get('sessionController')
      if (!controller || typeof controller.selectModel !== 'function') {
        return { toast: { type: 'warning', content: t.noController } }
      }
      try {
        const choice = parseChoice(option, action)
        const provider = choice?.p ?? action.p
        const model = choice?.m ?? action.m
        if (typeof provider !== 'string' || typeof model !== 'string') {
          return { toast: { type: 'info', content: t.gone } }
        }
        const requested = { sessionId: action.s, provider, model }
        // A model that offers efforts leaves a decision this click did not make, so
        // the card becomes the effort picker rather than applying a default the user
        // never saw. Applying the model alone is not an option either: the session's
        // existing effort may not even be valid for it.
        const catalog = await readModelCatalog()
        const { efforts } = catalog ? effortsFor(catalog, provider, model) : { efforts: [] }
        if (efforts.length > 0) {
          const card = buildEffortCard({
            catalog,
            current: await currentSelectionFor(action.s),
            provider,
            model,
            sessionId: action.s,
            locale: resolved.locale,
          })
          return { card: { type: 'raw', data: card } }
        }
        const value = await controller.selectModel(requested)
        const selected = value?.selected ?? requested
        const label = describeSelection(selected)
        logger.info(`[feishu-card] model switched to ${label} for ${action.s}`)
        // Rewrite the picker so it shows the new state: a toast alone leaves the
        // card claiming the previous model, which reads as "the click did nothing".
        const card = await repaintModelCard({ messageId, sessionId: action.s, current: selected })
        return card
          ? { toast: { type: 'success', content: t.toastSwitched(label) }, card: { type: 'raw', data: card } }
          : { toast: { type: 'success', content: t.toastSwitched(label) } }
      } catch (error) {
        logger.warn('[feishu-card] could not switch the model', error)
        return { toast: { type: 'error', content: '切换失败，详见日志' } }
      }
    }

    const entry = pending.get(submitId ?? action.id)
    if (!entry) return { toast: { type: 'info', content: '该操作已失效' } }

    // A click is only honoured from the chat the card was sent to, and only
    // from a configured approver when one is configured.
    if (entry.chatId && chatId && chatId !== entry.chatId) {
      logger?.warn?.(`[feishu-card] refused a card click from another chat (${chatId})`)
      return { toast: { type: 'warning', content: '无权操作' } }
    }
    if (resolved.approvers.length > 0) {
      const id = operator?.openId ?? operator
      if (!id || !resolved.approvers.includes(id)) {
        logger?.warn?.(`[feishu-card] refused a card click from a non-approver (${id})`)
        return { toast: { type: 'warning', content: '无权操作' } }
      }
    }

    if (submitId !== undefined) {
      // The input's `name` is `custom`, so the typed answer arrives under it.
      const custom = (formValue?.custom ?? '').toString().trim()
      if (!custom) return { toast: { type: 'warning', content: '请输入内容' } }
      entry.settle({ kind: 'custom', custom, operator })
      return { toast: { type: 'success', content: '已提交' } }
    }
    if (action.k === 'goal') {
      const outcome = await applyGoalOperation(ctx, entry.sessionId, action, logger)
      if (outcome.goal) void progress.showGoal(entry.sessionId, { goal: outcome.goal })
      return { toast: { type: outcome.ok ? 'success' : 'warning', content: outcome.message } }
    }
    if (action.k === 'option') {
      entry.settle({ kind: 'option', value: action.v, operator })
      return { toast: { type: 'success', content: '已选择' } }
    }
    if (action.k === 'approve') {
      entry.settle({ kind: 'approve', operator })
      return { toast: { type: 'success', content: '已允许' } }
    }
    if (action.k === 'deny') {
      entry.settle({ kind: 'deny', operator })
      return { toast: { type: 'info', content: '已拒绝' } }
    }
    return { toast: { type: 'info', content: '未知操作' } }
  }

  /**
   * Show a decision card and wait for one click.
   *
   * The card is its own entity so the click can settle it in place, and so it
   * never contends for the streaming card's CardKit sequence.
   */
  async function askViaCard({
    sessionId,
    title,
    body,
    approveLabel,
    denyLabel,
    options,
    allowCustom,
    cardInput,
    kind,
    signal,
  }) {
    const routing = sessions.routingFor(sessionId)
    if (!routing) throw new Error('[feishu-card] no chat is bound to this session')

    const id = nextId()
    const interaction = { id, title, body, options, allowCustom, cardInput, approveLabel, denyLabel }

    // Prefer the turn's own card: an approval or a question belongs in the
    // conversation it interrupts, not in a second message the reader has to
    // correlate. `setInteraction` reports false when no card is live (a
    // between-turn question), and only then is a standalone card sent.
    const inCard = renderer.setInteraction(sessionId, interaction)
    let cardId
    if (!inCard) {
      cardId = await transport.createCard(buildDecisionCard(interaction))
      await transport.sendCard(cardId, {
        chatId: routing.chatId,
        replyToMessageId: routing.replyToMessageId,
      })
    }

    return await new Promise((resolve) => {
      let done = false
      const finish = (outcome) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(reminder)
        signal?.removeEventListener?.('abort', onAbort)
        pending.delete(id)
        if (pendingByChat.get(routing.chatId) === id) pendingByChat.delete(routing.chatId)

        const label =
          outcome.kind === 'approve' ? (approveLabel ?? '允许一次')
          : outcome.kind === 'deny' ? (denyLabel ?? '拒绝')
          : outcome.kind === 'option' ? `${outcome.value}`
          : outcome.kind === 'custom' ? `已回答：${outcome.custom}`
          : outcome.kind === 'timeout' ? '已超时'
          : '已取消'

        if (inCard) {
          // Leave the receipt where the buttons were, so the card reads as one
          // continuous record of what was asked and what was chosen.
          renderer.setInteraction(sessionId, { settled: true, label, operator: outcome.operator })
        } else {
          void transport
            .updateCard(cardId, {
              schema: '2.0',
              config: { update_multi: true, summary: { content: title } },
              header: { title: { tag: 'plain_text', content: title }, template: TEMPLATE.neutral },
              body: {
                elements: [
                  { tag: 'markdown', element_id: ELEMENTS.prompt, content: body },
                  ...settledDecisionElements({ label, operator: outcome.operator }),
                ],
              },
            })
            .catch((error) => logger?.warn?.('[feishu-card] settling a decision card failed', error))
            .finally(() => transport.releaseCard(cardId))
        }
        resolve(outcome)
      }

      const timer = setTimeout(() => finish({ kind: 'timeout' }), resolved.approvalTimeoutSec * 1000)
      timer.unref?.()
      // An unanswered decision blocks the turn, so a nudge keeps it visible.
      const reminder =
        resolved.approvalReminderMs > 0
          ? setTimeout(() => {
              if (!inCard) {
                void transport
                  .streamElement(cardId, ELEMENTS.prompt, `${body}\n\n_仍在等待你的选择…_`)
                  .catch(() => {})
                return
              }
              renderer.setInteraction(sessionId, {
                ...interaction,
                body: `${body}\n\n_仍在等待你的选择…_`,
              })
            }, resolved.approvalReminderMs)
          : undefined
      reminder?.unref?.()

      const onAbort = () => finish({ kind: 'cancelled' })
      if (signal?.aborted) {
        finish({ kind: 'cancelled' })
        return
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      pending.set(id, { settle: finish, chatId: routing.chatId, kind, sessionId })
      if (kind === 'question') pendingByChat.set(routing.chatId, id)
    })
  }

  if (resolved.notices) {
    // A failed model attempt. This is a waterfall the loop owns, so the listener
    // only observes and always delegates.
    ctx.on('agent/request-error', (payload, next) => {
      try {
        const sessionId = payload?.agent?.id
        if (sessionId && sessions.serves(sessionId)) {
          void notices.modelRetry(sessionId, payload.failure)
        }
      } catch (error) {
        logger?.warn?.('[feishu-card] reporting a model retry failed', error)
      }
      return next()
    })

    // A compaction whose summary failed. Synchronous waterfall: observe, delegate,
    // and let the awaiting `post` settle on its own.
    ctx.on('compaction/summary-error', (payload, next) => {
      try {
        const sessionId = payload?.session?.id
        if (sessionId && sessions.serves(sessionId)) {
          void notices.compactionFailed(sessionId, payload.error)
        }
      } catch (error) {
        logger?.warn?.('[feishu-card] reporting a compaction failure failed', error)
      }
      return next()
    })

    // Background jobs settle outside any turn, so this is the only way a chat
    // learns that one finished.
    try {
      const jobs = ctx.get('jobs')
      if (jobs?.events?.subscribe) {
        const disposer = jobs.events.subscribe({ owners: 'all' }, (event) => {
          if (event?.type !== 'settled') return
          const sessionId = event.job?.owner
          if (sessionId && sessions.serves(sessionId)) void notices.jobSettled(event.job)
        })
        ctx.effect(() => () => disposer())
      }
    } catch (error) {
      logger?.warn?.('[feishu-card] subscribing to job events failed', error)
    }
  }

  // --- host events: render the turn ---------------------------------------

  ctx.on('agent/assistant-stream', (payload) => {
    const sessionId = payload?.agent?.id
    if (!sessionId || !sessions.serves(sessionId)) return
    const frame = payload.frame
    if (!frame) return
    if (frame.type === 'start') {
      renderer.resetLive(sessionId)
      return
    }
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk?.type === 'text-delta') renderer.addLiveAnswer(sessionId, chunk.text)
    else if (chunk?.type === 'reasoning-delta') {
      if (resolved.showProcess) renderer.addLiveReasoning(sessionId, chunk.text)
    }
  })

  /**
   * Install this channel's tool guard on one agent.
   *
   * Registered on BOTH `agent/created` and the post-reach hook. The event alone is
   * not sufficient: a session restored from disk rather than newly created may
   * never announce itself that way, and a guard that silently does not apply is
   * worse than none — the operator believes the tool is blocked.
   *
   * Idempotent per AGENT INSTANCE (a WeakSet, not the session id): a session can
   * outlive one agent and be resumed by another, which must be guarded too.
   */
  const guarded = new WeakSet()
  const ensureToolGuard = (agent) => {
    if (!agent?.ctx || guarded.has(agent)) return
    guarded.add(agent)
    const disposers = []
    const guardDispose = installToolGuard(agent, resolved.denyTools, logger)
    if (guardDispose) disposers.push(guardDispose)
    const toolDispose = registerFileTool(agent)
    if (toolDispose) disposers.push(toolDispose)
    if (disposers.length > 0) agentRegistrations.set(agent.id, disposers)
  }

  /**
   * Give this agent the ability to send a file back to its chat.
   *
   * Registered on the agent's own context, so it unwinds with the agent, and
   * idempotent per agent instance for the same reason the guard is.
   */
  const registeredTools = new WeakSet()
  const registerFileTool = (agent) => {
    if (!agent?.ctx || registeredTools.has(agent) || !resolved.fileOutput) return undefined
    registeredTools.add(agent)
    const tools = agent.ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') {
      logger.warn('[feishu-card] the tool registry is unavailable; send_file is NOT registered')
      return undefined
    }
    return agent.ctx.effect(() => {
      const dispose = tools.register(
        buildSendFileTool({
          resolve: (path) => resolveSendablePath(path, {
            cwd: resolved.cwd,
            allowedDirs: resolved.allowedFileDirs,
            maxBytes: resolved.maxFileBytes,
          }),
          send: async ({ bytes, name, caption }) => {
            const routing = sessions.routingFor(agent.id)
            if (!routing?.chatId) throw new Error('这个会话没有可发送的目标聊天')
            const fileKey = await transport.uploadFile(bytes, name)
            const messageId = await transport.sendFile({
              chatId: routing.chatId,
              fileKey,
              replyToMessageId: routing.replyToMessageId,
            })
            if (caption) {
              await transport.sendText(caption, {
                chatId: routing.chatId,
                replyToMessageId: routing.replyToMessageId,
              })
            }
            return { messageId }
          },
          logger,
        }),
      )
      logger.info(`[feishu-card] send_file registered for ${agent.id} (workspace ${resolved.cwd})`)
      return () => {
        try {
          dispose()
        } catch {
          // Already unwound with the agent.
        }
      }
    })
  }

  /**
   * Reconcile Feishu's slash-command picker with what this bot actually answers.
   *
   * Runs as soon as the plugin has a session to ask about — which includes
   * startup, because adopting an existing session reaches the same hook without an
   * agent yet, and the host's registry answers the global layer for that. Once per
   * process is enough: the set only changes when the deployment does.
   *
   * A failure resets the latch so the next session retries, rather than leaving the
   * panel wrong for the lifetime of the process.
   *
   * This is what stops the picker from lying. The commands it listed before came
   * from a plugin that had since been uninstalled, so half of them answered
   * "unknown command" — the panel advertised capability that was gone.
   */
  let panelSynced = false
  const syncCommandPanel = async (agent) => {
    if (panelSynced || !resolved.commandPanel) return
    panelSynced = true
    try {
      const registry = ctx.get('commands')
      const hostCommands = registry && typeof registry.list === 'function' ? registry.list(agent) : []
      const desired = desiredPanelEntries({ hostCommands })
      const plan = planPanelSync({ existing: await transport.listSlashCommands(), desired })
      const done = await applyPanelSync(plan, transport, logger)
      logger.info(
        `[feishu-card] slash-command panel synced: +${done.created} ~${done.updated} -${done.removed}`
          + `${done.failed ? ` (${done.failed} failed)` : ''}`,
      )
    } catch (error) {
      // Retry on the next message rather than staying out of sync for the process.
      panelSynced = false
      logger.warn('[feishu-card] could not sync the slash-command panel', error)
    }
  }

  /**
   * The model this session is currently on, or `undefined` when it never chose one.
   *
   * Read from the session projection rather than cached: the Web UI can change the
   * model too, and a cache would then disagree with the harness about what is
   * running. `undefined` is meaningful — the session is on the deployment default.
   */
  const currentModelSelection = (agent) => {
    const projections = ctx.get('sessionProjections')
    const session = agent?.session
    if (!projections || !session) return undefined
    try {
      return projections.stateOf(session, 'modelSelection')?.lastUsed ?? undefined
    } catch (error) {
      logger.warn('[feishu-card] could not read the model projection', error)
      return undefined
    }
  }

  /**
   * Redraw a model picker after its selection changed.
   *
   * Failures are logged, never surfaced as the action's outcome: the model DID
   * change, and reporting a repaint problem as a failed switch would be a lie.
   */
  const repaintModelCard = async ({ messageId, sessionId, current }) => {
    const catalog = await readModelCatalog()
    if (!catalog) return undefined
    const card = buildModelCard({ catalog, current, sessionId, locale: resolved.locale, settled: true })
    // Two routes to the same place, because only one of them is guaranteed:
    // returning the card in the callback response is what the platform documents
    // for a button click, and patching the message works even where that is
    // ignored. Both carry identical content, so applying both is harmless.
    if (messageId) {
      try {
        await transport.updateCardMessage(messageId, card)
      } catch (error) {
        logger.warn('[feishu-card] could not patch the model picker message', error)
      }
    }
    return card
  }

  /**
   * How many turns each session still owes to a message that arrived HERE.
   *
   * A chat should show what was said in the chat. Once a conversation can be bound
   * to a session another frontend also uses (see `/sessions`), "render every turn in
   * a served session" starts broadcasting Web-GUI conversations into a group chat —
   * a surprise the user never asked for, and one they cannot see is happening.
   *
   * Counted rather than flagged because a message admitted during a running turn is
   * queued: it owes a turn of its own, and that turn starts only after the current
   * one ends. A flag cleared at `turn/end` would lose it.
   */
  const channelTurns = new Map()

  /**
   * Read a select's choice.
   *
   * The option value is JSON because a select reports only one string: the intent
   * (which model, which effort, which session) has to travel inside it, while the
   * behavior value stays a constant marker for the card.
   *
   * @returns the parsed payload, or undefined when the value is absent or not JSON.
   */
  const parseChoice = (raw, action) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      // A select whose choice cannot be read looks exactly like a click that did
      // nothing, so record what DID arrive: the field name is the whole question.
      if (action && (action.k === 'model' || action.k === 'effort' || action.k === 'session')) {
        logger.warn(
          `[feishu-card] select action without an option (k=${action.k}, fields=${Object.keys(action).join(',')})`,
        )
      }
      return undefined
    }
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : undefined
    } catch {
      // Worth a line: a platform that reports the choice some other way would
      // otherwise look exactly like a click that did nothing.
      logger.warn(`[feishu-card] unreadable select option: ${raw.slice(0, 120)}`)
      return undefined
    }
  }

  /**
   * The agent for a session id, for the card actions that carry no agent.
   *
   * Cheap for a bound conversation: the session is already live, so this is a
   * lookup rather than a resume.
   */
  const agentFor = async (sessionId) => {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return undefined
    try {
      const result = await controller.resolveAgent(sessionId)
      return result?.agent
    } catch (error) {
      logger.warn('[feishu-card] could not resolve the session agent', error)
      return undefined
    }
  }

  /** A choice's display name, for the confirmation text. */
  const choiceLabel = async (kind, value, locale) => {
    const t = presetStrings(locale)
    try {
      if (kind === 'preset') {
        const registry = ctx.get('agentPresets')
        const found = presetOptions(await registry?.list?.() ?? []).find((option) => option.value === value)
        return found?.name ?? value
      }
      const service = ctx.get('permissionPresets')
      return permissionOptions(service?.catalog?.()).find((option) => option.value === value)?.name ?? value
    } catch {
      return value || t.unknownPreset
    }
  }

  /**
   * The preset each freshly rotated conversation should start with.
   *
   * `/new` cannot apply it: the session does not exist until the next message reaches
   * the ladder, and the host only accepts a preset before a session's first turn —
   * which is exactly then. So the choice is remembered and applied at creation.
   */
  const pendingPresets = new Map()

  /** Apply a remembered preset to a session that has not started yet. */
  const applyPendingPreset = async (key, agent) => {
    const wanted = pendingPresets.get(key)
    if (wanted === undefined) return
    const registry = ctx.get('agentPresets')
    if (!registry || typeof registry.select !== 'function') {
      pendingPresets.delete(key)
      return
    }
    // Cleared either way: a session that already ran cannot take one, and retrying
    // on every message would keep attempting the impossible.
    pendingPresets.delete(key)
    if (agentPresetLocked(agent)) return
    try {
      await registry.select(agent, wanted)
      logger.info(`[feishu-card] session ${agent.id} started with preset ${wanted}`)
    } catch (error) {
      logger.warn(`[feishu-card] could not apply the preset ${wanted}`, error)
    }
  }

  /** Whether this session has already run a turn, which locks its agent preset. */
  const agentPresetLocked = (agent) => {
    const projections = ctx.get('sessionProjections')
    if (!projections || !agent?.session) return false
    try {
      return presetLocked(projections.stateOf(agent.session, 'turnBoundary'))
    } catch (error) {
      logger.warn('[feishu-card] could not read the turn boundary', error)
      return false
    }
  }

  /** The session's current agent preset id, or undefined. */
  const currentPreset = (agent) => {
    const projections = ctx.get('sessionProjections')
    if (!projections || !agent?.session) return undefined
    try {
      return projections.stateOf(agent.session, 'agentPreset') ?? undefined
    } catch {
      return undefined
    }
  }

  /** Every visible session row, newest first (the host orders them by activity). */
  const listSessions = async () => {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.list !== 'function') return []
    try {
      const page = await controller.list({}, lifetime.signal)
      return page?.items ?? []
    } catch (error) {
      logger.warn('[feishu-card] could not list sessions', error)
      return []
    }
  }

  /**
   * Move a conversation onto another session.
   *
   * `/new` mints an id and is a one-way door; this adopts one that already exists,
   * so a conversation can go back to an earlier session or continue one that began
   * in the Web UI.
   *
   * The per-session accumulators of the session being LEFT are dropped: that
   * session is no longer served here, and leaving them would leak until unload.
   * The target's are deliberately NOT touched — it may be live in another chat.
   */
  const switchConversation = async (key, target, routing) => {
    const previous = sessions.idFor(key)
    if (previous === target) return { unchanged: true }
    progress.forget(previous)
    notices.forget(previous)
    fanout.forget(previous)
    await sessions.use(key, target)
    // Keep answering where the conversation already answered, rather than to the
    // card that happened to be clicked.
    sessions.bind(key, routing)
    logger.info(`[feishu-card] conversation moved from ${previous} to ${target}`)
    return { previous }
  }

  /**
   * The current model selection of a session, resolved from its id.
   *
   * The card action carries a session id, not an agent, and the picker needs the
   * live selection to mark the active effort. `resolveAgent` is cheap here: the
   * conversation is bound, so the session is already live.
   */
  const currentSelectionFor = async (sessionId) => {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return undefined
    try {
      const result = await controller.resolveAgent(sessionId)
      return result?.agent ? currentModelSelection(result.agent) : undefined
    } catch (error) {
      logger.warn('[feishu-card] could not resolve the session for its model selection', error)
      return undefined
    }
  }

  /** The host's model catalogue, or `undefined` when this deployment has none. */
  const readModelCatalog = async () => {
    const controller = ctx.get('sessionController')
    if (!controller || typeof controller.modelCatalog !== 'function') return undefined
    return controller.modelCatalog()
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (!agent || !sessions.serves(agent.id)) return
    ensureToolGuard(agent)
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId || !sessions.serves(sessionId)) return
    const data = event?.data

    switch (event.type) {
      case 'turn/start': {
        void reactions.show(sessions.routingFor(sessionId)?.messageId, 'working')
        renderer.setStatus(sessionId, { title: 'DSH · 思考中', template: TEMPLATE.running })
        renderer.setSubtitle(sessionId, '')
        renderer.resetLive(sessionId)
        if (!renderer.has(sessionId) && (channelTurns.get(sessionId) ?? 0) > 0) {
          const routing = sessions.routingFor(sessionId)
          if (routing) {
            void renderer
              .begin(sessionId, {
                chatId: routing.chatId,
                replyToMessageId: routing.replyToMessageId,
                title: 'DSH · 思考中',
              })
              .catch((error) => logger?.warn?.('[feishu-card] opening a card failed', error))
          }
        }
        break
      }

      case 'tool/call': {
        if (!resolved.showProcess) break
        const name = data?.name ?? 'tool'
        const phrase = describeCall(name, data?.arguments)
        renderer.addActivity(sessionId, phrase, true)
        renderer.setSubtitle(sessionId, phrase)
        const diff = describeDiff(name, data?.arguments)
        if (diff) renderer.addActivity(sessionId, diff)
        break
      }

      case 'tool/result': {
        if (!resolved.showProcess) break
        const error = data?.error
        if (error) {
          const reason = error.reason ? ` · ${error.reason}` : ''
          renderer.addActivity(sessionId, `⚠️ 失败${reason}`)
          renderer.setSubtitle(sessionId, `⚠️ ${error.name ?? 'tool'} 失败`)
        }
        break
      }

      case 'tool-workflow/run-start':
      case 'tool-workflow/agent-start':
      case 'tool-workflow/agent-end':
      case 'tool-workflow/run-end':
      case 'subagent/descriptor': {
        for (const line of fanout.lines(sessionId, event.type, data)) {
          renderer.addActivity(sessionId, line)
        }
        break
      }

      case 'todo/write': {
        void progress.showTodos(sessionId, data?.todos)
        break
      }

      case 'goal/change': {
        // A clear tombstone carries no snapshot: leave the last card as history.
        void progress.showGoal(sessionId, data)
        break
      }

      case 'request/context': {
        if (Number.isFinite(data?.contextWindow)) contextWindows.set(sessionId, data.contextWindow)
        break
      }

      case 'assistant/message': {
        renderer.commitAssistant(sessionId, readAssistantContent(data?.message))
        const source = data?.message?.source
        renderer.setUsage(sessionId, {
          model: source?.model ?? source?.provider,
          usage: data?.usage,
        })
        // A committed message means the request eventually succeeded.
        notices.clearRetries(sessionId)
        if (resolved.notices && data?.usage?.inputTokens) {
          void notices.contextUsage(sessionId, {
            inputTokens: data.usage.inputTokens,
            contextWindow: contextWindows.get(sessionId),
          })
        }
        renderer.setSubtitle(sessionId, '正在整理回答…')
        break
      }

      case 'turn/end': {
        // This turn's debt to a message from this chat is settled, whatever its
        // outcome: a turn ends exactly once, including when it fails or is aborted.
        const owed = channelTurns.get(sessionId) ?? 0
        if (owed <= 1) channelTurns.delete(sessionId)
        else channelTurns.set(sessionId, owed - 1)
        const kind = data?.reason?.kind
        const failed = kind === 'error' || kind === 'aborted' || kind === 'interrupted'
        const state = renderer.get(sessionId)
        const elapsed = state ? formatDuration(Date.now() - state.startedAt) : undefined
        const toolCount = state?.toolCount ?? 0
        if (state && !state.answer.trim() && !failed) {
          renderer.addActivity(sessionId, '（本轮没有产生输出）')
        }
        const footerParts = []
        if (elapsed) footerParts.push(`⏱ ${elapsed}`)
        if (toolCount > 0) footerParts.push(`🔧 ${toolCount}`)
        if (state?.model) footerParts.push(`🤖 ${state.model}`)
        const input = formatTokens(state?.usage?.inputTokens)
        const output = formatTokens(state?.usage?.outputTokens)
        if (input || output) footerParts.push(`↑${input ?? 0} ↓${output ?? 0}`)
        void reactions.show(
          sessions.routingFor(sessionId)?.messageId,
          failed ? 'fail' : 'done',
        )
        renderer.setSubtitle(sessionId, '')
        renderer
          .finish(sessionId, {
            title: failed ? `DSH · ${kind === 'aborted' ? '已中断' : '失败'}` : 'DSH · 已完成',
            template: failed ? TEMPLATE.failed : TEMPLATE.done,
            footer: footerParts.join('　'),
          })
          .catch((error) => logger?.warn?.('[feishu-card] finishing a card failed', error))
        break
      }

      default:
        break
    }
  })

  // --- host waterfalls: answer approval and questions with card buttons ----

  ctx.on(
    'approval/request',
    async (req, next) => {
      const sessionId = req?.agent?.id
      if (!sessionId || !sessions.serves(sessionId)) return next()
      const reason = req.displayReason?.zh_cn ?? req.displayReason?.en ?? req.reason ?? '此操作需要授权。'
      try {
        const outcome = await askViaCard({
          sessionId,
          kind: 'approval',
          title: '需要授权',
          body: `**工具**：\`${req.toolName}\`\n\n${reason}`,
          approveLabel: '允许一次',
          denyLabel: '拒绝',
          signal: req.signal,
        })
        if (outcome.kind === 'approve') return 'allowed-once'
        if (outcome.kind === 'deny') return 'rejected'
        return 'cancelled'
      } catch (error) {
        logger?.warn?.('[feishu-card] approval card failed; deferring to other answerers', error)
        return next()
      }
    },
    { prepend: true },
  )

  ctx.on(
    'user-questions/request',
    async (request, next) => {
      const sessionId = request?.agent?.id
      if (!sessionId || !sessions.serves(sessionId)) return next()
      const questions = request.questions ?? []
      if (questions.length === 0) return next()
      try {
        const answers = []
        for (const question of questions) {
          const options = question.options ?? []
          const lines = [question.question]
          if (question.detail) lines.push('', question.detail)
          if (question.multiSelect && options.length > 0) {
            lines.push('', '**可多选** — 请在下方输入框填写选项（逗号分隔）：')
            lines.push(...options.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ''}`))
          }
          const outcome = await askViaCard({
            sessionId,
            title: question.header || '请选择',
            body: lines.join('\n'),
            options: question.multiSelect ? [] : options.map((o) => ({ label: o.label, value: o.label })),
            allowCustom: true,
            cardInput: resolved.cardInput,
            kind: 'question',
            signal: request.signal,
          })
          if (outcome.kind === 'cancelled' || outcome.kind === 'timeout') return { answers: [] }
          if (outcome.kind === 'deny') {
            answers.push({ id: question.id, selected: [] })
            continue
          }
          const selected =
            outcome.kind === 'custom'
              ? outcome.custom.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
              : outcome.kind === 'option'
                ? [outcome.value]
                : []
          answers.push({ id: question.id, selected })
        }
        return { answers }
      } catch (error) {
        logger?.warn?.('[feishu-card] question card failed; deferring to other answerers', error)
        return next()
      }
    },
    { prepend: true },
  )

  // --- lifecycle ----------------------------------------------------------

  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    // Cancels any in-flight prompt admission or command execution.
    lifetime.abort()
    return (async () => {
      for (const entry of pending.values()) entry.settle({ kind: 'cancelled' })
      pending.clear()
      for (const dispose of agentRegistrations.values()) {
        try {
          await dispose()
        } catch {
          // Already unwound with its agent.
        }
      }
      agentRegistrations.clear()
      reactions.dispose()
      notices.dispose()
      progress.dispose()
      fanout.dispose()
      await renderer.dispose()
      await transport.stop()
    })()
  })

  /**
   * Re-read this plugin's settings from the live config.
   *
   * Reading back is the ONLY reliable way to see a Settings-page edit, and the
   * reason is worth recording: the config editor resolves the new values straight
   * into the live config references (`resolveConfig(fiber.runtime, resolved)`)
   * BEFORE it reconciles the Loader, so by the time the Loader diffs the config
   * nothing looks changed and `loader/volatile-update` never fires. A plugin that
   * only listens for that event keeps serving the old values while the page shows
   * the new ones — the settings look applied and are not.
   *
   * Called before each inbound message as well as on the events that do fire, so
   * correctness does not depend on any notification arriving at all.
   *
   * @returns whether anything actually changed.
   */
  const refreshSettings = (why) => {
    // NEVER throws. This runs on the path that handles an inbound message, and a
    // failure here is not a settings problem — it is every message being dropped.
    // (It has already happened once: reading `ctx.config` without declaring it in
    // `inject` throws, and that killed every message with one log line.)
    try {
      // The `config` argument, NOT `ctx.config`: Cordis throws
      // "cannot get property \"config\" without inject" for a plugin that did not
      // declare it, and the apply argument is the same object the loader mutates
      // for volatile fields anyway.
      // Layered exactly like the initial resolve: the config, over the stored app,
      // over the workspace we already resolved. Replacing `resolved` wholesale
      // would drop the two values the config does not carry.
      const next = withStoredCredentials(resolveConfig(config), storedCredentials)
      // `next.cwd` is the CONFIGURED value; the resolved workspace is ours to keep.
      const candidate = { ...next, cwd: resolved.cwd }
      if (JSON.stringify(candidate) === JSON.stringify(resolved)) return false
      const previous = resolved
      resolved = candidate
      const changed = Object.keys(candidate)
        .filter((key) => JSON.stringify(candidate[key]) !== JSON.stringify(previous[key]))
      logger.info(`[feishu-card] settings applied live (${why}): ${changed.join(', ')}`)
      if (next.appId !== previous.appId
        || next.appSecret !== previous.appSecret
        || next.domain !== previous.domain) {
        // The long connection was opened with the previous app, so it must be rebuilt.
        void reconnect()
      } else if (next.cwd !== configuredCwd) {
        void remountWorkspace(next.cwd)
      }
      return true
    } catch (error) {
      logger.warn('[feishu-card] could not re-read settings; keeping the current values', error)
      return false
    }
  }

  // External edits (the patch file, HMR) do announce themselves.
  ctx.on('loader/volatile-update', () => refreshSettings('volatile update'))
  // A Settings-page save does not, but the settings service does report the
  // document change; listening on the root is what reaches it, since the settings
  // context is a sibling of ours rather than an ancestor.
  ctx.root.on('settings/document-updated', (id) => {
    if (id === SETTINGS_NAMESPACE) refreshSettings('settings page')
  })

  /** Re-point the workspace new conversations start in, after a live `cwd` change. */
  async function remountWorkspace(rawCwd) {
    try {
      const workspace = await resolveWorkspaceCwd(ctx, rawCwd, logger)
      configuredCwd = rawCwd
      resolved = { ...resolved, cwd: workspace }
      // Rebuilt rather than mutated: the filer caches the workspace it resolved.
      fileSession = makeWorkspaceFiler(ctx, workspace, logger)
      logger.info(`[feishu-card] new conversations now start in ${workspace}`)
    } catch (error) {
      logger.warn('[feishu-card] could not switch the workspace', error)
    }
  }

  /** Rebuild the long connection after a live credential change. */
  async function reconnect() {
    if (!hasCredentials(resolved)) {
      // Nothing to connect with; dropping the live connection here would turn a
      // settings edit into an outage.
      logger.warn('[feishu-card] not reconnecting: no usable credentials')
      return
    }
    try {
      await transport.stop()
      transport.updateCredentials({
        appId: resolved.appId,
        appSecret: resolved.appSecret,
        domain: resolved.domain || undefined,
      })
      await startChannel()
    } catch (error) {
      logger.warn('[feishu-card] could not reconnect with the new credentials', error)
    }
  }

  if (hasCredentials(resolved)) {
    await startChannel()
    return
  }

  if (!resolved.onboarding) {
    logger?.warn?.(
      '[feishu-card] inactive: no Feishu credentials and onboarding is disabled. Set appId / appSecret (or FEISHU_APP_ID / FEISHU_APP_SECRET).',
    )
    return
  }

  // No credentials and none stored: register an app by QR.
  //
  // This is deliberately NOT awaited. The QR flow polls until someone scans, so
  // awaiting it would hold the plugin's activation open indefinitely. It runs as
  // a background task tied to the plugin's lifetime instead.
  logger?.info?.('[feishu-card] 未找到飞书凭据，开始二维码注册流程…')
  void beginOnboarding({
    registerApp: (options) => registerApp(options),
    store,
    dir: stateDir,
    logger,
  })
    .then(async (onboarded) => {
      if (!onboarded) {
        if (!disposed) logger?.warn?.('[feishu-card] onboarding did not complete; the plugin stays inert')
        return
      }
      if (disposed) return
      storedCredentials = { appId: onboarded.appId, appSecret: onboarded.appSecret }
      resolved = { ...resolved, appId: onboarded.appId, appSecret: onboarded.appSecret }
      transport.updateCredentials({ appId: onboarded.appId, appSecret: onboarded.appSecret })
      await startChannel()
    })
    .catch((error) => logger?.error?.('[feishu-card] onboarding failed; the plugin stays inert', error))

  /** Open the long connection and report the outcome. */
  async function startChannel() {
    try {
      await transport.start({
        onMessage,
        onCardAction,
        onReady: () => logger?.info?.('[feishu-card] connected to Feishu'),
        onError: (error) => logger?.warn?.('[feishu-card] Feishu connection error', error),
      })
      if (disposed) {
        await transport.stop()
        return
      }
      logger?.info?.(`[feishu-card] active (sessionScope=${resolved.sessionScope}, cwd=${resolved.cwd})`)
    } catch (error) {
      logger?.error?.('[feishu-card] could not open the Feishu connection; the plugin stays inert', error)
    }
  }
}

/**
 * Directories owned by the harness itself, which a chat-driven agent must never
 * be pointed at by default.
 *
 * `workspaceRegistry.list()` ordering is not the registration order — in this
 * deployment its first entry is the runtime install directory — so "the first
 * workspace" is not a safe default. The roots come from the running CLI path and
 * the DSH environment instead.
 */
function harnessRoots() {
  const roots = new Set()
  for (const value of [process.env.DSH_HOME, process.env.DSH_PROFILE_DIR]) {
    if (value) roots.add(value)
  }
  const argv1 = process.argv[1]
  if (argv1) {
    const marker = `${sep}node_modules${sep}`
    const index = argv1.indexOf(marker)
    roots.add(index > 0 ? argv1.slice(0, index) : dirname(argv1))
  }
  return [...roots]
}

/** Whether `candidate` is `root` itself or lives beneath it. */
function isInside(candidate, root) {
  const base = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(base)
}

/**
 * Resolve the working directory a new conversation starts in.
 *
 * A configured `cwd` always wins. Otherwise the first registered workspace the
 * harness does not own is used, because silently pointing a coding agent at the
 * running harness is exactly the default that becomes an accidental self-edit.
 */
async function resolveWorkspaceCwd(ctx, configured, logger) {
  if (configured) return configured
  let workspaces = []
  try {
    workspaces = [...(ctx.get('workspaceRegistry')?.list?.() ?? [])]
  } catch (error) {
    logger?.warn?.('[feishu-card] listing workspaces failed', error)
  }
  const roots = harnessRoots()
  const usable = workspaces.filter((w) => w?.path && !roots.some((root) => isInside(w.path, root)))
  if (usable.length > 0) {
    if (usable.length > 1) {
      logger?.info?.(
        `[feishu-card] ${usable.length} usable workspaces; using "${usable[0].title ?? usable[0].path}". Set \`cwd\` to pin another.`,
      )
    } else {
      logger?.info?.(`[feishu-card] using workspace as cwd: ${usable[0].path}`)
    }
    return usable[0].path
  }
  const fallback = process.cwd()
  logger?.warn?.(
    `[feishu-card] no workspace outside the harness directories was found; using ${fallback}. `
      + 'Set `cwd` in the plugin config to choose a real working directory.',
  )
  return fallback
}

/**
 * Apply one goal-card button.
 *
 * The card is a projection of durable state, so the click performs the real
 * mutation through the goal service and the refreshed snapshot is re-published
 * from its return value rather than being edited locally.
 */
async function applyGoalOperation(ctx, sessionId, action, logger) {
  const operation = { pause: 'pause', resume: 'resume', clear: 'clear' }[action.op]
  if (!operation) return { ok: false, message: '未知操作' }
  const goals = ctx.get('goals')
  const agent = ctx.get('agents')?.get(sessionId)
  if (!goals || !agent) return { ok: false, message: '目标服务不可用' }
  try {
    const ref = { id: action.id, revision: action.revision }
    if (operation === 'clear') {
      goals.clear(agent, ref)
      return { ok: true, message: '已清除目标' }
    }
    const goal = goals[operation](agent, ref)
    return { ok: true, message: operation === 'pause' ? '已暂停目标' : '已继续目标', goal }
  } catch (error) {
    logger?.warn?.('[feishu-card] a goal card action failed', error)
    return { ok: false, message: `操作失败：${error?.message ?? error}` }
  }
}

/** Re-arm a goal the harness disarmed while the conversation was idle. */
function resumeGoalIfNeeded(ctx, agent, logger) {
  try {
    const goals = ctx.get('goals')
    const view = goals?.get?.(agent)
    if (view && view.activation === 'disarmed' && view.phase === 'active') {
      goals.resume(agent, { id: view.id, revision: view.revision })
    }
  } catch (error) {
    logger?.warn?.('[feishu-card] auto-resuming a goal failed', error)
  }
}

/** Dynamic import so the SDK stays resolvable even if the module is pruned. */
async function registerApp(options) {
  const sdk = await import('@larksuiteoapi/node-sdk')
  return sdk.registerApp(options)
}
