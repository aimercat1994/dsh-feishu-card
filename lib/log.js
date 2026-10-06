/**
 * A logger that survives a log-less deployment.
 *
 * The harness's own console may be a pipe nobody reads (this deployment runs
 * under a supervisor), so a chat bridge whose failures are only on stdout is
 * undebuggable. Every line therefore also lands in a file next to the plugin's
 * state, which is the only channel guaranteed to be inspectable afterwards.
 *
 * @module dsh-feishu-card/log
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** Bound the file so a chatty failure loop cannot fill the disk. */
const MAX_BYTES = 512 * 1024

/** Render one log argument without exploding on objects or errors. */
function render(value) {
  if (value instanceof Error) return `${value.message}${value.stack ? `\n${value.stack}` : ''}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Wrap a Cordis logger so each call also appends to `<dir>/dsh-feishu-card.log`.
 *
 * Writing is fire-and-forget: logging must never delay or fail a delivery path.
 */
export function createLogger(base, dir) {
  const file = join(dir, 'dsh-feishu-card.log')
  let ready
  /** Bytes in the file, so rotation needs no stat per line. */
  let bytes = 0
  let measured = false

  /**
   * Append one line, rotating first when the file has grown past the cap.
   *
   * Rotation renames to `.1` (replacing the previous `.1`), so the log is bounded
   * at roughly twice MAX_BYTES without a rotation library. `MAX_BYTES` used to be
   * declared and exported without any code enforcing it, which is worse than not
   * having a cap at all: it reads like the growth is handled.
   */
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${args.map(render).join(' ')}
`
    ready = (ready ?? mkdir(dir, { recursive: true }))
      .then(async () => {
        if (!measured) {
          measured = true
          const { stat } = await import('node:fs/promises')
          bytes = (await stat(file).catch(() => ({ size: 0 }))).size
        }
        if (bytes > MAX_BYTES) {
          const { rename } = await import('node:fs/promises')
          await rename(file, `${file}.1`).catch(() => {})
          bytes = 0
        }
        await appendFile(file, line, 'utf8')
        bytes += Buffer.byteLength(line)
      })
      .catch(() => {})
    return ready
  }

  const forward = (level) =>
    (...args) => {
      void write(level, args)
      const target = base?.[level]
      if (typeof target === 'function') {
        try {
          target.call(base, ...args)
        } catch {
          // A broken console sink must not break the plugin.
        }
      }
    }

  return {
    path: file,
    info: forward('info'),
    warn: forward('warn'),
    error: forward('error'),
    debug: forward('debug'),
  }
}

export { MAX_BYTES }
