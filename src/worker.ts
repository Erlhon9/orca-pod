// Pod 워커. 화면(패널)의 요청을 받아 orca CLI 와 호스트 API 로 데이터를 모으고 조작을 실행한다.
// 셸을 거치지 않고 execFile 로 인자 배열을 넘기므로 입력값이 명령으로 해석되지 않는다.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { readConversation } from './conversation'
import { normalize, type Snapshot, type Topic, type TopicSet } from './model'

const CLI_CANDIDATES = [process.env.ORCA_CLI, '/usr/local/bin/orca', '/opt/homebrew/bin/orca'].filter(
  (p): p is string => typeof p === 'string' && p.length > 0
)
const CLI = CLI_CANDIDATES.find((p) => existsSync(p)) ?? 'orca'

class CliError extends Error {
  code = 'action_failed'
}

/** 사용자에게 보일 실패 문구. 한국어 원문이면 첫 줄만, 아니면(영어·명령 경로가 섞인 원문) 고정 문구. */
export function userMessage(raw: string): string {
  const line = raw.trim().split('\n')[0]?.slice(0, 200) ?? ''
  return /[가-힣]/.test(line) && !line.includes('/usr/') ? line : 'Orca 명령이 실패했습니다'
}

export function runCli(args: string[], timeoutMs = 20_000): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(CLI, [...args, '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      let parsed: any = null
      try {
        parsed = stdout ? JSON.parse(stdout) : null
      } catch {
        parsed = null
      }
      if (parsed && parsed.ok === false) {
        reject(new CliError(userMessage(String(parsed.error?.message ?? ''))))
      } else if (err && !parsed) {
        reject(new CliError(userMessage(String(stderr || err.message))))
      } else {
        resolve(parsed)
      }
    })
  })
}

function text(v: unknown, field: string, max = 20_000): string {
  if (typeof v !== 'string' || v.length === 0) throw new CliError(`${field} 값이 비어 있습니다`)
  if (v.length > max) throw new CliError(`${field} 값이 너무 깁니다`)
  return v
}

const worktreeSelector = (id: string) => `id:${id}`

const TOPICS_KEY = 'topics'

/** 터미널에 그대로 쓸 키. 화면 미러 아래의 키 버튼이 쓴다. */
const KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  up: '\x1b[A',
  down: '\x1b[B',
  tab: '\t',
  '1': '1',
  '2': '2',
  '3': '3',
  y: 'y',
  n: 'n'
}

function claudeCli(): string {
  const candidates = [process.env.POD_CLAUDE_CLI, join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return candidates.find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p)) ?? 'claude'
}

export function slug(name: string, taken: Set<string>): string {
  const base = name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'topic'
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  taken.add(id)
  return id
}

/** 사람이 고친 주제 목록을 정리한다: 빈 이름 제거, 키워드 다듬기, id 보존. */
export function cleanTopics(input: unknown): Topic[] {
  if (!Array.isArray(input)) return []
  const taken = new Set<string>()
  const out: Topic[] = []
  for (const raw of input.slice(0, 40)) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 40) : ''
    if (!name) continue
    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : [])
      .filter((k: unknown): k is string => typeof k === 'string')
      .map((k: string) => k.trim().slice(0, 40))
      .filter((k: string) => k.length > 0)
      .slice(0, 30)
    const wanted = typeof raw.id === 'string' && raw.id && raw.id !== '_' && raw.id.length <= 60 && !taken.has(raw.id) ? raw.id : null
    const id = wanted ?? slug(name, taken)
    taken.add(id)
    const parent = typeof raw.parent === 'string' && raw.parent ? raw.parent : undefined
    out.push({ id, name, keywords: [...new Set(keywords)], ...(parent ? { parent } : {}) })
  }
  // 없는 상위·자기 자신·순환은 끊어 최상위로 올린다.
  const ids = new Set(out.map((t) => t.id))
  const byId = new Map(out.map((t) => [t.id, t]))
  for (const t of out) {
    if (!t.parent) continue
    let ok = ids.has(t.parent) && t.parent !== t.id
    let cur = t.parent
    for (let i = 0; ok && i < 8; i++) {
      const up = byId.get(cur)?.parent
      if (!up) break
      if (up === t.id) ok = false
      cur = up
    }
    if (!ok) delete t.parent
  }
  // 그래프가 그리는 깊이(5단계)보다 깊으면 끊는다.
  for (const t of out) {
    let d = 0
    let cur = t.parent
    while (cur && d < 6) {
      d++
      cur = byId.get(cur)?.parent
    }
    if (d > 4) delete t.parent
  }
  return out
}

