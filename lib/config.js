/**
 * Plugin configuration.
 *
 * The `Config` schema is what the Settings page renders and what validates the
 * profile patch row. `resolveConfig` additionally folds in the process
 * environment, so the plugin works from env vars alone.
 *
 * @module dsh-feishu-card/config
 */

import z from '@deepseek-ai/schemastery'

/** How one chat facet maps to a DSH session. */
export const SESSION_SCOPES = ['chat', 'chat-thread', 'chat-sender']

/** Tools whose answer cannot reach a Feishu chat, denied per chat agent by default. */
const DEFAULT_DENY_TOOLS = []

/**
 * Fields the Settings page must NOT offer as live settings.
 *
 * Both are read once while the plugin mounts — `stateDir` decides where the log
 * file, credential store and rotation record live; `onboarding` decides whether a
 * missing credential starts the QR flow. Offering them as live settings would
 * promise an effect they cannot have.
 */
const MOUNT_ONLY = new Set(['stateDir', 'onboarding'])

/**
 * Mark the remaining fields volatile — which is what makes the Settings page
 * exist at all, not a refinement of it.
 *
 * The host projects a plugin's Config down to the fields that apply live
 * (`volatileForm`) and drops every other field; a schema with no volatile field
 * yields no form, the entry is skipped by `settings.describe()`, its namespace
 * never reaches the browser, and the page can only report that the namespace is
 * missing. Marking is the difference between a working page and a dead one.
 *
 * Volatile also means what it says: the loader writes the new value into the live
 * schema in place and emits `loader/volatile-update` instead of restarting the
 * plugin, so this plugin re-reads the affected settings from that event.
 */
function withVolatileFields(schema) {
  const dict = Object.fromEntries(
    Object.entries(schema.dict ?? {}).map(([key, field]) => [
      key,
      MOUNT_ONLY.has(key) ? field : field.volatile(),
    ]),
  )
  return z.object(dict)
}

/**
 * The schema the Settings page renders and the profile patch validates against.
 *
 * EVERY field carries `.description()`: the Settings page is schema-driven, so a
 * field without one renders as an unlabelled input. The description is the only
 * place a user can learn what a field does — the JSDoc above a field is for
 * whoever reads the source, not for the form.
 */
const FIELDS = z.object({
  // --- Feishu connection ---------------------------------------------------
  appId: z.string().default('')
    .description('飞书应用的 App ID（cli_ 开头）。留空则用环境变量 FEISHU_APP_ID、本地凭据文件，或走扫码建应用。'),
  appSecret: z.string().role('secret').default('')
    .description('飞书应用的 App Secret。留空则用环境变量 FEISHU_APP_SECRET、本地凭据文件，或走扫码建应用。'),
  domain: z.string().default('')
    .description('Open API 域名。国际版 Lark 填 https://open.larksuite.com，国内飞书留空。'),

  // --- Workspace & session -------------------------------------------------
  cwd: z.string().default('')
    .description('新会话的工作目录（飞书里开的对话从哪里开始）。留空则自动选择一个已注册的工作区，并排除 Harness 自身的安装目录。'),
  sessionScope: z.union(SESSION_SCOPES).default('chat')
    .description('一个飞书会话如何映射到 DSH session：chat=整个会话一个；chat-thread=每个话题一个；chat-sender=每个人一个。'),
  locale: z.union(['auto', 'zh', 'en']).default('auto')
    .description('机器人回复的语言。auto 跟随飞书消息的语言。'),

  // --- Transport -----------------------------------------------------------
  requireMention: z.boolean().default(true)
    .description('群里是否需要 @机器人 才响应。私聊不受影响。'),
  images: z.boolean().default(true)
    .description('把用户发来的图片附进 prompt。注意：若当前模型路由不支持图片，附件仍会写入会话历史，该会话此后会受影响——发 /new 可换一个新会话。'),
  maxImagesPerMessage: z.number().min(1).max(20).default(4)
    .description('一条消息最多取几张图。附件策略的上限更小时以策略为准。'),
  fileOutput: z.boolean().default(true)
    .description('允许 agent 用 send_file 把工作区里的文件作为附件发到聊天。工作区始终可发——它本就能读那里，这只是让它能把读到的东西交出来。'),
  allowedFileDirs: z.array(String).default([])
    .description('除工作区外，还允许 agent 发送文件的目录。注意这**不是安全边界**：agent 有文件工具，可以把文件复制进工作区再发。'),
  maxFileBytes: z.number().min(1).default(30 * 1024 * 1024)
    .description('发送文件的大小上限（字节）。平台硬限制 30 MB，超过平台也会拒。'),
  senderAllowlist: z.array(String).default([])
    .description('私聊白名单（open_id）。留空表示不限制。不在名单里的发送者会被丢弃，并记一条日志。'),
  groupAllowlist: z.array(String).default([])
    .description('群白名单（chat_id）。留空表示不限制。只约束群，私聊不受影响。'),
  approvers: z.array(String).default([])
    .description('谁可以点审批按钮（open_id）。留空则按上面的发送者/群白名单判断。'),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS])
    .description('在飞书渠道禁用的工具名。留空表示与 GUI 同权限。被拒时 agent 会收到一条说明，而不是静默失败。'),

  // --- Rendering -----------------------------------------------------------
  showProcess: z.boolean().default(true)
    .description('是否显示可折叠的「思考 + 工具」过程面板。关闭后正文仍在，但过程不可见。'),
  readingPreset: z.union(['classic', 'focused', 'detailed', 'task']).default('classic')
    .description('卡片版式预设。classic=过程折叠且折叠时隐藏正文细节；focused=只留过程标题；detailed=过程默认展开；task=偏任务视图。'),
  cardInput: z.boolean().default(false)
    .description('在提问卡片里放一个输入框。默认关闭：飞书的 input 元素会弹客户端原生面板，各端体验不一致，直接回复聊天更自然。'),
  widthMode: z.union(['default', 'compact', 'fill']).default('default')
    .description('卡片宽度（仅 JSON 2.0 卡片）。最终宽度仍由客户端决定。'),
  textSizes: z.object({
    reasoning: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
    activity: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
    answer: z.union(['normal', 'notation', 'x-small', 'small']).default('normal'),
    footer: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
  }).default({ reasoning: 'notation', activity: 'notation', answer: 'normal', footer: 'notation' })
    .description('逐区域的字号：reasoning=思考，activity=工具动作，answer=正文，footer=页脚。平台不校验该字段，所以这里只提供已知能渲染出差异的取值。'),
  hideProcessWhenDone: z.boolean().default(false)
    .description('回合结束后强制折叠过程面板。'),
  reactionFeedback: z.boolean().default(true)
    .description('在用户那条消息上打状态表情：OK → THINKING → DONE/ERROR。'),
  notices: z.boolean().default(true)
    .description('报告模型重试、上下文用量、压缩失败与后台任务结束。'),
  pressureWarnTokens: z.number().min(0).default(120000)
    .description('输入 token 达到该值时提示一次上下文用量。降回去之后会重新武装。'),
  flushIntervalMs: z.number().min(50).default(400)
    .description('流式写入的合并间隔（毫秒）。越小越跟手，越大越省 API 调用。'),
  reasoningTail: z.number().min(0).default(2000)
    .description('过程面板只显示思考的最后 N 个字符，0 表示不截断。'),

  // --- Interactions --------------------------------------------------------
  approvalTimeoutSec: z.number().min(0).default(300)
    .description('等待审批/回答的秒数，超时按取消处理。0 表示不超时。'),
  approvalReminderMs: z.number().min(0).default(0)
    .description('大于 0 时，每隔这么多毫秒在卡片上追加一句「仍在等待」。'),

  // --- Lifecycle -----------------------------------------------------------
  autoResumeGoals: z.boolean().default(false)
    .description('每条消息前尝试重新武装被 Harness disarm 的 goal。'),
  onboarding: z.boolean().default(true)
    .description('没有凭据时，允许通过扫码注册一个飞书应用并自动订阅事件与回调。'),
  stateDir: z.string().default('')
    .description('凭据、日志与轮换记录的存放目录。留空用 ~/.dsh/dsh-feishu-card。'),
})

