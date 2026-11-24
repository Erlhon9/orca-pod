import type { Snapshot, WorkspaceView } from './model'

export interface TopicScope {
  key: string
  name: string
  path: string[]
  parent: string | null
  workspaceIds: string[]
  repoIds: string[]
  signal: 'attention' | 'working' | ''
}

const keyOf = (path: string[]) => JSON.stringify(path.map(name => name.normalize('NFC').trim().toLocaleLowerCase()))

/** 저장소마다 다른 ID는 유지하고, 탐색할 때만 이름의 전체 경로로 함께 찾는다. */
function pathOf(snapshot: Snapshot, workspace: WorkspaceView): string[] {
  const topics = snapshot.repos.find(repo => repo.id === workspace.repoId)?.topics ?? []
  let id = workspace.topic
  const path: string[] = []
  const seen = new Set<string>()
  while (id) {
    if (seen.has(id) || seen.size >= 8) return []
    seen.add(id)
    const topic = topics.find(topic => topic.id === id)
    if (!topic?.name.trim()) return []
    path.unshift(topic.name.trim())
    id = topic.parent ?? null
  }
  return path
}

export function topicScopeIncludes(snapshot: Snapshot, workspace: WorkspaceView, key: string | null): boolean {
  if (key === null) return true
  const path = pathOf(snapshot, workspace)
  if (!path.length) return key === '[]'
  return path.some((_,index) => keyOf(path.slice(0,index+1)) === key)
}

export function collectTopicScopes(snapshot: Snapshot, include: (workspace: WorkspaceView) => boolean): TopicScope[] {
  const scopes = new Map<string,TopicScope>()
  for (const workspace of Object.values(snapshot.workspaces)) {
    if (!include(workspace)) continue
    const path = pathOf(snapshot, workspace)
    const paths = path.length ? path.map((_,index) => path.slice(0,index+1)) : [[]]
    for (const parts of paths) {
      const key = keyOf(parts)
      const scope = scopes.get(key) ?? {key,name:parts.at(-1) ?? '',path:parts,parent:parts.length>1?keyOf(parts.slice(0,-1)):null,workspaceIds:[],repoIds:[],signal:''}
      scope.workspaceIds.push(workspace.id)
      if (!scope.repoIds.includes(workspace.repoId)) scope.repoIds.push(workspace.repoId)
      if (workspace.agents.some(agent => agent.state === 'blocked' || agent.state === 'waiting')) scope.signal = 'attention'
      else if (!scope.signal && workspace.agents.some(agent => agent.state === 'working')) scope.signal = 'working'
      scopes.set(key,scope)
    }
  }
  return [...scopes.values()]
}
