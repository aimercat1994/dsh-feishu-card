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

import { Config, hasCredentials, resolveConfig } from './lib/config.js'
import { FeishuTransport, readCardAction, readInboundMessage } from './lib/feishu.js'
import { TurnRenderer } from './lib/turn.js'
import { ConversationSessions, conversationKey, makeWorkspaceFiler } from './lib/session.js'
import { CredentialStore, beginOnboarding, resolveStateDir } from './lib/onboarding.js'
import { commandName, helpText, isCommandLine, runCommandLine, strings } from './lib/commands.js'
import { createLogger } from './lib/log.js'
import { ReactionTracker } from './lib/react.js'
import { Notices } from './lib/notice.js'
import { ProgressCards } from './lib/progress.js'
import { Fanout } from './lib/fanout.js'
import { installToolGuard } from './lib/guard.js'
import { admit, isPolicyDrop } from './lib/access.js'
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
  const cwd = await resolveWorkspaceCwd(ctx, resolved.cwd, logger)
  resolved = { ...resolved, cwd }

  // Credentials: entry config (patch/env) wins, then the stored app, then the
  // QR flow. A half-configured pair is treated as unconfigured.
  if (!hasCredentials(resolved)) {
    const stored = await store.load()
    if (stored) {
      resolved = {
        ...resolved,
        appId: stored.appId,
        appSecret: stored.appSecret,
        domain: stored.domain || resolved.domain,
      }
    }
  }

  // Every host call that takes a cancellation signal gets this one. Omitting it
  // is NOT "no cancellation": the Remote implementations call
  // `signal.throwIfAborted()`, so `undefined` fails the entire call.
  const lifetime = new AbortController()

  // Built once: the filer caches the workspace lookup and the sessions it has
  // already attached, so a per-call instance would redo both every message.
  const fileSession = makeWorkspaceFiler(ctx, resolved.cwd, logger)
  const sessions = new ConversationSessions({
    sessionController: ctx.sessionController,
    cwd: resolved.cwd,
    stateDir,
    logger,
    onSession: async (sessionId, agent) => {
      // Both ladder rungs land here, so this is where per-agent setup belongs.
      ensureToolGuard(agent)
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
  const agentRegistrations = new Map()
  let counter = 0
  const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

  // --- inbound: a Feishu message drives one conversation -------------------

  async function onMessage(data) {
    const inbound = readInboundMessage(data)
    if (!inbound) return

    const text = stripMentionPlaceholders(inbound.text)
    const decision = admit(inbound, resolved, text)
    if (!decision.allow) {
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
        const name = commandName(text)
        let reply
        if (name === 'new') {
          // Rotating the session orphans every per-session structure keyed by the
          // old id, so they are dropped with it rather than leaking until unload.
          const previous = sessions.idFor(key)
          progress.forget(previous)
          notices.forget(previous)
          fanout.forget(previous)
          const rotated = await sessions.rotate(key)
          reply = { text: `${t.newSession}\n\n\`${rotated}\`` }
        } else if (name === 'status') {
          reply = {
            text: `\`${sessionId}\`\n卡片：${renderer.has(sessionId) ? t.statusBusy : t.statusIdle}`,
          }
        } else if (name === 'help') {
          reply = { text: await helpText({ commands: ctx.get('commands'), agent, locale: resolved.locale, logger }) }
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
            title: name === 'help' ? 'DSH · 帮助' : `DSH · /${name}`,
            template: reply.error ? TEMPLATE.failed : TEMPLATE.neutral,
            body: reply.text,
          }),
          { chatId: inbound.chatId, replyToMessageId: inbound.messageId },
        )
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

      await ctx.sessionController.prompt(
        {
          requestId: nextId(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        lifetime.signal,
      )
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
    const { action, name, operator, formValue, chatId } = readCardAction(data)

    // A form submit carries the submit button's `name` and the form's values, not
    // a callback `value` — so the correlation id is recovered from the name.
    const submitId =
      typeof name === 'string' && name.startsWith(CUSTOM_SUBMIT_PREFIX)
        ? name.slice(CUSTOM_SUBMIT_PREFIX.length)
        : undefined
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
    const dispose = installToolGuard(agent, resolved.denyTools, logger)
    if (dispose) agentRegistrations.set(agent.id, dispose)
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
        if (!renderer.has(sessionId)) {
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
