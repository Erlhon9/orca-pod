import type { Snapshot, Topic, TopicSet, WorkspaceView } from './model'

export interface TopicAssignment {
  workspaceId: string
  topicId: string
  /** 관제에 노출할 짧은 분류 근거. */
  reason: string
}

export interface TopicPlan {
  repoId: string
  baseFingerprint: string
  topics: Topic[]
  assignments: TopicAssignment[]
}

const MAX_TOPICS = 40
const MAX_NAME = 40
const MAX_KEYWORD = 40
const MAX_REASON = 240
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

function fail(message: string): never { throw new Error(`주제 분류안을 적용할 수 없습니다: ${message}`) }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
function workspaceScope(snapshot: Snapshot, repoId: string): WorkspaceView[] {
  if (!snapshot.repos.some((repo) => repo.id === repoId)) fail('저장소를 찾을 수 없습니다')
  // 완료 작업은 과거 배정을 보존한다. 새 분석은 아직 진행 중인 작업만 다룬다.
  return Object.values(snapshot.workspaces).filter((workspace) => workspace.repoId === repoId && workspace.status !== 'completed')
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = object(value)
  if (!record) return JSON.stringify(value)
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
function hash(text: string): string {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return (value >>> 0).toString(36)
}

/** 분류를 요청한 뒤 달라지면 이전 답을 버리기 위한 입력 지문이다. */
export function topicPlanFingerprint(snapshot: Snapshot, repoId: string): string {
  const repo = snapshot.repos.find((item) => item.id === repoId)
  if (!repo) return ''
  const workspaces = workspaceScope(snapshot, repoId)
    .sort((a, b) => a.id.localeCompare(b.id))
    // 폴링마다 바뀌는 활동 시각·에이전트 최신 메시지는 제외한다.
    .map((w) => ({ id: w.id, name: w.name, branch: w.branch, status: w.status, topic: w.topic, comment: w.comment, pr: w.pr?.title ?? '' }))
  return hash(stable({ repoId, topics: repo.topics, workspaces }))
}

function parseJson(raw: string): unknown {
  const text = raw.trim()
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  try { return JSON.parse(fenced ? fenced[1].trim() : text) } catch { fail('JSON 형식이 아닙니다') }
}

function validate(raw: unknown, snapshot: Snapshot, repoId: string): Pick<TopicPlan, 'topics' | 'assignments'> {
  const root = object(raw)
  if (!root || !exactKeys(root, ['topics', 'assignments']) || !Array.isArray(root.topics) || !Array.isArray(root.assignments)) fail('형식이 올바르지 않습니다')
  if (root.topics.length > MAX_TOPICS) fail(`주제는 ${MAX_TOPICS}개까지입니다`)
  const ids = new Set<string>()
  const topics: Topic[] = root.topics.map((value) => {
    const item = object(value)
    if (!item || !exactKeys(item, ['id', 'name', 'parent', 'keywords']) || typeof item.id !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.keywords) || (item.parent !== undefined && typeof item.parent !== 'string')) fail('주제 값이 안전하지 않습니다')
    const id = item.id.trim(), name = item.name.trim()
    if (!ID.test(id) || id === '_' || !name || name.length > MAX_NAME || ids.has(id)) fail('주제 ID 또는 이름이 중복되었거나 올바르지 않습니다')
    if (item.keywords.length > 30 || item.keywords.some((word) => typeof word !== 'string' || !word.trim() || word.trim().length > MAX_KEYWORD)) fail('키워드 값이 올바르지 않습니다')
    ids.add(id)
    return { id, name, keywords: item.keywords.map((word) => (word as string).trim()), ...(item.parent ? { parent: item.parent.trim() } : {}) }
  })
  const topicById = new Map(topics.map((topic) => [topic.id, topic]))
  const siblingNames = new Set<string>()
  for (const topic of topics) {
    if (topic.parent && (!topicById.has(topic.parent) || topic.parent === topic.id)) fail('상위 주제가 없거나 순환합니다')
    const sibling = `${topic.parent ?? ''}\u0000${topic.name.toLocaleLowerCase()}`
    if (siblingNames.has(sibling)) fail('같은 단계에 같은 이름의 주제가 있습니다')
    siblingNames.add(sibling)
    let current: Topic | undefined = topic
    let depth = 0
    const seen = new Set<string>()
    while (current.parent) {
      if (seen.has(current.id)) fail('주제가 순환합니다')
      seen.add(current.id); depth++
      current = topicById.get(current.parent)
      if (!current) fail('상위 주제가 없습니다')
      if (depth > 1) fail('하위 주제는 한 단계까지만 지원합니다')
    }
  }
  const scope = new Set(workspaceScope(snapshot, repoId).map((workspace) => workspace.id))
  const assigned = new Set<string>()
  const assignments: TopicAssignment[] = root.assignments.map((value) => {
    const item = object(value)
    if (!item || !exactKeys(item, ['workspaceId', 'topicId', 'reason']) || typeof item.workspaceId !== 'string' || typeof item.topicId !== 'string' || typeof item.reason !== 'string') fail('배정 값이 안전하지 않습니다')
    const workspaceId = item.workspaceId.trim(), topicId = item.topicId.trim(), reason = item.reason.trim()
    if (!scope.has(workspaceId) || assigned.has(workspaceId)) fail('저장소 밖 작업이 있거나 작업이 중복 배정되었습니다')
    // 「_」는 새 주제가 아닌, 관제의 기본 기타 그룹이다.
    if ((topicId !== '_' && !topicById.has(topicId)) || !reason || reason.length > MAX_REASON) fail('배정 주제 또는 근거가 올바르지 않습니다')
    assigned.add(workspaceId)
    return { workspaceId, topicId, reason }
  })
  if (assigned.size !== scope.size) fail('배정되지 않은 작업이 있습니다')
  return { topics, assignments }
}

