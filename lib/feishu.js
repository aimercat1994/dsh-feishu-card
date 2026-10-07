/**
 * Feishu/Lark transport over the official Open SDK.
 *
 * Owns exactly three things: the WebSocket long connection (inbound messages
 * and card actions — no public callback URL), the CardKit entity lifecycle for
 * one card per turn, and the strictly increasing `sequence` CardKit requires.
 *
 * Sequence discipline is the load-bearing invariant: every mutation of one
 * card entity must carry a larger `sequence` than the last, or the platform
 * rejects it. Counters live here, keyed by card id, so callers never hold one.
 *
 * @module dsh-feishu-card/feishu
 */

import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk'
import { collectStream, parsePostContent, sniffImageMediaType } from './media.js'

/** The slash-command API's path (unmodelled by the SDK, hence raw requests). */
const SLASH_COMMANDS_PATH = '/open-apis/application/v7/app_slash_commands'

/** CardKit rejects a mutation whose sequence does not exceed the previous one. */
const FIRST_SEQUENCE = 1

/**
 * Await one SDK call and fail with the platform's own diagnostic.
 *
 * The SDK rejects with an axios error whose useful part (`code`, `msg`, and the
 * offending element path) lives in `response.data`. Without it a failure reads
 * only as "status code 400", which is unactionable.
 */
async function call(what, promise) {
  try {
    return assertOk(what, await promise)
  } catch (error) {
    const detail = error?.response?.data
    if (detail) {
      throw new Error(`[feishu-card] ${what} failed: ${JSON.stringify(detail).slice(0, 400)}`)
    }
    throw error
  }
}

/** Feishu answers every Open API call with `code` and `msg`; 0 means success. */
function assertOk(what, response) {
  const code = response?.code
  if (code !== undefined && code !== 0) {
    const detail = response?.msg ?? 'unknown error'
    throw new Error(`[feishu-card] ${what} failed: code=${code} msg=${detail}`)
  }
  return response
}

/**
 * Read the correlation value and operator out of a `card.action.trigger`
 * payload. The platform nests ids under `context` in the v2 schema and has
 * historically delivered them at the root, so both are accepted.
 *
 * @returns the button's `value` object (empty when absent) and who clicked.
 */
export function readCardAction(data) {
  const value = data?.action?.value
  const action = value && typeof value === 'object' ? value : {}
  // A form submit reports neither `value` nor a callback: it reports the submit
  // button's `name` plus the form's field values.
  const name = typeof data?.action?.name === 'string' ? data.action.name : undefined
  const formValue = data?.action?.form_value ?? data?.action?.formValue
  const operatorId = data?.operator?.open_id ?? data?.operator?.user_id ?? data?.operator?.union_id
  const operator = data?.operator?.name ?? operatorId
  const chatId = data?.context?.open_chat_id ?? data?.open_chat_id
  const messageId = data?.context?.open_message_id ?? data?.open_message_id
  // A `select_static` reports the chosen option here, NOT in `value` — `value` stays
  // the behavior's own constant payload. Cards put their intent in the option value
  // (as JSON), so this is the field that carries it back.
  const option = typeof data?.action?.option === 'string' ? data.action.option : undefined
  return { action, name, formValue, operator, chatId, messageId, option }
}

/**
 * Read the text and routing out of an `im.message.receive_v1` payload.
 *
 * @returns null when the payload carries no usable chat or text.
 */
export function readInboundMessage(data) {
  const message = data?.message
  const chatId = message?.chat_id
  if (!chatId) return null

  const messageType = message.message_type ?? message.msg_type
  let unsupported
  let text = ''
  const imageKeys = []

  if (messageType === 'text') {
    try {
      text = JSON.parse(message.content ?? '{}').text ?? ''
    } catch {
      return null
    }
  } else if (messageType === 'image') {
    try {
      const key = JSON.parse(message.content ?? '{}').image_key
      if (typeof key === 'string') imageKeys.push(key)
    } catch {
      return null
    }
  } else if (messageType === 'post') {
    const parsed = parsePostContent(message.content)
    text = parsed.text
    imageKeys.push(...parsed.imageKeys)
  } else {
    // Other types (file, audio, sticker, ...) are not surfaced yet. The envelope
    // is still returned in full so the caller can decide — and so it can tell the
    // SENDER, plus check who the sender is before answering.
    unsupported = messageType
  }

  const mentions = Array.isArray(message.mentions) ? message.mentions : []
  return {
    unsupported,
    chatId,
    messageId: message.message_id,
    threadId: message.thread_id,
    chatType: message.chat_type,
    text,
    imageKeys,
    mentions,
    senderId: data?.sender?.sender_id?.open_id,
    senderType: data?.sender?.sender_type,
  }
}

