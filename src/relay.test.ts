import { assert, test } from 'orca/testing'
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
