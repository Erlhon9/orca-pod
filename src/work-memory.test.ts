import { assert, test } from 'orca/testing'
import type { AgentView, WorkspaceView } from './model'
import { readWorkJournal, readWorkMemory, reviewWork, sortWorkBriefs, workBrief, workExcerpt, workFingerprint } from './work-memory'

const agent = (patch: Partial<AgentView> = {}): AgentView => ({
  key: 'fictional-session', type: 'claude', state: 'idle', title: 'Example session', prompt: 'Fix the example.',
  lastMessage: 'Implementation ready. Deployment is unverified.', tool: null, since: 10, updatedAt: 20, subagents: 0,
  surface: 'chat', terminal: null, interrupted: false, ...patch
})
const workspace = (patch: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id: 'example-work', workspaceId: 'example', name: 'Example task', branch: 'example', repoId: 'example-repo', repo: 'Example',
  path: '/fictional/example', status: 'in-progress', parentId: null, childIds: [], isMain: false, pinned: false, unread: false,
  activity: 'active', lastActivityAt: 20, liveTerminals: 0, terminals: [], topic: null, pr: null, comment: '', agents: [agent()], ...patch
})

test('같은 공급자 한 세션만 있어도 작업 기억과 다음 행동을 유지한다', () => {
  const memory = readWorkMemory({ goal: 'Fix login', doneWhen: 'Review and regression tests', nextStep: 'Review the missing case', note: 'Keep existing login behavior' })
  const brief = workBrief(workspace(), memory)
  assert.equal(brief.goal, 'Fix login')
  assert.equal(brief.reason, 'next')
  assert.equal(brief.memory.doneWhen, 'Review and regression tests')
  const swapped = workBrief(workspace({ agents: [agent({ type: 'gemini', key: 'new-session' })] }), memory)
  assert.equal(swapped.goal, brief.goal)
  assert.equal(swapped.memory.note, brief.memory.note)
})

test('최근 요청을 최초 목표로 단정하거나 답변의 완료 주장을 완료 상태로 바꾸지 않는다', () => {
  const w = workspace({ agents: [agent({ state: 'done', prompt: 'Deploy everything', lastMessage: 'Everything is done.' })] })
  const brief = workBrief(w)
  assert.equal(brief.goal, w.name)
  assert.equal(brief.reason, 'quiet')
  assert.equal(brief.workspace.status, 'in-progress')
  assert.equal(brief.memory.doneWhen, '')
})

test('승인·질문·실패한 체크는 최근 변경과 메모보다 먼저 확인한다', () => {
  const memory = readWorkMemory({ nextStep: 'Polish the colors' })
  const question = workspace({ agents: [agent({ state: 'waiting', tool: {name:'AskUserQuestion',input:JSON.stringify({questions:[{question:'Choose',options:[{label:'A'}]}]})} })], unread: true })
  const approval = workspace({ agents: [agent({ state: 'waiting' }), agent({ state: 'blocked', key: 'approval', updatedAt: 5 })] })
  const failed = workspace({ pr: { number: 1, state: 'open', title: 'Example', url: 'https://example.test/pr/1', checks: 'failure' } })
  assert.equal(workBrief(approval, memory).target?.key, 'approval')
  assert.deepEqual(sortWorkBriefs([workBrief(failed), workBrief(question, memory), workBrief(approval, memory)]).map(b => b.reason), ['approval', 'question', 'checks'])
  assert.equal(workBrief(workspace({ pr: { ...failed.pr!, state: 'merged' } })).reason, 'quiet')
})

test('확인 표시가 실제 승인이나 질문 해결·작업 완료로 바뀌지 않는다', () => {
  const w = workspace({ agents: [agent({ state: 'blocked' })] })
  const saved = reviewWork(w, readWorkMemory({ note: 'Keep this' }), 500)
  const brief = workBrief(w, saved)
  assert.equal(brief.changed, false)
  assert.equal(brief.reason, 'approval')
  assert.equal(brief.memory.note, 'Keep this')
  assert.equal(brief.workspace.status, 'in-progress')
  assert.equal(saved.reviewed?.at, 500)
})