/** AI 가 새로 뽑은 주제에 이전 것을 합친다. 같은 이름은 이전 id 를 쓰고, 사람이 만든 하위 주제와 그 배정·「기타」 고정은 남긴다. */
export function mergeSuggested(prev: TopicSet | undefined, fresh: Topic[], assign: Record<string, string>): TopicSet {
  if (!prev) return { topics: fresh, assign, generatedAt: Date.now() }
  const prevByName = new Map(prev.topics.filter((t) => !t.parent).map((t) => [t.name, t.id]))
  const rename = new Map<string, string>()
  const topics = fresh.map((t) => {
    const old = prevByName.get(t.name)
    if (old && old !== t.id) rename.set(t.id, old)
    return old ? { ...t, id: old } : t
  })
  const ids = new Set(topics.map((t) => t.id))
  // 하위 주제는 상위가 살아 있는 동안 남긴다(여러 단계면 위에서부터 차례로).
  let added = true
  while (added) {
    added = false
    for (const t of prev.topics) {
      if (t.parent && !ids.has(t.id) && ids.has(t.parent)) {
        topics.push(t)
        ids.add(t.id)
        added = true
      }
    }
  }
  const next: Record<string, string> = {}
  for (const [w, t] of Object.entries(assign)) next[w] = rename.get(t) ?? t
  for (const [w, t] of Object.entries(prev.assign)) {
    const sub = prev.topics.find((x) => x.id === t)?.parent
    if (t === '_' || (sub && ids.has(t))) next[w] = t
  }
  return { topics, assign: next, generatedAt: Date.now() }
}

const SUGGEST_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } } },
        required: ['name', 'keywords']
      }
    },
    assignments: {
      type: 'array',
      items: { type: 'object', properties: { i: { type: 'integer' }, topic: { type: 'string' } }, required: ['i', 'topic'] }
    }
  },
  required: ['topics', 'assignments']
})

