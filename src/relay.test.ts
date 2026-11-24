import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { relayTool } from './relay'
import type { Snapshot } from './model'

const snap = () => ({ workspaces: { w: { name: '작업', repo: 'repo', agents: [
  { key: 'claude-key', type: 'claude', terminal: 'term_claude', state: 'idle', lastMessage: '답', surface: 'terminal' },
  { key: 'codex-key', type: 'codex', terminal: 'term_codex', state: 'working', lastMessage: '', surface: 'terminal' },
  { key: 'chat-key', type: 'codex', terminal: null, state: 'idle', lastMessage: '답', prompt: '요청', surface: 'chat' },
  { key: 'shell-key', type: 'shell', terminal: 'term_shell', state: 'idle', lastMessage: '' },
  { key: 'done-key', type: 'claude', terminal: 'term_done', state: 'done', lastMessage: '' },
  { key: 'gemini-key', type: 'gemini', terminal: 'term_gemini', state: 'idle', lastMessage: '', surface: 'terminal' }
] } } }) as unknown as Snapshot

test('공급자와 무관하게 정확한 키의 터미널로 보내고 제출 영수증을 보존한다', async () => {
  const calls: string[][] = []
  const receipt = { accepted: true, stage: 'input_accepted', requestId: 'request-1' }
  const deps = { snapshot: async () => snap(), cli: async (args: string[]) => { calls.push(args); return receipt } }
  for (const key of ['claude-key', 'codex-key', 'gemini-key']) {
    assert.deepEqual(await relayTool(deps, 'pod_send_session', { key, text: '-지시; $(echo hi)' }), receipt)
  }
  assert.deepEqual(calls[0], ['terminal', 'send', '--terminal', 'term_claude', '--text=-지시; $(echo hi)', '--enter', '--wait-submit', '5'])
  assert.equal(calls[1][3], 'term_codex')
  assert.equal(calls[2][3], 'term_gemini')
})

test('지도에 없는 키·중복 키·셸·끝난 세션·대화창에는 보내지 않는다', async () => {
  let sends = 0
  const deps = { snapshot: async () => snap(), cli: async () => { sends++; return {} } }
  for (const key of ['unknown', 'shell-key', 'done-key', 'chat-key']) {
    await assert.rejects(() => relayTool(deps, 'pod_send_session', { key, text: '전달' }))
  }
  const duplicate = snap()
  duplicate.workspaces.w.agents.push(duplicate.workspaces.w.agents[0])
  await assert.rejects(() => relayTool({ ...deps, snapshot: async () => duplicate }, 'pod_send_session', { key: 'claude-key', text: '전달' }))
  assert.equal(sends, 0)
})

test('목록에 전달 가능 여부를 표시하고 대화창 조회는 최근 요청·답변만 반환한다', async () => {
  const deps = { snapshot: async () => snap(), cli: async () => { throw new Error('실행되면 안 됨') } }
  const list = await relayTool(deps, 'pod_sessions', {}) as any[]
  assert.equal(list.find(a => a.key === 'chat-key').canSend, false)
  assert.equal(list.find(a => a.key === 'claude-key').canSend, true)
  assert.equal(list.some(a => a.key === 'done-key'), false)
  const chat = await relayTool(deps, 'pod_read_session', { key: 'chat-key' }) as any
  assert.equal(chat.lastMessage, '답')
  assert.equal(chat.prompt, '요청')
})

test('전송 오류는 자동 재시도하지 않는다', async () => {
  let sends = 0
  await assert.rejects(() => relayTool({ snapshot: async () => snap(), cli: async () => { sends++; throw new Error('timeout') } }, 'pod_send_session', { key: 'claude-key', text: '전달' }))
  assert.equal(sends, 1)
})

test('조회 전용 브리핑은 세션을 읽을 수 있지만 지시 전달 도구는 실행하지 못한다', async () => {
  let calls = 0
  const deps = { readOnly: true, snapshot: async () => snap(), cli: async () => { calls++; return {} } }
  const read = await relayTool(deps, 'pod_read_session', { key: 'chat-key' }) as any
  assert.equal(read.lastMessage, '답')
  const sessions=await relayTool(deps,'pod_sessions',{}) as any[]
  assert.equal(sessions.some(session=>session.canSend),false)
  await assert.rejects(() => relayTool(deps, 'pod_send_session', { key: 'claude-key', text: 'Send' }))
  assert.equal(calls, 0)
})

test('입력에 명령·파일 경로를 섞거나 터미널 핸들을 변조해도 실행하지 않는다', async () => {
  let calls = 0
  const deps = { snapshot: async () => snap(), cli: async () => { calls++; return {} } }
  for (const input of [null, [], { key: 'claude-key', text: 'Review', command: 'blocked' }, { key: 'claude-key', text: '' }, { key: 'claude-key', text: 'x'.repeat(20_001) }]) {
    await assert.rejects(() => relayTool(deps, 'pod_send_session', input))
  }
  await assert.rejects(() => relayTool(deps, 'pod_sessions', { path: '/private' }))
  const invalid = snap()
  invalid.workspaces.w.agents[0].terminal = '--all'
  await assert.rejects(() => relayTool({ ...deps, snapshot: async () => invalid }, 'pod_send_session', { key: 'claude-key', text: 'Review' }))
  assert.equal(calls, 0)
})

test('조회 대기 중 관제가 중단되면 뒤늦게 전송하지 않는다', async () => {
  let resolve!: (value: Snapshot) => void
  let active = true
  let calls = 0
  const pending = relayTool({ active: () => active, snapshot: () => new Promise(done => { resolve = done }), cli: async () => { calls++; return {} } }, 'pod_send_session', { key: 'claude-key', text: 'Review' })
  active = false
  resolve(snap())
  await assert.rejects(() => pending)
  assert.equal(calls, 0)
})
