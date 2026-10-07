/**
 * Offline verification for the card builders, turn renderer, session ladder and
 * command router.
 *
 * No Feishu connection is involved: fakes record every call so the assertions
 * can check the invariants that actually break users —
 *   * live deltas and committed text must NOT both be counted (no doubled text)
 *   * streaming writes must be coalesced, not one write per token
 *   * the terminal render must carry the complete accumulation
 *   * conversation keys must be injective, and concurrent opens must not fork
 *   * a slash line must reach the harness registry, and degrade without it
 * Run: node test/offline.mjs
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUSTOM_SUBMIT_PREFIX,
  ELEMENTS,
  TEMPLATE,
  buildNoticeCard,
  buildTurnCard,
  buildDecisionCard,
  assertValidCard,
  duplicateElementIds,
  invalidElementIds,
  settledDecisionElements,
} from '../lib/card.js'
import { TurnRenderer } from '../lib/turn.js'
import { ConversationSessions, conversationKey, makeWorkspaceFiler, sessionIdFor } from '../lib/session.js'
import { DESTRUCTIVE_COMMANDS, buildHelpCard, isDestructive } from '../lib/help-card.js'
import {
  buildChoiceCard,
  choiceOptionValue,
  permissionOptions,
  presetLocked,
  presetOptions,
  resolveOptionQuery,
} from '../lib/presets-ui.js'
import {
  SESSION_LIMIT,
  buildSessionsCard,
  relativeTime,
  resolveSessionQuery,
  selectableSessions,
  sessionLabel,
} from '../lib/sessions-ui.js'
import { commandName, helpText, isCommandLine, ownCommands, runCommandLine, strings } from '../lib/commands.js'
import {
  buildEffortCard,
  buildModelCard,
  describeSelection,
  effortsFor,
  flattenCatalog,
  resolveModelQuery,
} from '../lib/model.js'
import { describeCall, describeDiff, formatTokens, kindOf } from '../lib/present.js'
import { REACTION, ReactionTracker } from '../lib/react.js'
import { FeishuTransport } from '../lib/feishu.js'
import { Notices, compactionFailedLine, jobLine, pressureLine, retryLine } from '../lib/notice.js'
import { PROGRESS_ELEMENTS, ProgressCards, goalCard, todoCard } from '../lib/progress.js'
import {
  Config,
  SETTINGS_NAMESPACE,
  hasCredentials,
  isVolatileRef,
  plainConfig,
  resolveConfig,
  withStoredCredentials,
} from '../lib/config.js'
import { Fanout, agentEndLine, agentStartLine, runEndLine, runStartLine, subagentLine } from '../lib/fanout.js'
import { DENIAL_REASON, denialReason, installToolGuard } from '../lib/guard.js'
import { DROP, admit, isPolicyDrop } from '../lib/access.js'
import {
  COMMAND_NAME,
  OWN_PANEL_COMMANDS,
  applyPanelSync,
  desiredPanelEntries,
  planPanelSync,
} from '../lib/command-panel.js'
import { collectStream, parsePostContent, sniffImageMediaType } from '../lib/media.js'
import { SEND_FILE_TOOL, buildSendFileTool, isInside, resolveSendablePath } from '../lib/outbound.js'
import { failureNote, promptContent, resolveImages } from '../lib/images.js'

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** A transport that records calls instead of talking to Feishu. */
class FakeTransport {
  constructor() {
    this.cards = new Map()
    this.sent = []
    this.streams = []
    this.updates = []
    this.released = []
    this.n = 0
  }
  async createCard(card) {
    const id = `card_${++this.n}`
    this.cards.set(id, card)
    return id
  }
  async sendCard(cardId, opts) {
    this.sent.push({ cardId, opts })
    return `om_${cardId}`
  }
  async setStreaming(cardId, enabled) {
    this.streamingSettings = this.streamingSettings ?? []
    this.streamingSettings.push({ cardId, enabled })
  }
  async streamElement(cardId, elementId, content) {
    this.streams.push({ cardId, elementId, content })
  }
  async updateCard(cardId, card) {
    this.updates.push({ cardId, card })
  }
  releaseCard(cardId) {
    this.released.push(cardId)
  }
  /** Last streamed content for one element. */
  lastStream(elementId) {
    const hits = this.streams.filter((s) => s.elementId === elementId)
    return hits.length ? hits[hits.length - 1].content : undefined
  }
}

const settle = () => new Promise((r) => setTimeout(r, 5))

/** Every `tag` used anywhere in a card, including nested elements. */
function allTags(card) {
  const tags = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (typeof node.tag === 'string') tags.push(node.tag)
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return tags
}

/** Every button element in a card, including ones inside a column_set. */
function buttonsOf(card) {
  const found = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.tag === 'button') found.push(node)
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return found
}

/** Collect every element id in a card, including elements nested in panels. */
function allElementIds(card) {
  const ids = []
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (typeof node.element_id === 'string') ids.push(node.element_id)
    for (const value of Object.values(node)) walk(value)
  }
  walk(card)
  return ids
}

/** A session controller that mints sessions on demand. */
class FakeController {
  constructor() {
    this.live = new Set()
    this.calls = []
  }
  async resolveAgent(id) {
    this.calls.push(`resolve:${id}`)
    return this.live.has(id) ? { agent: { id } } : { error: { code: 'session/not-found' } }
  }
  async create({ sessionId }) {
    this.calls.push(`create:${sessionId}`)
    this.live.add(sessionId)
    return { sessionId }
  }
}

