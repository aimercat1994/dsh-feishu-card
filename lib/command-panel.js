/**
 * Keeping the Feishu slash-command panel honest.
 *
 * Feishu shows a command picker when someone types `/`, fed by commands registered
 * on the APP. Nothing keeps that list in step with what the bot actually
 * implements: uninstalling a plugin leaves its commands behind, so the panel goes
 * on advertising commands that now answer "unknown command". This module computes
 * the difference; the caller applies it.
 *
 * The plan is a pure function of two lists, so the rules are testable without an
 * app: what counts as a valid command name, which side wins a name collision, and
 * when an existing entry is updated rather than recreated.
 *
 * @module dsh-feishu-card/command-panel
 */

/** Feishu accepts a lowercase word: letters, digits and underscores. */
export const COMMAND_NAME = /^[a-z][a-z0-9_]{0,19}$/

/** The panel shows one line per command, so the description must fit one. */
const MAX_DESCRIPTION = 40

/** Fallback when a command carries no description. */
const NO_DESCRIPTION = '（无说明）'

/**
 * The commands this channel answers itself.
 *
 * They are listed LAST when building the desired set, so one of them overwrites a
 * host command of the same name: this plugin intercepts these before the host
 * registry sees them, so this is what actually runs.
 */
export const OWN_PANEL_COMMANDS = [
  { command: 'help', description: '显示可用命令' },
  { command: 'model', description: '查看与切换本会话的模型' },
  { command: 'new', description: '开始新会话' },
  { command: 'status', description: '查看当前会话与卡片状态' },
  { command: 'permission', description: '选择沙箱与审批权限' },
  { command: 'preset', description: '选择本会话的模式' },
  { command: 'sessions', description: '选择并切换会话' },
  { command: 'stop', description: '停止当前任务' },
  { command: 'switch', description: '直接切换到某个会话' },
]

/** One line's worth of description. */
function tidy(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return NO_DESCRIPTION
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat
}

/**
 * Build the command set the panel should show.
 *
 * Names the platform would reject are dropped rather than sent: a rejected create
 * aborts the whole sync, which would leave the panel half-updated.
 *
 * @param hostCommands descriptors from the host's command registry (`{name, description}`).
 * @param own          this channel's own commands.
 */
export function desiredPanelEntries({ hostCommands = [], own = OWN_PANEL_COMMANDS } = {}) {
  const byName = new Map()
  for (const item of Array.isArray(hostCommands) ? hostCommands : []) {
    const command = String(item?.name ?? '').trim().toLowerCase()
    if (!COMMAND_NAME.test(command)) continue
    byName.set(command, { command, description: tidy(item?.description) })
  }
  for (const item of own) byName.set(item.command, { command: item.command, description: tidy(item.description) })
  return [...byName.values()].sort((a, b) => a.command.localeCompare(b.command))
}

/**
 * Compare what the app has with what it should have.
 *
 * An entry whose description drifted is UPDATED, not recreated: deleting and
 * recreating would churn ids that other tooling may hold.
 *
 * @returns `{ remove, create, update, keep }` — `remove`/`keep` are the existing
 *          records, `create`/`update` carry the wanted `{command, description}`.
 */
export function planPanelSync({ existing = [], desired = [] } = {}) {
  const want = new Map(desired.map((entry) => [entry.command, entry]))
  const have = new Map()
  for (const item of Array.isArray(existing) ? existing : []) {
    const command = String(item?.command ?? '').trim()
    if (command) have.set(command, item)
  }

  const remove = []
  const update = []
  const keep = []
  for (const [command, item] of have) {
    const target = want.get(command)
    if (!target) {
      remove.push(item)
      continue
    }
    const current = String(item?.description?.default_value ?? '').trim()
    if (current === target.description) keep.push(command)
    else update.push({ id: item.command_id, command, description: target.description })
  }

  const create = [...want.values()].filter((entry) => !have.has(entry.command))
  return { remove, create, update, keep }
}

/**
 * Apply a plan through an injected transport.
 *
 * Failures are counted rather than thrown: the panel is cosmetic, and one refused
 * command must not abandon the rest of the reconciliation.
 *
 * @returns `{ created, updated, removed, failed }`.
 */
export async function applyPanelSync(plan, transport, logger) {
  const done = { created: 0, updated: 0, removed: 0, failed: 0 }
  const attempt = async (what, run) => {
    try {
      await run()
      done[what] += 1
    } catch (error) {
      done.failed += 1
      logger?.warn?.(`[feishu-card] slash-command panel: could not ${what.slice(0, -1)} an entry`, error)
    }
  }
  for (const item of plan.remove) await attempt('removed', () => transport.deleteSlashCommand(item.command_id))
  for (const entry of plan.update) {
    await attempt('updated', () => transport.updateSlashCommand(entry.id, entry))
  }
  for (const entry of plan.create) await attempt('created', () => transport.createSlashCommand(entry))
  return done
}
