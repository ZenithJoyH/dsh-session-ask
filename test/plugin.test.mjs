import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'

function makeSession(id, cwd = '/workspace') {
  const events = []
  return {
    id,
    events,
    header: { id, cwd },
    get seq() { return events.length },
    snapshotEvents(from = 0, toExclusive = events.length) {
      return events.slice(from, toExclusive)
    },
  }
}

function makeAgent(id, cwd) {
  const session = makeSession(id, cwd)
  return {
    id,
    session,
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    ctx: {
      tools: {
        get: () => undefined,
        restrict: () => () => {},
      },
    },
    whenIdle: async () => {},
    followups: [],
    followup(message) { this.followups.push(message) },
  }
}

function makeHarness({ callerCwd = '/workspace', targetCwd = '/workspace', targetTools = 'full', config = {} } = {}) {
  const defs = {}
  const listeners = new Set()
  const caller = makeAgent('session-a', callerCwd)
  const target = makeAgent('session-b', targetCwd)
  const sessions = new Map([[caller.id, caller], [target.id, target]])

  const ctx = {
    tools: { register(definition) { defs[definition.name] = definition; return () => {} } },
    sessionController: {
      async resolveAgent(id) {
        const found = sessions.get(id)
        return found === undefined ? { error: new Error(`unknown ${id}`) } : { agent: found }
      },
      async list() {
        return {
          items: [
            { sessionId: 'session-b', cwd: targetCwd, running: false, updatedAt: 3, blank: false, projections: { values: { title: 'Target work' } } },
            { sessionId: 'session-c', cwd: targetCwd, running: true, updatedAt: 2, blank: false, projections: { values: { title: 'Other' } } },
            { sessionId: 'session-d', cwd: '/other', running: false, updatedAt: 1, blank: false },
            { sessionId: 'session-e', cwd: targetCwd, running: false, updatedAt: 4, blank: false, origin: 'subagent' },
          ],
        }
      },
    },
    on(_event, listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  const emit = (session, type, data) => {
    const event = { seq: session.events.length, type, data }
    session.events.push(event)
    for (const listener of listeners) listener(session, event)
  }

  const runTurn = (agent, text) => {
    emit(agent.session, 'user/message', agent.followups.at(-1))
    emit(agent.session, 'assistant/message', { message: { content: [{ type: 'text', text }] } })
    emit(agent.session, 'turn/end', { reason: { kind: 'completed' } })
  }

  apply(ctx, { targetTools, ...config })
  return { defs, caller, target, emit, runTurn, listeners, ctx }
}

test('session_ask delivers, waits for the turn, and returns the final text', async () => {
  const h = makeHarness()
  h.target.followup = function (message) {
    this.followups.push(message)
    h.emit(this.session, 'user/message', message)
    h.emit(this.session, 'assistant/message', {
      message: { content: [{ type: 'text', text: 'the answer' }] },
    })
    h.emit(this.session, 'turn/end', { reason: { kind: 'completed' } })
  }

  const result = await h.defs.session_ask.execute(
    { session: 'session-b', question: 'What changed?' },
    { agent: h.caller, signal: new AbortController().signal },
  )
  assert.deepEqual(result, {
    sessionId: 'session-b',
    ticket: result.ticket,
    status: 'replied',
    reply: 'the answer',
  })
  assert.match(result.ticket, /^ask-/)
})

test('session_ask returns a ticket on timeout and delivers the late reply to the caller', async () => {
  const h = makeHarness()
  let message
  h.target.followup = function (input) {
    this.followups.push(input)
    message = input
  }

  const result = await h.defs.session_ask.execute(
    { session: 'session-b', question: 'slow?', timeout_ms: 1000 },
    { agent: h.caller, signal: new AbortController().signal },
  )
  assert.equal(result.status, 'pending')
  assert.match(result.ticket, /^ask-/)

  h.emit(h.target.session, 'user/message', message)
  h.emit(h.target.session, 'assistant/message', {
    message: { content: [{ type: 'text', text: 'late answer' }] },
  })
  h.emit(h.target.session, 'turn/end', { reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(h.caller.followups.length, 1)
  assert.match(h.caller.followups[0].content[0].text, /late answer/)
  assert.match(h.caller.followups[0].content[0].text, /Untrusted/)
})

test('session_send returns immediately and delivers the reply later', async () => {
  const h = makeHarness()
  h.target.followup = function (input) {
    this.followups.push(input)
  }

  const result = await h.defs.session_send.execute(
    { session: 'session-b', question: 'async?' },
    { agent: h.caller, signal: new AbortController().signal },
  )
  assert.equal(result.status, 'pending')
  assert.equal(h.caller.followups.length, 0)

  await new Promise(resolve => setTimeout(resolve, 10))
  h.runTurn(h.target, 'async answer')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(h.caller.followups.length, 1)
  assert.match(h.caller.followups[0].content[0].text, /async answer/)
})

test('session_ask rejects another workspace before delivery', async () => {
  const h = makeHarness({ callerCwd: '/workspace-a', targetCwd: '/workspace-b' })
  await assert.rejects(
    h.defs.session_ask.execute(
      { session: 'session-b', question: 'hi' },
      { agent: h.caller, signal: new AbortController().signal },
    ),
    /limited to the caller workspace/,
  )
  assert.equal(h.target.followups.length, 0)
})

test('session_ask refuses to ask the caller parent session', async () => {
  const h = makeHarness()
  h.caller.session.header.parentSession = 'session-b'
  await assert.rejects(
    h.defs.session_ask.execute(
      { session: 'session-b', question: 'hi' },
      { agent: h.caller, signal: new AbortController().signal },
    ),
    /parent session/,
  )
})

test('session_ask installs a read-only tool tier by default', async () => {
  const h = makeHarness({ targetTools: 'read-only' })
  const restrictions = []
  h.target.ctx.tools.get = name => (['read', 'grep'].includes(name) ? { name } : undefined)
  h.target.ctx.tools.restrict = filter => {
    restrictions.push(filter)
    return () => {}
  }
  h.target.followup = function (message) {
    this.followups.push(message)
    h.runTurn(this, 'restricted answer')
  }

  const result = await h.defs.session_ask.execute(
    { session: 'session-b', question: 'read only' },
    { agent: h.caller, signal: new AbortController().signal },
  )
  assert.equal(result.reply, 'restricted answer')
  assert.deepEqual(restrictions, [{ allow: ['read', 'grep'] }])
})

test('session_find lists same-workspace non-subagent sessions', async () => {
  const h = makeHarness()
  const result = await h.defs.session_find.execute(
    {},
    { agent: h.caller, signal: new AbortController().signal },
  )
  assert.deepEqual(result.items.map(item => item.sessionId), ['session-c', 'session-b'])
  assert.equal(result.items[1].title, 'Target work')
})
