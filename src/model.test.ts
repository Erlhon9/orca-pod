// `orca worktree ps` 결과를 화면용 스냅샷으로 바꾸는 규칙을 고정한다.
import { assert, test } from 'orca/testing'
import { topicPath, topicRoot } from './model'
import { classify, normalize, normalizeAgent, shortBranch } from './model'

const terminalList = {
  result: {
    terminals: [
      { handle: 'term_a', tabId: 'tab1', leafId: 'leaf1', worktreeId: 'repo::/w/a', connected: true },
      { handle: 'term_old', tabId: 'tab9', leafId: 'leaf9', worktreeId: 'repo::/w/a', connected: false }
    ]
  }
}

function row(over: Record<string, unknown>) {
  return {
    worktreeId: 'repo::/w/a',
    repoId: 'repo',
    repo: 'shop',
    path: '/w/a',
    branch: 'refs/heads/feat/x',
    displayName: 'A',
    workspaceStatus: 'in-progress',
    isArchived: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lastActivityAt: 100,
    agents: [],
    ...over
  }
}

test('브랜치 접두어를 떼어 낸다', () => {
  assert.equal(shortBranch('refs/heads/feat/x'), 'feat/x')
  assert.equal(shortBranch(undefined), '')
})

test('터미널 에이전트는 tabId:leafId 로 터미널 핸들을 찾는다', () => {
  const map = new Map([['tab1:leaf1', 'term_a']])
  const a = normalizeAgent({ paneKey: 'tab1:leaf1', state: 'working', agentType: 'claude', prompt: '고쳐줘' }, map)
  assert.equal(a.terminal, 'term_a')
  assert.equal(a.surface, 'terminal')
  assert.equal(a.title, '고쳐줘')
})

test('대화창 세션은 터미널이 없다', () => {
  const a = normalizeAgent({ paneKey: 'structured-agent-session-claude_x:y', state: 'done', conversationName: '기획' }, new Map())
  assert.equal(a.surface, 'chat')
  assert.equal(a.terminal, null)
  assert.equal(a.state, 'done')
  assert.equal(a.title, '기획')
})

test('끝났어도 터미널이 살아 있으면 대기로 본다', () => {
  const a = normalizeAgent({ paneKey: 't:l', state: 'done', hasLivePty: true }, new Map())
  assert.equal(a.state, 'idle')
})

test('mainAgent 상태가 있으면 그것을 따른다', () => {
  const a = normalizeAgent({ paneKey: 't:l', state: 'done', mainAgent: { state: 'blocked', stateStartedAt: 42 } }, new Map())
  assert.equal(a.state, 'blocked')
  assert.equal(a.since, 42)
})

test('보관된 워크스페이스는 빼고, 사라진 부모는 최상위로 올린다', () => {
  const snap = normalize(
    {
      result: {
        worktrees: [
          row({}),
          row({ worktreeId: 'repo::/w/b', path: '/w/b', displayName: 'B', parentWorktreeId: 'repo::/w/gone' }),
          row({ worktreeId: 'repo::/w/c', path: '/w/c', isArchived: true })
        ]
      }
    },
    terminalList,
    new Map([['/w/a', 'ws-a']])
  )
  assert.deepEqual(Object.keys(snap.workspaces).sort(), ['repo::/w/a', 'repo::/w/b'])
  assert.equal(snap.workspaces['repo::/w/b'].parentId, null)
  assert.equal(snap.workspaces['repo::/w/a'].workspaceId, 'ws-a')
  // 끝난 터미널도 탭이 남아 있으면 닫을 수 있게 싣는다.
  assert.deepEqual(
    snap.workspaces['repo::/w/a'].terminals.map((t) => [t.handle, t.connected]),
    [
      ['term_a', true],
      ['term_old', false]
    ]
  )
})

test('에이전트는 확인 필요 → 작업 중 → 대기 → 종료 순으로 정렬한다', () => {
  const snap = normalize(
    {
      result: {
        worktrees: [
          row({
            agents: [
              { paneKey: 'p1', state: 'done', updatedAt: 9 },
              { paneKey: 'p2', state: 'working', updatedAt: 1 },
              { paneKey: 'p3', state: 'blocked', updatedAt: 1 }
            ]
          })
        ]
      }
    },
    null,
    new Map()
  )
  const w = snap.workspaces['repo::/w/a']
  assert.deepEqual(w.agents.map((a) => a.state), ['blocked', 'working', 'done'])
  assert.equal(w.activity, 'working')
})