test('메타데이터 갱신·배열 정렬은 새 변경이 아니고 실제 요청·답변·상태 변경은 새 변경이다', () => {
  const a = agent()
  const b = agent({ key: 'another' })
  const w = workspace({ agents: [a, b] })
  const saved = reviewWork(w, readWorkMemory(), 500)
  const metadata = workspace({ agents: [{ ...b, updatedAt: 900 }, { ...a, since: 800, subagents: 3 }], lastActivityAt: 900, unread: true })
  assert.equal(workFingerprint(w), workFingerprint(metadata))
  assert.equal(workBrief(metadata, saved).changed, false)
  for (const patch of [{ prompt: 'New request' }, { lastMessage: 'New reply' }, { state: 'working' as const }, { tool: { name: 'Read', input: 'example.ts' } }]) {
    assert.equal(workBrief(workspace({ agents: [{ ...a, ...patch }, b] }), saved).changed, true)
  }
  assert.equal(workBrief(workspace({ comment: 'A new constraint', agents: [a, b] }), saved).changed, true)
})

test('처음 연 작업은 Orca unread 신호만 사용하고 모든 과거 세션을 새 변경으로 만들지 않는다', () => {
  assert.equal(workBrief(workspace()).changed, false)
  assert.equal(workBrief(workspace({ unread: true })).reason, 'changed')
  assert.equal(workBrief(workspace({ unread: true, agents: [agent({ state: 'working' })] })).lane, 'moving')
})

test('보류·완료 표시보다 현재 살아 있는 승인과 질문을 우선한다', () => {
  assert.equal(workBrief(workspace({ status: 'completed' })).reason, 'completed')
  assert.equal(workBrief(workspace({ status: 'on-hold' })).reason, 'paused')
  assert.equal(workBrief(workspace({ status: 'completed', agents: [agent({ state: 'waiting' })] })).reason, 'completed')
  assert.equal(workBrief(workspace({ status: 'completed', agents: [agent({ state: 'waiting',tool:{name:'AskUserQuestion',input:JSON.stringify({questions:[{question:'Choose',options:[{label:'A'}]}]})} })] })).reason, 'question')
  assert.equal(workBrief(workspace({ status: 'on-hold', agents: [agent({ state: 'working' })] })).lane, 'moving')
  assert.equal(workBrief(workspace({ status: 'completed', agents: [agent({ state: 'working' })] })).lane, 'moving')
})

test('기억 저장값은 크기를 제한하고 잘못된 입력·시각을 정리한다', () => {
  for (const value of [null, [], 'oops', 5]) assert.deepEqual(readWorkJournal(value), {})
  const journal = readWorkJournal({ one: { goal: ' x ', note: 'a'.repeat(3000), updatedAt: Infinity, reviewed: { fingerprint: 'invalid', at: 3 } }, two: null, three: [] })
  assert.deepEqual(Object.keys(journal), ['one'])
  assert.equal(journal.one.goal, 'x')
  assert.equal(journal.one.note.length, 2000)
  assert.equal(journal.one.updatedAt, 0)
  assert.equal(journal.one.reviewed, null)
})

test('재열기 복원은 사람 메모와 확인 지문만 보존하고 대화 본문을 자동 저장하지 않는다', () => {
  const w = workspace()
  const saved = { [w.id]: reviewWork(w, readWorkMemory({ goal: 'My objective' }), 500) }
  const text = JSON.stringify(saved)
  const restored = readWorkJournal(JSON.parse(text))
  assert.deepEqual(restored, saved)
  assert.equal(text.includes(w.agents[0].lastMessage), false)
  assert.equal(workBrief(w, restored[w.id]).changed, false)
})

test('발췌는 원문과 불확실성을 유지하고 길이가 넘으면 잘린 표시를 붙인다', () => {
  assert.equal(workExcerpt('  Not verified.\nNext: test it.  '), 'Not verified.\nNext: test it.')
  assert.equal(workExcerpt('0123456789', 6), '01234…')
})
