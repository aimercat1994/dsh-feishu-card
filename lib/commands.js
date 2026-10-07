/**
 * Slash commands.
 *
 * The plugin deliberately implements almost no commands. The harness already
 * owns a command registry with every built-in and plugin-registered command
 * (`/model`, `/compact`, `/goal`, `/permission`, …), so a chat line that starts
 * with `/` is forwarded to `commands.execute` and its answer is rendered into
 * the card. Re-implementing them per surface would drift from the harness the
 * moment a plugin registers its own.
 *
 * Only the commands that describe *this channel* are handled here.
 *
 * @module dsh-feishu-card/commands
 */

/** Any line beginning with a slash-command name. */
export const COMMAND_LINE = /^\/([a-zA-Z][\w-]*)/

/** Whether a message is a command line rather than a prompt. */
export function isCommandLine(text) {
  return COMMAND_LINE.test(text)
}

/** The command name without its leading slash, lowercased. */
export function commandName(text) {
  const match = COMMAND_LINE.exec(text)
  return match ? match[1].toLowerCase() : undefined
}

/** Localized strings owned by this plugin. */
const TEXT = {
  zh: {
    unknown: (name) => `未知命令 \`/${name}\`。`,
    unsupportedMessageType: (kind) => `暂不支持处理「${kind}」类型的消息，请发文字或图片。`,
    nothingToSend: '⚠️ 这条消息没有可处理的内容（图片没能读取，也没有文字）。',
    helpHeading: '**本渠道命令**',
    hostHeading: '**Harness 命令**',
    noCommands: '（没有可用的命令）',
    stopped: '⏹ 已停止当前任务',
    newSession: '已开始新会话。',
    statusIdle: '空闲',
    statusBusy: '进行中',
    pluginCommands: [
      '`/new` — 断开该会话绑定，下一条消息开新 session',
      '`/status` — 查看绑定的 session 与卡片状态',
      '`/model` — 查看与切换本会话的模型',
    '`/preset` — 选择本会话的模式（仅限未开始的会话）',
    '`/permission` — 选择沙箱与审批权限',
    '`/sessions` — 选择并切换会话',
    '`/switch <id>` — 直接切换到某个会话',
    '`/stop` — 停止当前回合',
      '`/help` — 本帮助',
    ],
  },
  en: {
    unknown: (name) => `Unknown command \`/${name}\`.`,
    unsupportedMessageType: (kind) => `Messages of type "${kind}" are not supported yet; send text or an image.`,
    nothingToSend: '⚠️ Nothing to process: no text and the image could not be read.',
    helpHeading: '**Channel commands**',
    hostHeading: '**Harness commands**',
    noCommands: '(no commands available)',
    stopped: '⏹ Stopped the current turn',
    newSession: 'Started a new session.',
    statusIdle: 'idle',
    statusBusy: 'running',
    pluginCommands: [
      '`/new` — drop this conversation binding; the next message starts a new session',
      '`/status` — show the bound session and card state',
      '`/model` — view and switch this conversation\'s model',
    '`/preset` — choose this session\'s preset (unstarted sessions only)',
    '`/permission` — choose the sandbox and approval policy',
    '`/sessions` — choose and switch sessions',
    '`/switch <id>` — switch to one session directly',
    '`/stop` — stop the current turn',
      '`/help` — this help',
    ],
  },
}

/** Text table for one locale. */
export function strings(locale) {
  return TEXT[locale] ?? TEXT.zh
}

/**
 * Render the help text: the harness's own command registry first (authoritative,
 * includes plugin-registered commands), then this channel's additions.
 */
export async function helpText({ commands, agent, locale, logger }) {
  const t = strings(locale)
  const lines = [t.helpHeading, ...t.pluginCommands, '']
  let host = []
  try {
    host = [...(commands?.list?.(agent) ?? [])]
  } catch (error) {
    logger?.warn?.('[feishu-card] listing harness commands failed', error)
  }
  lines.push(t.hostHeading)
  if (host.length === 0) lines.push(t.noCommands)
  else for (const descriptor of host) lines.push(`\`/${descriptor.name}\` — ${descriptor.description}`)
  return lines.join('\n')
}

/**
 * Run one command line.
 *
 * @returns the reply text, and whether the harness reported an error.
 */
export async function runCommandLine({ commands, agent, line, locale, logger, signal }) {
  const t = strings(locale)
  const name = commandName(line)
  if (name === undefined) return { text: line }

  let execution
  try {
    execution = await commands?.execute?.(agent, line, [], signal)
  } catch (error) {
    logger?.warn?.(`[feishu-card] running /${name} failed`, error)
    return { text: `⚠️ \`/${name}\` 执行失败：${error?.message ?? error}`, error: true }
  }

  if (execution === undefined) {
    // The harness does not know this name: say so, then show what does exist.
    return { text: `${t.unknown(name)}\n\n${await helpText({ commands, agent, locale, logger })}`, error: true }
  }
  const result = execution.result
  if (result.kind === 'error') return { text: `⚠️ ${result.text}`, error: true }
  return { text: result.text ?? `✅ \`/${name}\` 已执行` }
}
