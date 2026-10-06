/**
 * Conversation identity: one chat facet maps to one durable DSH session.
 *
 * Durability comes from the host, not from a plugin file. The session id is a
 * pure function of the chat facet (`feishu-<key>`), so after a restart the
 * plugin derives the same id and the host's own session store supplies the
 * history. The plugin keeps only routing (which chat to answer in), which is
 * process-local and rebuilt from the next inbound message.
 *
 * The id function must stay injective: two different facets must never collide,
 * which is why the key parts are colon-joined and the `feishu-` prefix is
 * reserved for this plugin.
 *
 * @module dsh-feishu-card/session
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Compose the conversation key for one inbound message under the chosen scope.
 *
 * Parts are percent-encoded before joining: a bare `chatId + ':' + threadId`
 * would let `{chatId:'a:b', threadId:'c'}` and `{chatId:'a', threadId:'b:c'}`
 * collapse onto one session id. Feishu ids never contain a colon today, but an
 * id collision silently merges two conversations, so the separator is escaped
 * rather than trusted.
 */
export function conversationKey(scope, inbound) {
  const part = (value) => encodeURIComponent(value)
  switch (scope) {
    case 'chat-thread':
      return inbound.threadId ? `${part(inbound.chatId)}:${part(inbound.threadId)}` : part(inbound.chatId)
    case 'chat-sender':
      return inbound.senderId ? `${part(inbound.chatId)}:${part(inbound.senderId)}` : part(inbound.chatId)
    default:
      return part(inbound.chatId)
  }
}

/** The reserved session id for one conversation key. */
export function sessionIdFor(key) {
  return `feishu-${key}`
}

/** Where a session's output goes. Process-local; rebuilt per inbound message. */
function routingOf(inbound) {
  return {
    chatId: inbound.chatId,
    threadId: inbound.threadId,
    replyToMessageId: inbound.messageId,
    messageId: inbound.messageId,
  }
}

/**
 * Resolves conversation keys to live agents, and remembers where each one
 * answers.
 *
 * The default session id is derived from the key, so restart continuity needs no
 * file at all. `/new` is the exception: it must reach a *different* session, and
 * a deterministic id would resolve the old one again. Only that rotation is
 * persisted, in a small override map.
 */
export class ConversationSessions {
  #controller
  #cwd
  #stateDir
  #logger
  /** key -> Agent, for the sessions this process opened or reached. */
  #agents = new Map()
  /** sessionId -> routing for the chat it serves. */
  #routing = new Map()
  /** sessionId -> key, so a session event can find its chat. */
  #keyBySession = new Map()
  /** key -> in-flight reach, so two messages cannot open two agents. */
  #opening = new Map()
  /** key -> rotated session id, written only by `/new`. */
  #overrides = new Map()
  #onSession

  constructor({ sessionController, cwd, stateDir, logger, onSession }) {
    this.#controller = sessionController
    this.#cwd = cwd
    this.#stateDir = stateDir
    this.#logger = logger
    /**
     * Called once per session this process reaches, so the caller can file the
     * session under its workspace. Grouping is a presentation concern: a failure
     * here is logged and never blocks the conversation.
     */
    this.#onSession = onSession
  }

  /** The session id serving a key: a rotated one when `/new` was used, else derived. */
  idFor(key) {
    return this.#overrides.get(key) ?? sessionIdFor(key)
  }

