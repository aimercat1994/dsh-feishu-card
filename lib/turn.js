/**
 * One streamed card per turn: accumulation, throttling, and terminal render.
 *
 * Four rules shape this module.
 *
 * 1. Live model deltas and committed session events describe the same text, so
 *    they are accumulated in **separate** fields and displayed concatenated.
 *    A committed `assistant/message` folds the live buffer into the committed
 *    one and clears it; appending both would print every answer twice.
 * 2. The card document is rebuilt from accumulated strings, never patched into
 *    an unknown state. The terminal render is therefore a single `card.update`
 *    rather than a series of element edits racing the streaming writes.
 * 3. Model deltas arrive far faster than the platform accepts writes, so text
 *    lands in a buffer and a timer coalesces it into one write per element per
 *    interval. A terminal event always flushes.
 * 4. A card's streaming session expires. Feishu closes it ten minutes after it
 *    was last enabled — writes do not renew it — and a turn can easily outlive
 *    that, so a write refreshes a session it has not renewed recently, and a
 *    write refused as "session closed" re-opens it and is retried. Writes are
 *    additionally serialized per turn, because two overlapping rounds hand out
 *    sequence numbers that can overtake each other in flight and be rejected as
 *    "sequence number compare failed".
 *
 * @module dsh-feishu-card/turn
 */

import { ELEMENTS, PRESETS, TEMPLATE, assertValidCard, buildTurnCard } from './card.js'
import { isStreamingClosed } from './feishu.js'

/** Rendered reasoning keeps only this many trailing characters. */
export const DEFAULT_REASONING_TAIL = 2000

/** A single markdown element larger than this is truncated with a notice. */
const MAX_ELEMENT_CHARS = 28000

/**
 * How long a streaming session is trusted before a write re-enables it first.
 *
 * The platform closes streaming mode 10 minutes after it was last enabled, and
 * writes do not renew it. Checking on the write path is what makes this cover
 * both shapes of long turn: one that streams continuously past the deadline,
 * and one that goes quiet for longer than the lifetime (a long tool phase) and
 * then resumes. The margin is deliberately wide — re-enabling resets the window,
 * so refreshing early costs one extra settings call, while refreshing late means
 * writing into a dead session.
 */
export const STREAM_REFRESH_MS = 8 * 60 * 1000

/**
 * Consecutive failed writes after which the live element path is abandoned.
 *
 * A recovery that does not actually recover must not become a per-interval
 * retry storm against a card the platform has stopped accepting writes for.
 */
export const MAX_WRITE_FAILURES = 3

/** Keep the tail of over-long text, where the model's latest thought lives. */
function tail(text, limit) {
  if (text.length <= limit) return text
  return `…（已省略前 ${text.length - limit} 字）\n\n${text.slice(-limit)}`
}

/** Clamp one element's content and announce any truncation. */
function clamp(text) {
  if (text.length <= MAX_ELEMENT_CHARS) return text
  return `${text.slice(0, MAX_ELEMENT_CHARS)}\n\n…（内容过长，已截断）`
}

/** Everything the plugin knows about one in-flight turn's card. */
class TurnState {
  constructor({ sessionId, chatId, replyToMessageId, cardId, startedAt, preset, showProcess, hideProcessWhenDone }) {
    this.sessionId = sessionId
    this.chatId = chatId
    this.replyToMessageId = replyToMessageId
    this.cardId = cardId
    this.startedAt = startedAt
    /** Committed, durable text — the authoritative accumulation. */
    this.committedAnswer = ''
    this.committedReasoning = ''
    /** Transient text from the live assistant stream for the current attempt. */
    this.liveAnswer = ''
    this.liveReasoning = ''
    this.activity = ''
    this.footer = ''
    this.title = 'DSH · 思考中'
    this.template = TEMPLATE.running
    /** One line under the title: what the turn is doing right now. */
    this.subtitle = ''
    this.preset = preset ?? 'classic'
    this.showProcess = showProcess !== false
    this.hideProcessWhenDone = hideProcessWhenDone === true
    this.widthMode = 'default'
    this.textSizes = undefined
    /** Tool calls seen this turn, shown in the panel title and the footer. */
    this.toolCount = 0
    this.model = ''
    this.usage = undefined
    /** Set once the turn settles, so the panel can fold away. */
    this.done = false
    this.dirty = new Set()
    /** Last content successfully written per element, so a no-op write is skipped. */
    this.sent = new Map()
    /**
     * Something outside the addressable elements changed — the header, or the
     * pending decision block — so the card needs a full rewrite rather than
     * per-element content writes. The header is not an element at all, which is
     * exactly why a title or a live action line cannot be streamed.
     */
    this.fullDirty = false
    /** A pending decision rendered inside this card, or its settled receipt. */
    this.interaction = undefined
    this.timer = undefined
    this.settled = false
    this.reasoningTail = DEFAULT_REASONING_TAIL
    /** Whether per-element streaming writes are still accepted. */
    this.streaming = true
    /** When streaming mode was last enabled, so it can be refreshed in time. */
    this.streamOpenedAt = startedAt
    /** Consecutive failed writes; a success resets it. */
    this.writeFailures = 0
    /** Cleared once live updates are abandoned; the terminal write still runs. */
    this.liveUpdates = true
    /**
     * The tail of the flush chain. Every round of writes is appended here, so
     * two rounds can never be in flight against the same card at once.
     */
    this.chain = undefined
  }