test('상태 목록은 보드 순서를 따르고 모르는 상태는 뒤에 붙는다', () => {
  const snap = normalize(
    {
      result: {
        worktrees: [
          row({ workspaceStatus: 'completed' }),
          row({ worktreeId: 'repo::/w/b', path: '/w/b', workspaceStatus: 'zzz-custom' }),
          row({ worktreeId: 'repo::/w/c', path: '/w/c', workspaceStatus: 'in-review' })
        ]
      }
    },
    null,
    new Map()
  )
  assert.deepEqual(snap.statuses, ['in-review', 'completed', 'zzz-custom'])
})

const topics = {
  topics: [
    { id: 'pay', name: '결제', keywords: ['결제', 'payment'] },
    { id: 'settle', name: '정산', keywords: ['정산', '환불', 'settle'] }
  ],
  assign: {}
}

function view(over: Record<string, unknown>) {
  return { id: 'w', name: '', branch: '', comment: '', pr: null, agents: [], ...over } as any
}

test('키워드가 이름에 있으면 그 주제로 분류한다', () => {
  assert.equal(classify(view({ name: '결제 연동' }), topics), 'pay')
  assert.equal(classify(view({ branch: 'fix/settle-invoice' }), topics), 'settle')
})

test('맞는 키워드가 없으면 null', () => {
  assert.equal(classify(view({ name: 'aws cost' }), topics), null)
  assert.equal(classify(view({ name: '결제' }), undefined), null)
})

test('직접 정한 주제가 키워드보다 우선한다', () => {
  assert.equal(classify(view({ id: 'x', name: '결제 연동' }), { ...topics, assign: { x: 'settle' } }), 'settle')
})

test('스냅샷에 디렉토리 주제와 워크스페이스 주제가 실린다', () => {
  const snap = normalize({ result: { worktrees: [row({ displayName: '환불 정산 오류' })] } }, null, new Map(), 0, { repo: topics })
  assert.equal(snap.repos[0].topics.length, 2)
  assert.equal(snap.workspaces['repo::/w/a'].topic, 'settle')
})

test('직접 「기타」로 옮긴 워크스페이스는 키워드가 맞아도 주제가 없다', () => {
  const set = { topics: [{ id: 'pay', name: '결제', keywords: ['결제'] }], assign: { w1: '_' } }
  const w = { id: 'w1', name: '결제 문의', branch: '', comment: '', pr: null, agents: [] }
  assert.equal(classify(w, set), null)
  assert.equal(classify({ ...w, id: 'w2' }, set), 'pay')
})

test('하위 섹션 이름은 「상위 › 하위」, 색은 맨 위 섹션을 따른다', () => {
  const topics = [
    { id: 'a', name: '결제', keywords: [] },
    { id: 'b', name: '상품', keywords: [], parent: 'a' },
    { id: 'c', name: '가격', keywords: [], parent: 'b' }
  ]
  assert.equal(topicPath(topics, 'c'), '결제 › 상품 › 가격')
  assert.equal(topicRoot(topics, 'c'), 'a')
  assert.equal(topicRoot(topics, 'a'), 'a')
})

test('터미널 종류: 에이전트·초기 설정·셸을 가르고 마지막 줄을 뽑는다', () => {
  const list = {
    result: {
      terminals: [
        { handle: 't1', tabId: 'a', leafId: '1', worktreeId: 'repo::/w/a', connected: true, title: '다음 작업', agentIdentity: 'claude', preview: '' },
        { handle: 't2', tabId: 'b', leafId: '2', worktreeId: 'repo::/w/a', connected: false, title: '초기 설정', preview: 'a\n[setup] done\n\n' },
        { handle: 't3', tabId: 'c', leafId: '3', worktreeId: 'repo::/w/a', connected: true, title: 'zsh', preview: '' }
      ]
    }
  }
  const snap = normalize({ result: { worktrees: [row({})] } }, list, new Map())
  const t = snap.workspaces['repo::/w/a'].terminals
  assert.deepEqual(t.map((x) => x.kind), ['agent', 'setup', 'shell'])
  assert.equal(t[0].agentType, 'claude')
  assert.equal(t[1].lastLine, '[setup] done')
})

test('대화창 세션: 정상으로 끝난 최근 것은 대기, 중단됐거나 오래된 것은 종료', () => {
  const now = 1_800_000_000_000
  const base = { paneKey: 'structured-agent-session-claude_x', state: 'done', agentType: 'claude', updatedAt: now - 3600_000 }
  const m = new Map<string, string>()
  assert.equal(normalizeAgent({ ...base, mainAgent: { state: 'done', outcome: 'success' } }, m, now).state, 'idle')
  assert.equal(normalizeAgent({ ...base, interrupted: true, mainAgent: { state: 'done', outcome: 'cancellation' } }, m, now).state, 'done')
  assert.equal(normalizeAgent({ ...base, updatedAt: now - 30 * 86400_000 }, m, now).state, 'done')
})
