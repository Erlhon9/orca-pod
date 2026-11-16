// 관제 세션: 도구 제한과 개인 설정 파일 권한을 검증한다.
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { controlArgs, controlMap, writeControlFiles } from './control'
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

test('Claude 관제는 승인 생략·기본 도구·사용자 설정 없이 Pod 도구 세 개만 연다', () => {
  const args = controlArgs('/demo/control')
  assert.equal(args.includes('bypassPermissions'), false)
  assert.equal(args.includes('--dangerously-skip-permissions'), false)
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.equal(args.includes('--tools='), true)
  assert.equal(args.includes('--setting-sources='), true)
  assert.ok(args.includes('--restricted'))
  assert.ok(args.includes('--strict-mcp-config'))
  assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--strict-mcp-config')), [
    'mcp__pod__pod_sessions', 'mcp__pod__pod_read_session', 'mcp__pod__pod_send_session'
  ])
  for (const name of ['Bash', 'Read', 'Glob', 'Grep', 'SendMessage', 'ListAgents']) assert.equal(args.includes(name), false)
})

test('관제 설정은 사용자 전용 권한으로 저장하고 기존 파일 심볼릭 링크를 따라 쓰지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pod-private-'))
  try {
    const outside = join(dir, 'outside')
    await writeFile(outside, 'preserve')
    await symlink(outside, join(dir, 'mcp.json'))
    const config = { mcpServers: { pod: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }
    await writeControlFiles(dir, null, null, config)
    assert.equal(await readFile(outside, 'utf8'), 'preserve')
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    for (const file of ['mcp.json', 'settings.json', 'prompt.md']) assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8')), config)
    const settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))
    assert.equal(settings.permissions.disableBypassPermissionsMode, 'disable')
    assert.equal(settings.hooks, undefined)
    await symlink(dir, join(dir, 'linked'))
    await assert.rejects(() => writeControlFiles(join(dir, 'linked'), null, null))
  } finally { await rm(dir, { recursive: true, force: true }) }
})
