// 관제 세션: 세션 지도와 명령 제한 훅이 허용·차단을 바르게 가른다.
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { controlMap, GUARD_PY } from './control'
import type { AgentView, Snapshot, WorkspaceView } from './model'

const agent = (o: Partial<AgentView>): AgentView => ({
  key: 'k',
  type: 'claude',
  state: 'idle',
  title: '세션',
  prompt: '',
  lastMessage: '',
  tool: null,
  since: 0,
  updatedAt: 0,
  subagents: 0,
  surface: 'terminal',
  terminal: null,
  interrupted: false,
  ...o
})
const ws = (id: string, agents: AgentView[], topic: string | null = null): WorkspaceView =>
  ({ id, name: id, path: `/w/${id}`, repoId: 'r', status: 'in-progress', topic, agents }) as unknown as WorkspaceView

test('세션 지도: 끝난 세션·빈 워크스페이스는 빼고, 에이전트 터미널만 보내기 대상으로 모은다', () => {
  const snap = {
    at: 1,
    statuses: [],
    repos: [{ id: 'r', name: '저장소', workspaceIds: ['a', 'b'], topics: [{ id: 't', name: '결제', keywords: [] }] }],
    workspaces: {
      a: ws('a', [agent({ key: '1', terminal: 'term_1', title: '살아 있음' }), agent({ key: '2', terminal: 'term_2', state: 'done' })], 't'),
      b: ws('b', [agent({ key: '3', state: 'done' })])
    }
  } as unknown as Snapshot
  const m = controlMap(snap)
  assert.deepEqual(m.agentTerminals, ['term_1'])
  assert.equal(m.workspaces.length, 1)
  assert.equal(m.workspaces[0].topic, '결제')
  assert.deepEqual(m.workspaces[0].sessions.map((s) => s.title), ['살아 있음'])
})

test('명령 제한 훅: orca 조회·에이전트 터미널 보내기만 통과한다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pod-guard-'))
  try {
    await writeFile(join(dir, 'guard.py'), GUARD_PY)
    await writeFile(join(dir, 'map.json'), JSON.stringify({ agentTerminals: ['term_a'] }))
    const run = (command: string) => {
      try {
        execFileSync('python3', [join(dir, 'guard.py')], { input: JSON.stringify({ tool_input: { command } }), stdio: ['pipe', 'pipe', 'pipe'] })
        return 0
      } catch (e: any) {
        return e.status as number
      }
    }
    assert.equal(run('orca worktree ps --json'), 0)
    assert.equal(run("orca terminal send --terminal term_a --text='a; b | c $(x) `y`' --enter"), 0)
    assert.equal(run('orca terminal send --terminal term_shell --text=ls --enter'), 2)
    assert.equal(run('orca worktree ps; rm -rf x'), 2)
    assert.equal(run('orca worktree ps && echo x'), 2)
    assert.equal(run('orca worktree ps > /tmp/x'), 2)
    assert.equal(run('echo hi'), 2)
    assert.equal(run('orca worktree rm --worktree x'), 2)
    assert.equal(run('orca terminal send --terminal term_a --text="$(rm x)"'), 2)
    assert.equal(run("orca terminal send --terminal term_a --text='열린 따옴표"), 2)
    // 리뷰에서 찾은 우회: $'…' 인용, --terminal 두 번, 줄 이음
    assert.equal(run("orca terminal read --terminal=$'\\'' ; echo PWNED >&2 #'"), 2)
    assert.equal(run("orca terminal send --terminal term_shell --terminal term_a --text='ls' --enter"), 2)
    assert.equal(run("orca terminal send --terminal term_a --text='a' --enter \\\nrm x"), 2)
    assert.equal(run("orca terminal send --terminal term_a --text='it'\\''s ok' --enter"), 0)
    assert.equal(run("orca terminal send --terminal term_a --enter"), 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