async function main() {
  console.log('card builders')
  const card = buildTurnCard({ title: 'DSH · 思考中', template: TEMPLATE.running, answer: 'hi' })
  await check('card is JSON 2.0 with every addressable element present', () => {
    assert.equal(card.schema, '2.0')
    const ids = allElementIds(card)
    for (const id of [
      ELEMENTS.reasoning,
      ELEMENTS.activity,
      ELEMENTS.answer,
      ELEMENTS.footer,
      ELEMENTS.footerSep,
    ]) {
      assert.ok(ids.includes(id), `missing element ${id}`)
    }
  })
  await check('streaming is on and the summary is set', () => {
    assert.equal(card.config.streaming_mode, true)
    assert.ok(card.config.summary.content)
    assert.ok(card.config.streaming_config.print_frequency_ms)
  })
  await check('decision card carries a callback value with the correlation id', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'abc' })
    const values = buttonsOf(d).map((b) => b.behaviors?.[0]?.value)
    assert.deepEqual(values, [{ k: 'approve', id: 'abc' }, { k: 'deny', id: 'abc' }])
  })
  // Card JSON V2 removed the `action` container: a button is a body element, and
  // an `action` wrapper makes the whole card uncreatable (`code 200861`), which
  // reaches the user as no question card at all.
  await check('no card uses the schema-1.0 action container', () => {
    const cards = [
      buildTurnCard({ title: 't' }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x' }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x', allowCustom: true }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x', allowCustom: true, cardInput: true }),
      buildNoticeCard({ title: 't', body: 'b' }),
    ]
    for (const card of cards) assert.ok(!allTags(card).includes('action'), 'the action tag is unsupported in V2')
  })
  await check('a button is a direct body element', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'x' })
    assert.equal(d.body.elements[1].tag, 'button')
  })
  await check('free text defaults to a reply hint, not an in-card input', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'x', allowCustom: true })
    assert.equal(allTags(d).includes('form'), false, 'no native editor panel by default')
    assert.equal(allTags(d).includes('input'), false)
    const hint = d.body.elements.find((e) => e.element_id === ELEMENTS.hint)
    assert.match(hint.content, /回复文字作答/)
  })
  await check('the custom form is named and its submit carries no callback', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'x', allowCustom: true, cardInput: true })
    const form = d.body.elements.find((e) => e.tag === 'form')
    assert.ok(form.name, 'the form requires a name (code 11310 otherwise)')
    const input = form.elements.find((e) => e.tag === 'input')
    assert.equal(input.input_type, 'text')
    const submit = form.elements.find((e) => e.tag === 'button')
    assert.equal(submit.form_action_type, 'submit')
    assert.equal(submit.behaviors, undefined, 'a form submit must not carry a callback')
  })
  await check('the submit button name carries the correlation id', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'xyz', allowCustom: true, cardInput: true })
    const submit = d.body.elements.flatMap((e) => e.elements ?? []).find((e) => e.tag === 'button')
    assert.equal(submit.name, `${CUSTOM_SUBMIT_PREFIX}xyz`)
  })

  // The platform rejects a card whose element_id breaks its rule, and the user
  // sees NO card at all rather than an error. A real hyphenated divider id
  // (`footer-sep`) caused exactly that, so every builder is checked here.
  console.log('element ids obey the platform rule')
  await check('the detector catches a hyphenated id', () => {
    assert.deepEqual(invalidElementIds({ body: { elements: [{ tag: 'hr', element_id: 'footer-sep' }] } }), [
      'footer-sep',
    ])
    assert.deepEqual(invalidElementIds({ element_id: 'a'.repeat(21) }), ['a'.repeat(21)])
    assert.deepEqual(invalidElementIds({ element_id: '9starts_with_digit' }), ['9starts_with_digit'])
    assert.deepEqual(invalidElementIds({ element_id: 'ok_id_1' }), [])
  })
  await check('every builder produces only legal element ids', () => {
    const cards = [
      buildTurnCard({ title: 't', template: TEMPLATE.running, answer: 'a' }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x' }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x', allowCustom: true }),
      buildDecisionCard({ title: 't', body: 'b', id: 'x', options: [{ label: 'A' }, { label: 'B' }], allowCustom: true }),
      buildNoticeCard({ title: 't', body: 'b' }),
    ]
    for (const card of cards) {
      assert.deepEqual(invalidElementIds(card), [], `illegal element id in ${JSON.stringify(card.header.title.content)}`)
    }
    assert.deepEqual(invalidElementIds({ body: { elements: settledDecisionElements({ label: 'x' }) } }), [])
  })

  console.log('turn accumulation')
  const transport = new FakeTransport()
  const renderer = new TurnRenderer({ transport, flushIntervalMs: 5, reasoningTail: 2000 })

  const state = await renderer.begin('s1', { chatId: 'c1', replyToMessageId: 'm1' })
  await check('a card entity is created and sent into the chat', () => {
    assert.equal(state.cardId, 'card_1')
    assert.equal(transport.sent.length, 1)
    assert.equal(transport.sent[0].opts.chatId, 'c1')
  })
  await check('streaming mode is enabled on the new card', () => {
    assert.deepEqual(transport.streamingSettings, [{ cardId: 'card_1', enabled: true }])
  })

  renderer.addLiveReasoning('s1', '思考A')
  renderer.addLiveAnswer('s1', '你')
  renderer.addLiveAnswer('s1', '好')
  await settle()
  await check('live deltas coalesce and the answer is complete', () => {
    assert.equal(transport.lastStream(ELEMENTS.answer), '你好')
    assert.ok(transport.streams.length < 6, `expected coalescing, saw ${transport.streams.length} writes`)
  })

  renderer.commitAssistant('s1', { text: '你好', reasoning: '思考A' })
  await settle()
  await check('committed text does not double the live buffer', () => {
    assert.equal(transport.lastStream(ELEMENTS.answer), '你好')
    assert.equal(renderer.get('s1').answer, '你好')
  })

  renderer.resetLive('s1')
  renderer.addLiveAnswer('s1', '世界')
  await settle()
  await check('a second step appends to the committed text', () => {
    assert.equal(renderer.get('s1').answer, '你好世界')
  })
  renderer.commitAssistant('s1', { text: '世界' })
  await settle()
  await check('the second commit does not double either', () => {
    assert.equal(renderer.get('s1').answer, '你好世界')
  })

  await check('activity lines accumulate', () => {
    renderer.addActivity('s1', '🔧 **read**')
    renderer.addActivity('s1', '✅ 完成')
    assert.equal(renderer.get('s1').activity, '🔧 **read**\n✅ 完成')
  })

  await renderer.finish('s1', { title: 'DSH · 已完成', template: TEMPLATE.done, footer: '⏱ 1.0s' })
  await check('the terminal render is one card.update carrying everything', () => {
    assert.equal(transport.updates.length, 1)
    const final = transport.updates[0].card
    const answer = final.body.elements.find((e) => e.element_id === ELEMENTS.answer)
    const footer = final.body.elements.find((e) => e.element_id === ELEMENTS.footer)
    assert.equal(answer.content, '你好世界')
    assert.equal(footer.content, '⏱ 1.0s')
    assert.equal(final.header.title.content, 'DSH · 已完成')
    assert.equal(final.header.template, TEMPLATE.done)
  })
  await check('a settled card stops animating and releases its sequence', () => {
    assert.equal(transport.updates[0].card.config.streaming_mode, false)
    assert.deepEqual(transport.released, ['card_1'])
    assert.equal(renderer.has('s1'), false)
  })

  console.log('reasoning tail')
  const t2 = new FakeTransport()
  const r2 = new TurnRenderer({ transport: t2, flushIntervalMs: 5, reasoningTail: 10 })
  await r2.begin('s2', { chatId: 'c2' })
  r2.addLiveReasoning('s2', 'abcdefghijKLMNOP')
  await settle()
  await check('only the tail of long reasoning is rendered', () => {
    const shown = t2.lastStream(ELEMENTS.reasoning)
    assert.ok(shown.includes('KLMNOP'), shown)
    assert.ok(!shown.includes('abcdef'), 'the head should be trimmed')
  })
  await r2.finish('s2', {})

  console.log('option buttons')
  await check('a choice list renders one button per option plus a skip', () => {
    const d = buildDecisionCard({
      title: '选一个',
      body: 'b',
      id: 'x1',
      options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
    })
    const values = buttonsOf(d).map((a) => a.behaviors[0].value)
    assert.deepEqual(
      values.map((v) => [v.k, v.v ?? null]),
      [['option', '甲'], ['option', '乙'], ['option', '丙'], ['deny', null]],
    )
  })
  await check('a boolean decision keeps approve/deny with no skip', () => {
    const d = buildDecisionCard({ title: 't', body: 'b', id: 'x2' })
    assert.deepEqual(buttonsOf(d).map((a) => a.behaviors[0].value.k), ['approve', 'deny'])
  })
  await check('a long option list wraps into column rows of four', () => {
    const d = buildDecisionCard({
      title: 't',
      body: 'b',
      id: 'x3',
      options: [1, 2, 3, 4, 5, 6].map((i) => ({ label: `选项${i}` })),
    })
    const rows = d.body.elements.filter((e) => e.tag === 'column_set')
    assert.equal(rows.length, 2, 'six options make two rows')
    assert.equal(rows[0].columns.length, 4)
    assert.equal(rows[0].flex_mode, 'flow')
    assert.equal(buttonsOf(d).length, 7, 'six options plus skip')
  })

  console.log('card creation is race-safe')
  const t3 = new FakeTransport()
  const r3 = new TurnRenderer({ transport: t3, flushIntervalMs: 5 })
  const [a, b] = await Promise.all([r3.begin('s3', { chatId: 'c3' }), r3.begin('s3', { chatId: 'c3' })])
  await check('two concurrent begins create exactly one card', () => {
    assert.equal(t3.sent.length, 1, `expected 1 send, saw ${t3.sent.length}`)
    assert.equal(a.cardId, b.cardId)
  })
  await check('a later begin attaches to the live card instead of replacing it', async () => {
    const again = await r3.begin('s3', { chatId: 'c3' })
    assert.equal(again.cardId, a.cardId)
    assert.equal(t3.sent.length, 1)
  })
  await r3.finish('s3', {})

  console.log('conversation identity')
  const groupMsg = { chatId: 'oc_1', threadId: 'omt_9', senderId: 'ou_a' }
  await check('scope chat keys on the chat alone', () => {
    assert.equal(conversationKey('chat', groupMsg), 'oc_1')
  })
  await check('scope chat-thread keys on chat + thread', () => {
    assert.equal(conversationKey('chat-thread', groupMsg), 'oc_1:omt_9')
  })
  await check('chat-thread without a thread falls back to the chat', () => {
    assert.equal(conversationKey('chat-thread', { chatId: 'oc_1' }), 'oc_1')
  })
  await check('scope chat-sender keys on chat + sender', () => {
    assert.equal(conversationKey('chat-sender', groupMsg), 'oc_1:ou_a')
  })
  await check('the key function is injective across facets', () => {
    const keys = new Set([
      conversationKey('chat-thread', { chatId: 'oc_1', threadId: 'omt_9' }),
      conversationKey('chat-thread', { chatId: 'oc_1', threadId: 'omt_10' }),
      conversationKey('chat-sender', { chatId: 'oc_1', senderId: 'ou_a' }),
      conversationKey('chat', { chatId: 'oc_1' }),
      // A colon inside an id must not let two facets collide.
      conversationKey('chat-thread', { chatId: 'oc_1', threadId: 'omt_9:ou_a' }),
      conversationKey('chat-thread', { chatId: 'oc_1:omt_9', threadId: 'ou_a' }),
    ])
    assert.equal(keys.size, 6, `expected 6 distinct keys, got ${keys.size}`)
  })
  await check('the session id carries the reserved prefix', () => {
    assert.equal(sessionIdFor('oc_1'), 'feishu-oc_1')
  })

  console.log('session ladder')
  const controller = new FakeController()
  const ladder = new ConversationSessions({ sessionController: controller, cwd: '/tmp' })

  const first = await ladder.reach('oc_9')
  await check('first contact resolves, misses, creates, then resolves the new agent', () => {
    assert.equal(first.id, 'feishu-oc_9')
    // create() returns only the id, so the agent needs one more resolve.
    assert.deepEqual(controller.calls, [
      'resolve:feishu-oc_9',
      'create:feishu-oc_9',
      'resolve:feishu-oc_9',
    ])
  })
  await check('a second reach is served from the live agent', async () => {
    const again = await ladder.reach('oc_9')
    assert.equal(again.id, 'feishu-oc_9')
    assert.equal(controller.calls.length, 3, 'no extra controller calls')
  })
  await check('concurrent reaches open exactly one session', async () => {
    const before = controller.calls.length
    const [x, y] = await Promise.all([ladder.reach('oc_10'), ladder.reach('oc_10')])
    assert.equal(x.id, y.id)
    assert.equal(controller.calls.length - before, 3, 'one open, not two')
  })
  await check('binding records routing and serves() reports it', () => {
    ladder.bind('oc_9', { chatId: 'oc_9', messageId: 'om_1' })
    assert.equal(ladder.serves('feishu-oc_9'), true)
    assert.equal(ladder.routingFor('feishu-oc_9').chatId, 'oc_9')
    assert.equal(ladder.serves('feishu-nobody'), false)
  })
  await check('a resume failure that is not not-found is reported, not forked', async () => {
    const busy = new ConversationSessions({
      sessionController: { resolveAgent: async () => ({ error: { code: 'session/agent-busy' } }) },
      cwd: '/tmp',
    })
    await assert.rejects(() => busy.reach('oc_busy'), /agent-busy/)
  })
  await check('forget drops the binding', () => {
    ladder.forget('oc_9')
    assert.equal(ladder.serves('feishu-oc_9'), false)
  })

  console.log('/new actually rotates the session')
  const tmp = await mkdtemp(join(tmpdir(), 'feishu-card-'))
  const rotated = new ConversationSessions({ sessionController: new FakeController(), cwd: '/tmp', stateDir: tmp })
  await rotated.load()
  await check('the default id is derived from the key', () => {
    assert.equal(rotated.idFor('oc_r'), 'feishu-oc_r')
  })
  const newId = await rotated.rotate('oc_r')
  await check('rotate mints a different id for the same key', () => {
    assert.notEqual(newId, 'feishu-oc_r')
    assert.equal(rotated.idFor('oc_r'), newId)
  })
  await check('reach opens the rotated session, not the old one', async () => {
    const agent = await rotated.reach('oc_r')
    assert.equal(agent.id, newId)
  })
  await check('the rotation survives a restart (reloaded from disk)', async () => {
    const reloaded = new ConversationSessions({ sessionController: new FakeController(), cwd: '/tmp', stateDir: tmp })
    await reloaded.load()
    assert.equal(reloaded.idFor('oc_r'), newId)
  })
  await check('an unrelated key still uses the derived id', () => {
    assert.equal(rotated.idFor('oc_other'), 'feishu-oc_other')
  })
  await rm(tmp, { recursive: true, force: true })

  console.log('slash commands')
  await check('a command line is recognized and named', () => {
    assert.equal(isCommandLine('/model deepseek/chat'), true)
    assert.equal(isCommandLine('hello /model'), false)
    assert.equal(commandName('/MODEL foo'), 'model')
    assert.equal(commandName('no slash'), undefined)
  })

  const hostCommands = [
    { name: 'model', description: 'Choose the model' },
    { name: 'compact', description: 'Compact the context' },
  ]
  const fakeCommands = {
    list: () => hostCommands,
    execute: async (agent, line) => ({ commandId: 'c1', result: { kind: 'success', text: `ran ${line}` } }),
  }
  await check('help lists harness commands from the registry', async () => {
    const text = await helpText({ commands: fakeCommands, agent: { id: 's' }, locale: 'zh' })
    assert.match(text, /`\/model` — Choose the model/)
    assert.match(text, /`\/compact`/)
  })
  await check('a host command is delegated and its text returned', async () => {
    const out = await runCommandLine({ commands: fakeCommands, agent: { id: 's' }, line: '/model x', locale: 'zh' })
    assert.equal(out.text, 'ran /model x')
    assert.ok(!out.error)
  })
  await check('an error result is surfaced as an error', async () => {
    const out = await runCommandLine({
      commands: { execute: async () => ({ commandId: 'c', result: { kind: 'error', text: 'nope' } }) },
      agent: { id: 's' },
      line: '/model x',
      locale: 'zh',
    })
    assert.ok(out.error)
    assert.match(out.text, /nope/)
  })
  await check('an unknown command falls back to the help text', async () => {
    const out = await runCommandLine({
      commands: { list: () => hostCommands, execute: async () => undefined },
      agent: { id: 's' },
      line: '/nope',
      locale: 'zh',
    })
    assert.ok(out.error)
    assert.match(out.text, /未知命令/)
    assert.match(out.text, /`\/model`/)
  })
  await check('a missing commands service degrades instead of throwing', async () => {
    const out = await runCommandLine({ commands: undefined, agent: { id: 's' }, line: '/model', locale: 'zh' })
    assert.ok(out.error)
  })

  console.log('reading presets arrange the card')
  const panelOf = (c) => {
    let found
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk)
      if (!n || typeof n !== 'object') return
      if (n.tag === 'collapsible_panel') found = n
      for (const v of Object.values(n)) walk(v)
    }
    walk(c)
    return found
  }
  await check('every preset puts the answer above the process panel', () => {
    for (const preset of ['classic', 'focused', 'detailed', 'task']) {
      const tags = buildTurnCard({ title: 't', preset }).body.elements.map((e) => e.tag)
      assert.equal(tags[0], 'markdown', `${preset}: the answer leads`)
      assert.equal(tags[1], 'collapsible_panel', `${preset}: the process follows`)
    }
  })
  await check('classic opens the panel while running and folds it when done', () => {
    assert.equal(panelOf(buildTurnCard({ title: 't', preset: 'classic' })).expanded, true)
    assert.equal(panelOf(buildTurnCard({ title: 't', preset: 'classic', expanded: false })).expanded, false)
  })
  await check('focused keeps the panel folded even while running', () => {
    assert.equal(panelOf(buildTurnCard({ title: 't', preset: 'focused' })).expanded, false)
  })
  await check('detailed keeps the panel open', () => {
    assert.equal(panelOf(buildTurnCard({ title: 't', preset: 'detailed' })).expanded, true)
    assert.equal(panelOf(buildTurnCard({ title: 't', preset: 'detailed', expanded: true })).expanded, true)
  })
  await check('task hides reasoning from the panel', () => {
    const ids = allElementIds(panelOf(buildTurnCard({ title: 't', preset: 'task' })))
    assert.ok(ids.includes(ELEMENTS.activity))
    assert.ok(!ids.includes(ELEMENTS.reasoning), 'task should not render thinking')
  })
  await check('the panel title counts tools and hints how to open', () => {
    const folded = panelOf(buildTurnCard({ title: 't', preset: 'focused', toolCount: 3 }))
    assert.match(folded.header.title.content, /3 个工具/)
    assert.match(folded.header.title.content, /点开查看/)
    const open = panelOf(buildTurnCard({ title: 't', preset: 'detailed', toolCount: 0 }))
    assert.match(open.header.title.content, /^▾/)
  })
  await check('showProcess false drops the panel entirely', () => {
    const c = buildTurnCard({ title: 't', showProcess: false })
    assert.equal(panelOf(c), undefined)
    assert.equal(c.body.elements[0].tag, 'markdown')
  })
  await check('the header carries a live subtitle', () => {
    assert.equal(buildTurnCard({ title: 't', subtitle: '⚡ exec' }).header.subtitle.content, '⚡ exec')
    assert.equal(buildTurnCard({ title: 't' }).header.subtitle, undefined)
  })

  console.log('tool presentation')
  await check('tools are classified by family', () => {
    assert.equal(kindOf('read'), 'read')
    assert.equal(kindOf('bash'), 'execute')
    assert.equal(kindOf('grep'), 'search')
    assert.equal(kindOf('edit_file'), 'edit')
    assert.equal(kindOf('totally_unknown'), 'other')
  })
  await check('a call is described with an icon and its target', () => {
    const line = describeCall('read', JSON.stringify({ path: 'src/index.js' }))
    assert.match(line, /📖/)
    assert.match(line, /src\/index\.js/)
  })
  await check('a malformed argument string degrades to the bare name', () => {
    assert.match(describeCall('bash', '{not json'), /execute/)
    assert.equal(describeDiff('bash', '{not json'), undefined)
  })
  await check('an edit renders a diff, a non-edit does not', () => {
    const diff = describeDiff('edit_file', JSON.stringify({ path: 'a.txt', old_str: 'one', new_str: 'two' }))
    assert.match(diff, /```diff/)
    assert.match(diff, /- one/)
    assert.match(diff, /\+ two/)
    assert.equal(describeDiff('read', JSON.stringify({ path: 'a.txt' })), undefined)
  })
  await check('a whole-file write shows the new content', () => {
    const diff = describeDiff('write', JSON.stringify({ path: 'a.txt', content: 'hello' }))
    assert.match(diff, /hello/)
  })
  await check('tokens are formatted compactly', () => {
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(1234), '1.2k')
    assert.equal(formatTokens(45678), '46k')
    assert.equal(formatTokens(0), undefined)
  })

  console.log('hideProcessWhenDone folds the panel at the end')
  const t4 = new FakeTransport()
  const r4 = new TurnRenderer({ transport: t4, flushIntervalMs: 5, preset: 'detailed', hideProcessWhenDone: true })
  await r4.begin('s4', { chatId: 'c4' })
  await check('the panel starts expanded while running', () => {
    assert.equal(panelOf(t4.cards.get('card_1')).expanded, true)
  })
  await r4.finish('s4', { title: 'done' })
  await check('the settled card folds it', () => {
    const final = t4.updates[0].card
    assert.equal(panelOf(final).expanded, false)
    assert.equal(final.config.streaming_mode, false)
  })

  console.log('header state reaches the card while the turn runs')
  const t5 = new FakeTransport()
  const r5 = new TurnRenderer({ transport: t5, flushIntervalMs: 5, preset: 'classic' })
  await r5.begin('s5', { chatId: 'c5' })
  r5.setSubtitle('s5', '📖 \`read\` src/index.js')
  await settle()
  await check('a new subtitle is pushed as a card.update, not lost in memory', () => {
    assert.ok(t5.updates.length >= 1, 'the header change must reach Feishu')
    const card = t5.updates[t5.updates.length - 1].card
    assert.equal(card.header.subtitle.content, '📖 \`read\` src/index.js')
  })
  await check('the running card shows the process panel open', () => {
    const card = t5.updates[t5.updates.length - 1].card
    assert.equal(panelOf(card).expanded, true)
  })
  await check('the panel stays below the answer', () => {
    const tags = t5.updates[0].card.body.elements.map((e) => e.tag)
    assert.equal(tags[0], 'markdown')
    assert.equal(tags[1], 'collapsible_panel')
  })
  r5.setStatus('s5', { title: 'DSH · 已完成', template: TEMPLATE.done })
  await settle()
  await check('a status change is pushed too', () => {
    const card = t5.updates[t5.updates.length - 1].card
    assert.equal(card.header.title.content, 'DSH · 已完成')
    assert.equal(card.header.template, TEMPLATE.done)
  })
  await check('an unchanged subtitle does not spam an update', async () => {
    r5.setSubtitle('s5', '正在整理回答…')
    await settle()
    const before = t5.updates.length
    r5.setSubtitle('s5', '正在整理回答…')
    r5.setSubtitle('s5', '正在整理回答…')
    await settle()
    assert.equal(t5.updates.length, before, 'a repeated value is not republished')
  })
  await r5.finish('s5', {})

  console.log('a decision renders inside the turn card')
  const t6 = new FakeTransport()
  const r6 = new TurnRenderer({ transport: t6, flushIntervalMs: 5, preset: 'classic' })
  await r6.begin('s6', { chatId: 'c6' })
  await check('setInteraction claims the live card', () => {
    assert.equal(r6.setInteraction('s6', { id: 'q1', title: '请选择', body: '选一个', options: [{ label: '甲' }, { label: '乙' }] }), true)
  })
  await settle()
  await check('the buttons land in the same card, not a second message', () => {
    assert.equal(t6.sent.length, 1, 'only the turn card was ever sent')
    const card = t6.updates[t6.updates.length - 1].card
    const values = buttonsOf(card).map((b) => b.behaviors?.[0]?.value?.k)
    assert.deepEqual(values, ['option', 'option', 'deny'])
  })
  await check('the decision sits above the footer', () => {
    const ids = allElementIds(t6.updates[t6.updates.length - 1].card)
    assert.ok(ids.indexOf('prompt') < ids.indexOf('footer'))
  })
  await check('settling leaves a receipt in place of the buttons', async () => {
    r6.setInteraction('s6', { settled: true, label: '已选择 甲', operator: '张三' })
    await settle()
    const card = t6.updates[t6.updates.length - 1].card
    assert.equal(buttonsOf(card).length, 0, 'the buttons are gone')
    const receipt = card.body.elements.flatMap((e) => e.elements ?? [e]).find((e) => e.element_id === 'actions')
    assert.match(receipt.content, /已选择 甲/)
    assert.match(receipt.content, /张三/)
  })
  await check('a pending decision survives the terminal render', async () => {
    const t7 = new FakeTransport()
    const r7 = new TurnRenderer({ transport: t7, flushIntervalMs: 5 })
    await r7.begin('s7', { chatId: 'c7' })
    r7.setInteraction('s7', { id: 'q2', title: 't', body: 'b', approveLabel: '允许一次', denyLabel: '拒绝' })
    await r7.finish('s7', { title: 'DSH · 已完成' })
    const final = t7.updates[t7.updates.length - 1].card
    assert.deepEqual(buttonsOf(final).map((b) => b.behaviors[0].value.k), ['approve', 'deny'])
  })
  await check('setInteraction refuses a session with no live card', () => {
    assert.equal(r6.setInteraction('nobody', { id: 'q3' }), false)
  })

  console.log('reaction feedback')
  /** A transport that records reaction traffic in order. */
  class ReactionTransport {
    constructor() { this.log = []; this.n = 0 }
    async addReaction(messageId, emoji) {
      this.log.push(`+${emoji}`)
      return `r${++this.n}`
    }
    async removeReaction(messageId, id) { this.log.push(`-${id}`) }
  }
  const rt = new ReactionTransport()
  const tracker = new ReactionTracker({ transport: rt })
  await tracker.show('m1', 'ack')
  await tracker.show('m1', 'working')
  await tracker.show('m1', 'done')
  await check('each step swaps the previous reaction out first', () => {
    // Feishu reactions are additive, so leaving the old one would stack emoji.
    assert.deepEqual(rt.log, ['+OK', '-r1', '+THINKING', '-r2', '+DONE'])
  })
  await check('a terminal state is once-only', async () => {
    const before = rt.log.length
    await tracker.show('m1', 'working')
    assert.equal(rt.log.length, before, 'done must not fall back to working')
  })
  await check('a repeated state is not re-sent', async () => {
    const rt2 = new ReactionTransport()
    const t2 = new ReactionTracker({ transport: rt2 })
    await t2.show('m2', 'working')
    await t2.show('m2', 'working')
    assert.deepEqual(rt2.log, ['+THINKING'])
  })
  await check('a failed removal is reported but does not stop the swap', async () => {
    const flaky = new ReactionTransport()
    flaky.removeReaction = async () => { throw new Error('gone') }
    const warned = []
    const t3 = new ReactionTracker({ transport: flaky, logger: { warn: (...a) => warned.push(a) } })
    await t3.show('m3', 'ack')
    await t3.show('m3', 'working')
    assert.equal(warned.length, 1)
    assert.deepEqual(flaky.log, ['+OK', '+THINKING'])
  })
  await check('disabling the feature sends nothing', async () => {
    const off = new ReactionTransport()
    const t4 = new ReactionTracker({ transport: off, enabled: false })
    await t4.show('m4', 'ack')
    assert.deepEqual(off.log, [])
  })
  await check('a missing message id is a no-op rather than a throw', async () => {
    const t5 = new ReactionTracker({ transport: new ReactionTransport() })
    await t5.show(undefined, 'ack')
  })

  console.log('card appearance')
  await check('width_mode is omitted at the default', () => {
    assert.equal(buildTurnCard({ title: 't' }).config.width_mode, undefined)
    assert.equal(buildTurnCard({ title: 't', widthMode: 'default' }).config.width_mode, undefined)
    assert.equal(buildTurnCard({ title: 't', widthMode: 'fill' }).config.width_mode, 'fill')
  })
  await check('text sizes reach their elements', () => {
    const c = buildTurnCard({
      title: 't',
      answer: 'a',
      footer: 'f',
      reasoning: 'r',
      activity: 'x',
      preset: 'detailed',
      textSizes: { reasoning: 'small', activity: 'x-small', answer: 'large', footer: 'notation' },
    })
    const find = (id) => {
      let hit
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        if (n.element_id === id) hit = n
        for (const v of Object.values(n)) walk(v)
      }
      walk(c)
      return hit
    }
    assert.equal(find(ELEMENTS.answer).text_size, 'large')
    assert.equal(find(ELEMENTS.reasoning).text_size, 'small')
    assert.equal(find(ELEMENTS.activity).text_size, 'x-small')
    assert.equal(find(ELEMENTS.footer).text_size, 'notation')
  })

  console.log('notice formatting')
  await check('a retry names the attempt and the provider status', () => {
    const line = retryLine({ message: 'rate limited', status: 429 }, 3)
    assert.match(line, /正在重试/)
    assert.match(line, /第 3 次/)
    assert.match(line, /429/)
    assert.doesNotMatch(retryLine({ message: 'x' }, 1), /第 1 次/)
  })
  await check('context pressure only reports at or above the threshold', () => {
    assert.equal(pressureLine({ inputTokens: 50, contextWindow: 200000, threshold: 120000 }), undefined)
    const line = pressureLine({ inputTokens: 128000, contextWindow: 200000, threshold: 120000 })
    assert.match(line, /128k/)
    assert.match(line, /200k/)
    assert.equal(pressureLine({ inputTokens: 0, threshold: 1 }), undefined)
  })
  await check('a compaction failure and a job settlement read correctly', () => {
    assert.match(compactionFailedLine(new Error('boom')), /压缩失败/)
    assert.match(compactionFailedLine(new Error('boom')), /boom/)
    assert.match(jobLine({ status: 'completed', label: 'build' }), /✅.*build/)
    assert.match(jobLine({ status: 'failed', label: 'test' }), /❌.*test/)
    assert.match(jobLine({ status: 'killed', label: 'x' }), /⛔/)
  })

  console.log('notice delivery')
  /** A stand-in for the pieces Notices talks to. */
  function noticeHarness({ live, panel = true }) {
    const sent = []
    const activity = []
    // `panel: false` models `showProcess: false`, where the process panel — and
    // therefore the `activity` element — does not exist at all.
    const renderer = {
      has: () => live,
      acceptsActivity: () => live && panel,
      addActivity: (id, line) => activity.push(line),
    }
    const transport = { sendCardOnce: async (card) => { sent.push(card) } }
    const sessions = { routingFor: () => ({ chatId: 'c', replyToMessageId: 'm' }) }
    const notices = new Notices({ renderer, transport, sessions, logger: undefined, pressureThreshold: 1000 })
    return { notices, sent, activity, renderer }
  }
  await check('inside a turn a notice joins the process panel', async () => {
    const h = noticeHarness({ live: true })
    await h.notices.modelRetry('s', { message: 'x' })
    assert.equal(h.sent.length, 0, 'no extra message while a card is live')
    assert.match(h.activity[0], /正在重试/)
  })
  await check('outside a turn a notice becomes its own card', async () => {
    const h = noticeHarness({ live: false })
    await h.notices.modelRetry('s', { message: 'x' })
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].body.elements[0].content.includes('正在重试'), true)
  })
  await check('context pressure posts once per climb and re-arms after a drop', async () => {
    const h = noticeHarness({ live: true })
    await h.notices.contextUsage('s', { inputTokens: 2000, contextWindow: 8000 })
    await h.notices.contextUsage('s', { inputTokens: 3000, contextWindow: 8000 })
    assert.equal(h.activity.length, 1, 'the second reading is the same climb')
    await h.notices.contextUsage('s', { inputTokens: 10, contextWindow: 8000 })
    await h.notices.contextUsage('s', { inputTokens: 4000, contextWindow: 8000 })
    assert.equal(h.activity.length, 2, 'a drop below the threshold re-arms it')
  })
  await check('with no process panel the notice goes out as a card, not into nothing', async () => {
    // The `activity` element lives inside the process panel. With
    // `showProcess: false` the panel is not built, so appending would write to a
    // nonexistent element and be swallowed — the notice would silently vanish.
    const h = noticeHarness({ live: true, panel: false })
    await h.notices.modelRetry('s', { message: 'x' })
    assert.equal(h.activity.length, 0, 'must not target a missing element')
    assert.equal(h.sent.length, 1, 'it must still reach the user')
  })

  await check('a job with no owner is not announced', async () => {
    const h = noticeHarness({ live: true })
    await h.notices.jobSettled({ status: 'completed', label: 'x' })
    assert.equal(h.activity.length, 0)
  })

  console.log('progress cards')
  await check('a todo card counts progress and marks each row', () => {
    const card = todoCard([
      { content: '读代码', status: 'completed' },
      { content: '写测试', status: 'in_progress' },
      { content: '提交', status: 'pending' },
    ])
    assert.match(card.header.title.content, /1\/3/)
    const body = card.body.elements[0].content
    assert.match(body, /✅ 读代码/)
    assert.match(body, /🔵 写测试/)
    assert.match(body, /⚪ 提交/)
  })
  await check('a long todo list is bounded', () => {
    const card = todoCard(Array.from({ length: 30 }, (_, i) => ({ content: `t${i}`, status: 'pending' })))
    assert.match(card.body.elements[0].content, /还有 18 项/)
  })
  await check('a goal card shows its phase and offers the right buttons', () => {
    const paused = goalCard({ id: 'g', revision: 2, objective: '做完这件事', phase: 'paused', maxGoalRounds: 5 })
    const labels = buttonsOf(paused).map((b) => b.text.content)
    assert.deepEqual(labels, ['▶️ 继续', '⏹ 清除'])
    assert.match(paused.header.title.content, /已暂停/)
    const active = goalCard({ id: 'g', revision: 2, objective: 'o', phase: 'active' })
    assert.deepEqual(buttonsOf(active).map((b) => b.text.content), ['⏸️ 暂停', '⏹ 清除'])
    const done = goalCard({ id: 'g', revision: 3, objective: 'o', phase: 'complete' })
    assert.equal(buttonsOf(done).length, 0, 'a finished goal has no controls')
  })
  await check('a goal button carries the ref it was rendered from', () => {
    const card = goalCard({ id: 'g1', revision: 7, objective: 'o', phase: 'active' })
    const value = buttonsOf(card)[0].behaviors[0].value
    assert.deepEqual(value, { k: 'goal', id: 'g1', revision: 7, op: 'pause' })
  })
  await check('progress cards use schema-2.0 shapes only', () => {
    for (const card of [todoCard([]), goalCard({ id: 'g', revision: 1, objective: 'o', phase: 'active' })]) {
      assert.ok(!allTags(card).includes('action'))
      assert.deepEqual(invalidElementIds(card), [])
    }
  })

  console.log('progress card delivery')
  /** A transport that counts entity writes. */
  class ProgressTransport {
    constructor() { this.created = 0; this.sent = 0; this.updates = 0 }
    async createCard() { this.created++; return `pc${this.created}` }
    async sendCard() { this.sent++ }
    async updateCard() { this.updates++ }
  }
  const pt = new ProgressTransport()
  const sessionsFor = { routingFor: () => ({ chatId: 'c', replyToMessageId: 'm' }) }
  const pc = new ProgressCards({ transport: pt, sessions: sessionsFor })
  await pc.showTodos('s', [{ content: 'a', status: 'pending' }])
  await pc.showTodos('s', [{ content: 'a', status: 'completed' }])
  await check('the first snapshot creates a card and later ones update it in place', () => {
    assert.equal(pt.created, 1, 'one card entity for the session')
    assert.equal(pt.sent, 1, 'sent once, not per change')
    assert.equal(pt.updates, 1)
  })
  await check('a cleared goal leaves the last card standing', async () => {
    await pc.showGoal('s', { kind: 'goal/change', operation: 'clear' })
    assert.equal(pt.created, 1, 'no card is created for a tombstone')
  })
  await check('a stale entity is forgotten so the next snapshot recovers', async () => {
    pt.updateCard = async () => { throw new Error('expired') }
    await pc.showTodos('s', [{ content: 'b', status: 'pending' }])
    assert.equal(pc.cardId('s', 'todo'), undefined, 'the dead id was dropped')
    pt.updateCard = ProgressTransport.prototype.updateCard ?? (async () => { pt.updates++ })
    await pc.showTodos('s', [{ content: 'c', status: 'pending' }])
    assert.equal(pt.created, 2, 'a fresh card replaces the expired one')
  })

  console.log('fan-out narration')
  await check('a run opens, members open and settle, the run closes with a tally', () => {
    const f = new Fanout({})
    assert.match(f.lines('s', 'tool-workflow/run-start', { runId: 'r1', name: '审计' })[0], /🚀.*审计/)
    assert.match(f.lines('s', 'tool-workflow/agent-start', { runId: 'r1', seq: 1, label: '读文件' })[0], /🧑‍💻 #1 读文件/)
    f.lines('s', 'tool-workflow/agent-start', { runId: 'r1', seq: 2, label: '改代码' })
    assert.match(f.lines('s', 'tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: 'completed' })[0], /✅ #1 completed 读文件/)
    assert.match(f.lines('s', 'tool-workflow/agent-end', { runId: 'r1', seq: 2, outcome: 'failed' })[0], /❌/)
    const end = f.lines('s', 'tool-workflow/run-end', { runId: 'r1', stopReason: 'error' })[0]
    assert.match(end, /❌/)
    assert.match(end, /2\/2 完成/)
    assert.match(end, /error/)
  })
  await check('an unknown event is not narrated', () => {
    assert.deepEqual(new Fanout({}).lines('s', 'turn/start', {}), [])
  })
  await check('run state does not leak past the run', () => {
    const f = new Fanout({})
    f.lines('s', 'tool-workflow/run-start', { runId: 'r', name: 'x' })
    f.lines('s', 'tool-workflow/agent-start', { runId: 'r', seq: 1, label: 'a' })
    f.lines('s', 'tool-workflow/run-end', { runId: 'r', stopReason: 'completed' })
    const second = f.lines('s', 'tool-workflow/run-end', { runId: 'r', stopReason: 'completed' })[0]
    assert.doesNotMatch(second, /1\/1/, 'the tally belongs to its own run')
  })
  await check('odd payloads degrade instead of throwing', () => {
    const f = new Fanout({ logger: { warn: () => {} } })
    assert.equal(f.lines('s', 'tool-workflow/agent-start', undefined).length, 1)
    assert.equal(f.lines('s', 'tool-workflow/agent-end', {}).length, 1)
    assert.match(subagentLine(undefined), /子代理/)
  })

  // The fake transports above implement whatever the test wants them to, so they
  // CANNOT prove the real transport has the methods a component calls. That gap
  // shipped a silently-dead reaction feature: every `show()` threw inside the
  // tracker's own catch and was logged as a warning, and every per-component test
  // stayed green. This cross-check reads the real source calls and compares them
  // against the real class prototype.
  console.log('transport contract')
  await check('every transport method the components call really exists', async () => {
    const root = new URL('../', import.meta.url)
    const libDir = new URL('lib/', root)
    // `index.js` also drives the transport (start/stop/createCard/...), so it must
    // be scanned too — a check that only looks at lib/ has a hole exactly where
    // the lifecycle calls live.
    const files = ['index.js', ...(await readdir(libDir)).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)]
    const called = new Map()
    for (const file of files) {
      const source = await readFile(new URL(file, root), 'utf8')
      // `transport.foo(` and `this.#transport.foo(`; property reads have no
      // parenthesis and are therefore not matched.
      for (const match of source.matchAll(/(?:#transport|\btransport)\.([a-zA-Z][A-Za-z0-9]*)\(/g)) {
        if (match[1] === 'constructor') continue
        if (!called.has(match[1])) called.set(match[1], file)
      }
    }
    assert.ok(called.size >= 8, `expected to find transport calls, found ${called.size}`)
    const missing = []
    for (const [name, file] of called) {
      if (typeof FeishuTransport.prototype[name] !== 'function') missing.push(`${name} (called from ${file})`)
    }
    assert.deepEqual(missing, [], `the real transport lacks: ${missing.join(', ')}`)
  })

  await check('assertValidCard turns an illegal id into a local error', () => {
    assert.doesNotThrow(() => assertValidCard(buildTurnCard({ title: 't' })))
    assert.throws(
      () => assertValidCard({ body: { elements: [{ tag: 'hr', element_id: 'footer-sep' }] } }, 'x'),
      /illegal element_id/,
    )
  })

  console.log('sessions are filed under their workspace')
  await check('the create rung files the new session', async () => {
    const filed = []
    const s = new ConversationSessions({
      sessionController: new FakeController(),
      cwd: '/tmp',
      onSession: async (id) => { filed.push(id) },
    })
    await s.reach('oc_file1')
    assert.deepEqual(filed, ['feishu-oc_file1'])
  })
  await check('the resume rung files it too, repairing older sessions', async () => {
    // A session created before this existed is already persisted, so only the
    // resume rung can still put it in a group.
    const controller = new FakeController()
    controller.live.add('feishu-oc_file2')
    const filed = []
    const s = new ConversationSessions({
      sessionController: controller,
      cwd: '/tmp',
      onSession: async (id) => { filed.push(id) },
    })
    await s.reach('oc_file2')
    assert.deepEqual(filed, ['feishu-oc_file2'])
    assert.deepEqual(controller.calls, ['resolve:feishu-oc_file2'], 'resumed, not created')
  })
  await check('a failing filer never blocks the conversation', async () => {
    const s = new ConversationSessions({
      sessionController: new FakeController(),
      cwd: '/tmp',
      onSession: async () => { throw new Error('registry down') },
      logger: { warn: () => {} },
    })
    const agent = await s.reach('oc_file3')
    assert.equal(agent.id, 'feishu-oc_file3')
  })

  console.log('workspace filer')
  /** A registry whose behaviour the test controls. */
  function registryHarness({ owned }) {
    const calls = { resolve: 0, create: 0, attach: [] }
    const workspace = { title: 'aimercat', attachSession: async (id) => { calls.attach.push(id) } }
    const registry = {
      resolveByPath: async () => { calls.resolve += 1; return owned ? workspace : undefined },
      create: async () => { calls.create += 1; return workspace },
    }
    return { registry, calls }
  }
  await check('an existing workspace is reused, not created', async () => {
    const h = registryHarness({ owned: true })
    const filer = makeWorkspaceFiler({ get: () => h.registry }, '/w', undefined)
    await filer('s1')
    assert.equal(h.calls.create, 0)
    assert.deepEqual(h.calls.attach, ['s1'])
  })
  await check('an unowned directory gets a workspace', async () => {
    const h = registryHarness({ owned: false })
    const filer = makeWorkspaceFiler({ get: () => h.registry }, '/w', undefined)
    await filer('s1')
    assert.equal(h.calls.create, 1)
    assert.deepEqual(h.calls.attach, ['s1'])
  })
  await check('the workspace is resolved once and each session attached once', async () => {
    const h = registryHarness({ owned: true })
    const filer = makeWorkspaceFiler({ get: () => h.registry }, '/w', undefined)
    await filer('s1')
    await filer('s1')
    await filer('s2')
    assert.equal(h.calls.resolve, 1, 'the workspace lookup is cached')
    assert.deepEqual(h.calls.attach, ['s1', 's2'])
  })
  await check('no workspace service means no crash, just no grouping', async () => {
    const filer = makeWorkspaceFiler({ get: () => undefined }, '/w', undefined)
    await filer('s1')
  })
  await check('an attach failure propagates to the ladder, which contains it', async () => {
    const warned = []
    const workspace = { title: 'x', attachSession: async () => { throw new Error('gone') } }
    const filer = makeWorkspaceFiler(
      { get: () => ({ resolveByPath: async () => workspace, create: async () => workspace }) },
      '/w',
      { warn: (...a) => warned.push(a) },
    )
    await assert.rejects(() => filer('s1'), /gone/)
  })

  await check('startup adopts rotations AND this workspace\'s persisted sessions', async () => {
    const tmp2 = await mkdtemp(join(tmpdir(), 'feishu-adopt-'))
    const controller = new FakeController()
    controller.inspect = async (id) => {
      if (!controller.live.has(id)) throw new Error('unknown session')
      return {}
    }
    // What the Session LIST API would report.
    controller.list = async () => ({
      items: [
        { sessionId: 'feishu-superseded', cwd: '/tmp' },   // in this cwd → adopt
        { sessionId: 'feishu-elsewhere', cwd: '/other' },  // different cwd → leave
        { sessionId: 'session-abc', cwd: '/tmp' },         // not ours → leave
      ],
    })
    const filed = []
    const s = new ConversationSessions({
      sessionController: controller,
      cwd: '/tmp',
      stateDir: tmp2,
      onSession: async (id) => { filed.push(id) },
    })
    const gone = await s.rotate('oc_gone')   // never persisted
    const here = await s.rotate('oc_here')   // persisted
    controller.live.add(here)
    await s.adoptExisting()
    assert.deepEqual(filed.sort(), ['feishu-superseded', here].sort())
    assert.ok(!filed.includes(gone), 'a vanished rotation is skipped')
    assert.ok(!filed.includes('feishu-elsewhere'), 'another cwd is not claimed')
    assert.ok(!filed.includes('session-abc'), 'a non-Feishu session is not claimed')
    await rm(tmp2, { recursive: true, force: true })
  })

  console.log('tool guard')
  await check('a denied tool gets a reason; everything else passes', () => {
    const denied = new Set(['read', 'write'])
    assert.equal(denialReason(denied, { name: 'read' }), DENIAL_REASON)
    assert.equal(denialReason(denied, { name: 'write' }), DENIAL_REASON)
    assert.equal(denialReason(denied, { name: 'bash' }), undefined)
  })
  await check('a malformed execution is allowed, not denied', () => {
    // Denying on garbage would break every other tool in the process.
    const denied = new Set(['read'])
    for (const bad of [undefined, null, {}, { name: '' }, { name: 42 }, { name: null }]) {
      assert.equal(denialReason(denied, bad), undefined, `must allow ${JSON.stringify(bad)}`)
    }
  })
  await check('an empty deny list never denies', () => {
    assert.equal(denialReason(new Set(), { name: 'read' }), undefined)
  })

  /** A minimal agent double exposing the scoped-registration surface. */
  function agentDouble({ withTools = true, guardWorks = true } = {}) {
    const installed = []
    const disposed = []
    const effects = []
    const tools = withTools
      ? { guard: (fn) => { if (!guardWorks) throw new Error('registry refused'); installed.push(fn); return () => disposed.push(fn) } }
      : undefined
    return {
      agent: {
        id: 'feishu-x',
        ctx: {
          get: (k) => (k === 'tools' ? tools : undefined),
          effect: (fn) => { const d = fn(); effects.push(d); return d },
        },
      },
      installed, disposed, effects,
    }
  }
  await check('installing the guard registers it and logs the install', () => {
    const logged = []
    const h = agentDouble()
    const dispose = installToolGuard(h.agent, ['read'], { info: (m) => logged.push(m), warn: () => {} })
    assert.equal(h.installed.length, 1, 'exactly one guard registered')
    assert.match(logged.join('\n'), /tool guard installed/)
    assert.equal(h.installed[0]({ name: 'read' }), DENIAL_REASON)
    assert.equal(h.installed[0]({ name: 'bash' }), undefined)
    dispose()
    assert.equal(h.disposed.length, 1, 'unwinding removes it')
  })
  await check('an empty deny list installs nothing at all', () => {
    const h = agentDouble()
    assert.equal(installToolGuard(h.agent, [], { info: () => {}, warn: () => {} }), undefined)
    assert.equal(h.installed.length, 0)
  })
  await check('a registry that cannot accept a guard says so instead of failing silently', () => {
    // The whole point of this module: never leave the operator believing a tool
    // is blocked when it is not.
    const warned = []
    const h = agentDouble({ withTools: false })
    assert.equal(installToolGuard(h.agent, ['read'], { info: () => {}, warn: (m) => warned.push(m) }), undefined)
    assert.match(warned.join('\n'), /NOT in effect/)
  })
  await check('an agent with no scope is skipped, not crashed', () => {
    assert.equal(installToolGuard(undefined, ['read'], { info: () => {}, warn: () => {} }), undefined)
    assert.equal(installToolGuard({ id: 'x' }, ['read'], { info: () => {}, warn: () => {} }), undefined)
  })

  console.log('admission control')
  const msg = (over = {}) => ({
    senderType: 'user', chatType: 'p2p', chatId: 'oc_1', senderId: 'ou_1', mentions: [], text: 'hi', ...over,
  })
  const open = { requireMention: false, groupAllowlist: [], senderAllowlist: [] }

  await check('an unrestricted policy admits a direct message', () => {
    assert.deepEqual(admit(msg(), open, 'hi'), { allow: true })
  })
  await check("this app's own echo and other bots never open a turn", () => {
    assert.equal(admit(msg({ senderType: 'app' }), open, 'hi').reason, DROP.notAUser)
  })
  await check('an EMPTY allowlist means no restriction, a non-empty one must match', () => {
    // The easy bug here is treating "empty list" as "deny everything".
    assert.equal(admit(msg(), open, 'hi').allow, true)
    // The listed sender passes...
    assert.equal(admit(msg({ senderId: 'ou_1' }), { ...open, senderAllowlist: ['ou_1'] }, 'hi').allow, true)
    // ...and an unlisted one does not.
    const denied = admit(msg({ senderId: 'ou_nope' }), { ...open, senderAllowlist: ['ou_1'] }, 'hi')
    assert.equal(denied.reason, DROP.senderNotAllowed)
  })
  await check('the group allowlist only constrains GROUPS', () => {
    const policy = { ...open, groupAllowlist: ['oc_allowed'] }
    // A direct message has no chat allowlist semantics; it must still pass.
    assert.equal(admit(msg(), policy, 'hi').allow, true)
    assert.equal(admit(msg({ chatType: 'group', chatId: 'oc_allowed', mentions: [{}] }), policy, 'hi').allow, true)
    assert.equal(
      admit(msg({ chatType: 'group', chatId: 'oc_other', mentions: [{}] }), policy, 'hi').reason,
      DROP.groupNotAllowed,
    )
  })
  await check('the sender allowlist also applies inside groups', () => {
    const policy = { ...open, senderAllowlist: ['ou_1'] }
    assert.equal(
      admit(msg({ chatType: 'group', senderId: 'ou_2', mentions: [{}] }), policy, 'hi').reason,
      DROP.senderNotAllowed,
    )
  })
  await check('requireMention gates groups only', () => {
    const policy = { ...open, requireMention: true }
    assert.equal(admit(msg(), policy, 'hi').allow, true, 'a DM needs no mention')
    assert.equal(admit(msg({ chatType: 'group' }), policy, 'hi').reason, DROP.needsMention)
    assert.equal(admit(msg({ chatType: 'group', mentions: [{ key: '@_user_1' }] }), policy, 'hi').allow, true)
  })
  await check('an empty body is dropped after mention stripping', () => {
    assert.equal(admit(msg(), open, '').reason, DROP.empty)
    assert.equal(admit(undefined, open, 'hi').reason, DROP.empty)
  })
  await check('only policy rejections are worth logging', () => {
    // Logging every unmentioned group message would drown the log in a busy group.
    assert.equal(isPolicyDrop(DROP.senderNotAllowed), true)
    assert.equal(isPolicyDrop(DROP.groupNotAllowed), true)
    assert.equal(isPolicyDrop(DROP.needsMention), false)
    assert.equal(isPolicyDrop(DROP.empty), false)
    assert.equal(isPolicyDrop(DROP.notAUser), false)
  })

  console.log('inbound media')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
  const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)])

  await check('image types are sniffed from the bytes, not guessed', () => {
    // Feishu sends no content type; a wrong guess is refused by the attachment
    // service, which would turn every image into a failed prompt.
    assert.equal(sniffImageMediaType(png), 'image/png')
    assert.equal(sniffImageMediaType(jpeg), 'image/jpeg')
    assert.equal(sniffImageMediaType(gif), 'image/gif')
    assert.equal(sniffImageMediaType(webp), 'image/webp')
  })
  await check('an unrecognised or truncated payload is refused, never assumed', () => {
    assert.equal(sniffImageMediaType(Buffer.from('not an image at all')), undefined)
    assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50])), undefined)
    assert.equal(sniffImageMediaType(undefined), undefined)
    assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined)
  })
  await check('a rich-text post yields its text and every nested image', () => {
    const parsed = parsePostContent(JSON.stringify({
      title: '看这个',
      content: [[{ tag: 'text', text: 'hello ' }, { tag: 'img', image_key: 'img_1' }],
                [{ tag: 'a', text: 'link' }, { tag: 'img', image_key: 'img_2' }]],
    }))
    assert.equal(parsed.text, '看这个\nhello link')
    assert.deepEqual(parsed.imageKeys, ['img_1', 'img_2'])
  })
  await check('a malformed post yields what it can instead of throwing', () => {
    assert.deepEqual(parsePostContent('{not json'), { text: '', imageKeys: [] })
    assert.deepEqual(parsePostContent(undefined), { text: '', imageKeys: [] })
    assert.deepEqual(parsePostContent('null'), { text: '', imageKeys: [] })
  })
  await check('stream collection is bounded', async () => {
    async function* chunks(...list) { for (const c of list) yield c }
    const got = await collectStream(chunks(Buffer.from('ab'), Buffer.from('cd')), 100)
    assert.equal(got.toString(), 'abcd')
    await assert.rejects(
      () => collectStream(chunks(Buffer.alloc(10), Buffer.alloc(10)), 15),
      /exceeds/,
    )
  })

  console.log('image pipeline')
  /** A transport whose download behaviour the test controls. */
  function imageHarness({ download, perMessage = 2 }) {
    return {
      transport: { downloadImage: download ?? (async () => ({ bytes: png, mediaType: 'image/png' })) },
      attachments: {
        imageLimits: { maxImageBytes: 1000, maxImagesPerMessage: perMessage, mediaTypes: ['image/png', 'image/jpeg'] },
        validateImage: async () => {},
      },
    }
  }
  await check('images become prompt parts in order', async () => {
    const h = imageHarness({})
    const out = await resolveImages({ imageKeys: ['a', 'b'], messageId: 'm', transport: h.transport, attachments: h.attachments })
    assert.equal(out.parts.length, 2)
    assert.equal(out.parts[0].type, 'image')
    assert.equal(out.parts[0].mediaType, 'image/png')
    assert.equal(out.parts[0].data, png.toString('base64'))
    assert.deepEqual(out.failures, [])
  })
  await check('the deployment cap wins over the configured limit', async () => {
    const h = imageHarness({})
    // limit 10 but the deployment allows 2 per message.
    const out = await resolveImages({ imageKeys: ['a', 'b', 'c'], messageId: 'm', transport: h.transport, attachments: h.attachments, limit: 10 })
    assert.equal(out.parts.length, 2)
    assert.match(out.failures.join(' '), /最多附带 2 张/)
  })
  await check('one bad image never costs the others', async () => {
    const h = imageHarness({
      // Room for three so the middle failure is actually reached.
      perMessage: 5,
      download: async (mid, key) => (key === 'bad' ? undefined : { bytes: jpeg, mediaType: 'image/jpeg' }),
    })
    const out = await resolveImages({ imageKeys: ['ok1', 'bad', 'ok2'], messageId: 'm', transport: h.transport, attachments: h.attachments })
    assert.equal(out.parts.length, 2)
    assert.equal(out.failures.length, 1)
    assert.match(out.failures[0], /格式无法识别/)
  })
  await check('an unsupported media type is refused with a reason', async () => {
    const h = imageHarness({ download: async () => ({ bytes: gif, mediaType: 'image/gif' }) })
    const out = await resolveImages({ imageKeys: ['a'], messageId: 'm', transport: h.transport, attachments: h.attachments })
    assert.equal(out.parts.length, 0)
    assert.match(out.failures[0], /不支持 image\/gif/)
  })
  await check('a download failure is reported, not thrown', async () => {
    const h = imageHarness({ download: async () => { throw new Error('network down') } })
    const out = await resolveImages({ imageKeys: ['a'], messageId: 'm', transport: h.transport, attachments: h.attachments, logger: { warn: () => {} } })
    assert.equal(out.parts.length, 0)
    assert.match(out.failures[0], /network down/)
  })
  await check('a policy refusal is reported per image, before the prompt', async () => {
    // Pre-validation keeps a policy refusal from rejecting the whole prompt.
    const h = imageHarness({})
    h.attachments.validateImage = async () => { throw new Error('too many pixels') }
    const out = await resolveImages({ imageKeys: ['a'], messageId: 'm', transport: h.transport, attachments: h.attachments, logger: { warn: () => {} } })
    assert.equal(out.parts.length, 0)
    assert.match(out.failures[0], /too many pixels/)
  })
  await check('no images means no work at all', async () => {
    const out = await resolveImages({ imageKeys: [], messageId: 'm', transport: {} })
    assert.deepEqual(out, { parts: [], failures: [] })
  })
  await check('the prompt puts text first and omits an empty text part', () => {
    assert.deepEqual(promptContent('hi', [{ type: 'image' }]), [{ type: 'text', text: 'hi' }, { type: 'image' }])
    // An image with no caption is still a message.
    assert.deepEqual(promptContent('', [{ type: 'image' }]), [{ type: 'image' }])
  })
  await check('the failure note is one line, or nothing', () => {
    assert.equal(failureNote([]), '')
    assert.equal(failureNote(undefined), '')
    assert.match(failureNote(['a', 'b']), /⚠️ a；b/)
  })

  console.log('media-aware admission')
  await check('an image with no caption is admitted', () => {
    // The empty-body rule must not swallow a picture.
    assert.deepEqual(admit(msg(), open, '', 1), { allow: true })
    assert.equal(admit(msg(), open, '', 0).reason, DROP.empty)
  })
  await check('an unsupported message type is dropped as unsupported', () => {
    assert.equal(admit({ ...msg(), unsupported: 'file' }, open, 'hi', 0).reason, DROP.unsupported)
    assert.equal(isPolicyDrop(DROP.unsupported), false, 'not a policy rejection')
  })
  await check('another bot gets NO reply about an unsupported type', () => {
    // The caller answers `unsupported`. If that were decided before the sender
    // gate, two bots would answer each other's attachments forever.
    const fromBot = { ...msg({ senderType: 'app' }), unsupported: 'file' }
    assert.equal(admit(fromBot, open, '', 0).reason, DROP.notAUser)
    // ...and the same for a sender the allowlist excludes.
    const excluded = { ...msg({ senderId: 'ou_no' }), unsupported: 'file' }
    assert.equal(
      admit(excluded, { ...open, senderAllowlist: ['ou_yes'] }, '', 0).reason,
      DROP.senderNotAllowed,
    )
  })

  // `node --check` only parses a file; it cannot see that a body references a
  // symbol no one imported. That gap shipped a live failure twice — the reaction
  // tracker calling transport methods that did not exist, and feishu.js calling
  // `collectStream` with no import — each time because an edit script silently
  // matched nothing. This check compares real cross-module references against the
  // real import statements.
  console.log('cross-module references')
  await check("no module uses another module's export without importing it", async () => {
    const root = new URL('../', import.meta.url)
    const libDir = new URL('lib/', root)
    const files = [
      'index.js',
      ...(await readdir(libDir)).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
    ]
    const sources = new Map()
    for (const file of files) sources.set(file, await readFile(new URL(file, root), 'utf8'))

    // Prose and string contents must not count as references: `required: ['name']`
    // names a field, it does not reference the `name` export.
    const strip = (src) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .replace(/'[^'\n]*'/g, "''")
        .replace(/"[^"\n]*"/g, '""')
        .replace(/`[^`]*`/g, '``')

    const exportedBy = new Map()
    for (const [file, raw] of sources) {
      for (const m of strip(raw).matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
        if (!exportedBy.has(m[1])) exportedBy.set(m[1], new Set())
        exportedBy.get(m[1]).add(file)
      }
    }
    assert.ok(exportedBy.size >= 20, `expected many exports, saw ${exportedBy.size}`)

    const problems = []
    for (const [file, raw] of sources) {
      const src = strip(raw)
      const imported = new Set()
      const addNames = (list) => {
        for (const part of list.split(',')) {
          const name = part.trim().split(/\s+as\s+/).pop().trim()
          if (name) imported.add(name)
        }
      }
      // The list may span lines...
      for (const m of src.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) addNames(m[1])
      // ...and a module may be pulled in dynamically instead.
      for (const m of src.matchAll(/(?:const|let|var)\s*\{([\s\S]*?)\}\s*=\s*await\s+import\s*\(/g)) addNames(m[1])
      // A name can also be local here: a parameter or declaration of the same
      // spelling is not a reference to the other module's export.
      const local = new Set()
      for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1])
      for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
        for (const part of m[1].split(',')) {
          const ids = part.trim().replace(/=.*$/, '').match(/[A-Za-z_$][\w$]*/g)
          if (ids?.length) local.add(ids[ids.length - 1])
        }
      }
      for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=>/g)) local.add(m[1])

      for (const [name, owners] of exportedBy) {
        if (owners.has(file) || imported.has(name) || local.has(name)) continue
        // Excluded: `obj.name` (property access) and `name:` (object key or label).
        // A ternary's `name` is missed as a result, which is the safe direction —
        // a missed reference cannot fail a correct build.
        const pattern = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])(?![\\w$]*\\s*:)`)
        if (pattern.test(src)) {
          problems.push(`${file} uses ${name} (from ${[...owners].join(', ')}) without importing it`)
        }
      }
    }
    assert.deepEqual(problems, [], problems.join('; '))
  })

  console.log('outbound path safety')
  await check('isInside compares path SEGMENTS, not prefixes', () => {
    // `/a/bc` must not count as inside `/a/b` — the classic prefix bug.
    assert.equal(isInside('/a/b/c.txt', '/a/b'), true)
    assert.equal(isInside('/a/b', '/a/b'), true)
    assert.equal(isInside('/a/bc', '/a/b'), false)
    assert.equal(isInside('/a/bc/d', '/a/b'), false)
    assert.equal(isInside(undefined, '/a'), false)
  })

  const sandbox = await mkdtemp(join(tmpdir(), 'feishu-out-'))
  const inside = join(sandbox, 'inside')
  const outside = join(sandbox, 'outside')
  await mkdir(inside)
  await mkdir(outside)
  await writeFile(join(inside, 'ok.txt'), 'hello')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await writeFile(join(inside, 'empty.txt'), '')
  await writeFile(join(inside, 'big.bin'), Buffer.alloc(2048))
  // The case the whole realpath step exists for: a symlink INSIDE the workspace
  // pointing outside it. A prefix check on the unresolved path would allow it.
  await symlink(join(outside, 'secret.txt'), join(inside, 'link.txt'))
  await symlink(outside, join(inside, 'linkdir'))

  await check('a workspace file is sendable', async () => {
    const r = await resolveSendablePath('ok.txt', { cwd: inside })
    assert.equal(r.ok, true)
    assert.equal(r.name, 'ok.txt')
    assert.equal(r.bytes, 5)
  })
  await check('a file outside the workspace is refused', async () => {
    const r = await resolveSendablePath(join(outside, 'secret.txt'), { cwd: inside })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不在允许发送的目录内/)
  })
  await check('a SYMLINK out of the workspace is refused', async () => {
    // Without realpath this passes the prefix check and leaks the file.
    const direct = await resolveSendablePath('link.txt', { cwd: inside })
    assert.equal(direct.ok, false, 'a symlinked file must not escape')
    const throughDir = await resolveSendablePath('linkdir/secret.txt', { cwd: inside })
    assert.equal(throughDir.ok, false, 'a symlinked directory must not escape')
  })
  await check('allowedFileDirs widens the set deliberately', async () => {
    const r = await resolveSendablePath(join(outside, 'secret.txt'), { cwd: inside, allowedDirs: [outside] })
    assert.equal(r.ok, true)
  })
  await check('a missing path, a directory, an empty file and an oversized file are each refused', async () => {
    assert.equal((await resolveSendablePath('nope.txt', { cwd: inside })).ok, false)
    assert.equal((await resolveSendablePath('.', { cwd: inside })).ok, false)
    assert.match((await resolveSendablePath('empty.txt', { cwd: inside })).reason, /空文件/)
    const big = await resolveSendablePath('big.bin', { cwd: inside, maxBytes: 100 })
    assert.equal(big.ok, false)
    assert.match(big.reason, /上限/)
  })
  await check('an empty or non-string path is refused, not resolved to the cwd', async () => {
    // resolve(cwd, '') is the cwd itself — silently sending a directory would be a
    // nasty surprise.
    assert.equal((await resolveSendablePath('', { cwd: inside })).ok, false)
    assert.equal((await resolveSendablePath('   ', { cwd: inside })).ok, false)
    assert.equal((await resolveSendablePath(undefined, { cwd: inside })).ok, false)
  })

  console.log('outbound tool')
  await check('the tool declares a usable schema for the model', () => {
    const tool = buildSendFileTool({ resolve: async () => ({ ok: false, reason: 'x' }), send: async () => ({}) })
    assert.equal(tool.name, SEND_FILE_TOOL)
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['path'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.ok(tool.description.length > 40, 'the model needs to know when to use it')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  })
  await check('a refusal is returned as a result, not thrown', async () => {
    const tool = buildSendFileTool({ resolve: async () => ({ ok: false, reason: '不在允许目录' }), send: async () => ({}) })
    const value = await tool.execute({ path: '/etc/passwd' })
    assert.equal(value.sent, false)
    assert.match(value.reason, /不在允许目录/)
    assert.match(tool.output.render({}, value)[0].text, /未发送/)
  })
  await check('a success uploads and reports the file', async () => {
    const sent = []
    const tool = buildSendFileTool({
      resolve: async () => ({ ok: true, path: join(inside, 'ok.txt'), name: 'ok.txt', bytes: 5 }),
      send: async (f) => { sent.push(f); return { messageId: 'om_1' } },
    })
    const value = await tool.execute({ path: 'ok.txt', caption: '给你' })
    assert.deepEqual(value, { sent: true, name: 'ok.txt', bytes: 5 })
    assert.equal(sent.length, 1)
    assert.equal(sent[0].name, 'ok.txt')
    assert.equal(sent[0].caption, '给你')
    assert.match(tool.output.render({}, value)[0].text, /已发送文件 ok.txt/)
  })
  await rm(sandbox, { recursive: true, force: true })

  // The Plugins page shows a "configure" control only when a client half registers
  // the row's EXACT key (`<package name>#<row id>`). Nothing validates that string,
  // so a mismatch fails as "the control never appears" — silent, and invisible to
  // every other check here.
  console.log('settings page contract')
  const repoRoot = new URL('../', import.meta.url)
  const pkg = JSON.parse(await readFile(new URL('package.json', repoRoot), 'utf8'))
  const patchText = await readFile(new URL('cordis.patch.yml', repoRoot), 'utf8')
  const clientSource = await readFile(new URL(pkg.exports['./client'], repoRoot), 'utf8')

  await check('the client half is declared for the web platform', () => {
    assert.equal(typeof pkg.exports['./client'], 'string', 'exports["./client"] must point at the browser half')
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.ok(pkg.files.includes('client'), 'the client directory must ship with the package')
  })
  await check('the client half registers at the BUNDLE level, keyed by package name', () => {
    // plugins.bundle.config is keyed by the package name; the row-level slot is
    // keyed `<package>#<rowId>` and is for one component of a multi-row bundle.
    assert.match(clientSource, /slots\.inject\('plugins\.bundle\.config'/)
    assert.match(clientSource, /name: 'plugins\.bundle\.config'/)
    assert.match(clientSource, new RegExp(`BUNDLE_KEY = '${pkg.name}'`))
  })
  await check('the settings namespace is the BARE patch id, not the loader entry id', () => {
    // `settings.describe()` keys namespaces by `entry.options.id`, which is the
    // patch's own id (`feishu-card`) — the loader's directory shows the same row as
    // `include:feishu-card`. Using the prefixed form finds nothing, and the page
    // then sits on its loading state forever with no error anywhere.
    const rowId = /-\s*id:\s*([A-Za-z0-9_-]+)/.exec(patchText)?.[1]
    assert.ok(rowId, 'the patch must declare a row id')
    // Both halves carry the string, so both are pinned to the patch.
    assert.equal(SETTINGS_NAMESPACE, rowId, 'the host half must use the bare patch id')
    assert.match(clientSource, new RegExp(`NAMESPACE = '${rowId}'`))
    assert.doesNotMatch(clientSource, new RegExp(`NAMESPACE = 'include:`))
  })
  await check('the client half fetches its own form, since the bundle page gets none', () => {
    // renderSlot("plugins.bundle.config", { view: "page" }, …) passes no `form`.
    assert.match(clientSource, /configForms/)
    assert.match(clientSource, /exports\.inject = \['slots', 'configForms'\]/)
  })
  await check('the entry point forwards the WHOLE props object, not picked fields', () => {
    // The injected services arrive as props here. Forwarding a hand-picked subset
    // silently drops the rest — naming only `form` is how `configForms` was lost,
    // and the page then reported a missing namespace that was never missing.
    assert.match(clientSource, /return h\(ConfigPage, props\)/)
    assert.doesNotMatch(clientSource, /h\(ConfigPage, \{ form: props\.form \}\)/)
  })
  await check('the client half renders both views the owner asks for', () => {
    // The owner renders the same entry twice: as the card's one-liner and as the
    // page. A component that ignores `view` renders a form in a one-line slot.
    assert.match(clientSource, /view === 'summary'/)
    assert.match(clientSource, /props\.configForms|props\.form/)
  })
  await check('the client half loads through the browser module loader', () => {
    assert.match(clientSource, /window\.__ModuleLoader__\.load\(\{/)
    assert.match(clientSource, /id: 'dsh-feishu-card'/)
    // Build-free: React.createElement only, so there is no transform to forget.
    assert.doesNotMatch(clientSource, /jsx>|React\.createElement\(\s*'<\//)
  })

  // The Settings page renders a plugin's Config down to its VOLATILE fields: the
  // host drops every other field, and a schema with no volatile field yields no
  // form at all — the entry is skipped by settings.describe(), its namespace never
  // reaches the browser, and the page can only say the namespace is missing. That
  // is exactly how this feature was dead on arrival, with nothing logged.
  console.log('settings schema')
  const schemaFields = Object.keys(Config.dict ?? {})
  const volatileFields = schemaFields.filter((name) => Config.dict[name]?.meta?.volatile === true)
  const MOUNT_ONLY = ['onboarding', 'stateDir']

  await check('every config field is either live-editable or a documented mount-only one', () => {
    const notVolatile = schemaFields.filter((name) => !volatileFields.includes(name))
    assert.deepEqual(notVolatile.sort(), [...MOUNT_ONLY].sort())
  })
  await check('a schema with no volatile field is what breaks the page, so there must be many', () => {
    assert.ok(volatileFields.length >= 20, `only ${volatileFields.length} volatile fields`)
  })
  await check('every field keeps its description, since that is the form label', () => {
    const missing = schemaFields.filter((name) => !Config.dict[name]?.meta?.description)
    assert.deepEqual(missing, [], `fields without a description: ${missing.join(', ')}`)
  })
  await check('the browser form covers exactly the fields the host will send', () => {
    // A field in the form but not in the host's form shows an empty control whose
    // value can never be read back; a field in the host's form but not in ours is
    // simply unreachable from the UI.
    // The entries are formatted across lines, so the separator must allow newlines.
    const inForm = [...clientSource.matchAll(/\{\s*name:\s*'([A-Za-z]+)'/g)].map((m) => m[1])
    const declared = inForm.filter((name) => schemaFields.includes(name))
    assert.deepEqual([...new Set(declared)].sort(), [...volatileFields].sort())
  })
  await check('the plugin reads the LIVE config, not only an event', async () => {
    // A Settings-page save does NOT emit `loader/volatile-update`: the config editor
    // resolves the new values into the live references first, so the loader's own
    // diff finds nothing to announce. A plugin that only listens keeps serving the
    // old values while the page shows the new ones.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    // ...so it reads the live config on every inbound message too, which makes no
    // notification load-bearing.
    assert.match(indexSource, /refreshSettings\('inbound message'\)/)
    // The settings service reports the document change on its own context, which is
    // a sibling of ours — only a root listener reaches it.
    assert.match(indexSource, /ctx\.root\.on\('settings\/document-updated'/)
  })
  await check('the plugin never reads ctx.config, which needs its own inject', async () => {
    // Cordis throws `cannot get property "config" without inject` for a plugin that
    // did not declare it — on the inbound path that killed EVERY message, with one
    // log line and no reply. Comments may mention it; code may not.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const code = indexSource
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.doesNotMatch(code, /ctx\.config/)
  })
  await check('re-reading settings cannot break message handling', async () => {
    // It runs before the handler's own try, so an unguarded throw is every message
    // dropped rather than one settings problem. The refresh must swallow and warn.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const body = indexSource.slice(indexSource.indexOf('const refreshSettings'))
    assert.match(body.slice(0, 900), /try \{/)
    assert.match(body, /could not re-read settings; keeping the current values/)
  })

  // A volatile field does not validate into a plain value: the loader hands out a
  // REFERENCE (`{get, set}`) so it can rewrite the live schema in place. Reading
  // `config.cwd` without unwrapping therefore yields an object, and the plugin
  // passes `[object Object]` where a path belongs — which is exactly what happened
  // when these fields were first marked volatile.
  console.log('volatile config references')
  const validated = Config({})

  await check('a volatile field validates into a reference, not a value', () => {
    assert.equal(typeof validated.cwd, 'object')
    assert.equal(isVolatileRef(validated.cwd), true)
  })
  await check('the reference protocol is the GLOBAL symbol, so it survives copies', () => {
    // Symbol.for is what makes this recognisable without importing cosmokit, which
    // this plugin cannot resolve.
    assert.equal(Symbol.for('cosmokit.volatile.write') in validated.cwd, true)
  })
  await check('plainConfig unwraps references, including nested ones', () => {
    const plain = plainConfig(validated)
    assert.equal(typeof plain.cwd, 'string')
    assert.equal(typeof plain.images, 'boolean')
    assert.equal(typeof plain.textSizes, 'object')
    assert.equal(typeof plain.textSizes.answer, 'string')
    assert.equal(isVolatileRef(plain.textSizes), false)
    assert.equal(isVolatileRef(plain.textSizes.answer), false)
  })
  await check('resolveConfig returns plain values from a validated config', () => {
    // The end-to-end invariant: this is the regression that shipped [object Object].
    const resolved = resolveConfig(validated)
    assert.equal(typeof resolved.cwd, 'string')
    assert.equal(typeof resolved.sessionScope, 'string')
    assert.equal(typeof resolved.images, 'boolean')
    assert.equal(typeof resolved.maxImagesPerMessage, 'number')
    assert.deepEqual(resolved.textSizes, {
      reasoning: 'notation', activity: 'notation', answer: 'normal', footer: 'notation',
    })
    assert.ok(!JSON.stringify(resolved).includes('[object Object]'))
  })
  await check('a plain config object still resolves normally', () => {
    const resolved = resolveConfig({ cwd: '/tmp/x', images: false })
    assert.equal(resolved.cwd, '/tmp/x')
    assert.equal(resolved.images, false)
    assert.equal(resolved.sessionScope, 'chat')
  })

  console.log('credential layering')
  const stored = { appId: 'cli_stored', appSecret: 'secret_stored', domain: 'https://open.larksuite.com' }

  await check('config credentials win over the stored app', () => {
    const out = withStoredCredentials({ appId: 'cli_cfg', appSecret: 's_cfg', domain: '' }, stored)
    assert.equal(out.appId, 'cli_cfg')
    assert.equal(out.domain, '')
  })
  await check('a config without credentials keeps the stored app', () => {
    const out = withStoredCredentials({ appId: '', appSecret: '', domain: '' }, stored)
    assert.equal(out.appId, 'cli_stored')
    assert.equal(out.appSecret, 'secret_stored')
    assert.equal(out.domain, 'https://open.larksuite.com')
  })
  await check('no stored app leaves the config alone', () => {
    const out = withStoredCredentials({ appId: '', appSecret: '' }, undefined)
    assert.equal(hasCredentials(out), false)
  })
  await check('RE-READING the config must not look like the credentials vanished', () => {
    // This is the regression that took the channel down: `refreshSettings` replaced
    // `resolved` with a bare re-resolve, so the stored app disappeared, the diff
    // looked like a credential change, and the reconnect used an empty app id.
    const reread = withStoredCredentials(resolveConfig({}), stored)
    assert.equal(hasCredentials(reread), true, 'the stored app must survive a re-read')
    assert.equal(reread.appId, 'cli_stored')
  })

  // Feishu's command picker is fed by commands registered on the APP, and nothing
  // keeps that list in step with the bot: an uninstalled plugin leaves its commands
  // behind, so the picker went on offering commands that answered "unknown command".
  console.log('slash-command panel')
  await check('the desired set drops names the platform would reject', () => {
    // A rejected create aborts the whole sync, leaving the panel half-updated.
    assert.equal(COMMAND_NAME.test('help'), true)
    assert.equal(COMMAND_NAME.test('a_b2'), true)
    assert.equal(COMMAND_NAME.test('has-dash'), false)
    assert.equal(COMMAND_NAME.test('Upper'), false)
    assert.equal(COMMAND_NAME.test('1leading'), false)
    assert.equal(COMMAND_NAME.test('x'.repeat(21)), false)
    const entries = desiredPanelEntries({ hostCommands: [
      { name: 'model', description: 'pick a model' },
      { name: 'has-dash', description: 'nope' },
      { name: '  ', description: 'nope' },
    ] })
    assert.deepEqual(entries.map((e) => e.command), ['help', 'model', 'new', 'permission', 'sessions', 'status', 'stop', 'switch'])
  })
  await check("this channel's own commands win a name collision", () => {
    // The plugin intercepts these before the host registry, so ours is what runs.
    const entries = desiredPanelEntries({ hostCommands: [{ name: 'stop', description: 'host stop' }] })
    assert.equal(entries.find((e) => e.command === 'stop').description, '停止当前任务')
  })
  await check('descriptions are tidied to one line and bounded', () => {
    const entries = desiredPanelEntries({ hostCommands: [
      { name: 'a', description: '  multi\n  line   text  ' },
      { name: 'b', description: 'y'.repeat(80) },
      { name: 'c' },
    ] })
    const by = Object.fromEntries(entries.map((e) => [e.command, e.description]))
    assert.equal(by.a, 'multi line text')
    assert.equal(by.b.length, 40)
    assert.match(by.b, /…$/)
    assert.equal(by.c, '（无说明）')
  })
  await check('the plan removes, creates, updates and keeps correctly', () => {
    const plan = planPanelSync({
      existing: [
        { command: 'gone', command_id: '1', description: { default_value: 'old' } },
        { command: 'same', command_id: '2', description: { default_value: 'unchanged' } },
        { command: 'drift', command_id: '3', description: { default_value: 'before' } },
      ],
      desired: [
        { command: 'same', description: 'unchanged' },
        { command: 'drift', description: 'after' },
        { command: 'fresh', description: 'new' },
      ],
    })
    assert.deepEqual(plan.remove.map((i) => i.command), ['gone'])
    assert.deepEqual(plan.keep, ['same'])
    assert.deepEqual(plan.create, [{ command: 'fresh', description: 'new' }])
    // Updated rather than recreated: churning ids would break anything holding one.
    assert.deepEqual(plan.update, [{ id: '3', command: 'drift', description: 'after' }])
  })
  await check('an empty panel plans only creations, and an empty wish only removals', () => {
    assert.equal(planPanelSync({ existing: [], desired: [{ command: 'x', description: 'd' }] }).create.length, 1)
    const only = planPanelSync({ existing: [{ command: 'x', command_id: '1', description: { default_value: 'd' } }], desired: [] })
    assert.equal(only.remove.length, 1)
    assert.deepEqual(only.create, [])
  })
  await check('applying a plan counts failures instead of abandoning the rest', async () => {
    // The panel is cosmetic; one refused command must not skip the other nine.
    const seen = []
    const transport = {
      deleteSlashCommand: async (id) => { seen.push(`del:${id}`); if (id === 'bad') throw new Error('refused') },
      updateSlashCommand: async (id) => { seen.push(`upd:${id}`) },
      createSlashCommand: async (e) => { seen.push(`new:${e.command}`) },
    }
    const plan = {
      remove: [{ command_id: 'bad' }, { command_id: 'ok' }],
      update: [{ id: '3', command: 'd', description: 'x' }],
      create: [{ command: 'c', description: 'x' }],
    }
    const warned = []
    const done = await applyPanelSync(plan, transport, { warn: (...a) => warned.push(a) })
    assert.deepEqual(done, { created: 1, updated: 1, removed: 1, failed: 1 })
    assert.deepEqual(seen, ['del:bad', 'del:ok', 'upd:3', 'new:c'])
    assert.equal(warned.length, 1)
  })

  // `/model` is the channel's own command: the host has no `/model`, so without it
  // the Feishu picker offered a name that answered "unknown command".
  console.log('/model')
  const catalog = {
    default: { provider: 'deepseek', model: 'flash' },
    routableProviders: ['deepseek', 'other'],
    groups: [
      { id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'flash', name: 'Flash', description: 'fast' },
        { id: 'pro', name: 'Pro' },
      ] },
      { id: 'other', name: 'Other', models: [{ id: 'flash', name: 'Flash' }] },
    ],
    failures: [],
  }

  await check('reasoning efforts are read from the catalogue, or reported absent', () => {
    const withEfforts = {
      default: { provider: 'deepseek', model: 'pro' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        { id: 'flash', name: 'Flash' },
      ] }],
      failures: [],
    }
    assert.deepEqual(effortsFor(withEfforts, 'deepseek', 'pro').efforts.map((e) => e.id), ['low', 'high'])
    assert.equal(effortsFor(withEfforts, 'deepseek', 'pro').defaultEffort, 'low')
    // A model with no reasoning block has no such choice; that is not an error.
    assert.deepEqual(effortsFor(withEfforts, 'deepseek', 'flash').efforts, [])
    assert.deepEqual(effortsFor(withEfforts, 'nope', 'nope').efforts, [])
  })
  await check('an effort can be given on the command line', () => {
    const cat = {
      default: { provider: 'deepseek', model: 'pro' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
        { id: 'flash', name: 'Flash' },
      ] }],
      failures: [],
    }
    assert.equal(resolveModelQuery('deepseek/pro high', cat, 'zh').effort, 'high')
    assert.equal(resolveModelQuery('deepseek/pro High', cat, 'zh').effort, 'high', 'names work too')
    assert.equal(resolveModelQuery('pro low', cat, 'zh').effort, 'low')
    assert.equal(resolveModelQuery('deepseek/pro', cat, 'zh').effort, undefined)
    // An effort the model does not offer must be refused, not silently dropped:
    // dropping it would look like it took effect.
    assert.match(resolveModelQuery('deepseek/pro ultra', cat, 'zh').error, /找不到推理档位/)
    assert.match(resolveModelQuery('deepseek/flash high', cat, 'zh').error, /不支持推理档位/)
  })
  await check('the effort picker preselects the active effort and offers the default', () => {
    const cat = {
      default: { provider: 'deepseek', model: 'pro' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
      ] }],
      failures: [],
    }
    const card = buildEffortCard({
      catalog: cat,
      current: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      provider: 'deepseek',
      model: 'pro',
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    assertValidCard(card, 'effort card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const select = card.body.elements.find((el) => el.element_id === 'eselect')
    // One per effort, plus an explicit "default" — a distinct outcome from "no
    // effort recorded", so it cannot be folded into the effort list.
    assert.deepEqual(select.options.map((o) => JSON.parse(o.value).e), ['low', 'high', ''])
    assert.equal(select.initial_option, '{"e":"high"}')
    // The model is carried by the behavior: the click decides only the effort.
    assert.deepEqual(select.behaviors, [{ type: 'callback', value: { k: 'effort', s: 'feishu-abc', p: 'deepseek', m: 'pro' } }])
    assert.match(JSON.stringify(select.options), /Low \(默认\)|Low（默认）/)
  })
  await check('the model picker only carries an effort select when there is one', () => {
    const cat = {
      default: { provider: 'deepseek', model: 'pro' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
        { id: 'flash', name: 'Flash' },
      ] }],
      failures: [],
    }
    const onPro = buildModelCard({
      catalog: cat, current: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      sessionId: 's', locale: 'zh',
    })
    assert.ok(onPro.body.elements.some((el) => el.element_id === 'eselect'), 'adjustable in place')
    // A model with no efforts gets no dead-end select.
    const onFlash = buildModelCard({
      catalog: cat, current: { provider: 'deepseek', model: 'flash' }, sessionId: 's', locale: 'zh',
    })
    assert.ok(!onFlash.body.elements.some((el) => el.element_id === 'eselect'))
  })
  await check('a model WITH efforts opens the effort step instead of applying', async () => {
    // Applying the model default silently would be choosing on the user's behalf —
    // and the session's existing effort may not even be valid for the new model.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const branch = indexSource.slice(indexSource.indexOf("if (efforts.length > 0)"))
    assert.match(branch.slice(0, 700), /buildEffortCard\(/)
    assert.match(branch.slice(0, 700), /return \{ card: \{ type: 'raw', data: card \} \}/)
    // And the effort select sends the effort only when one was named.
    assert.match(indexSource, /if \(effort !== ''\) requested\.reasoningEffort = effort/)
  })
  await check('/model is advertised by this channel and in the Feishu panel', () => {
    assert.ok(OWN_PANEL_COMMANDS.some((c) => c.command === 'model'))
    for (const locale of ['zh', 'en']) {
      assert.ok(strings(locale).pluginCommands.some((line) => line.includes('/model')), `${locale} help must list /model`)
    }
  })
  await check('a selection reads as provider/model, plus effort when set', () => {
    assert.equal(describeSelection({ provider: 'p', model: 'm' }), 'p/m')
    assert.equal(describeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }), 'p/m (high)')
    assert.equal(describeSelection(undefined), '')
    assert.equal(describeSelection({ provider: '', model: '' }), '')
  })
  await check('the catalogue flattens with each model carrying its provider', () => {
    const flat = flattenCatalog(catalog)
    assert.equal(flat.length, 3)
    assert.deepEqual(flat.map((e) => `${e.provider}/${e.model}`), ['deepseek/flash', 'deepseek/pro', 'other/flash'])
    assert.equal(flat[0].providerName, 'DeepSeek')
  })
  await check('an exact provider/model resolves', () => {
    const out = resolveModelQuery('deepseek/pro', catalog, 'zh')
    assert.equal(out.entry.provider, 'deepseek')
    assert.equal(out.entry.model, 'pro')
  })
  await check('a bare name resolves only when it is unambiguous', () => {
    // Guessing between two providers' same-named models would silently pick one.
    assert.equal(resolveModelQuery('pro', catalog, 'zh').entry.model, 'pro')
    const ambiguous = resolveModelQuery('flash', catalog, 'zh')
    assert.equal(ambiguous.entry, undefined)
    assert.match(ambiguous.error, /deepseek\/flash/)
    assert.match(ambiguous.error, /other\/flash/)
  })
  await check('matching is case-insensitive, and display names work', () => {
    assert.equal(resolveModelQuery('DEEPSEEK/PRO', catalog, 'zh').entry.model, 'pro')
    assert.equal(resolveModelQuery('Pro', catalog, 'zh').entry.entry?.model ?? resolveModelQuery('Pro', catalog, 'zh').entry.model, 'pro')
  })
  await check('an unknown name and an empty query are distinguished', () => {
    assert.match(resolveModelQuery('nope', catalog, 'zh').error, /找不到模型/)
    assert.match(resolveModelQuery('nope', catalog, 'en').error, /No model matches/)
    assert.equal(resolveModelQuery('   ', catalog, 'zh').list, true)
  })
  await check('the picker card is valid and its select names every model', () => {
    const card = buildModelCard({
      catalog,
      current: { provider: 'deepseek', model: 'flash' },
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    assertValidCard(card, 'model card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const select = card.body.elements.find((el) => el.element_id === 'mselect')
    assert.ok(select, 'the models live in one select')
    assert.equal(select.tag, 'select_static')
    // A select reports only one string, so the intent travels as JSON in the value
    // while the behavior stays a constant marker for the card.
    assert.deepEqual(select.behaviors, [{ type: 'callback', value: { k: 'model', s: 'feishu-abc' } }])
    assert.equal(select.options.length, flattenCatalog(catalog).length)
    for (const option of select.options) {
      const parsed = JSON.parse(option.value)
      assert.ok(parsed.p && parsed.m, 'every option names a provider and a model')
    }
    // The current model is preselected, so the dropdown opens where you are.
    assert.deepEqual(JSON.parse(select.initial_option), { p: 'deepseek', m: 'flash' })
  })
  await check('a card with no current selection still builds, and an empty catalogue degrades', () => {
    const bare = buildModelCard({ catalog, current: undefined, sessionId: 'feishu-abc', locale: 'zh' })
    assertValidCard(bare, 'model card without a selection')
    const empty = buildModelCard({
      catalog: { default: { provider: 'p', model: 'm' }, groups: [], failures: [] },
      current: undefined,
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    assertValidCard(empty, 'model card without models')
    assert.match(JSON.stringify(empty), /没有可用模型/)
  })
  await check('a settled card shows the outcome and offers no more choices', () => {
    // The picker is for deciding. Leaving it open after the decision reads as "not
    // saved", and the way back is a deliberate `/model` rather than a mis-tap.
    const card = buildModelCard({
      catalog,
      current: { provider: 'deepseek', model: 'pro' },
      sessionId: 'feishu-abc',
      locale: 'zh',
      settled: true,
    })
    assertValidCard(card, 'settled model card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const text = JSON.stringify(card)
    assert.equal((text.match(/"tag":"button"/g) ?? []).length, 0, 'no buttons once settled')
    assert.match(text, /deepseek\/pro/)
    assert.match(text, /重新发送/)
    // The same shape in the other locale, since both are shipped.
    const en = buildModelCard({
      catalog, current: { provider: 'deepseek', model: 'pro' }, sessionId: 's', locale: 'en', settled: true,
    })
    assertValidCard(en, 'settled model card (en)')
    assert.match(JSON.stringify(en), /Send `\/model` again/)
  })
  await check('only the switch repaint settles; the /model picker still offers choices', async () => {
    // Getting this backwards would leave `/model` unable to change anything.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const repaint = indexSource.slice(indexSource.indexOf('const repaintModelCard'))
    assert.match(repaint.slice(0, 600), /settled: true/)
    const picker = indexSource.slice(indexSource.indexOf("name === 'model'"))
    assert.doesNotMatch(picker.slice(0, 900), /settled: true/)
  })
  await check('the preselect ignores the reasoning effort', () => {
    // The option stands for a model, not for one effort level. Comparing the
    // rendered label (which appends " (high)") would leave nothing preselected
    // exactly when the session is most specifically configured.
    const card = buildModelCard({
      catalog,
      current: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    const select = card.body.elements.find((el) => el.element_id === 'mselect')
    assert.deepEqual(JSON.parse(select.initial_option), { p: 'deepseek', m: 'pro' })
    // The effort itself still shows, in the current-model line and in the effort
    // select that rides along — which needs a catalogue where the model has one.
    assert.match(JSON.stringify(card), /deepseek\/pro \(high\)/)
    const withEffort = {
      default: { provider: 'deepseek', model: 'pro' },
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'pro', name: 'Pro', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
      ] }],
      failures: [],
    }
    const card2 = buildModelCard({
      catalog: withEffort,
      current: { provider: 'deepseek', model: 'pro', reasoningEffort: 'high' },
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    assert.equal(card2.body.elements.find((el) => el.element_id === 'eselect').initial_option, '{"e":"high"}')
  })
  await check('a switch repaints the picker by BOTH routes', async () => {
    // A toast alone leaves the card claiming the previous model, which reads as
    // "the click did nothing" — the exact complaint this fixes. Neither route is
    // guaranteed on its own: the callback-response card is what the platform
    // documents for a click, and patching the message covers where that is ignored.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    assert.match(indexSource, /card: \{ type: 'raw', data: card \}/)
    assert.match(indexSource, /transport\.updateCardMessage\(/)
    // The message id has to survive being read out of the callback.
    // The message id is destructured out of the callback; dropping it would leave
    // the patch with nothing to address.
    assert.match(indexSource, /const \{[^}]*messageId[^}]*\} = readCardAction\(data\)/)
    const transport = await readFile(new URL('lib/feishu.js', repoRoot), 'utf8')
    assert.match(transport, /async updateCardMessage\(messageId, card\)/)
    assert.match(transport, /im\.v1\.message\.patch/)
    // A missing id must be loud here: silently skipping would look like a repaint.
    assert.match(transport, /updateCardMessage needs a message id/)
  })
  await check('the SDK client is built lazily, so API calls work before start()', async () => {
    // Building it only inside start() meant any API method called first failed with
    // "cannot read properties of undefined (reading 'im')".
    const transport = await readFile(new URL('lib/feishu.js', repoRoot), 'utf8')
    assert.match(transport, /#ensureClient\(\)/)
    assert.match(transport, /get #client\(\) \{\s*\n\s*return this\.#ensureClient\(\)/)
  })
  await check('provider failures are surfaced rather than hidden', () => {
    const card = buildModelCard({
      catalog: { ...catalog, failures: [{ id: 'broken', name: 'Broken', message: 'no credentials' }] },
      current: undefined,
      sessionId: 'feishu-abc',
      locale: 'zh',
    })
    assertValidCard(card, 'model card with failures')
    assert.match(JSON.stringify(card), /no credentials/)
  })

  // `/new` mints an id and is a one-way door; these commands make the binding
  // visible and reversible.
  console.log('session picker')
  const NOW = Date.now()
  const sessionRows = [
    { sessionId: 'feishu-oc_a-mux1', updatedAt: NOW - 30_000, cwd: '/w/aimercat', projections: { values: { title: '重构卡片渲染' } } },
    { sessionId: 'feishu-oc_a-mux2', updatedAt: NOW - 3_600_000, running: true, projections: { values: { title: '部署排查' } } },
    { sessionId: 'feishu-oc_a-mux3', updatedAt: NOW - 90_000_000, blank: true },
    { sessionId: 'feishu-oc_a-mux4', updatedAt: NOW - 120_000, origin: 'subagent' },
    { sessionId: 'other-xyz', updatedAt: NOW - 5_000, projections: { values: { title: 'Web UI 会话' } } },
  ]

  await check('the picker hides machinery and unused sessions, newest first', () => {
    const { items, total } = selectableSessions({ summaries: sessionRows, currentId: 'feishu-oc_a-mux2' })
    // A blank session was never used and a subagent one is machinery; neither is
    // something a person means to switch to.
    assert.deepEqual(items.map((r) => r.sessionId), ['other-xyz', 'feishu-oc_a-mux1', 'feishu-oc_a-mux2'])
    assert.equal(total, 3)
    assert.ok(!items.some((r) => r.sessionId.endsWith('mux3')))
    assert.ok(!items.some((r) => r.sessionId.endsWith('mux4')))
  })
  await check('the current session survives the filter, and the list is capped', () => {
    // A picker that omits where you already are is confusing.
    const { items } = selectableSessions({ summaries: sessionRows, currentId: 'feishu-oc_a-mux3' })
    assert.ok(items.some((r) => r.sessionId.endsWith('mux3')), 'a blank CURRENT session must still be listed')
    const many = Array.from({ length: 20 }, (_, i) => ({ sessionId: `feishu-s${i}`, updatedAt: NOW - i }))
    const capped = selectableSessions({ summaries: many, currentId: 'feishu-s0' })
    assert.equal(capped.items.length, SESSION_LIMIT)
    assert.equal(capped.total, 20)
  })
  await check('a session is labelled by its title, else by its id tail', () => {
    assert.equal(sessionLabel(sessionRows[0]), '重构卡片渲染')
    assert.equal(sessionLabel({ sessionId: 'feishu-abcdef' }), 'abcdef')
    assert.equal(sessionLabel({ sessionId: 'feishu-abcdef', projections: { values: { title: '   ' } } }), 'abcdef')
  })
  await check('relative time is coarse and never negative', () => {
    assert.equal(relativeTime(NOW - 10_000, NOW, 'zh'), '刚刚')
    assert.equal(relativeTime(NOW - 5 * 60_000, NOW, 'zh'), '5 分钟前')
    assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW, 'zh'), '3 小时前')
    assert.equal(relativeTime(NOW - 2 * 86_400_000, NOW, 'en'), '2d ago')
    assert.equal(relativeTime(NOW + 5_000, NOW, 'zh'), '刚刚', 'a clock skew must not read as negative')
    assert.equal(relativeTime(undefined, NOW, 'zh'), '')
  })
  await check('a typed id resolves exactly, by prefix, or refuses when ambiguous', () => {
    // Binding a conversation to the wrong session is not something the user can see
    // happened, so an ambiguous prefix is refused rather than guessed.
    assert.equal(resolveSessionQuery('feishu-oc_a-mux1', sessionRows, 'zh').item.sessionId, 'feishu-oc_a-mux1')
    assert.equal(resolveSessionQuery('mux1', sessionRows, 'zh').item.sessionId, 'feishu-oc_a-mux1')
    assert.match(resolveSessionQuery('mux', sessionRows, 'zh').error, /匹配到多个会话/)
    assert.match(resolveSessionQuery('nope', sessionRows, 'zh').error, /找不到会话/)
    assert.equal(resolveSessionQuery('  ', sessionRows, 'zh').list, true)
  })
  await check('the picker card is valid and its select names every session', () => {
    const { items, total } = selectableSessions({ summaries: sessionRows, currentId: 'feishu-oc_a-mux2' })
    const card = buildSessionsCard({
      items, total, currentId: 'feishu-oc_a-mux2', sessionId: 'feishu-oc_a-mux2', locale: 'zh',
    })
    assertValidCard(card, 'sessions card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const select = card.body.elements.find((el) => el.element_id === 'sselect')
    assert.equal(select.options.length, items.length)
    for (const option of select.options) {
      const parsed = JSON.parse(option.value)
      // `t` is the target session; the behavior's `s` identifies the CONVERSATION.
      assert.ok(items.some((row) => row.sessionId === parsed.t))
      assert.ok(option.text.content.length > 0)
    }
    assert.deepEqual(JSON.parse(select.initial_option), { t: 'feishu-oc_a-mux2' })
    assert.deepEqual(select.behaviors, [{ type: 'callback', value: { k: 'session', s: 'feishu-oc_a-mux2' } }])
  })
  await check('a settled picker shows the outcome and offers no more choices', () => {
    const card = buildSessionsCard({
      items: [sessionRows[0]], total: 1, currentId: sessionRows[0].sessionId,
      sessionId: sessionRows[0].sessionId, locale: 'zh', settled: true,
    })
    assertValidCard(card, 'settled sessions card')
    assert.equal((JSON.stringify(card).match(/"tag":"button"/g) ?? []).length, 0)
    assert.match(JSON.stringify(card), /下一条消息将发往该会话/)
  })
  await check('an empty list still renders a valid card', () => {
    const card = buildSessionsCard({ items: [], total: 0, currentId: 'x', sessionId: 'x', locale: 'zh' })
    assertValidCard(card, 'empty sessions card')
    assert.match(JSON.stringify(card), /没有可切换的会话/)
  })

  console.log('session switching')
  const switchDir = await mkdtemp(join(tmpdir(), 'feishu-switch-'))
  const switchLadder = new ConversationSessions({
    sessionController: new FakeController(), cwd: '/tmp', stateDir: switchDir,
  })
  const switched = await switchLadder.use('oc_a', 'feishu-old-session')
  await check('use() adopts an existing session instead of minting one', () => {
    assert.equal(switched, 'feishu-old-session')
    assert.equal(switchLadder.idFor('oc_a'), 'feishu-old-session')
    // keyOf() reports ROUTING, which bind() establishes — use() only repoints the
    // key. Asserting it here would be asserting the wrong contract.
    assert.equal(switchLadder.keyOf('feishu-old-session'), undefined)
    switchLadder.bind('oc_a', { chatId: 'oc_a', messageId: 'om_0' })
    assert.equal(switchLadder.keyOf('feishu-old-session'), 'oc_a')
  })
  await check('use() persists, so a restart keeps the conversation where it was put', async () => {
    const reloaded = new ConversationSessions({
      sessionController: new FakeController(), cwd: '/tmp', stateDir: switchDir,
    })
    await reloaded.load()
    assert.equal(reloaded.idFor('oc_a'), 'feishu-old-session')
  })
  await check('use() drops the routing of the session being left', async () => {
    const inbound = { chatId: 'oc_a', messageId: 'om_1', senderId: 'u1', threadId: undefined }
    switchLadder.bind('oc_a', inbound)
    assert.equal(switchLadder.serves('feishu-old-session'), true)
    const derived = sessionIdFor('oc_a')
    switchLadder.bind('oc_a', inbound)
    await switchLadder.use('oc_a', 'feishu-newer')
    // The conversation answers from the new session only; the old pairing is gone.
    assert.equal(switchLadder.serves('feishu-old-session'), false)
    assert.equal(switchLadder.serves('feishu-newer'), false, 'routing is re-established by bind()')
    assert.equal(switchLadder.keyOf('feishu-newer'), undefined)
    assert.equal(derived === 'feishu-newer', false)
  })
  await check('use() with the same id is a no-op that keeps the binding', async () => {
    const ladder2 = new ConversationSessions({ sessionController: new FakeController(), cwd: '/tmp' })
    ladder2.bind('oc_b', { chatId: 'oc_b', messageId: 'om_2' })
    const id = ladder2.idFor('oc_b')
    await ladder2.use('oc_b', id)
    assert.equal(ladder2.idFor('oc_b'), id)
  })
  await check('only turns this chat asked for are rendered into it', async () => {
    // Binding a conversation to a session another frontend uses must not broadcast
    // that frontend's conversations into a chat the user never pointed at it.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    assert.match(indexSource, /const channelTurns = new Map\(\)/)
    // Counted, not flagged: a message admitted during a running turn is queued and
    // owes a turn that starts only after the current one ends.
    assert.match(indexSource, /channelTurns\.set\(sessionId, \(channelTurns\.get\(sessionId\) \?\? 0\) \+ 1\)/)
    assert.match(indexSource, /if \(!renderer\.has\(sessionId\) && \(channelTurns\.get\(sessionId\) \?\? 0\) > 0\) \{/)
    assert.match(indexSource, /const owed = channelTurns\.get\(sessionId\) \?\? 0/)
    // A dispatch that throws must give the count back: left raised, the next turn in
    // the session renders a card even when another frontend started it.
    const dispatch = indexSource.slice(indexSource.indexOf('channelTurns.set(sessionId'))
    const rollback = dispatch.indexOf('throw error')
    assert.ok(rollback > 0 && rollback < 1400, 'the dispatch must roll the count back before rethrowing')
    assert.match(dispatch.slice(0, rollback), /channelTurns\.delete\(sessionId\)/)
  })
  await check('the switch action is handled before the pending lookup', async () => {
    // Like the model buttons, it is stateless: no correlation entry exists, so the
    // pending lookup would reject it as expired.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const action = indexSource.indexOf("action.k === 'session'")
    const lookup = indexSource.indexOf('const entry = pending.get(submitId ?? action.id)')
    assert.ok(action > 0 && lookup > 0 && action < lookup, 'the stateless branch must come first')
    // And it must verify the conversation is one this channel serves.
    assert.match(indexSource.slice(action, action + 900), /sessions\.keyOf\(action\.s\)/)
  })

  // Both are one value out of a small fixed set, applied to the session this
  // conversation is on.
  console.log('preset and permission pickers')
  await check('the preset lock mirrors the host guard exactly', () => {
    // This check exists to PREDICT a refusal, so being wrong either way is a bug:
    // a false positive hides a usable picker, a false negative offers one that fails.
    assert.equal(presetLocked({ openTurnStartSeq: null, lastTurn: 0 }), false)
    assert.equal(presetLocked({ openTurnStartSeq: 5, lastTurn: 0 }), true, 'an open turn locks it')
    assert.equal(presetLocked({ openTurnStartSeq: null, lastTurn: 3 }), true, 'a finished turn locks it')
    assert.equal(presetLocked(undefined), false, 'no projection is not evidence of a lock')
    assert.equal(presetLocked(null), false)
  })
  await check('broken presets are hidden and order is respected', () => {
    // A preset that failed to compose cannot be selected; offering it is a dead end.
    const options = presetOptions([
      { id: 'b', name: 'B', order: 2 },
      { id: 'broken', name: 'Broken', order: 1, broken: 'compose failed' },
      { id: 'a', name: 'A', order: 1 },
    ])
    assert.deepEqual(options.map((o) => o.value), ['a', 'b'])
    assert.deepEqual(presetOptions(undefined), [])
  })
  await check('the built-in ids get Chinese names, a host name still wins', () => {
    // The harness ships the built-ins as ids only, so a picker would read
    // "standard / ptc / minimal" in an otherwise Chinese UI.
    assert.deepEqual(
      presetOptions([{ id: 'standard' }, { id: 'ptc' }, { id: 'minimal' }]).map((o) => o.name),
      ['标准模式', 'PTC 模式', '极简模式'],
    )
    assert.equal(presetOptions([{ id: 'liangshen', name: '梁神模式' }])[0].name, '梁神模式')
    assert.equal(presetOptions([{ id: 'custom' }])[0].name, 'custom', 'an unknown id falls back to itself')
    assert.deepEqual(
      permissionOptions({ options: [{ value: 'read-only' }, { value: 'workspace-write' }, { value: 'danger-full-access' }] }).map((o) => o.name),
      ['只读', '可写工作区', '完全访问（危险）'],
    )
  })
  await check('permission options come from the catalog', () => {
    const options = permissionOptions({ options: [{ value: 'ask', name: 'Ask' }, { value: '', name: 'bad' }], defaultPreset: 'ask' })
    assert.deepEqual(options.map((o) => o.value), ['ask'])
    assert.deepEqual(permissionOptions(undefined), [])
  })
  await check('a typed value or name resolves, an ambiguous one is refused', () => {
    const options = [{ value: 'standard', name: '标准' }, { value: 'minimal', name: '极简' }]
    assert.equal(resolveOptionQuery('standard', options, 'zh').option.value, 'standard')
    assert.equal(resolveOptionQuery('标准', options, 'zh').option.value, 'standard')
    assert.equal(resolveOptionQuery('STANDARD', options, 'zh').option.value, 'standard')
    assert.match(resolveOptionQuery('nope', options, 'zh').error, /找不到/)
    assert.equal(resolveOptionQuery('', options, 'zh').list, true)
    // Applying the wrong preset to a session is not something the user can see
    // happened, so a shared name must not be guessed.
    const clash = [{ value: 'a', name: '同名' }, { value: 'b', name: '同名' }]
    assert.match(resolveOptionQuery('同名', clash, 'zh').error, /匹配到多个/)
  })
  await check('the choice card preselects the current value and carries the kind', () => {
    const card = buildChoiceCard({
      title: 'DSH · 模式',
      heading: '**当前模式**',
      currentLabel: '标准',
      currentValue: 'standard',
      placeholder: '选择模式',
      options: [{ value: 'standard', name: '标准' }, { value: 'minimal', name: '极简' }],
      behavior: { k: 'preset', s: 'feishu-abc' },
      hint: 'hint',
      emptyText: 'none',
    })
    assertValidCard(card, 'preset card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const select = card.body.elements.find((el) => el.tag === 'select_static')
    assert.equal(select.initial_option, choiceOptionValue('standard'))
    assert.deepEqual(select.behaviors, [{ type: 'callback', value: { k: 'preset', s: 'feishu-abc' } }])
    assert.deepEqual(select.options.map((o) => JSON.parse(o.value).v), ['standard', 'minimal'])
    // The label is prose for the reader; the value must match an option exactly.
    assert.match(JSON.stringify(card.body.elements[0]), /标准/)
  })
  await check('a settled choice card shows the outcome, never an object', () => {
    // The label and the value are separate parameters because the label is
    // concatenated into markdown — passing the record would render "[object Object]".
    const card = buildChoiceCard({
      title: 'DSH · 权限',
      heading: '**当前权限**',
      currentLabel: '极简',
      currentValue: 'minimal',
      placeholder: 'x',
      options: [],
      behavior: {},
      settledText: '已切到 **极简**。',
      emptyText: '',
      settled: true,
    })
    assertValidCard(card, 'settled choice card')
    const text = JSON.stringify(card)
    assert.match(text, /极简/)
    assert.doesNotMatch(text, /object Object/)
    assert.equal((text.match(/"tag":"select_static"/g) ?? []).length, 0, 'no picker once settled')
  })
  await check('an empty catalog still renders a valid card', () => {
    const card = buildChoiceCard({
      title: 'T', heading: 'H', currentLabel: 'none', currentValue: undefined,
      placeholder: 'p', options: [], behavior: {}, emptyText: '（没有可选）',
    })
    assertValidCard(card, 'empty choice card')
    assert.match(JSON.stringify(card), /没有可选/)
  })
  await check('the preset is deferred to the next message, not applied by the card', async () => {
    // Right after `/new` the session does not exist, and the host only accepts a
    // preset before a session's first turn — which is when it is created.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const action = indexSource.slice(indexSource.indexOf("action.k === 'preset' || action.k === 'permission'"))
    assert.match(action.slice(0, 1600), /pendingPresets\.set\(key, value\)/)
    // Applied at creation, before the first prompt.
    assert.match(indexSource, /await applyPendingPreset\(key, agent\)/)
    const apply = indexSource.slice(indexSource.indexOf('const applyPendingPreset'))
    assert.match(apply.slice(0, 900), /agentPresetLocked\(agent\)/)
    // `/new` binds the rotated session so the card's callback is authorised.
    const newBlock = indexSource.slice(indexSource.indexOf("if (name === 'new')"))
    assert.match(newBlock.slice(0, 1400), /sessions\.bind\(key, \{ chatId, messageId: replyToMessageId \}\)/)
  })
  await check('/new defaults the preset, so skipping the picker is not a gap', async () => {
    // "Start without choosing" has to mean the default, and that must not depend on
    // the user touching the picker.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    const newBlock = indexSource.slice(indexSource.indexOf("if (name === 'new')"))
    assert.match(newBlock.slice(0, 2200), /pendingPresets\.set\(key, fallback\)/)
    assert.match(newBlock.slice(0, 2200), /registry\.defaultId/)
  })
  await check('/permission is advertised, and /preset is gone (it merged into /new)', () => {
    assert.ok(OWN_PANEL_COMMANDS.some((c) => c.command === 'permission'))
    // The preset picker is part of `/new` now: a separate command would be a second
    // way in, and the only moment it works is the moment `/new` creates.
    assert.ok(!OWN_PANEL_COMMANDS.some((c) => c.command === 'preset'))
    for (const locale of ['zh', 'en']) {
      const lines = strings(locale).pluginCommands
      assert.ok(lines.some((line) => line.includes('/permission')), `${locale} help must list /permission`)
      assert.ok(!lines.some((line) => line.includes('/preset')), `${locale} help must not list /preset`)
      assert.ok(lines.some((line) => line.includes('/new')), `${locale} help must mention /new`)
    }
  })

  // A text list tells you what exists; a card lets you run it. Feishu has no
  // autocomplete, so the card is the only discoverability there is.
  console.log('/help card')
  const helpHostCommands = [
    { name: 'export', description: 'Download this Session log as a ZIP archive' },
    { name: 'feedback', description: 'Record feedback about this session' },
    { name: 'restart', description: 'Restart the harness' },
    { name: 'shutdown', description: 'Stop the harness' },
  ]

  await check('the channel owns one structured command list', () => {
    // The text help and the card render the same list; two renderings of one fact
    // drift apart.
    const own = ownCommands('zh')
    assert.ok(own.length >= 8)
    for (const entry of own) {
      assert.ok(entry.name && entry.description, 'every command needs a name and a description')
      assert.ok(!entry.name.startsWith('/'), 'names are bare: the slash is presentation')
    }
    assert.deepEqual(
      ownCommands('zh').map((c) => c.name),
      strings('zh').pluginCommands.map((line) => /`\/([a-z]+)`/.exec(line)[1]),
      'the rendered lines must come from the same list',
    )
  })
  await check('destructive commands are recognised by name, not by prose', () => {
    // The registry's description is prose for a human and cannot be relied on to
    // mark danger.
    for (const name of ['new', 'stop', 'restart', 'shutdown']) assert.equal(isDestructive(name), true, name)
    for (const name of ['model', 'sessions', 'status', 'help']) assert.equal(isDestructive(name), false, name)
    assert.equal(isDestructive(undefined), false)
    assert.equal(DESTRUCTIVE_COMMANDS.has('new'), true)
  })
  await check('the help card offers a button per safe command and runs nothing else', () => {
    const card = buildHelpCard({ own: ownCommands('zh'), host: helpHostCommands, sessionId: 'feishu-abc', locale: 'zh' })
    assertValidCard(card, 'help card')
    assert.deepEqual(invalidElementIds(card), [])
    assert.deepEqual(duplicateElementIds(card), [])
    const buttons = []
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      if (node.tag === 'button') buttons.push(node)
      Object.values(node).forEach(walk)
    }
    walk(card)
    const labels = buttons.map((b) => b.text.content)
    // Every non-destructive command of BOTH sections is runnable.
    for (const name of ['/model', '/sessions', '/switch', '/permission', '/status', '/help', '/export', '/feedback']) {
      assert.ok(labels.includes(name), `${name} must be a button`)
    }
    // A mis-tap on these cannot be undone by looking at the result, so they are not.
    for (const name of ['/new', '/stop', '/restart', '/shutdown']) {
      assert.ok(!labels.includes(name), `${name} must NOT be a button`)
    }
    for (const button of buttons) {
      const payload = button.behaviors[0].value
      assert.equal(payload.k, 'run')
      assert.equal(payload.s, 'feishu-abc')
      assert.ok(!payload.c.startsWith('/'), 'the payload names the command without the slash')
    }
    // Stated, not silently omitted: a user who cannot find `/new` needs to know why.
    assert.match(JSON.stringify(card), /需要手动输入/)
    assert.match(JSON.stringify(card), /`\/new`/)
  })
  await check('the help card still renders with nothing to show', () => {
    const card = buildHelpCard({ own: [], host: [], sessionId: 's', locale: 'zh' })
    assertValidCard(card, 'empty help card')
    assert.match(JSON.stringify(card), /没有可用的命令/)
  })
  await check('a help button runs through the SAME dispatcher as a typed command', async () => {
    // A command that works when typed but fails when tapped is reported as "the
    // button does nothing", so there is exactly one implementation.
    const indexSource = await readFile(new URL('index.js', repoRoot), 'utf8')
    assert.match(indexSource, /await runCommand\(\{/)
    const action = indexSource.slice(indexSource.indexOf("action.k === 'run'"))
    const body = action.slice(0, action.indexOf("action.k === 'preset'"))
    assert.match(body, /await runCommand\(\{/)
    // The payload is a NAME, so anything that trusted it blindly could run an
    // arbitrary line.
    assert.match(body, /const offered = ownCommands\(resolved\.locale\)\.some/)
    assert.match(body, /if \(!offered \|\| key === undefined\)/)
    // And the text form survives as the fallback.
    assert.match(indexSource, /help card failed; falling back to text/)
  })

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
