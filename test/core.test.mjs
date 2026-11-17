import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_QUESTION_CHARS,
  MAX_TIMEOUT_MS,
  extractReply,
  frameQuestion,
  normalizeArgs,
  wouldCycle,
} from '../lib/core.js'

test('normalizeArgs applies defaults and clamps the timeout', () => {
  assert.deepEqual(normalizeArgs({ session: ' session-b ', question: ' hi ' }), {
    session: 'session-b',
    question: 'hi',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    wait: true,
  })
  assert.equal(normalizeArgs({ session: 's', question: 'q', timeout_ms: 9_999_999 }).timeoutMs, MAX_TIMEOUT_MS)
})

test('normalizeArgs rejects invalid input', () => {
  assert.throws(() => normalizeArgs(null))
  assert.throws(() => normalizeArgs({ session: '', question: 'q' }))
  assert.throws(() => normalizeArgs({ session: 's', question: '   ' }))
  assert.throws(() => normalizeArgs({ session: 's', question: 'q', timeout_ms: 999 }))
  assert.throws(() => normalizeArgs({ session: 's', question: 'x'.repeat(MAX_QUESTION_CHARS + 1) }))
})

test('frameQuestion names the sender and asks for a direct reply', () => {
  const text = frameQuestion({ callerId: 'session-a', question: 'What changed?' })
  assert.match(text, /session-a/)
  assert.match(text, /What changed\?/)
  assert.match(text, /final assistant message/)
})

test('wouldCycle follows the waiter graph', () => {
  const waiting = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['c'])],
  ])
  assert.equal(wouldCycle(waiting, 'c', 'a'), true)
  assert.equal(wouldCycle(waiting, 'a', 'c'), false)
  assert.equal(wouldCycle(new Map(), 'a', 'a'), true)
})

test('extractReply returns the last text-bearing assistant message of the turn', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { id: 'm1' } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
    { seq: 3, type: 'tool/result', data: {} },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final answer' }] } } },
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(extractReply(events, 'm1'), {
    found: true,
    text: 'final answer',
    reason: 'completed',
  })
})

test('extractReply ignores same-turn runtime context user messages', () => {
  const events = [
    { seq: 1, type: 'user/message', data: { id: 'm1' } },
    {
      seq: 2,
      type: 'user/message',
      data: { id: 'ctx', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'time' }] },
    },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ours' }] } } },
    { seq: 4, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(extractReply(events, 'm1'), {
    found: true,
    text: 'ours',
    reason: 'completed',
  })
})

test('extractReply reports a missing message and an empty turn', () => {
  assert.deepEqual(extractReply([], 'missing'), { found: false, text: '', reason: null })
  const events = [
    { seq: 1, type: 'user/message', data: { id: 'm1' } },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error' } } },
  ]
  assert.deepEqual(extractReply(events, 'm1'), { found: true, text: '', reason: 'error' })
})
