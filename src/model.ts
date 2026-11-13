// `orca worktree ps --json` 과 `orca terminal list --json` 결과를 화면용 스냅샷으로 바꾼다.
// 워커와 테스트가 같이 쓰므로 Node·DOM 의존 없이 순수 함수로 둔다.

export type AgentState = 'working' | 'blocked' | 'waiting' | 'idle' | 'done'

export interface AgentView {
  key: string
  type: string
  state: AgentState
  title: string
  prompt: string
  lastMessage: string
  tool: { name: string; input: string } | null
  since: number
  updatedAt: number
  subagents: number
  surface: 'terminal' | 'chat'
  terminal: string | null
  interrupted: boolean
}

export interface Topic {
  id: string
  name: string
  keywords: string[]
  /** 상위 섹션 id(하위 섹션일 때). */
  parent?: string
}

/** 맨 위 섹션 id(색을 가족끼리 맞출 때). */
export function topicRoot(topics: Topic[], id: string): string {
  const byId = new Map(topics.map((t) => [t.id, t]))
  let cur = byId.get(id)
  for (let i = 0; cur?.parent && byId.has(cur.parent) && i < 6; i++) cur = byId.get(cur.parent)
  return cur?.id ?? id
}

/** 「상위 › 하위」 형태의 이름. */
export function topicPath(topics: Topic[], id: string): string {
  const byId = new Map(topics.map((t) => [t.id, t]))
  const names: string[] = []
  let cur = byId.get(id)
  for (let i = 0; cur && i < 6; i++) {
    names.unshift(cur.name)
    cur = cur.parent ? byId.get(cur.parent) : undefined
  }
  return names.join(' › ')
}

/** 디렉토리 하나의 주제 설정. assign 은 워크스페이스 id → 주제 id 로 직접 정한 것(키워드보다 우선). */
export interface TopicSet {
  topics: Topic[]
  assign: Record<string, string>
  generatedAt?: number
}

export interface TerminalRef {
  handle: string
  title: string
  /** 프로세스가 살아 있는지. false 면 끝났는데 탭만 남은 것. */
  connected: boolean
  /** agent: 에이전트가 도는 터미널, setup: 워크스페이스 초기 설정, shell: 그 밖의 셸. */
  kind: 'agent' | 'setup' | 'shell'
  agentType: string | null
  /** 화면 마지막 줄. */
  lastLine: string
}

const SETUP_TITLE = /^(초기 설정|setup)$/i

export interface PullRequestView {
  number: number
  state: string
  title: string
  url: string
  checks: string | null
}

export interface WorkspaceView {
  id: string
  workspaceId: string | null
  name: string
  branch: string
  repoId: string
  repo: string
  path: string
  status: string
  parentId: string | null
  childIds: string[]
  isMain: boolean
  pinned: boolean
  unread: boolean
  activity: 'working' | 'active' | 'inactive'
  lastActivityAt: number
  liveTerminals: number
  terminals: TerminalRef[]
  /** 주제 id. 주제가 없거나 맞는 주제가 없으면 null. */
  topic: string | null
  pr: PullRequestView | null
  comment: string
  agents: AgentView[]
}

export interface RepoView {
  id: string
  name: string
  workspaceIds: string[]
  topics: Topic[]
}

export interface Snapshot {
  at: number
  repos: RepoView[]
  workspaces: Record<string, WorkspaceView>
  statuses: string[]
}

/** 기본 보드 상태의 표시 순서. 모르는 상태는 뒤에 붙는다. */
export const STATUS_ORDER = ['in-progress', 'in-review', 'todo', 'long-running', 'on-hold', 'completed']

const AGENT_ORDER: Record<AgentState, number> = { blocked: 0, waiting: 1, working: 2, idle: 3, done: 4 }