  /** Assistant text to display: committed steps plus this attempt's live deltas. */
  get answer() {
    return this.committedAnswer + this.liveAnswer
  }

  /** Reasoning to display, same split. */
  get reasoning() {
    return this.committedReasoning + this.liveReasoning
  }

  /** The whole card document for the current accumulation. */
  document() {
    const layout = PRESETS[this.preset] ?? PRESETS.classic
    // While the turn runs the panel shows live progress; once it settles the
    // answer leads, so the panel folds unless the preset keeps it open.
    const expanded = this.done
      ? this.hideProcessWhenDone
        ? false
        : layout.expandedDone
      : layout.expandedRunning
    return buildTurnCard({
      title: this.title,
      subtitle: this.subtitle,
      template: this.template,
      summary: this.title,
      preset: this.preset,
      reasoning: tail(this.reasoning, this.reasoningTail),
      activity: clamp(this.activity),
      answer: clamp(this.answer),
      footer: this.footer,
      showProcess: this.showProcess,
      expanded,
      toolCount: this.toolCount,
      streamingMode: !this.done,
      interaction: this.interaction,
      widthMode: this.widthMode,
      textSizes: this.textSizes,
    })
  }
}

/** Owns every live turn card. Created once per plugin activation. */
export class TurnRenderer {
  #transport
  #logger
  #flushIntervalMs
  #reasoningTail
  #preset
  #showProcess
  #hideProcessWhenDone
  #widthMode
  #textSizes
  #streamRefreshMs
  #maxWriteFailures
  #turns = new Map()
  /** Cards currently being created, so two triggers cannot open two cards. */
  #beginning = new Map()

  constructor({
    transport,
    logger,
    flushIntervalMs = 400,
    reasoningTail = DEFAULT_REASONING_TAIL,
    preset = 'classic',
    showProcess = true,
    hideProcessWhenDone = false,
    widthMode = 'default',
    textSizes,
    streamRefreshMs = STREAM_REFRESH_MS,
    maxWriteFailures = MAX_WRITE_FAILURES,
  }) {
    this.#transport = transport
    this.#logger = logger
    this.#flushIntervalMs = flushIntervalMs
    this.#reasoningTail = reasoningTail
    this.#preset = preset
    this.#showProcess = showProcess
    this.#hideProcessWhenDone = hideProcessWhenDone
    this.#widthMode = widthMode
    this.#textSizes = textSizes
    this.#streamRefreshMs = streamRefreshMs
    this.#maxWriteFailures = maxWriteFailures
  }

  /** The live turn card for a session, when one exists. */
  get(sessionId) {
    return this.#turns.get(sessionId)
  }

  /**
   * Whether the live card has a process panel to accept an activity line.
   *
   * `showProcess: false` removes the `activity` element entirely, so appending to
   * it would write to a nonexistent element and be swallowed as a warning — the
   * notice would simply vanish. Callers must ask instead of assuming.
   */
  acceptsActivity(sessionId) {
    const state = this.#turns.get(sessionId)
    return Boolean(state && state.showProcess && !state.settled)
  }

  /** Whether this session currently has a card being streamed. */
  has(sessionId) {
    return this.#turns.has(sessionId)
  }

