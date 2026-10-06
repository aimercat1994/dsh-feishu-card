/**
 * The channel's tool guard: refuse named tools for agents this channel owns.
 *
 * Why a guard rather than a restriction: `tools.restrict` masks tools out of the
 * model's schema, so the model never sees them and cannot ask for them. A guard
 * runs later and can *deny a call with a reason*, which is what a chat channel
 * wants — the user should be told the tool is unavailable here and why, instead
 * of the model silently behaving as if the capability never existed.
 *
 * Registration is agent-scoped (`agent.ctx`), so unwinding the agent's fiber
 * removes the guard automatically. The contract is monotonic: any matching guard
 * may deny, and none can force-allow what another denied.
 *
 * @module dsh-feishu-card/guard
 */

/** The reason shown to the model when a tool is refused on this channel. */
export const DENIAL_REASON = '该工具在飞书渠道不可用，请直接在对话中用文字提问。'

/**
 * The decision for one execution.
 *
 * Pure, so the policy can be tested without a registry. Note the default: an
 * unknown, empty, or malformed execution is ALLOWED. A guard that denied on
 * garbage would break every other tool in the process.
 *
 * @returns the denial reason, or `undefined` to let the call proceed.
 */
export function denialReason(denied, execution) {
  const name = execution?.name
  if (typeof name !== 'string' || name.length === 0) return undefined
  return denied instanceof Set ? (denied.has(name) ? DENIAL_REASON : undefined) : undefined
}

/**
 * Install the guard on one agent.
 *
 * @param agent        the agent whose scope the guard belongs to.
 * @param denyTools    tool names to refuse.
 * @param logger       optional logger; a denial is logged so it can be verified.
 * @returns the effect disposer, or `undefined` when nothing was installed.
 */
export function installToolGuard(agent, denyTools, logger) {
  const names = Array.isArray(denyTools) ? denyTools.filter((n) => typeof n === 'string' && n) : []
  if (!agent?.ctx || names.length === 0) return undefined
  const tools = agent.ctx.get('tools')
  if (!tools || typeof tools.guard !== 'function') {
    // Never fail silently: an operator who set `denyTools` must not be left
    // believing a tool is blocked when the registry could not accept the guard.
    logger?.warn?.('[feishu-card] the tool registry cannot accept a guard; denyTools is NOT in effect')
    return undefined
  }
  const denied = new Set(names)
  return agent.ctx.effect(() => {
    const dispose = tools.guard((execution) => {
      const reason = denialReason(denied, execution)
      if (reason) logger?.info?.(`[feishu-card] denied tool "${execution?.name}" for ${agent.id}`)
      return reason
    })
    logger?.info?.(`[feishu-card] tool guard installed for ${agent.id} (deny: ${names.join(', ')})`)
    return () => {
      try {
        dispose()
      } catch {
        // A disposer that already ran is not an error.
      }
    }
  })
}