  /** Load persisted rotations. A missing or corrupt file simply means none. */
  async load() {
    if (!this.#stateDir) return this
    try {
      const parsed = JSON.parse(await readFile(this.#file(), 'utf8'))
      for (const [key, sessionId] of Object.entries(parsed ?? {})) {
        if (typeof key === 'string' && typeof sessionId === 'string') this.#overrides.set(key, sessionId)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger?.warn?.('[feishu-card] ignoring unreadable session overrides', error)
      }
    }
    return this
  }

  #file() {
    return join(this.#stateDir, 'bindings.json')
  }

  async #persist() {
    if (!this.#stateDir) return
    const file = this.#file()
    const temp = `${file}.${process.pid}.tmp`
    try {
      await mkdir(this.#stateDir, { recursive: true })
      await writeFile(temp, JSON.stringify(Object.fromEntries(this.#overrides), null, 2), 'utf8')
      await rename(temp, file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      this.#logger?.warn?.('[feishu-card] persisting session overrides failed', error)
    }
  }

  /**
   * Start a fresh conversation for a key.
   *
   * A new id is minted and persisted and the in-memory binding is dropped, so
   * the next message opens that new session instead of resolving the old one.
   *
   * @returns the new session id.
   */
  async rotate(key) {
    const next = `${sessionIdFor(key)}-${Date.now().toString(36)}`
    this.#overrides.set(key, next)
    this.#agents.delete(key)
    for (const [sessionId, mappedKey] of [...this.#keyBySession]) {
      if (mappedKey === key) {
        this.#routing.delete(sessionId)
        this.#keyBySession.delete(sessionId)
      }
    }
    await this.#persist()
    return next
  }

  /** Remember where a conversation answers, and record the pairing. */
  bind(key, inbound) {
    const sessionId = this.idFor(key)
    this.#routing.set(sessionId, routingOf(inbound))
    this.#keyBySession.set(sessionId, key)
    return sessionId
  }

  /** Routing for a session this plugin serves, or undefined. */
  routingFor(sessionId) {
    return this.#routing.get(sessionId)
  }

  /** Whether this plugin renders for the given session. */
  serves(sessionId) {
    return this.#routing.has(sessionId)
  }

  /**
   * Point a bound session at the newest user message.
   *
   * Both the reply anchor and the reaction target follow it: the reaction marks
   * the message the user just sent, which is where their attention is.
   */
  refreshReplyAnchor(sessionId, messageId) {
    const routing = this.#routing.get(sessionId)
    if (!routing) return
    routing.replyToMessageId = messageId
    routing.messageId = messageId
  }

  /** Re-point a bound session at a new chat (the bot may be re-added elsewhere). */
  rebind(sessionId, inbound) {
    if (!this.#routing.has(sessionId)) return
    this.#routing.set(sessionId, routingOf(inbound))
  }

  /** Drop a conversation, e.g. for `/new`. */
  forget(key) {
    const sessionId = this.idFor(key)
    this.#agents.delete(key)
    this.#routing.delete(sessionId)
    this.#keyBySession.delete(sessionId)
  }

  /** Every live session this process serves. */
  liveSessions() {
    return [...this.#routing.keys()]
  }

  /**
   * Reach the agent for a key, creating the session on first contact.
   *
   * The ladder is live-agent → persisted session → fresh session. A persisted
   * session that cannot be read is reported and then replaced, because the
   * registry offers no existence probe and an unreadable log must not be
   * silently mistaken for a brand-new conversation.
   *
   * @returns the live agent.
   */
  async reach(key) {
    const cached = this.#agents.get(key)
    if (cached) return cached
    const inflight = this.#opening.get(key)
    if (inflight) return inflight

    const opening = this.#open(key).finally(() => this.#opening.delete(key))
    this.#opening.set(key, opening)
    return opening
  }

  async #open(key) {
    const sessionId = this.idFor(key)

    const first = await this.#controller.resolveAgent(sessionId)
    if (!first.error) {
      this.#agents.set(key, first.agent)
      await this.#assignWorkspace(sessionId)
      return first.agent
    }
    if (first.error.code !== 'session/not-found') {
      // Busy or writer-held is a transient condition, not a reason to fork a new
      // conversation; the caller reports it and drops the message.
      throw new Error(`resolveAgent(${sessionId}) failed: ${first.error.code}`)
    }

    await this.#controller.create({ sessionId, cwd: this.#cwd })
    const second = await this.#controller.resolveAgent(sessionId)
    if (second.error) throw new Error(`resolveAgent(${sessionId}) failed after create: ${second.error.code}`)
    this.#agents.set(key, second.agent)
    await this.#assignWorkspace(sessionId)
    return second.agent
  }

  /**
   * File the sessions this plugin already knows about, at startup.
   *
   * Without this, a conversation that already exists stays ungrouped until its
   * next inbound message — which is exactly the reported symptom. Only rotations
   * are knowable up front (the derived ones are filed when first reached), and a
   * session that vanished is skipped rather than recreated.
   */
  async adoptExisting() {
    const known = [...this.#overrides.keys()].map((key) => this.idFor(key))
    for (const sessionId of known) {
      try {
        await this.#controller.inspect(sessionId)
      } catch {
        continue
      }
      await this.#assignWorkspace(sessionId)
    }
  }

  /** Offer a session to its workspace. Never throws. */
  async #assignWorkspace(sessionId) {
    if (!this.#onSession) return
    try {
      await this.#onSession(sessionId)
    } catch (error) {
      this.#logger?.warn?.(`[feishu-card] filing ${sessionId} under its workspace failed`, error)
    }
  }
}

/**
 * File each reached session under the workspace that owns `cwd`.
 *
 * A session's `meta.cwd` alone does NOT put it in a workspace group: the Web UI
 * groups by the workspace REGISTRY, and membership is a separate association made
 * with `Workspace.attachSession`. Without this call a Feishu conversation keeps
 * the right working directory but shows up under "ungrouped".
 *
 * Called on the resume rung too, so sessions created before this existed are
 * repaired on their next message rather than staying stranded.
 *
 * Grouping is presentation only: every failure here is logged and swallowed, and
 * the attach set keeps the durable write to once per session per process.
 */
export function makeWorkspaceFiler(ctx, cwd, logger) {
  const attached = new Set()
  let pending
  const workspace = async () => {
    const registry = ctx.get('workspaceRegistry')
    if (!registry) return undefined
    // `resolveByPath` rejects for a missing directory and returns undefined for an
    // existing but unowned one, so both are folded into "needs create".
    const existing = await registry.resolveByPath(cwd).catch(() => undefined)
    if (existing) return existing
    return await registry.create(cwd).catch((error) => {
      logger?.warn?.(`[feishu-card] no workspace owns ${cwd}; the session stays ungrouped`, error)
      return undefined
    })
  }
  return async (sessionId) => {
    if (attached.has(sessionId)) return
    pending ??= workspace()
    const owner = await pending
    if (!owner) return
    await owner.attachSession(sessionId)
    attached.add(sessionId)
    logger?.info?.(`[feishu-card] session ${sessionId} filed under workspace "${owner.title}"`)
  }
}