  /**
   * Open — or return — the card for one turn.
   *
   * Idempotent and race-safe: a turn can be announced by the inbound message
   * and by `turn/start` at almost the same moment (and a queued message opens
   * its card only when its turn actually starts), so a second call must attach
   * to the existing card rather than settle it and open another.
   *
   * @returns the live turn state.
   */
  async begin(sessionId, { chatId, replyToMessageId, title, replyInThread = false }) {
    const existing = this.#turns.get(sessionId)
    if (existing) return existing
    const inflight = this.#beginning.get(sessionId)
    if (inflight) return inflight

    const creation = this.#create(sessionId, { chatId, replyToMessageId, title, replyInThread })
      .finally(() => this.#beginning.delete(sessionId))
    this.#beginning.set(sessionId, creation)
    return creation
  }

  /** Create and send one card entity. */
  async #create(sessionId, { chatId, replyToMessageId, title, replyInThread }) {
    const state = new TurnState({
      sessionId,
      chatId,
      replyToMessageId,
      cardId: undefined,
      startedAt: Date.now(),
      preset: this.#preset,
      showProcess: this.#showProcess,
      hideProcessWhenDone: this.#hideProcessWhenDone,
    })
    state.reasoningTail = this.#reasoningTail
    state.widthMode = this.#widthMode
    state.textSizes = this.#textSizes
    if (title) state.title = title

    state.cardId = await this.#transport.createCard(assertValidCard(state.document(), 'turn card'))
    // `streaming_mode` is declared in the card JSON, but the platform also
    // exposes it as a card-level setting. Enabling it both ways maximises the
    // chance the typewriter effect is on; a rejected settings call is not fatal
    // (the card still streams, just without client-side interpolation).
    try {
      await this.#transport.setStreaming(state.cardId, true)
    } catch (error) {
      this.#logger?.warn?.('[feishu-card] could not enable card streaming mode', error)
    }
    // Whenever streaming was enabled — including by the card JSON — the
    // platform's 10-minute lifetime window starts now, so the deadline is
    // tracked from here either way.
    state.streamOpenedAt = Date.now()
    await this.#transport.sendCard(state.cardId, { chatId, replyToMessageId, replyInThread })
    this.#turns.set(sessionId, state)
    return state
  }