export default function activate(orca: any): void {
  let cache: { at: number; snapshot: Snapshot } | null = null
  let inflight: Promise<Snapshot> | null = null
  let idsByPath = new Map<string, string>()
  let idsAt = 0

  async function workspaceIds(force = false): Promise<Map<string, string>> {
    if (!force && Date.now() - idsAt < 30_000 && idsByPath.size > 0) return idsByPath
    try {
      const res = await orca.host.call('workspace.list', {})
      const next = new Map<string, string>()
      for (const w of res?.workspaces ?? []) if (w.path && w.id) next.set(w.path, w.id)
      idsByPath = next
      idsAt = Date.now()
    } catch (e: any) {
      orca.log(`workspace.list 실패: ${e?.code ?? ''} ${e?.message ?? e}`)
    }
    return idsByPath
  }

  /** 읽기 실패를 빈 값으로 삼키지 않는다(그대로 쓰면 다른 디렉토리 주제까지 지워진다). */
  async function topicSets(): Promise<Record<string, TopicSet>> {
    const v = await orca.storage.get(TOPICS_KEY)
    return v && typeof v === 'object' ? (v as Record<string, TopicSet>) : {}
  }

  /** 주제 저장은 한 줄로 세워 차례로 한다(읽고 고치고 쓰는 사이에 다른 저장이 끼지 않게). */
  let topicQueue: Promise<unknown> = Promise.resolve()
  function editTopicSet(repoId: string, edit: (prev: TopicSet | undefined) => TopicSet | null): Promise<void> {
    const run = topicQueue.then(async () => {
      const all = await topicSets()
      const next = edit(all[repoId])
      if (next) all[repoId] = next
      else delete all[repoId]
      await orca.storage.set(TOPICS_KEY, all)
    })
    topicQueue = run.catch(() => {})
    return run
  }

  function saveTopicSet(repoId: string, set: TopicSet | null): Promise<void> {
    return editTopicSet(repoId, () => set)
  }

  async function build(): Promise<Snapshot> {
    const [ps, terminals, ids, topics] = await Promise.all([
      runCli(['worktree', 'ps']),
      runCli(['terminal', 'list']).catch(() => null),
      workspaceIds(),
      topicSets().catch(() => ({}) as Record<string, TopicSet>)
    ])
    return normalize(ps, terminals, ids, Date.now(), topics)
  }

  async function snapshot(maxAgeMs = 1_500): Promise<Snapshot> {
    if (cache && Date.now() - cache.at < maxAgeMs) return cache.snapshot
    // 조작 직후(maxAge 0)에는 그 전에 시작된 읽기를 쓰지 않고, 끝나기를 기다렸다가 새로 읽는다.
    if (maxAgeMs === 0 && inflight) await inflight.catch(() => null)
    if (!inflight) {
      inflight = build()
        .then((s) => {
          cache = { at: Date.now(), snapshot: s }
          return s
        })
        .finally(() => {
          inflight = null
        })
    }
    return inflight
  }

  // 이벤트가 몰려 와도 한 번만 다시 읽어서 열려 있는 패널에 보낸다.
  let timer: ReturnType<typeof setTimeout> | null = null
  function refreshSoon(delay = 250): void {
    if (timer) return
    timer = setTimeout(async () => {
      timer = null
      try {
        cache = null
        orca.panels.post('pod.changed', await snapshot(0))
      } catch (e: any) {
        orca.log(`갱신 실패: ${e?.message ?? e}`)
      }
    }, delay)
  }

  async function terminalHandles(): Promise<Set<string>> {
    const res = await runCli(['terminal', 'list']).catch(() => null)
    return new Set<string>((res?.result?.terminals ?? []).map((t: any) => String(t.handle)))
  }

  /** 명령 전후의 터미널 목록을 비교해 새로 생긴 핸들을 돌려준다. */
  async function newHandleAfter(run: () => Promise<unknown>): Promise<string | null> {
    const before = await terminalHandles()
    await run()
    for (let i = 0; i < 6; i++) {
      const after = await terminalHandles()
      const fresh = [...after].find((h) => !before.has(h))
      if (fresh) return fresh
      await new Promise((r) => setTimeout(r, 500))
    }
    return null
  }

  async function afterChange<T>(result: T): Promise<T> {
    refreshSoon(150)
    return result
  }

  for (const event of ['agent.status.changed', 'workspace.created', 'workspace.removed', 'workspace.changed']) {
    orca.events.on(event, () => {
      if (event !== 'agent.status.changed') idsAt = 0
      refreshSoon()
    })
  }

  orca.panels.handle('pod.snapshot', async (input: { fresh?: boolean } | undefined) =>
    snapshot(input?.fresh ? 0 : 1_500)
  )

  orca.panels.handle('pod.openWorkspace', async (input: { id: string }) => {
    const id = text(input?.id, 'id')
    const snap = await snapshot()
    const w = snap.workspaces[id]
    if (!w) throw new CliError('워크스페이스를 찾지 못했습니다')
    let workspaceId = w.workspaceId ?? (await workspaceIds(true)).get(w.path) ?? null
    if (workspaceId) {
      await orca.host.call('workspace.open', { workspaceId })
      return { opened: true }
    }
    // 호스트 목록에 없으면 그 워크스페이스의 터미널로 전환해서 연다.
    const live = w.terminals.find((t) => t.connected)
    if (live) {
      await runCli(['terminal', 'switch', '--terminal', live.handle])
      return { opened: true }
    }
    throw new CliError('이 워크스페이스를 열 방법을 찾지 못했습니다')
  })

  orca.panels.handle('pod.focusAgent', async (input: { id: string; agentKey: string }) => {
    const id = text(input?.id, 'id')
    const snap = await snapshot()
    const agent = snap.workspaces[id]?.agents.find((a) => a.key === input?.agentKey)
    if (agent?.terminal) {
      await runCli(['terminal', 'switch', '--terminal', agent.terminal])
      return { opened: true }
    }
    const w = snap.workspaces[id]
    if (!w) throw new CliError('워크스페이스를 찾지 못했습니다')
    const workspaceId = w.workspaceId ?? (await workspaceIds(true)).get(w.path)
    if (!workspaceId) throw new CliError('이 워크스페이스를 열 방법을 찾지 못했습니다')
    await orca.host.call('workspace.open', { workspaceId })
    return { opened: true }
  })

  orca.panels.handle('pod.send', async (input: { terminal: string; text: string }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    const body = text(input?.text, '메시지')
    // 「-」로 시작하는 지시도 옵션으로 읽히지 않게 --옵션=값 형태로 넘긴다.
    await runCli(['terminal', 'send', '--terminal', terminal, `--text=${body}`, '--enter'])
    return afterChange({ sent: true })
  })

  orca.panels.handle('pod.interrupt', async (input: { terminal: string }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    await runCli(['terminal', 'send', '--terminal', terminal, '--interrupt'])
    return afterChange({ sent: true })
  })

  orca.panels.handle('pod.key', async (input: { terminal: string; key: string }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    const bytes = KEYS[String(input?.key)]
    if (!bytes) throw new CliError('모르는 키입니다')
    await runCli(['terminal', 'send', '--terminal', terminal, `--text=${bytes}`])
    return afterChange({ sent: true })
  })

  orca.panels.handle('pod.screen', async (input: { terminal: string; lines?: number }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    const res = await runCli(['terminal', 'read', '--terminal', terminal, '--screen'])
    const t = res?.result?.terminal ?? {}
    const lines: string[] = Array.isArray(t.tail) ? t.tail.map(String) : String(t.tail ?? '').split('\n')
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return { lines: lines.slice(-Math.min(Math.max(Number(input?.lines) || 200, 20), 400)), status: String(t.status ?? '') }
  })

  orca.panels.handle(
    'pod.conversation',
    async (input: { path: string; key: string; type: string; title?: string; prompt?: string; since?: number }) =>
      readConversation({
        path: text(input?.path, 'path', 2000),
        key: text(input?.key, 'key', 400),
        type: String(input?.type ?? ''),
        title: typeof input?.title === 'string' ? input.title.slice(0, 400) : undefined,
        prompt: typeof input?.prompt === 'string' ? input.prompt.slice(0, 400) : undefined,
        since: typeof input?.since === 'number' && Number.isFinite(input.since) ? input.since : undefined
      })
  )

  // 탭 닫기. 끝난 터미널(초기 설정 등)을 치울 때 쓴다.
  orca.panels.handle('pod.closeTerminals', async (input: { terminals: string[] }) => {
    const list = Array.isArray(input?.terminals) ? input.terminals.slice(0, 200) : []
    let closed = 0
    const failed: string[] = []
    for (const raw of list) {
      const terminal = text(raw, 'terminal', 200)
      try {
        await runCli(['terminal', 'close', '--terminal', terminal, '--tab'])
        closed++
      } catch {
        failed.push(terminal)
      }
    }
    if (closed === 0 && failed.length) throw new CliError('탭을 닫지 못했습니다')
    return afterChange({ closed, failed })
  })

  orca.panels.handle('pod.saveTopics', async (input: { repoId: string; topics: unknown }) => {
    const repoId = text(input?.repoId, 'repoId', 200)
    const topics = cleanTopics(input?.topics)
    const ids = new Set(topics.map((t) => t.id))
    await editTopicSet(repoId, (prev) => {
      const assign = Object.fromEntries(Object.entries(prev?.assign ?? {}).filter(([, t]) => t === '_' || ids.has(t)))
      return topics.length ? { topics, assign, generatedAt: prev?.generatedAt } : null
    })
    cache = null
    return afterChange({ ok: true })
  })

  orca.panels.handle('pod.assignTopic', async (input: { repoId: string; id: string; topicId: string | null }) => {
    const repoId = text(input?.repoId, 'repoId', 200)
    const id = text(input?.id, 'id')
    const topicId = typeof input?.topicId === 'string' && input.topicId ? input.topicId : null
    await editTopicSet(repoId, (set) => {
      if (!set) throw new CliError('이 디렉토리에는 주제가 없습니다')
      if (topicId && topicId !== '_' && !set.topics.some((t) => t.id === topicId)) throw new CliError('없는 주제입니다')
      if (topicId) set.assign[id] = topicId
      else delete set.assign[id]
      return set
    })
    cache = null
    return afterChange({ ok: true })
  })

  // claude -p 로 주제를 뽑는다. 도구·MCP·사용자 훅 없이 한 번만 묻고, 결과를 저장한다.
  orca.panels.handle('pod.suggestTopics', async (input: { repoId: string }) => {
    const repoId = text(input?.repoId, 'repoId', 200)
    const snap = await snapshot(0)
    const list = Object.values(snap.workspaces)
      .filter((w) => w.repoId === repoId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 300)
    if (list.length === 0) throw new CliError('워크스페이스가 없습니다')
    const lines = list.map((w, i) =>
      [
        `${i}. ${w.name}`,
        w.branch && w.branch !== w.name ? `브랜치 ${w.branch}` : '',
        w.pr?.title ? `PR ${w.pr.title}` : '',
        w.agents.length ? `대화 ${w.agents.slice(0, 2).map((a) => a.title).join(' / ')}` : '',
        w.comment ? `메모 ${w.comment.slice(0, 80)}` : ''
      ]
        .filter(Boolean)
        .join(' | ')
        .slice(0, 300)
    )
    const prompt = [
      '아래는 한 저장소에서 진행한 작업(워크스페이스) 목록이다.',
      '업무 영역 기준으로 주제 5~10개로 묶어라. 제품 기능 영역(예: 결제, 정산처럼)을 우선하고, 인프라·개발환경·운영·사용자문의 대응 같은 비제품 영역도 주제가 될 수 있다.',
      '주제 이름은 짧은 한국어 명사(2~8자). 각 주제마다 앞으로 새 작업을 분류할 때 쓸 키워드를 6~15개 준다: 작업 이름에 나오는 한국어 단어와 브랜치에 나오는 영어 단어를 모두 포함한다.',
      '모든 작업 번호(i)를 정확히 하나의 주제에 배정한다. 주제 이름은 topics 의 name 과 똑같이 쓴다.',
      '',
      ...lines
    ].join('\n')
    const raw = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        claudeCli(),
        [
          '-p',
          '--output-format',
          'json',
          '--model',
          'sonnet',
          '--tools',
          '',
          '--no-session-persistence',
          '--strict-mcp-config',
          '--setting-sources',
          'project',
          '--json-schema',
          SUGGEST_SCHEMA,
          prompt
        ],
        {
          cwd: tmpdir(),
          maxBuffer: 16 * 1024 * 1024,
          timeout: 180_000,
          // 워커 환경에는 USER 가 없어 claude 가 키체인에서 로그인 정보를 못 찾는다.
          env: { ...process.env, USER: process.env.USER ?? userInfo().username, LOGNAME: process.env.LOGNAME ?? userInfo().username, ELECTRON_RUN_AS_NODE: undefined }
        },
        (err, stdout, stderr) =>
          err && !stdout ? reject(new CliError(String(stderr || err.message).slice(-300))) : resolve(stdout)
      )
      // 표준 입력을 바로 닫아야 claude 가 입력을 기다리지 않는다.
      child.stdin?.end()
    })
    let out: any
    try {
      const envelope = JSON.parse(raw)
      out = envelope.structured_output ?? JSON.parse(envelope.result)
    } catch {
      orca.log(`claude 응답을 읽지 못함: ${raw.replace(/"usage":\{.*?"modelUsage":\{\},/, "").slice(0, 900)}`)
      throw new CliError('주제 결과를 읽지 못했습니다')
    }
    const topics = cleanTopics(out?.topics)
    if (topics.length === 0) throw new CliError('주제를 뽑지 못했습니다')
    const byName = new Map(topics.map((t) => [t.name, t.id]))
    const assign: Record<string, string> = {}
    for (const a of Array.isArray(out?.assignments) ? out.assignments : []) {
      const w = list[Number(a?.i)]
      const topicId = byName.get(String(a?.topic ?? '').trim())
      if (w && topicId) assign[w.id] = topicId
    }
    // 다시 뽑아도 사람이 다듬은 것은 남긴다: 이름이 같은 주제는 id 를 이어 쓰고, 하위 주제와 그 배정·「기타」 고정은 그대로 둔다.
    await editTopicSet(repoId, (prev) => mergeSuggested(prev, topics, assign))
    cache = null
    refreshSoon(50)
    return { topics: topics.length, assigned: Object.keys(assign).length }
  })

  orca.panels.handle('pod.tail', async (input: { terminal: string }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    const res = await runCli(['terminal', 'read', '--terminal', terminal, '--screen'])
    const t = res?.result?.terminal ?? {}
    const raw: string = typeof t.tail === 'string' ? t.tail : Array.isArray(t.tail) ? t.tail.join('\n') : ''
    const lines = raw
      .split('\n')
      .map((l: string) => l.replace(/\s+$/, ''))
      .filter((l: string, i: number, all: string[]) => l || (i > 0 && all[i - 1]))
    return { lines: lines.slice(-24) }
  })

  orca.panels.handle('pod.setStatus', async (input: { id: string; status: string }) => {
    const id = text(input?.id, 'id')
    const status = text(input?.status, 'status', 80)
    await runCli(['worktree', 'set', '--worktree', worktreeSelector(id), '--workspace-status', status])
    return afterChange({ ok: true })
  })

  orca.panels.handle('pod.setComment', async (input: { id: string; comment: string }) => {
    const id = text(input?.id, 'id')
    const comment = typeof input?.comment === 'string' ? input.comment.slice(0, 2_000) : ''
    await runCli(['worktree', 'set', '--worktree', worktreeSelector(id), `--comment=${comment}`])
    return afterChange({ ok: true })
  })

  orca.panels.handle('pod.markRead', async (input: { id: string }) => {
    const id = text(input?.id, 'id')
    await runCli(['worktree', 'set', '--worktree', worktreeSelector(id), '--read'])
    return afterChange({ ok: true })
  })

  orca.panels.handle('pod.launchAgent', async (input: { id: string; agent: string; prompt?: string }) => {
    const id = text(input?.id, 'id')
    const agent = text(input?.agent, 'agent', 40)
    // 작업실에서 바로 이어 쓰도록 터미널로 띄운다(대화창은 CLI 로 입력을 보낼 수 없다).
    const args = ['agent', 'launch', '--agent', agent, '--worktree', worktreeSelector(id), '--surface', 'terminal']
    if (input?.prompt) args.push(`--prompt=${text(input.prompt, '프롬프트')}`)
    const terminal = await newHandleAfter(() => runCli(args, 60_000))
    cache = null
    return afterChange({ ok: true, terminal })
  })

  orca.panels.handle('pod.newTerminal', async (input: { id: string; title?: string }) => {
    const id = text(input?.id, 'id')
    const args = ['terminal', 'create', '--worktree', worktreeSelector(id)]
    if (input?.title) args.push('--title', text(input.title, '제목', 80))
    const terminal = await newHandleAfter(() => runCli(args, 30_000))
    cache = null
    return afterChange({ ok: true, terminal })
  })

  orca.panels.handle(
    'pod.createWorkspace',
    async (input: { repoId: string; name: string; agent?: string; prompt?: string; parentId?: string; topicId?: string }) => {
      const repoId = text(input?.repoId, 'repoId', 200)
      const name = text(input?.name, '이름', 120)
      const before = new Set(Object.keys((await snapshot(0)).workspaces))
      const args = ['worktree', 'create', '--repo', `id:${repoId}`, `--name=${name}`, '--surface', 'terminal']
      if (input?.parentId) args.push('--parent-worktree', worktreeSelector(input.parentId))
      else args.push('--no-parent')
      if (input?.agent) args.push('--agent', text(input.agent, 'agent', 40))
      if (input?.agent && input?.prompt) args.push(`--prompt=${text(input.prompt, '프롬프트')}`)
      await runCli(args, 120_000)
      idsAt = 0
      // 새로 생긴 워크스페이스를 찾아 주제를 붙인다.
      const after = await snapshot(0)
      const created = Object.keys(after.workspaces).find((k) => !before.has(k)) ?? null
      if (created && input?.topicId) {
        const topicId = input.topicId
        await editTopicSet(repoId, (set) => {
          if (set?.topics.some((t) => t.id === topicId)) set.assign[created] = topicId
          return set ?? null
        })
        cache = null
      }
      return afterChange({ ok: true, id: created })
    }
  )
}
