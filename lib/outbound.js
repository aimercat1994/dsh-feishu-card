/**
 * Outbound files: let the agent hand a file back to the chat.
 *
 * This is the one capability in this plugin that can move bytes OUT of the
 * machine, so the path check is the load-bearing part and is written accordingly:
 *
 *  * the request is resolved against the workspace, then **realpath'd** — a
 *    prefix check on the unresolved path is defeated by a symlink inside the
 *    workspace pointing anywhere else, which is exactly the case an attacker
 *    would arrange;
 *  * both the file and every allowed root are canonicalized before comparison;
 *  * the file must be a regular file, non-empty, and within the upload limit
 *    (the platform refuses >30 MB and empty files).
 *
 * The workspace itself is always allowed. That adds no file access — the agent can
 * already read there — it only adds the ability to send what it can already read.
 *
 * @module dsh-feishu-card/outbound
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, resolve, sep } from 'node:path'

/** The tool name the model sees. */
export const SEND_FILE_TOOL = 'send_file'

/** The platform refuses uploads above this, so refuse them earlier and clearer. */
export const PLATFORM_MAX_BYTES = 30 * 1024 * 1024

/**
 * Canonicalize one path, or return undefined when it does not exist.
 */
async function canonical(target) {
  try {
    return await realpath(target)
  } catch {
    return undefined
  }
}

/** Whether `child` is `root` itself or lives beneath it. */
export function isInside(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string') return false
  if (child === root) return true
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Resolve a requested path to something sendable.
 *
 * @returns `{ ok: true, path, name, bytes }` or `{ ok: false, reason }` — the
 *          reason is written for the model, which has to explain itself to a human.
 */
export async function resolveSendablePath(inputPath, { cwd, allowedDirs = [], maxBytes = PLATFORM_MAX_BYTES }) {
  if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    return { ok: false, reason: 'path 不能为空' }
  }
  const requested = resolve(cwd, inputPath)
  const real = await canonical(requested)
  if (!real) return { ok: false, reason: `文件不存在：${inputPath}` }

  let info
  try {
    info = await stat(real)
  } catch {
    return { ok: false, reason: `无法读取：${inputPath}` }
  }
  if (!info.isFile()) return { ok: false, reason: `不是普通文件：${inputPath}` }
  if (info.size === 0) return { ok: false, reason: '平台不接受空文件' }
  if (info.size > maxBytes) {
    return { ok: false, reason: `文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 上限` }
  }

  // Canonicalize the roots too: comparing a real path against an unresolved root
  // would reject a legitimate workspace reached through a symlink.
  const roots = [cwd, ...allowedDirs]
  for (const root of roots) {
    const realRoot = await canonical(root)
    if (realRoot && isInside(real, realRoot)) {
      return { ok: true, path: real, name: basename(real), bytes: info.size }
    }
  }
  return {
    ok: false,
    reason: `不在允许发送的目录内（工作区：${cwd}${allowedDirs.length ? `，另允许 ${allowedDirs.length} 个目录` : ''}）`,
  }
}

/**
 * The tool definition handed to `tools.register`.
 *
 * Written as plain JSON Schema rather than through `defineTool`: that helper lives
 * in a package this plugin cannot resolve, and it only converts its own flattened
 * spec into JSON Schema anyway. The cost is that argument validation is ours —
 * which is why the checks below read as instructions to the model.
 *
 * @param deps.resolve  `resolveSendablePath` bound to this agent's policy.
 * @param deps.send     `(file) => Promise<{messageId}>` — uploads and delivers.
 */
export function buildSendFileTool({ resolve, send, logger }) {
  return {
    name: SEND_FILE_TOOL,
    description:
      'Send one file from the workspace to the user as a chat attachment. Use it to '
      + 'deliver a finished artifact (a report, an exported data file, a chart, a '
      + 'generated document) — not to show file contents, which belong in your reply. '
      + 'The file must already exist on disk and be inside the workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to send, relative to the workspace or absolute.',
        },
        caption: {
          type: 'string',
          description: 'Optional one-line note to send alongside the file.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sent', 'name', 'bytes'],
        properties: {
          sent: { type: 'boolean', description: 'Whether the file was delivered.' },
          name: { type: 'string', description: 'File name as the user sees it.' },
          bytes: { type: 'integer', description: 'Size of the delivered file.' },
        },
      },
      render(args, value) {
        if (value?.sent === false) return [{ type: 'text', text: `未发送：${value.reason ?? '未知原因'}` }]
        const size = typeof value?.bytes === 'number' ? ` (${Math.round(value.bytes / 1024)} KB)` : ''
        return [{ type: 'text', text: `已发送文件 ${value?.name ?? args?.path ?? ''}${size}` }]
      },
    },
    async execute(args) {
      const outcome = await resolve(args?.path)
      if (!outcome.ok) {
        // A refusal is a normal result, not a crash: the model should relay the
        // reason and try something else.
        logger?.info?.(`[feishu-card] refused to send ${args?.path}: ${outcome.reason}`)
        return { sent: false, name: String(args?.path ?? ''), bytes: 0, reason: outcome.reason }
      }
      const bytes = await readFile(outcome.path)
      const delivered = await send({
        bytes,
        name: outcome.name,
        caption: typeof args?.caption === 'string' ? args.caption : undefined,
      })
      logger?.info?.(`[feishu-card] sent file ${outcome.name} (${outcome.bytes} bytes) as ${delivered?.messageId ?? '?'}`)
      return { sent: true, name: outcome.name, bytes: outcome.bytes }
    },
  }
}
