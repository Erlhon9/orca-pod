import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pendingQuestions, readQuestions } from './questions'
import { emptyState, feed } from './transcript'

const input = { questions: [{ header: 'Review', question: 'Which review should run?', multiSelect: true, options: [
  { label: 'Check layout', description: 'Review spacing and alignment.' },
  { label: 'Check behavior', description: 'Review navigation and state.' }
] }] }
const ask = (id: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } })
const line = (value: unknown) => JSON.stringify(value) + '\n'

test('질문 JSON에서 제목·질문·선택지 설명·복수 선택을 보존한다', () => {
  assert.deepEqual(readQuestions(input), input.questions)
  assert.deepEqual(readQuestions(JSON.stringify(input)), input.questions)
})

test('잘못된 질문 입력은 버리고 HTML처럼 보이는 문자열도 텍스트로 보존한다', () => {
  for (const bad of [null, 'not json', [], { questions: null }, { questions: [null, {}, { question: 1 }] }]) assert.deepEqual(readQuestions(bad), [])
  assert.equal(readQuestions({ questions: [{ question: '<img src=x onerror=alert(1)>', options: [null, { label: 42 }] }] })[0].question, '<img src=x onerror=alert(1)>')
  assert.deepEqual(readQuestions({ questions: [{ question: 'Question', options: [null, { label: 42 }] }] })[0].options, [])
})

test('대화 기록의 질문 도구 입력을 버리지 않고 결과를 받으면 대기 질문에서 제외한다', () => {
  const state = feed(emptyState(), line(ask('q1')))
  assert.deepEqual(pendingQuestions(state.items), input.questions)
  const tool = state.items[0]
  assert.equal(tool.k === 'tool' ? tool.detail : null, 'Which review should run?')
  feed(state, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'Check layout' }] } }))
  assert.deepEqual(pendingQuestions(state.items), [])
})

test('마지막 질문이 해결되거나 실패해도 과거 질문을 대기 상태로 다시 꺼내지 않는다', () => {
  const state = feed(emptyState(), line(ask('old')) + line(ask('new')))
  feed(state, line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'new', is_error: true, content: 'Cancelled' }] } }))
  assert.deepEqual(pendingQuestions(state.items), [])
  assert.equal(state.items[1].k === 'tool' && state.items[1].error, true)
})
