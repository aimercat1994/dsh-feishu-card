/**
 * Credentials: where they come from, and the QR flow that creates them.
 *
 * Resolution order is entry config (profile patch / env) → this plugin's own
 * credentials file → QR onboarding. The host `settings` service in this
 * deployment has no `register`, so a plugin-owned file is the only durable
 * store available; it is written 0600 because it holds an app secret.
 *
 * @module dsh-feishu-card/onboarding
 */

import { mkdir, readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Where plugin-local state lives, unless the config names a directory. */
export function resolveStateDir(configured) {
  return configured && configured.length > 0 ? configured : join(homedir(), '.dsh', 'dsh-feishu-card')
}

/** A durable JSON store for the onboarded app credentials. */
export class CredentialStore {
  #dir
  #file
  #logger

  constructor({ dir, logger }) {
    this.#dir = resolveStateDir(dir)
    this.#file = join(this.#dir, 'credentials.json')
    this.#logger = logger
  }

  get path() {
    return this.#file
  }

  /** Read the stored credentials; a missing or corrupt file reads as none. */
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8'))
      if (typeof parsed?.appId === 'string' && typeof parsed?.appSecret === 'string') {
        return { appId: parsed.appId, appSecret: parsed.appSecret, domain: parsed.domain }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger?.warn?.('[feishu-card] ignoring an unreadable credentials file', error)
      }
    }
    return undefined
  }

  /** Persist credentials atomically and restrict their permissions. */
  async save(credentials) {
    await mkdir(this.#dir, { recursive: true })
    const temp = `${this.#file}.${process.pid}.tmp`
    const payload = JSON.stringify(
      { appId: credentials.appId, appSecret: credentials.appSecret, ...(credentials.domain ? { domain: credentials.domain } : {}) },
      null,
      2,
    )
    try {
      await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600)
      await rename(temp, this.#file)
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
    return this.#file
  }
}

/** Print a scannable QR when the optional renderer is present, else the URL. */
async function presentUrl(url, expireIn, dir, logger) {
  const seconds = Math.round(expireIn / 1000)
  logger?.info?.(`[feishu-card] 扫码创建飞书应用（${seconds}s 内有效）：${url}`)
  // A QR is a convenience; the console may be a log file nobody reads, so the
  // URL is also written where it can always be found.
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'onboarding-url.txt'), `${url}\n`, 'utf8')
  } catch (error) {
    logger?.warn?.('[feishu-card] could not write the onboarding URL file', error)
  }
  try {
    const terminal = await import('qrcode-terminal')
    const generate = terminal.default?.generate ?? terminal.generate
    generate?.(url, { small: true }, (rendered) => {
      logger?.info?.(`[feishu-card] 用飞书扫码：\n${rendered}`)
    })
  } catch {
    // Without the optional renderer the URL above is still sufficient.
  }
}

/**
 * Run the device-code registration until it yields credentials or the operator
 * stops it.
 *
 * An expired QR is re-issued after a floor so a poll loop cannot spin, and any
 * other failure ends the attempt: the plugin stays inert rather than retrying
 * forever.
 *
 * @returns the credentials, or undefined when onboarding did not complete.
 */
export async function beginOnboarding({ registerApp, store, dir, logger, signal, reissueFloorMs = 60_000 }) {
  let attempt = 0
  while (!signal?.aborted) {
    attempt += 1
    let expired = false
    try {
      const result = await registerApp({
        source: 'dsh-feishu-card',
        signal,
        appPreset: { name: 'DSH Agent', desc: 'DSH 会话机器人' },
        addons: {
          scopes: {
            tenant: [
              'im:message',
              'im:message:send_as_bot',
              'im:message:readonly',
              'im:resource',
              'im:chat:read',
              'im:message.reactions',
            ],
          },
          events: { items: { tenant: ['im.message.receive_v1'] } },
          callbacks: { items: ['card.action.trigger'] },
        },
        onQRCodeReady: ({ url, expireIn }) => {
          void presentUrl(url, expireIn, dir, logger)
        },
        onStatusChange: (info) => {
          if (info?.status === 'expired_token') expired = true
        },
      })
      if (!result?.client_id || !result?.client_secret) {
        logger?.error?.('[feishu-card] app registration returned no credentials')
        return undefined
      }
      const credentials = { appId: result.client_id, appSecret: result.client_secret }
      try {
        await store.save(credentials)
        logger?.info?.(`[feishu-card] 应用 ${credentials.appId} 注册成功，凭证已写入 ${store.path}`)
      } catch (error) {
        logger?.warn?.('[feishu-card] credentials acquired but not persisted', error)
      }
      return credentials
    } catch (error) {
      if (signal?.aborted) return undefined
      const code = error?.code ?? error?.message ?? String(error)
      if (expired || String(code).includes('expired')) {
        logger?.warn?.(`[feishu-card] 二维码已过期，重新生成（第 ${attempt} 次）`)
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, reissueFloorMs)
          timer.unref?.()
        })
        continue
      }
      logger?.error?.('[feishu-card] app registration failed; the plugin stays inert', error)
      return undefined
    }
  }
  return undefined
}