type Json = Record<string, any>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** 키워드가 어디에 나오느냐에 따라 가중치를 달리 줘서 가장 점수가 높은 주제를 고른다. */
export function classify(
  w: Pick<WorkspaceView, 'id' | 'name' | 'branch' | 'comment' | 'pr' | 'agents'>,
  set: TopicSet | undefined
): string | null {
  if (!set || set.topics.length === 0) return null
  const manual = set.assign[w.id]
  // '_' 는 직접 「기타」로 옮긴 것(키워드로 다시 분류하지 않는다).
  if (manual === '_') return null
  if (manual && set.topics.some((t) => t.id === manual)) return manual
  const fields: [string, number][] = [
    [w.name, 3],
    [w.branch.replace(/[-_/]/g, ' '), 2],
    [w.pr?.title ?? '', 2],
    [w.comment, 1],
    [w.agents.map((a) => a.title).join(' '), 1]
  ]
  const lowered = fields.map(([t, wt]) => [t.toLowerCase(), wt] as const)
  let best: string | null = null
  let bestScore = 0
  for (const t of set.topics) {
    let score = 0
    for (const raw of [t.name, ...t.keywords]) {
      const k = raw.trim().toLowerCase()
      if (k.length < 2) continue
      for (const [text, wt] of lowered) if (text.includes(k)) score += wt
    }
    if (score > bestScore) {
      best = t.id
      bestScore = score
    }
  }
  return best
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function shortBranch(ref: unknown): string {
  return str(ref).replace(/^refs\/heads\//, '')
}

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 대화창 세션을 아직 열린(대기) 것으로 보는 기간. */
const CHAT_IDLE_MS = 7 * 24 * 60 * 60 * 1000

export function normalizeAgent(raw: Json, terminalByPane: Map<string, string>, now = Date.now()): AgentView {
  const paneKey = str(raw.paneKey)
  const chat = paneKey.startsWith('structured-agent-session')
  const terminal = chat ? null : (terminalByPane.get(paneKey) ?? null)
  const reported = str(raw.mainAgent?.state || raw.state) as AgentState
  const known = reported === 'working' || reported === 'blocked' || reported === 'waiting'
  // done 이어도 터미널이 살아 있으면 다음 지시를 기다리는 중이다.
  // 대화창 세션은 답을 마치면 항상 done 으로 오므로, 중단되지 않고 최근에 끝난 것은 다음 지시를 기다리는 것으로 본다.
  const outcome = str(raw.mainAgent?.outcome)
  const updated = num(raw.updatedAt) || num(raw.stateStartedAt)
  const openChat = chat && raw.interrupted !== true && outcome !== 'cancellation' && updated > 0 && now - updated < CHAT_IDLE_MS
  const state: AgentState = known ? reported : raw.hasLivePty || openChat ? 'idle' : 'done'
  const prompt = str(raw.prompt)
  const title =
    str(raw.conversationName) || str(raw.taskTitle) || str(raw.displayName) || firstLine(prompt, 60) || '이름 없는 세션'
  const toolName = str(raw.toolName)
  return {
    key: paneKey,
    type: str(raw.agentType) || 'agent',
    state,
    title,
    prompt,
    lastMessage: str(raw.lastAssistantMessage),
    tool: toolName ? { name: toolName, input: str(raw.toolInput) } : null,
    since: num(raw.mainAgent?.stateStartedAt) || num(raw.stateStartedAt),
    updatedAt: num(raw.updatedAt),
    subagents: Array.isArray(raw.children) ? raw.children.length : 0,
    surface: chat ? 'chat' : 'terminal',
    terminal,
    interrupted: raw.interrupted === true
  }
}

export function sortAgents(agents: AgentView[]): AgentView[] {
  return [...agents].sort((a, b) => AGENT_ORDER[a.state] - AGENT_ORDER[b.state] || b.updatedAt - a.updatedAt)
}

export function normalize(
  ps: Json,
  terminalList: Json | null,
  workspaceIdByPath: Map<string, string>,
  now = Date.now(),
  topicSets: Record<string, TopicSet> = {}
): Snapshot {
  const terminals: Json[] = terminalList?.result?.terminals ?? []
  const terminalByPane = new Map<string, string>()
  const terminalsByWorktree = new Map<string, TerminalRef[]>()
  for (const t of terminals) {
    if (t.tabId && t.leafId) terminalByPane.set(`${t.tabId}:${t.leafId}`, str(t.handle))
    // 끝난 터미널도 탭이 남아 있으면 보여 준다(닫을 수 있게).
    const list = terminalsByWorktree.get(str(t.worktreeId)) ?? []
    const title = str(t.title)
    const agentType = typeof t.agentIdentity === 'string' && t.agentIdentity ? t.agentIdentity : null
    list.push({
      handle: str(t.handle),
      title,
      connected: t.connected === true,
      kind: agentType ? 'agent' : SETUP_TITLE.test(title.trim()) ? 'setup' : 'shell',
      agentType,
      lastLine: str(t.preview).split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 160) ?? ''
    })
    terminalsByWorktree.set(str(t.worktreeId), list)
  }

  const rows: Json[] = ps?.result?.worktrees ?? []
  const workspaces: Record<string, WorkspaceView> = {}
  const repos = new Map<string, RepoView>()
  const statuses = new Set<string>()

  for (const w of rows) {
    if (w.isArchived) continue
    const id = str(w.worktreeId)
    const repoId = str(w.repoId) || 'folders'
    const status = str(w.workspaceStatus) || 'todo'
    statuses.add(status)
    const pr = w.linkedPR && typeof w.linkedPR.number === 'number' ? w.linkedPR : null
    const agents = sortAgents((Array.isArray(w.agents) ? w.agents : []).map((a: Json) => normalizeAgent(a, terminalByPane, now)))
    const sidebar = str(w.sidebarStatus || w.status)
    workspaces[id] = {
      id,
      workspaceId: workspaceIdByPath.get(str(w.path)) ?? null,
      name: str(w.displayName) || shortBranch(w.branch) || str(w.path).split('/').pop() || id,
      branch: shortBranch(w.branch),
      repoId,
      repo: str(w.repo) || (w.workspaceKind === 'folder' ? '폴더' : repoId),
      path: str(w.path),
      status,
      parentId: str(w.parentWorktreeId) || null,
      childIds: Array.isArray(w.childWorktreeIds) ? w.childWorktreeIds.map(str) : [],
      isMain: w.isMainWorktree === true,
      pinned: w.isPinned === true,
      unread: w.unread === true,
      activity:
        agents.some((a) => a.state === 'working') || sidebar === 'working'
          ? 'working'
          : sidebar === 'active' || num(w.liveTerminalCount) > 0
            ? 'active'
            : 'inactive',
      lastActivityAt: num(w.lastActivityAt) || num(w.createdAt),
      liveTerminals: num(w.liveTerminalCount),
      terminals: terminalsByWorktree.get(id) ?? [],
      pr: pr
        ? {
            number: pr.number,
            state: str(pr.state) || 'unknown',
            title: str(pr.title),
            url: str(pr.url),
            checks: str(pr.checksStatus) || null
          }
        : null,
      comment: str(w.comment),
      agents,
      topic: null
    }
    workspaces[id].topic = classify(workspaces[id], topicSets[repoId])
    const repo = repos.get(repoId) ?? {
      id: repoId,
      name: workspaces[id].repo,
      workspaceIds: [],
      topics: topicSets[repoId]?.topics ?? []
    }
    repo.workspaceIds.push(id)
    repos.set(repoId, repo)
  }

  // 부모가 목록에 없으면(보관됨 등) 최상위로 올린다.
  for (const w of Object.values(workspaces)) {
    if (w.parentId && !workspaces[w.parentId]) w.parentId = null
    w.childIds = w.childIds.filter((c) => workspaces[c])
  }

  const repoList = [...repos.values()]
  for (const r of repoList) {
    r.workspaceIds.sort((a, b) => workspaces[b].lastActivityAt - workspaces[a].lastActivityAt)
  }
  // 움직이는 게 많은 디렉토리가 위로 온다.
  const weight = (r: RepoView) =>
    r.workspaceIds.reduce((n, id) => {
      const w = workspaces[id]
      return n + (w.status === 'completed' ? 0 : 1) + (w.activity === 'working' ? 100 : 0)
    }, 0)
  repoList.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))

  const ordered = [
    ...STATUS_ORDER.filter((s) => statuses.has(s)),
    ...[...statuses].filter((s) => !STATUS_ORDER.includes(s)).sort()
  ]
  return { at: now, repos: repoList, workspaces, statuses: ordered }
}
