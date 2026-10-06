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
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
  invalidElementIds,
  settledDecisionElements,
} from '../lib/card.js'
import { TurnRenderer } from '../lib/turn.js'
import { ConversationSessions, conversationKey, sessionIdFor } from '../lib/session.js'
import { commandName, helpText, isCommandLine, runCommandLine } from '../lib/commands.js'
import { describeCall, describeDiff, formatTokens, kindOf } from '../lib/present.js'
import { REACTION, ReactionTracker } from '../lib/react.js'
import { FeishuTransport } from '../lib/feishu.js'
import { Notices, compactionFailedLine, jobLine, pressureLine, retryLine } from '../lib/notice.js'
import { PROGRESS_ELEMENTS, ProgressCards, goalCard, todoCard } from '../lib/progress.js'
import { Fanout, agentEndLine, agentStartLine, runEndLine, runStartLine, subagentLine } from '../lib/fanout.js'

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

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
