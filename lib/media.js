/**
 * Inbound media: reading what Feishu sent, and knowing what it is.
 *
 * Feishu returns image resources as raw bytes with no declared content type, so
 * the type has to be sniffed from the bytes themselves. Guessing wrong is not
 * cosmetic: the attachment service validates against the declared media type and
 * refuses a mismatch, which would turn every image into a failed prompt.
 *
 * @module dsh-feishu-card/media
 */

/** Magic-byte signatures for the media types the attachment service accepts. */
const SIGNATURES = [
  { mediaType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
]

/** Whether the bytes at `offset` match. */
function matches(bytes, offset, signature) {
  if (bytes.length < offset + signature.length) return false
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * Identify an encoded image from its leading bytes.
 *
 * @returns the media type, or `undefined` when it is not an image this harness
 *          accepts. Callers must treat `undefined` as "refuse", never as "assume".
 */
export function sniffImageMediaType(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 12) return undefined
  for (const { mediaType, bytes: signature } of SIGNATURES) {
    if (matches(bytes, 0, signature)) return mediaType
  }
  // WEBP is a RIFF container: "RIFF" .... "WEBP"
  if (matches(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, 8, [0x57, 0x45, 0x42, 0x50])) {
    return 'image/webp'
  }
  return undefined
}

/**
 * Extract the text and image keys from a `post` (rich text) message.
 *
 * The payload nests paragraphs of tagged nodes, and images can appear anywhere in
 * them. A malformed payload yields what could be read rather than throwing: a
 * partially readable message beats losing the whole turn.
 */
export function parsePostContent(content) {
  const out = { text: '', imageKeys: [] }
  let parsed
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : content
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== 'object') return out
  if (typeof parsed.title === 'string' && parsed.title) out.text += `${parsed.title}\n`

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    if (node.tag === 'img' && typeof node.image_key === 'string') out.imageKeys.push(node.image_key)
    else if (node.tag === 'text' && typeof node.text === 'string') out.text += node.text
    else if (node.tag === 'a' && typeof node.text === 'string') out.text += node.text
    else if (node.tag === 'at' && typeof node.user_id === 'string') out.text += `@${node.user_id} `
    if (Array.isArray(node.content)) node.content.forEach(walk)
  }
  walk(parsed.content)
  return { text: out.text.trim(), imageKeys: out.imageKeys }
}

/**
 * Drain a readable stream into one buffer.
 *
 * Bounded on purpose: an unbounded collect on a mislabelled resource is how a
 * chat message turns into a memory exhaustion.
 */
export async function collectStream(stream, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (typeof maxBytes === 'number' && total > maxBytes) {
      throw new Error(`resource exceeds the ${maxBytes} byte limit`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