  /** Replace the header line and colour. */
  setStatus(sessionId, { title, template } = {}) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled) return
    let changed = false
    if (title !== undefined && title !== state.title) {
      state.title = title
      changed = true
    }
    if (template !== undefined && template !== state.template) {
      state.template = template
      changed = true
    }
    if (changed) {
      state.fullDirty = true
      this.#schedule(state)
    }
  }

  /** Start a fresh attempt: its live buffer no longer describes anything. */
  resetLive(sessionId) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled) return
    state.liveAnswer = ''
    state.liveReasoning = ''
  }

  /** Append model reasoning deltas. */
  addLiveReasoning(sessionId, text) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled || !text) return
    state.liveReasoning += text
    state.dirty.add(ELEMENTS.reasoning)
    this.#schedule(state)
  }

  /** Append assistant answer deltas. */
  addLiveAnswer(sessionId, text) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled || !text) return
    state.liveAnswer += text
    state.dirty.add(ELEMENTS.answer)
    this.#schedule(state)
  }

  /**
   * Fold one committed assistant message into the accumulation.
   *
   * The committed text is authoritative, so the live buffer for this attempt is
   * dropped rather than kept alongside it.
   *
   * @param payload - committed `text` and `reasoning` for this step.
   */
  commitAssistant(sessionId, { text = '', reasoning = '' } = {}) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled) return
    // Fall back to the live buffer only when the committed message carries no
    // reasoning of its own, so a thought is never silently dropped.
    state.committedReasoning += reasoning || state.liveReasoning
    state.committedAnswer += text
    state.liveAnswer = ''
    state.liveReasoning = ''
    state.dirty.add(ELEMENTS.reasoning)
    state.dirty.add(ELEMENTS.answer)
    this.#schedule(state)
  }

  /**
   * Put a pending decision inside this turn's card, or update its receipt.
   *
   * The buttons are ordinary body elements, so a full rewrite is what publishes
   * them; the next `flush` does that.
   */
  setInteraction(sessionId, interaction) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled) return false
    state.interaction = interaction
    state.fullDirty = true
    this.#schedule(state)
    return true
  }

  /** Replace the one-line "what is happening now" under the title. */
  setSubtitle(sessionId, text) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled) return
    const next = text ?? ''
    if (next === state.subtitle) return
    state.subtitle = next
    state.fullDirty = true
    this.#schedule(state)
  }

  /** Record the model and token usage for the terminal footer. */
  setUsage(sessionId, { model, usage } = {}) {
    const state = this.#turns.get(sessionId)
    if (!state) return
    if (model) state.model = model
    if (usage) state.usage = usage
  }

  /** The live turn state, for a caller that needs to read its counters. */
  peek(sessionId) {
    return this.#turns.get(sessionId)
  }

  /**
   * Append one already-formatted process line.
   * @param countsAsTool - whether this line is a tool call (drives the counter).
   */
  addActivity(sessionId, line, countsAsTool = false) {
    const state = this.#turns.get(sessionId)
    if (!state || state.settled || !line) return
    if (countsAsTool) state.toolCount += 1
    state.activity += state.activity ? `\n${line}` : line
    state.dirty.add(ELEMENTS.activity)
    this.#schedule(state)
  }

  /** Schedule one coalesced flush. */
  #schedule(state) {
    if (state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      void this.flush(state.sessionId)
    }, this.#flushIntervalMs)
    state.timer.unref?.()
  }

  /**
   * Publish the pending changes.
   *
   * Rounds are serialized per turn. A flush can be triggered while an earlier
   * one is still awaiting the platform — a delta arrives, the timer re-arms,
   * and the next round starts before the last has answered. Two rounds in
   * flight mint `sequence` values in call order but deliver them in completion
   * order, and the platform answers the overtaken one with "sequence number
   * compare failed" (300317), losing that write. Chaining costs one round of
   * latency and removes the race entirely.
   *
   * The header is not an element, so the only way to move the title, the live
   * action line, or the status colour is a full `card.update`. That update
   * carries every element's content too, so it replaces the per-element writes
   * for that round rather than racing them.
   */
  async flush(sessionId) {
    const state = this.#turns.get(sessionId)
    if (!state) return
    const previous = state.chain ?? Promise.resolve()
    const run = previous.then(
      () => this.#write(state),
      () => this.#write(state),
    )
    // Keep the chain settled: a rejected round must not poison every later one.
    state.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** One round of live writes, with the previous round already complete. */
  async #write(state) {
    if (state.settled || !state.liveUpdates) return

    // Refresh before writing when the session has not been renewed recently,
    // so no write ever lands in a session the platform has already closed. This
    // runs before the dirty check on purpose: a turn that went quiet past the
    // lifetime then resumes writes is refreshed first and its first write
    // succeeds, rather than failing once and needing the reactive path.
    if (state.streaming && Date.now() - state.streamOpenedAt >= this.#streamRefreshMs) {
      await this.#reopenStream(state, { eager: true })
    }
    if (state.dirty.size === 0 && !state.fullDirty) return

    if (state.fullDirty || !state.streaming) {
      // A full replace carries every element, which is also why it is the
      // fallback once the streaming session is gone: the card keeps progressing
      // without the typewriter effect, instead of freezing until the turn ends.
      try {
        await this.#transport.updateCard(state.cardId, state.document())
      } catch (error) {
        state.writeFailures += 1
        this.#report(state, error, 'full card update', { fatal: true })
        // `fullDirty` and `dirty` are deliberately left set, so the next round
        // retries rather than losing the text.
        return
      }
      state.writeFailures = 0
      state.fullDirty = false
      state.dirty.clear()
      // The full card now carries every element, so record what is on screen.
      for (const elementId of [ELEMENTS.reasoning, ELEMENTS.activity, ELEMENTS.answer]) {
        state.sent.set(elementId, this.#elementContent(state, elementId))
      }
      return
    }

    for (const elementId of [...state.dirty]) {
      const content = this.#elementContent(state, elementId)
      // The platform rejects an EMPTY content write (HTTP 400), and rewriting an
      // unchanged element burns a sequence number. Neither is fatal, but a
      // rejected write is a live update the user simply never sees.
      if (!content || content === state.sent.get(elementId)) {
        state.dirty.delete(elementId)
        continue
      }
      try {
        await this.#transport.streamElement(state.cardId, elementId, content)
      } catch (error) {
        // Leave the element dirty: it is what the next round retries, and the
        // terminal `card.update` carries the full accumulation regardless.
        await this.#streamFailed(state, error)
        return
      }
      state.sent.set(elementId, content)
      state.dirty.delete(elementId)
      state.writeFailures = 0
    }
  }

  /**
   * React to one failed element write.
   *
   * A closed streaming session is recoverable and is retried after re-opening
   * it; anything else is counted, so a card the platform has stopped accepting
   * writes for degrades to full updates instead of a per-interval retry storm.
   */
  async #streamFailed(state, error) {
    state.writeFailures += 1
    if (isStreamingClosed(error) && state.writeFailures < this.#maxWriteFailures) {
      if (await this.#reopenStream(state)) {
        this.#logger?.warn?.('[feishu-card] card streaming session had closed; re-opened it', error)
      }
      return
    }
    this.#report(state, error, 'streaming update')
  }

  /**
   * Report a failed live write.
   *
   * Past the budget the turn degrades one step rather than retrying forever:
   * a failing element write switches to full-card updates, and a failing full
   * update — the last live path there is — stops trying. `finish` still issues
   * the terminal update either way, so the turn's answer lands regardless.
   *
   * @param fatal - whether there is no further live path to fall back to.
   */
  #report(state, error, what, { fatal = false } = {}) {
    if (state.writeFailures < this.#maxWriteFailures) {
      this.#logger?.warn?.(`[feishu-card] ${what} failed`, error)
      return
    }
    if (fatal) {
      state.liveUpdates = false
      this.#logger?.warn?.(
        `[feishu-card] ${what} failed ${state.writeFailures} times in a row; no further live card updates this turn`,
        error,
      )
      return
    }
    state.streaming = false
    this.#logger?.warn?.(
      `[feishu-card] ${what} failed ${state.writeFailures} times in a row; switching to full card updates`,
      error,
    )
  }

  /**
   * Re-enable the card's streaming session.
   *
   * Feishu closes streaming mode ten minutes after it was last enabled, so
   * re-enabling it is how a turn that outlives the window keeps streaming.
   *
   * @param eager - this is a pre-emptive refresh, not a response to a write the
   *   platform refused. The distinction decides what a failure means: a refused
   *   write is proof the session is gone, while a failed refresh proves nothing
   *   and must not take working element writes away.
   * @returns whether streaming is usable again.
   */
  async #reopenStream(state, { eager = false } = {}) {
    // Move the deadline forward either way, so a refresh that could not be made
    // is retried on the next window rather than on every single flush.
    state.streamOpenedAt = Date.now()
    try {
      await this.#transport.setStreaming(state.cardId, true)
    } catch (error) {
      this.#logger?.warn?.('[feishu-card] could not re-enable card streaming', error)
      if (!eager) state.streaming = false
      return false
    }
    state.streaming = true
    return true
  }

  /** The current content for one element of this turn. */
  #elementContent(state, elementId) {
    switch (elementId) {
      case ELEMENTS.reasoning:
        return tail(state.reasoning, this.#reasoningTail)
      case ELEMENTS.activity:
        return clamp(state.activity)
      case ELEMENTS.answer:
        return clamp(state.answer)
      default:
        return ''
    }
  }

  /**
   * Settle the turn: cancel any pending flush and write the complete card once.
   * Safe to call for a session that has no card.
   */
  async finish(sessionId, { title, template, footer } = {}) {
    // A turn that ends before its card finished being created must still settle
    // that card, so wait for the in-flight creation first.
    const inflight = this.#beginning.get(sessionId)
    if (inflight) {
      try {
        await inflight
      } catch {
        // A creation failure means there is no card to settle.
      }
    }
    const state = this.#turns.get(sessionId)
    if (!state) return
    this.#turns.delete(sessionId)
    state.settled = true
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    // Let the round already in flight land before the terminal write. A
    // streaming write that arrives after streaming mode has been turned off is
    // rejected, so this ordering is what keeps the last deltas from being lost.
    if (state.chain) await state.chain
    state.done = true
    if (title !== undefined) state.title = title
    if (template !== undefined) state.template = template
    if (footer !== undefined) state.footer = footer
    try {
      await this.#transport.updateCard(state.cardId, withStreamingOff(state.document()))
    } catch (error) {
      this.#logger?.warn?.('[feishu-card] final card update failed', error)
    } finally {
      this.#transport.releaseCard(state.cardId)
    }
  }

  /** Drop every live card, e.g. on plugin unload. */
  async dispose() {
    const sessionIds = [...new Set([...this.#turns.keys(), ...this.#beginning.keys()])]
    await Promise.allSettled(sessionIds.map((id) => this.finish(id, {})))
    this.#turns.clear()
    this.#beginning.clear()
  }
}

/** A settled card must stop animating. */
function withStreamingOff(card) {
  return { ...card, config: { ...card.config, streaming_mode: false } }
}
