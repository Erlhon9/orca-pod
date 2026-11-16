import { assert, test } from 'orca/testing'
import type { AgentView, Snapshot, WorkspaceView } from './model'
import { addTarget, controlMessage, ControlMessageTooLongError, MissingControlTargetError, resolveTarget, targetKey } from './panel/control-targets'

function fixture(): Snapshot {
  const agent = (key: string) => ({ key, title: 'Review', type: 'claude', terminal: `term-${key}` }) as AgentView
  const workspace = (id: string) => ({ id, name: 'Dashboard', repoId: 'repo', topic: null, agents: [agent('first'), agent('second')] }) as WorkspaceView
  return { repos: [{ id: 'repo', name: 'Demo', topics: [] }], workspaces: { one: workspace('one'), two: workspace('two') } } as unknown as Snapshot
}

test('관제 대상은 이름이 같아도 ID로 구분하고 같은 세션은 중복 추가하지 않는다', () => {
  const first = { workspaceId: 'one', sessionKey: 'first' }
  const list = addTarget([], first)
  assert.equal(addTarget(list, { ...first }), list)
  assert.equal(addTarget(list, { ...first, sessionKey: 'second' }).length, 2)
  assert.equal(addTarget(list, { ...first, workspaceId: 'two' }).length, 2)
  assert.ok(targetKey(first) !== targetKey({ ...first, sessionKey: null }))
})

test('관제 전송 시에만 최신 대상 정보와 정확한 ID를 본문에 넣고 작성한 지시는 보존한다', () => {
  const snap = fixture()
  snap.workspaces.one.name = 'Renamed workspace'
  snap.workspaces.one.agents[0].title = 'Renamed session'
  const targets = [{ workspaceId: 'one', sessionKey: 'first' }, { workspaceId: 'two', sessionKey: 'second' }]
  const message = controlMessage(snap, targets, 'Check these changes\nthen report back')
  assert.ok(message.includes('Renamed workspace'))
  assert.ok(message.includes('Renamed session'))
  assert.ok(message.includes('ID first]'))
  assert.ok(message.includes('ID second]'))
  assert.ok(message.includes('term-first'))
  assert.ok(message.endsWith('Check these changes\nthen report back'))
  assert.equal(targets.length, 2)
})

test('사라진 세션은 같은 이름의 다른 세션으로 바꾸거나 일부 대상만 보내지 않는다', () => {
  const snap = fixture()
  snap.workspaces.one.agents.shift()
  const missing = { workspaceId: 'one', sessionKey: 'first' }
  assert.equal(resolveTarget(snap, missing), null)
  assert.throws(() => controlMessage(snap, [{ workspaceId: 'two', sessionKey: 'first' }, missing], 'Review'), error => error instanceof MissingControlTargetError)
  assert.throws(() => controlMessage(null, [missing], 'Review'), error => error instanceof MissingControlTargetError)
})

test('워크스페이스 칩은 워크스페이스 ID를 보내고 대상 없는 일반 메시지는 그대로 보낸다', () => {
  assert.equal(controlMessage(null, [], '  Keep this draft  '), '  Keep this draft  ')
  const message = controlMessage(fixture(), [{ workspaceId: 'one', sessionKey: null }], 'Summarize')
  assert.ok(message.includes('ID one]'))
  assert.ok(message.endsWith('Summarize'))
})

test('대상 참조를 포함한 메시지가 워커 제한을 넘으면 ID가 잘리지 않도록 막는다', () => {
  assert.throws(() => controlMessage(fixture(), [{ workspaceId: 'one', sessionKey: 'first' }], 'a'.repeat(20_000)), error => error instanceof ControlMessageTooLongError)
})