/** 에이전트의 JSON 응답을 검증한다. 실패하면 절대 부분 적용하지 않도록 예외를 낸다. */
export function parseTopicPlan(raw: string, snapshot: Snapshot, repoId: string): TopicPlan {
  if (typeof raw !== 'string') fail('응답이 텍스트가 아닙니다')
  const result = validate(parseJson(raw), snapshot, repoId)
  return { ...result, repoId, baseFingerprint: topicPlanFingerprint(snapshot, repoId) }
}

function pathMap(topics: Topic[]): Map<string, string> {
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const result = new Map<string, string>()
  for (const topic of topics) {
    const parts = [topic.name]
    let current = topic
    const seen = new Set<string>()
    while (current.parent) {
      if (seen.has(current.id)) fail('기존 주제 경로가 순환합니다')
      seen.add(current.id)
      const parent = byId.get(current.parent)
      if (!parent) fail('기존 주제의 상위 경로가 없습니다')
      current = parent
      parts.unshift(current.name)
    }
    result.set(parts.map((part) => part.toLocaleLowerCase()).join('\u0000'), topic.id)
  }
  return result
}

/** 이미 있는 동일 경로는 ID를 유지하고, 현재 스냅샷과 달라진 계획은 거절한다. */
export function applyTopicPlan(plan: TopicPlan, snapshot: Snapshot, repoId: string, previous: TopicSet | undefined): TopicSet {
  if (!plan || plan.repoId !== repoId || plan.baseFingerprint !== topicPlanFingerprint(snapshot, repoId)) fail('분석 뒤 작업 맥락이 바뀌었습니다. 다시 분석하세요')
  const valid = validate({ topics: plan.topics, assignments: plan.assignments }, snapshot, repoId)
  const priorPaths = pathMap(previous?.topics ?? [])
  const proposedPaths = pathMap(valid.topics)
  const rename = new Map<string, string>()
  const used = new Set<string>()
  for (const [path, proposedId] of proposedPaths) {
    const oldId = priorPaths.get(path)
    if (oldId && !used.has(oldId)) { rename.set(proposedId, oldId); used.add(oldId) }
  }
  const topics = valid.topics.map((topic) => ({ ...topic, id: rename.get(topic.id) ?? topic.id, ...(topic.parent ? { parent: rename.get(topic.parent) ?? topic.parent } : {}) }))
  const topicIds = new Set(topics.map((topic) => topic.id))
  if (topicIds.size !== topics.length) fail('기존 주제 ID와 충돌합니다')
  const activeIds = new Set(workspaceScope(snapshot, repoId).map((workspace) => workspace.id))
  const assign: Record<string, string> = Object.fromEntries(valid.assignments.map((item) => [item.workspaceId, rename.get(item.topicId) ?? item.topicId]))
  // 완료 작업의 기존 분류와, 거기에 필요한 상위 경로는 그대로 남긴다.
  const repoTopics = snapshot.repos.find((repo) => repo.id === repoId)?.topics ?? []
  const priorById = new Map([...repoTopics, ...(previous?.topics ?? [])].map((topic) => [topic.id, topic]))
  const priorTopics = [...priorById.values()]
  const needed = new Set<string>()
  for (const [workspaceId, topicId] of Object.entries(previous?.assign ?? {})) {
    if (activeIds.has(workspaceId)) continue
    assign[workspaceId] = topicId
    let current = topicId
    while (current && !needed.has(current)) {
      needed.add(current)
      current = priorById.get(current)?.parent ?? ''
    }
  }
  // 저장된 직접 배정이 없어도, 현재 완료 작업의 분류 상태를 고정한다.
  // null/알 수 없는 주제도 「기타」로 명시해 새 키워드가 과거 작업을 재분류하지 못하게 한다.
  for (const workspace of Object.values(snapshot.workspaces)) {
    if (workspace.repoId !== repoId || workspace.status !== 'completed' || assign[workspace.id] !== undefined) continue
    const topicId = workspace.topic && (workspace.topic === '_' || priorById.has(workspace.topic)) ? workspace.topic : '_'
    assign[workspace.id] = topicId
    let current = topicId
    while (current && !needed.has(current)) {
      needed.add(current)
      current = priorById.get(current)?.parent ?? ''
    }
  }
  for (const topic of priorTopics) {
    if (!needed.has(topic.id)) continue
    if (topicIds.has(topic.id)) {
      const collision = topics.find((candidate) => candidate.id === topic.id)!
      if (collision.name !== topic.name || collision.parent !== topic.parent) fail('기존 주제 ID와 충돌합니다')
    } else { topics.push({ ...topic }); topicIds.add(topic.id) }
  }
  if (topics.length > MAX_TOPICS) fail(`보존할 완료 작업을 포함하면 주제가 ${MAX_TOPICS}개를 넘습니다`)
  return { topics, assign, generatedAt: Date.now() }
}