/** The exported schema: the field set above, with the live-editable fields marked. */
export const Config = withVolatileFields(FIELDS)

/** Resolve the row config, folding in the process environment and defaults. */
export function resolveConfig(config = {}) {
  const appId = config.appId || process.env.FEISHU_APP_ID || ''
  const appSecret = config.appSecret || process.env.FEISHU_APP_SECRET || ''
  const domain = config.domain || process.env.FEISHU_DOMAIN || ''
  const scope = SESSION_SCOPES.includes(config.sessionScope) ? config.sessionScope : 'chat'
  return {
    appId,
    appSecret,
    domain,
    // Empty means "not configured". `apply` resolves a real workspace, because
    // the host process cwd is the harness installation directory, which is a
    // dangerous place to point a coding agent.
    cwd: config.cwd || '',
    sessionScope: scope,
    // `auto` means English only on the international Lark domain.
    locale: config.locale && config.locale !== 'auto' ? config.locale : domain.includes('larksuite') ? 'en' : 'zh',
    requireMention: config.requireMention !== false,
    images: config.images !== false,
    maxImagesPerMessage: config.maxImagesPerMessage ?? 4,
    fileOutput: config.fileOutput !== false,
    allowedFileDirs: asArray(config.allowedFileDirs),
    maxFileBytes: config.maxFileBytes ?? 30 * 1024 * 1024,
    senderAllowlist: asArray(config.senderAllowlist),
    groupAllowlist: asArray(config.groupAllowlist),
    approvers: asArray(config.approvers),
    denyTools: asArray(config.denyTools),
    showProcess: config.showProcess !== false,
    cardInput: config.cardInput === true,
    widthMode: ['default', 'compact', 'fill'].includes(config.widthMode) ? config.widthMode : 'default',
    textSizes: {
      reasoning: config.textSizes?.reasoning ?? 'notation',
      activity: config.textSizes?.activity ?? 'notation',
      answer: config.textSizes?.answer ?? 'normal',
      footer: config.textSizes?.footer ?? 'notation',
    },
    readingPreset: ['classic', 'focused', 'detailed', 'task'].includes(config.readingPreset)
      ? config.readingPreset
      : 'classic',
    hideProcessWhenDone: config.hideProcessWhenDone === true,
    reactionFeedback: config.reactionFeedback !== false,
    notices: config.notices !== false,
    pressureWarnTokens: numberOr(config.pressureWarnTokens, 120000),
    flushIntervalMs: numberOr(config.flushIntervalMs, 400),
    reasoningTail: numberOr(config.reasoningTail, 2000),
    approvalTimeoutSec: numberOr(config.approvalTimeoutSec, 300),
    approvalReminderMs: numberOr(config.approvalReminderMs, 0),
    autoResumeGoals: config.autoResumeGoals === true,
    onboarding: config.onboarding !== false,
    stateDir: config.stateDir || '',
  }
}

/** Whether the resolved config can actually open a Feishu connection. */
export function hasCredentials(config) {
  return Boolean(config.appId && config.appSecret)
}

function asArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : []
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
