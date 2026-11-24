import { assert, test } from 'orca/testing'
import type { Snapshot, TopicSet } from './model'
import { applyTopicPlan, parseTopicPlan, topicPlanFingerprint } from './topic-plan'

const snapshot = (): Snapshot => ({ at: 1, statuses: [], repos: [{ id: 'r', name: 'repo', workspaceIds: ['w1', 'w2'], topics: [] }], workspaces: {
  w1: { id: 'w1', workspaceId: null, name: '결제 수정', branch: 'pay', repoId: 'r', repo: 'repo', path: '', status: 'in-progress', parentId: null, childIds: [], isMain: false, pinned: false, unread: false, activity: 'active', lastActivityAt: 0, liveTerminals: 0, terminals: [], topic: null, pr: null, comment: '', agents: [] },
  w2: { id: 'w2', workspaceId: null, name: '문서', branch: 'docs', repoId: 'r', repo: 'repo', path: '', status: 'completed', parentId: null, childIds: [], isMain: false, pinned: false, unread: false, activity: 'inactive', lastActivityAt: 0, liveTerminals: 0, terminals: [], topic: null, pr: null, comment: '', agents: [] }
} })
const raw = (topics: unknown, assignments: unknown) => JSON.stringify({ topics, assignments })
const ok = () => raw([{ id: 'payment', name: '결제', keywords: [] }, { id: 'api', name: 'API', parent: 'payment', keywords: ['연동'] }], [{ workspaceId: 'w1', topicId: 'api', reason: '결제 API' }])

test('분류안은 fenced JSON을 읽고 모든 현재 작업을 배정한다', () => {
  const plan = parseTopicPlan(`\`\`\`json\n${ok()}\n\`\`\``, snapshot(), 'r')
  assert.equal(plan.assignments.length, 1)
})

test('잘못된 ID, 누락, 순환, 중복은 거절한다', () => {
  for (const value of [
    raw([{ id: 'x', name: 'X', keywords: [] }], [{ workspaceId: 'other', topicId: 'x', reason: 'x' }]),
    raw([{ id: 'x', name: 'X', parent: 'y', keywords: [] }, { id: 'y', name: 'Y', parent: 'x', keywords: [] }], [{ workspaceId: 'w1', topicId: 'x', reason: 'x' }]),
    raw([{ id: 'x', name: 'X', keywords: [] }], []),
    raw([{ id: 'x', name: 'X', keywords: [] }], [{ workspaceId: 'w1', topicId: 'x', reason: 'x' }, { workspaceId: 'w1', topicId: 'x', reason: 'x' }])
  ]) { let failed = false; try { parseTopicPlan(value, snapshot(), 'r') } catch { failed = true }; assert.equal(failed, true) }
})

test('같은 경로는 기존 ID를 보존하면서 새 배정을 이동한다', () => {
  const previous: TopicSet = { topics: [{ id: 'old-pay', name: '결제', keywords: [] }, { id: 'old-api', name: 'API', parent: 'old-pay', keywords: [] }], assign: { w1: 'old-pay', w2: 'old-pay' } }
  const out = applyTopicPlan(parseTopicPlan(ok(), snapshot(), 'r'), snapshot(), 'r', previous)
  assert.deepEqual(out.topics.map((topic) => topic.id), ['old-pay', 'old-api'])
  assert.equal(out.assign.w1, 'old-api')
  assert.equal(out.assign.w2, 'old-pay')
})

test('완료 작업의 현재 주제는 이전 직접 배정이 없어도 보존한다', () => {
  const current = snapshot()
  current.workspaces.w2.topic = 'old-pay'
  const previous: TopicSet = { topics: [{ id: 'old-pay', name: '결제', keywords: [] }], assign: {} }
  const out = applyTopicPlan(parseTopicPlan(ok(), current, 'r'), current, 'r', previous)
  assert.equal(out.assign.w2, 'old-pay')
})

test('미분류 완료 작업은 새 키워드에 다시 묶이지 않도록 기타로 고정한다', () => {
  const current = snapshot()
  current.workspaces.w2.name = '외부 연동 완료'
  const previous: TopicSet = { topics: [{ id: 'old-pay', name: '결제', keywords: [] }], assign: {} }
  const out = applyTopicPlan(parseTopicPlan(ok(), current, 'r'), current, 'r', previous)
  assert.equal(out.assign.w2, '_')
  assert.equal(out.topics.find(topic => topic.id === 'api')?.keywords[0], '연동')
})

test('분석 뒤 작업이 바뀌면 stale 계획은 적용하지 않는다', () => {
  const before = snapshot(), plan = parseTopicPlan(ok(), before, 'r'), after = snapshot()
  after.workspaces.w1.name = '다른 작업'
  let failed = false; try { applyTopicPlan(plan, after, 'r', undefined) } catch { failed = true }
  assert.equal(failed, true)
  assert.notEqual(topicPlanFingerprint(before, 'r'), topicPlanFingerprint(after, 'r'))
})
