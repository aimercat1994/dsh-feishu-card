/**
 * Who may open a conversation, and why a message was dropped.
 *
 * This is admission control for the channel, so it is deliberately a pure
 * function of the inbound message and the policy: the decision is the part worth
 * testing, and burying it in the message handler made it untestable and — worse —
 * silent. A dropped message used to leave no trace at all, so an operator whose
 * messages were being ignored had nothing to look at.
 *
 * @module dsh-feishu-card/access
 */

/** Why a message was not admitted. */
export const DROP = {
  /** A bot or this app's own echo: never a turn. */
  notAUser: 'not-a-user',
  /** A group outside `groupAllowlist`. */
  groupNotAllowed: 'group-not-allowed',
  /** A sender outside `senderAllowlist`. */
  senderNotAllowed: 'sender-not-allowed',
  /** A group message that did not address the bot. */
  needsMention: 'needs-mention',
  /** Nothing left after the mention placeholders were stripped. */
  empty: 'empty',
}

/**
 * Reasons that indicate a POLICY rejection rather than ordinary traffic.
 *
 * An unmentioned group message is normal and must not be logged as a rejection,
 * or a busy group would drown the log.
 */
const POLICY_DROPS = new Set([DROP.groupNotAllowed, DROP.senderNotAllowed])

/** Whether a drop is worth telling the operator about. */
export function isPolicyDrop(reason) {
  return POLICY_DROPS.has(reason)
}

/**
 * Decide whether one inbound message may drive a conversation.
 *
 * @param inbound the parsed message (senderType, chatType, chatId, senderId, mentions, text).
 * @param policy  `requireMention`, `groupAllowlist`, `senderAllowlist`.
 * @param text    the message text after mention placeholders were stripped.
 * @returns `{ allow: true }` or `{ allow: false, reason }`.
 */
export function admit(inbound, policy, text) {
  if (!inbound) return { allow: false, reason: DROP.empty }
  // Feishu reports sender_type as `user` or `app`; anything that is not a real
  // user (another bot, or this app's own echo) must never open a turn.
  if (inbound.senderType && inbound.senderType !== 'user') {
    return { allow: false, reason: DROP.notAUser }
  }

  const groups = policy?.groupAllowlist ?? []
  const senders = policy?.senderAllowlist ?? []
  const isGroup = inbound.chatType === 'group'

  // An allowlist that is EMPTY means "no restriction"; a non-empty one must match.
  if (groups.length > 0 && isGroup && !groups.includes(inbound.chatId)) {
    return { allow: false, reason: DROP.groupNotAllowed }
  }
  if (senders.length > 0 && !senders.includes(inbound.senderId)) {
    return { allow: false, reason: DROP.senderNotAllowed }
  }
  if (policy?.requireMention && isGroup && (inbound.mentions?.length ?? 0) === 0) {
    return { allow: false, reason: DROP.needsMention }
  }
  if (!text) return { allow: false, reason: DROP.empty }

  return { allow: true }
}
