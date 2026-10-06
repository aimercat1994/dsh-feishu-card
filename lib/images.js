/**
 * Turning images a user sent into prompt parts.
 *
 * Every step here can fail on its own — the download, the format, the deployment
 * policy — and a failure must cost only that image. The text the user typed still
 * has to arrive: dropping the whole prompt because one attachment was a corrupt
 * WebP is a worse outcome than answering without the image.
 *
 * So the result is deliberately two lists: the parts to send, and human-readable
 * reasons for the ones left out. The caller reports the reasons.
 *
 * @module dsh-feishu-card/images
 */

/**
 * Resolve image keys into prompt content parts.
 *
 * @param imageKeys   image keys from the inbound message, in order.
 * @param messageId   the message the resources belong to.
 * @param transport   needs `downloadImage(messageId, fileKey, maxBytes)`.
 * @param attachments optional attachment service, for policy and pre-validation.
 * @param limit       cap on how many images to take from this message.
 * @param logger      optional.
 * @returns `{ parts, failures }` — `parts` are `{type:'image', mediaType, data}`.
 */
export async function resolveImages({
  imageKeys,
  messageId,
  transport,
  attachments,
  limit = 4,
  logger,
}) {
  const parts = []
  const failures = []
  const keys = Array.isArray(imageKeys) ? imageKeys : []
  if (keys.length === 0) return { parts, failures }

  const limits = attachments?.imageLimits
  const accepted = limits?.mediaTypes ?? ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  const maxBytes = limits?.maxImageBytes
  // A deployment cap below the operator's own limit must win: exceeding it would
  // only move the rejection later, after the bytes were already downloaded.
  const cap = Math.max(0, Math.min(limit, limits?.maxImagesPerMessage ?? limit))
  if (keys.length > cap) {
    failures.push(`一条消息最多附带 ${cap} 张图片，多余的已忽略`)
  }

  for (const fileKey of keys.slice(0, cap)) {
    try {
      const downloaded = await transport.downloadImage(messageId, fileKey, maxBytes)
      if (!downloaded) {
        failures.push('有一张图片的格式无法识别，已忽略')
        continue
      }
      if (!accepted.includes(downloaded.mediaType)) {
        failures.push(`不支持 ${downloaded.mediaType} 格式的图片，已忽略`)
        continue
      }
      // Pre-validate so a policy refusal is reported per image, instead of the
      // attachment layer rejecting the entire prompt (text included) later.
      if (typeof attachments?.validateImage === 'function') {
        await attachments.validateImage({
          data: downloaded.bytes,
          mediaType: downloaded.mediaType,
        })
      }
      parts.push({
        type: 'image',
        mediaType: downloaded.mediaType,
        data: downloaded.bytes.toString('base64'),
      })
    } catch (error) {
      logger?.warn?.('[feishu-card] could not attach an image', error)
      failures.push(`有一张图片读取失败（${error?.message ?? error}），已忽略`)
    }
  }

  return { parts, failures }
}

/**
 * Assemble the prompt content: the user's text first, then the images.
 *
 * A message may be images only, in which case the text part is omitted rather than
 * sent empty.
 */
export function promptContent(text, imageParts) {
  const content = []
  if (typeof text === 'string' && text.length > 0) content.push({ type: 'text', text })
  content.push(...(imageParts ?? []))
  return content
}

/** A one-line note about images that were left out, or an empty string. */
export function failureNote(failures) {
  const list = (failures ?? []).filter(Boolean)
  return list.length > 0 ? `⚠️ ${list.join('；')}` : ''
}
