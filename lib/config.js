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

/** The schema the Settings page and the profile patch validate against. */
export const Config = z.object({
  appId: z.string().default(''),
  appSecret: z.string().role('secret').default(''),
  domain: z.string().default(''),
  cwd: z.string().default(''),
  sessionScope: z.union(SESSION_SCOPES).default('chat'),
  locale: z.union(['auto', 'zh', 'en']).default('auto'),

  // Transport
  requireMention: z.boolean().default(true),
  /**
   * Whether images sent to the bot are attached to the prompt.
   *
   * Default ON. The risk this accepts is real and worth stating: if the active
   * model route cannot accept images, the attachment is still committed to the
   * session, so that conversation is poisoned from then on. `/new` escapes it by
   * starting a fresh session. Set false to refuse images outright.
   */
  images: z.boolean().default(true),
  /** Cap on images taken from one message; the attachment policy caps this too. */
  maxImagesPerMessage: z.number().min(1).max(20).default(4),
  senderAllowlist: z.array(String).default([]),
  groupAllowlist: z.array(String).default([]),
  approvers: z.array(String).default([]),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),

  // Rendering
  showProcess: z.boolean().default(true),
  readingPreset: z.union(['classic', 'focused', 'detailed', 'task']).default('classic'),
  cardInput: z.boolean().default(false),
  // `width_mode` only affects card JSON 2.0; the platform accepts the value and
  // the client decides the real width.
  widthMode: z.union(['default', 'compact', 'fill']).default('default'),
  // The platform does NOT validate text_size — an unknown value is silently
  // ignored — so each field is constrained to a set that renders differently.
  textSizes: z.object({
    reasoning: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
    activity: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
    answer: z.union(['normal', 'notation', 'x-small', 'small']).default('normal'),
    footer: z.union(['normal', 'notation', 'x-small', 'small']).default('notation'),
  }).default({ reasoning: 'notation', activity: 'notation', answer: 'normal', footer: 'notation' }),
  hideProcessWhenDone: z.boolean().default(false),
  reactionFeedback: z.boolean().default(true),
  notices: z.boolean().default(true),
  /** Input-token count at which one context-pressure notice is posted. */
  pressureWarnTokens: z.number().min(0).default(120000),
  flushIntervalMs: z.number().min(50).default(400),
  reasoningTail: z.number().min(0).default(2000),

  // Interactions
  approvalTimeoutSec: z.number().min(0).default(300),
  approvalReminderMs: z.number().min(0).default(0),

  // Lifecycle
  autoResumeGoals: z.boolean().default(false),
  onboarding: z.boolean().default(true),
  stateDir: z.string().default(''),
})

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
