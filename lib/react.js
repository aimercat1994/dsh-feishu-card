/**
 * Reaction feedback: the "I heard you, and I am still working" signal.
 *
 * A chat turn can run for minutes with nothing on screen. A reaction on the
 * user's own message is the cheapest possible liveness proof, and it lives on
 * the message the user just sent — where their attention already is.
 *
 * Feishu reactions are ADDITIVE: the app may hold several on one message at
 * once. Showing one state is therefore a swap — remove the previous emoji, then
 * add the next — which is also why a failed removal is worth reporting rather
 * than ignoring: leaving two emoji on the message looks like a bug to the user.
 *
 * State is once-only per message: a turn that reached `done` never falls back to
 * `working`, so a late event cannot resurrect the spinner.
 *
 * @module dsh-feishu-card/react
 */

/** The emoji that represents each lifecycle step. */
/**
 * Cap on tracked messages. A settled reaction can never move again, so dropping
 * the oldest bookkeeping is free.
 */
const MAX_TRACKED = 200

export const REACTION = {
  ack: 'OK',
  working: 'THINKING',
  done: 'DONE',
  fail: 'ERROR',
}

/** How one message's current reaction is tracked. */
class Tracked {
  constructor() {
    this.reactionId = undefined
    this.emoji = undefined
    this.settled = false
  }
}

/** Owns the reactions this app has placed, keyed by message. */
export class ReactionTracker {
  #transport
  #logger
  #enabled
  #byMessage = new Map()
  /** Serialises swaps per message so two fast transitions cannot interleave. */
  #queues = new Map()

  constructor({ transport, logger, enabled = true }) {
    this.#transport = transport
    this.#logger = logger
    this.#enabled = enabled
  }

  /**
   * Swap the reaction on one message to the given step.
   *
   * @param step - a {@link REACTION} key: ack, working, done, or fail.
   */
  async show(messageId, step) {
    if (!this.#enabled || !messageId) return
    const emoji = REACTION[step]
    if (!emoji) return

    let tracked = this.#byMessage.get(messageId)
    if (!tracked) {
      tracked = new Tracked()
      this.#byMessage.set(messageId, tracked)
      this.#evict()
    }
    // `done`/`fail` are terminal, and a later `working` must not undo them.
    if (tracked.settled) return
    if (tracked.emoji === emoji) return

    const previous = this.#queues.get(messageId) ?? Promise.resolve()
    const next = previous
      .then(() => this.#swap(messageId, tracked, emoji))
      .catch((error) => this.#logger?.warn?.('[feishu-card] reaction update failed', error))
    this.#queues.set(messageId, next)
    await next
  }

  async #swap(messageId, tracked, emoji) {
    if (tracked.reactionId) {
      const stale = tracked.reactionId
      tracked.reactionId = undefined
      tracked.emoji = undefined
      try {
        await this.#transport.removeReaction(messageId, stale)
      } catch (error) {
        // Worth reporting: a failed removal leaves two emoji on the message.
        this.#logger?.warn?.('[feishu-card] removing the previous reaction failed', error)
      }
    }
    tracked.reactionId = await this.#transport.addReaction(messageId, emoji)
    tracked.emoji = emoji
    if (emoji === REACTION.done || emoji === REACTION.fail) tracked.settled = true
  }

  /**
   * Forget one message, e.g. when its turn is torn down.
   */
  forget(messageId) {
    this.#byMessage.delete(messageId)
    this.#queues.delete(messageId)
  }

  /**
   * Keep the track maps bounded.
   *
   * These are keyed by MESSAGE, and messages arrive forever, so without eviction a
   * long-running bot grows one entry per message. Every settled entry is dead
   * weight: the reaction is already on the message and nothing will move it again.
   */
  #evict() {
    while (this.#byMessage.size > MAX_TRACKED) {
      const oldest = this.#byMessage.keys().next().value
      this.#byMessage.delete(oldest)
      this.#queues.delete(oldest)
    }
  }

  /** Drop every track. Reactions already placed are left on the messages. */
  dispose() {
    this.#byMessage.clear()
    this.#queues.clear()
  }
}
