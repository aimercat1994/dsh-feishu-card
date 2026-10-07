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

/**
 * The commands this channel implements, with a one-line description each.
 *
 * One structured list rather than pre-formatted lines: the text help and the `/help`
 * card both render it, and two renderings of the same fact drift apart.
 *
 * `usage` is the FULL form (`/switch <id>`), matching what `commandUsage()` derives
 * from a host descriptor — one shape, so a renderer never has to know which side a
 * command came from.
 */
const OWN_COMMANDS = {
  zh: [
    { name: 'new', description: '开新会话并选择模式' },
    { name: 'model', usage: '/model [<provider>/<model>] [档位]', description: '查看与切换本会话的模型（含推理档位）' },
    { name: 'sessions', description: '选择并切换会话' },
    { name: 'switch', usage: '/switch <会话 id 或前缀>', description: '直接切换到某个会话' },
    { name: 'permission', description: '选择沙箱模式与审批策略' },
    { name: 'status', description: '查看绑定的会话与卡片状态' },
    { name: 'stop', description: '停止当前回合' },
    { name: 'help', description: '本帮助' },
  ],
  en: [
    { name: 'new', description: 'start a new session and choose its preset' },
    { name: 'model', usage: '/model [<provider>/<model>] [effort]', description: "view and switch this conversation's model (and reasoning effort)" },
    { name: 'sessions', description: 'choose and switch sessions' },
    { name: 'switch', usage: '/switch <session id or prefix>', description: 'switch to one session directly' },
    { name: 'permission', description: 'choose the sandbox mode and approval policy' },
    { name: 'status', description: 'show the bound session and card state' },
    { name: 'stop', description: 'stop the current turn' },
    { name: 'help', description: 'this help' },
  ],
}

/** This channel's own commands for one locale. */
export function ownCommands(locale) {
  return OWN_COMMANDS[locale] ?? OWN_COMMANDS.zh
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
    pluginCommands: ownCommands('zh').map((c) => `\`${c.usage ?? `/${c.name}`}\` — ${c.description}`),
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
    pluginCommands: ownCommands('en').map((c) => `\`${c.usage ?? `/${c.name}`}\` — ${c.description}`),
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
/**
 * The usage form of a command, when it declares one.
 *
 * The host's `input.hint` is the only authoritative statement of what a command
 * takes — the description is prose.
 */
export function commandUsage(descriptor) {
  const hint = descriptor?.input?.hint
  return typeof hint === 'string' && hint.trim().length > 0 ? `/${descriptor.name} ${hint.trim()}` : undefined
}

/** The descriptor for one command name, or undefined. */
export function findCommand(commands, agent, name) {
  try {
    return [...(commands?.list?.(agent) ?? [])].find((entry) => entry.name === name)
  } catch {
    return undefined
  }
}

/**
 * Run one slash line through the harness registry.
 *
 * Two things beyond dispatch:
 *
 *  * ATTACHMENTS are forwarded, so a command that declares `input.attachments` can
 *    receive the images the user sent with it. The host admits them, and rejects
 *    them for a command that does not declare the capability — so this only passes
 *    what the descriptor allows.
 *  * A bare invocation of a command that takes an argument gets its USAGE appended.
 *    Without it the answer is often a plausible-looking list and the user never
 *    learns the command had a form at all.
 *
 * @returns `{ text, error? }` for the caller to render.
 */
export async function runCommandLine({
  commands,
  agent,
  line,
  locale,
  logger,
  signal,
  submittedAttachments = [],
}) {
  const t = strings(locale)
  const name = commandName(line)
  if (name === undefined) return { text: line }

  const descriptor = findCommand(commands, agent, name)
  const usage = commandUsage(descriptor)
  const rawInput = line.slice(1 + name.length).trim()

  let execution
  try {
    execution = await commands?.execute?.(agent, line, submittedAttachments, signal)
  } catch (error) {
    logger?.warn?.(`[feishu-card] running /${name} failed`, error)
    return { text: `⚠️ \`/${name}\` 执行失败：${error?.message ?? error}`, error: true }
  }

  // Appended only for a bare invocation: once the user supplied an argument they
  // have evidently found the form, and repeating it every time is noise.
  const withUsage = (body) => (usage !== undefined && rawInput.length === 0 ? `${body}\n\n用法：\`${usage}\`` : body)

  if (execution === undefined) {
    // The harness does not know this name: say so, then show what does exist.
    return { text: withUsage(`${t.unknown(name)}\n\n${await helpText({ commands, agent, locale, logger })}`), error: true }
  }
  const result = execution.result
  if (result.kind === 'error') return { text: withUsage(`⚠️ ${result.text}`), error: true }
  return { text: withUsage(result.text ?? `✅ \`/${name}\` 已执行`) }
}