/** One Feishu app connection plus the card entities it owns. */
export class FeishuTransport {
  #appId
  #appSecret
  #domain
  #logger
  #sdk
  #ws
  #dispatcher
  #sequences = new Map()

  constructor({ appId, appSecret, domain, logger }) {
    this.#appId = appId
    this.#appSecret = appSecret
    this.#domain = domain
    this.#logger = logger
  }

  /**
   * Install credentials acquired after construction (QR onboarding).
   * Only valid before {@link start}; a running connection is not reconfigured.
   */
  updateCredentials({ appId, appSecret, domain }) {
    if (this.#ws) throw new Error('[feishu-card] cannot change credentials on a running connection')
    this.#appId = appId
    this.#appSecret = appSecret
    if (domain) this.#domain = domain
  }

  /**
   * The SDK client, created on first use.
   *
   * Created lazily rather than in `start`, because the API methods are usable
   * without a connection — and building them only in `start` meant calling one
   * first failed with "cannot read properties of undefined (reading 'im')".
   */
  #ensureClient() {
    if (!this.#sdk) {
      this.#sdk = new Client({
        appId: this.#appId,
        appSecret: this.#appSecret,
        ...(this.#domain ? { domain: this.#domain } : {}),
      })
    }
    return this.#sdk
  }

  get #client() {
    return this.#ensureClient()
  }

  /** Open the long connection and route inbound events to the two callbacks. */
  async start({ onMessage, onCardAction, onReady, onError }) {
    this.#ensureClient()

    this.#dispatcher = new EventDispatcher({})
    this.#dispatcher.register({
      'im.message.receive_v1': async (data) => {
        try {
          await onMessage(data)
        } catch (error) {
          this.#logger?.error?.('[feishu-card] inbound message handler failed', error)
        }
      },
      'card.action.trigger': async (data) => {
        try {
          return await onCardAction(data)
        } catch (error) {
          this.#logger?.error?.('[feishu-card] card action handler failed', error)
          return undefined
        }
      },
    })

    this.#ws = new WSClient({
      appId: this.#appId,
      appSecret: this.#appSecret,
      ...(this.#domain ? { domain: this.#domain } : {}),
      autoReconnect: true,
      onReady: () => onReady?.(),
      onError: (error) => onError?.(error),
    })
    await this.#ws.start({ eventDispatcher: this.#dispatcher })
  }

  /** Stop the connection. Safe to call when never started. */
  async stop() {
    try {
      this.#ws?.close({ force: true })
    } catch (error) {
      this.#logger?.warn?.('[feishu-card] closing the Feishu connection failed', error)
    }
    this.#ws = undefined
    this.#dispatcher = undefined
    this.#sequences.clear()
  }

  /** Next strictly increasing sequence for one card entity. */
  #nextSequence(cardId) {
    const next = (this.#sequences.get(cardId) ?? 0) + FIRST_SEQUENCE
    this.#sequences.set(cardId, next)
    return next
  }

  /** Forget a card entity's counter once the card can no longer be updated. */
  releaseCard(cardId) {
    this.#sequences.delete(cardId)
  }

  /**
   * Create a card entity from full card JSON 2.0.
   * @returns the `card_id` used by every later mutation.
   */
  async createCard(card) {
    const response = assertOk(
      'cardkit.card.create',
      await call('cardkit.v1.card.create', this.#client.cardkit.v1.card.create({
        data: { type: 'card_json', data: JSON.stringify(card) },
      })),
    )
    const cardId = response?.data?.card_id
    if (!cardId) throw new Error('[feishu-card] cardkit.card.create returned no card_id')
    this.#sequences.set(cardId, FIRST_SEQUENCE)
    return cardId
  }

  /** Turn the card's typewriter effect on or off. */
  async setStreaming(cardId, enabled) {
    assertOk(
      'cardkit.card.settings',
      await call('cardkit.v1.card.settings', this.#client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: enabled } }),
          sequence: this.#nextSequence(cardId),
        },
      })),
    )
  }

  /** Replace the whole card document. */
  async updateCard(cardId, card) {
    assertOk(
      'cardkit.card.update',
      await call('cardkit.v1.card.update', this.#client.cardkit.v1.card.update({
        path: { card_id: cardId },
        data: {
          card: { type: 'card_json', data: JSON.stringify(card) },
          sequence: this.#nextSequence(cardId),
        },
      })),
    )
  }

  /** Push new content into one element — the streaming hot path. */
  async streamElement(cardId, elementId, content) {
    assertOk(
      'cardkit.cardElement.content',
      await call('cardkit.v1.cardElement.content', this.#client.cardkit.v1.cardElement.content({
        path: { card_id: cardId, element_id: elementId },
        data: { content, sequence: this.#nextSequence(cardId) },
      })),
    )
  }

  /**
   * Deliver a card entity into a chat, or as a reply when a message id is given.
   * @returns the message id, for logging and thread continuity.
   */
  async sendCard(cardId, { chatId, replyToMessageId, replyInThread = false }) {
    const content = JSON.stringify({ type: 'card', data: { card_id: cardId } })
    if (replyToMessageId) {
      const response = assertOk(
        'im.message.reply',
        await this.#client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content, reply_in_thread: replyInThread },
        }),
      )
      return response?.data?.message_id
    }
    const response = assertOk(
      'im.message.create',
      await call('im.message.create', this.#client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      })),
    )
    return response?.data?.message_id
  }

  /**
   * Download one resource attached to a message.
   *
   * Feishu sends image bytes with no content type, so the caller sniffs it. The
   * size bound comes from the attachment policy, not a guess: collecting an
   * unbounded stream is how one chat message exhausts memory.
   *
   * @returns the bytes, or undefined when the resource is not an acceptable image.
   */
  async downloadImage(messageId, fileKey, maxBytes) {
    const response = await call(
      'im.messageResource.get',
      this.#client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'image' },
      }),
    )
    const bytes = await collectStream(response.getReadableStream(), maxBytes)
    const mediaType = sniffImageMediaType(bytes)
    return mediaType ? { bytes, mediaType } : undefined
  }

  /**
   * Upload one file and return the key needed to send it.
   *
   * The platform refuses empty files and anything over 30 MB, so callers check
   * both first and report the limit in their own words.
   */
  async uploadFile(bytes, fileName) {
    const response = assertOk(
      'im.file.create',
      await this.#client.im.v1.file.create({
        data: { file_type: 'stream', file_name: fileName, file: bytes },
      }),
    )
    const key = response?.file_key ?? response?.data?.file_key
    if (!key) throw new Error('[feishu-card] im.file.create returned no file_key')
    return key
  }

  /** Deliver an uploaded file into a chat, optionally threaded under a message. */
  async sendFile({ chatId, fileKey, replyToMessageId }) {
    const content = JSON.stringify({ file_key: fileKey })
    if (replyToMessageId) {
      const response = assertOk(
        'im.message.reply (file)',
        await this.#client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'file', content },
        }),
      )
      return response?.data?.message_id
    }
    const response = assertOk(
      'im.message.create (file)',
      await this.#client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'file', content },
      }),
    )
    return response?.data?.message_id
  }

  /**
   * Replace a card message's content in place.
   *
   * A callback may return a card to swap in, but that path is only as good as the
   * platform's willingness to honour it on a plain interactive message — and when
   * it is ignored the card silently keeps showing stale state, which is exactly
   * what a user notices. This is the explicit, documented route: the message id is
   * in the callback context, and `message.patch` is defined as "update the card
   * content of an already-sent message".
   *
   * @param messageId the card message to rewrite (from `context.open_message_id`).
   * @param card      the complete replacement card.
   */
  async updateCardMessage(messageId, card) {
    if (!messageId) throw new Error('updateCardMessage needs a message id')
    return call('message.patch', this.#client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    }))
  }

  /**
   * The app's slash commands, via the generic request escape hatch.
   *
   * The SDK does not model `application/v7/app_slash_commands` at all (the string
   * `slash_command` appears zero times in its type definitions), so these go
   * through `client.request`.
   *
   * The body is FLAT. Every other v7 endpoint wraps its fields in a resource-named
   * key, and guessing `slash_command` here is accepted by the transport and then
   * rejected with "field validation failed" plus `field_violations` reading
   * "command is required" — which looks like a missing field rather than a wrong
   * envelope. Printing only `code`/`msg` hid that for a dozen attempts.
   */
  async listSlashCommands() {
    const response = await call(
      'app_slash_commands.list',
      this.#client.request({ method: 'GET', url: SLASH_COMMANDS_PATH, params: { page_size: 100 } }),
    )
    return response?.data?.items ?? []
  }

  /** @returns the new command's id. */
  async createSlashCommand({ command, description }) {
    const response = await call(
      'app_slash_commands.create',
      this.#client.request({
        method: 'POST',
        url: SLASH_COMMANDS_PATH,
        data: { command, description: { default_value: description } },
      }),
    )
    return response?.data?.command_id
  }

  async updateSlashCommand(commandId, { command, description }) {
    await call(
      'app_slash_commands.update',
      this.#client.request({
        method: 'PATCH',
        url: `${SLASH_COMMANDS_PATH}/${commandId}`,
        data: { command, description: { default_value: description } },
      }),
    )
  }

  async deleteSlashCommand(commandId) {
    await call(
      'app_slash_commands.delete',
      this.#client.request({ method: 'DELETE', url: `${SLASH_COMMANDS_PATH}/${commandId}` }),
    )
  }

  /**
   * Add one emoji reaction to a message.
   *
   * Reactions are ADDITIVE: the app may hold several on one message at once, so
   * showing a single state emoji is a swap (remove, then add), not an overwrite.
   *
   * @returns the `reaction_id` needed to remove it again.
   */
  async addReaction(messageId, emojiType) {
    const response = await call(
      'im.messageReaction.create',
      this.#client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }),
    )
    return response?.data?.reaction_id
  }

  /** Remove one of this app's own reactions. */
  async removeReaction(messageId, reactionId) {
    await call(
      'im.messageReaction.delete',
      this.#client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }),
    )
  }

  /**
   * Send plain text. This is the last-resort channel: it cannot fail for any
   * card-related reason, so a card-path failure still reaches the user instead
   * of vanishing into a swallowed exception.
   */
  async sendText(text, { chatId, replyToMessageId }) {
    const content = JSON.stringify({ text })
    if (replyToMessageId) {
      const response = assertOk(
        'im.message.reply (text)',
        await this.#client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'text', content },
        }),
      )
      return response?.data?.message_id
    }
    const response = assertOk(
      'im.message.create (text)',
      await this.#client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content },
      }),
    )
    return response?.data?.message_id
  }

  /**
   * Send one standalone card as an inline `interactive` message.
   *
   * The content is the card document itself. Wrapping it as
   * `{type:'card', data:<document>}` is the *entity* form (which requires a
   * `card_id`), and the platform rejects it — which is how a card-path failure
   * used to turn into "no message at all" instead of a visible error.
   */
  async sendCardOnce(card, { chatId, replyToMessageId }) {
    const content = JSON.stringify(card)
    if (replyToMessageId) {
      const response = assertOk(
        'im.message.reply',
        await this.#client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { msg_type: 'interactive', content },
        }),
      )
      return response?.data?.message_id
    }
    const response = assertOk(
      'im.message.create',
      await this.#client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content },
      }),
    )
    return response?.data?.message_id
  }
}
