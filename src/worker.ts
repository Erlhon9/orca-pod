// Pod 워커. 화면(패널)의 요청을 받아 orca CLI 와 호스트 API 로 데이터를 모으고 조작을 실행한다.
// 셸을 거치지 않고 execFile 로 인자 배열을 넘기므로 입력값이 명령으로 해석되지 않는다.
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { readConversation, readSession } from './conversation'
import { CONTROL_DIR, controlArgs, writeControlFiles, writeControlMap } from './control'
import { ControlRuntime, type ControlImage, type ControlView } from './runtime'
import { CodexControlRuntime } from './codex-runtime'
import { createControlBridge, type ControlBridge } from './control-bridge'
import { TerminalControlRuntime, terminalControlPrompt, controlLaunchResult, controlScreenLines } from './terminal-control'
import { CONTROL_AGENTS, controlAgentLabel } from './control-agents'
import { controlHandoff, mergeControlHistory, visibleControlItem } from './control-handoff'
import { CONTROL_TURNS_KEY, prepareControlRequest, readControlTurns, scopeKey, type ControlTurn } from './control-turns'
import { isControlProvider, relayTool, type ControlProvider } from './relay'
import type { ChatItem } from './transcript'
import { applyTopicPlan, parseTopicPlan, topicPlanFingerprint, type TopicPlan } from './topic-plan'
import { topicPlanPrompt } from './topic-prompt'
import { WATCH_KEY, emptyWatch, readWatchState, readWatchSettings, watchContext, watchDecision, watchPrompt, type WatchState, type WatchContext } from './control-watch'
import { WORK_JOURNAL_KEY, readWorkJournal } from './work-memory'
import { normalize, type Snapshot, type Topic, type TopicSet } from './model'
import { ProgressRepository } from './progress'
import { dashboardQuery } from './dashboard'
import { DashboardSource, MachineSource } from './dashboard-source'
import { PriorityRepository, priorityChange } from './work-priority'

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

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
/** 사진 한 장 최대 크기(바이트). */
export const IMAGE_MAX = 15 * 1024 * 1024
export const ATTACH_DIR = join(tmpdir(), 'pod-attachments')
/** 관제에 바로 넘기는 사진 한 장 최대 크기(바이트). */
const CONTROL_IMAGE_MAX = 5 * 1024 * 1024

/** 붙인 사진은 이틀 지나면 지운다. */
async function sweepAttachments(): Promise<void> {
  const old = Date.now() - 2 * 24 * 3600_000
  for (const n of await readdir(ATTACH_DIR).catch(() => [] as string[])) {
    const p = join(ATTACH_DIR, n)
    const st = await stat(p).catch(() => null)
    if (st && st.mtimeMs < old) await unlink(p).catch(() => {})
  }
}

const CONTROL_KEY = 'control-session'
const CONTROL_PROVIDER_KEY = 'control-provider'
const CONTROL_HANDOFF_KEY = 'control-handoff'
type ControlEngine = ControlRuntime | CodexControlRuntime | TerminalControlRuntime

/** 예전 워커가 띄운 관제 프로세스면 내린다. 번호가 다른 프로세스에 다시 쓰였을 수 있어 명령 줄을 확인한다. */
function killStaleControl(pid: number): Promise<string> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], (err, out) => {
      const cmd = String(out ?? '')
      if (err || (!cmd.includes('--input-format stream-json') && !cmd.includes('app-server')) || !cmd.includes(CONTROL_DIR)) return resolve('해당 없음')
      try {
        process.kill(pid, 'SIGTERM')
        resolve('내림')
      } catch (e: any) {
        resolve(`실패 ${e?.code ?? ''}`)
      }
    })
  })
}

/** 워커가 내려갈 때 관제 프로세스도 내린다. */
let controlRuntime: ControlEngine | null = null
let controlBridge: ControlBridge | null = null
export function deactivate(): void {
  void Promise.resolve(controlRuntime?.shutdown()).catch(() => {})
  controlRuntime = null
  void controlBridge?.close()
  controlBridge = null
}

/**
 * 관제를 띄울 곳: Claude 세션이 가장 최근에 돈 워크스페이스(이미 신뢰한 폴더라 «폴더 신뢰» 확인에 걸리지 않는다).
 * 같은 저장소의 메인 워크트리가 있으면 그쪽을 쓴다.
 */
export function pickControlHome(snap: Snapshot): string | null {
  const all = Object.values(snap.workspaces)
  const used = all
    .map((w) => ({ w, at: Math.max(0, ...w.agents.filter((a) => a.type === 'claude').map((a) => a.updatedAt)) }))
    .filter((x) => x.at > 0)
    .sort((a, b) => b.at - a.at)
  const best = used[0]?.w
  if (!best) return null
  const main = used.find((x) => x.w.repoId === best.repoId && x.w.isMain)?.w
  return (main ?? best).id
}

const worktreeSelector = (id: string) => `id:${id}`

const TOPICS_KEY = 'topics'

function claudeCli(): string {
  const candidates = [process.env.POD_CLAUDE_CLI, join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  return candidates.find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p)) ?? 'claude'
}

function codexCli(): string {
  const candidates = [process.env.POD_CODEX_CLI, join(homedir(), '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']
  return candidates.find((p): p is string => typeof p === 'string' && p.length > 0 && existsSync(p)) ?? 'codex'
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
    const keywords: string[] = (Array.isArray(raw.keywords) ? raw.keywords : [])
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

export default function activate(orca: any): void {
  const progress=new ProgressRepository(orca.storage)
  const dashboardSource=new DashboardSource()
  const machineSource=new MachineSource()
  const priorities=new PriorityRepository(orca.storage)
  let progressError:string|null=null
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
  function editTopicSet(repoId: string, edit: (prev: TopicSet | undefined) => TopicSet | null | Promise<TopicSet | null>): Promise<void> {
    const run = topicQueue.then(async () => {
      const all = await topicSets()
      const next = await edit(all[repoId])
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

  /** 관제 세션이 살아 있으면 스냅샷마다 세션 지도를 쓴다. */
  let controlOn = false
  let controlSelf: string | null = null

  async function build(): Promise<Snapshot> {
    const [ps, terminals, ids, topics] = await Promise.all([
      runCli(['worktree', 'ps']),
      runCli(['terminal', 'list']).catch(() => null),
      workspaceIds(),
      topicSets().catch(() => ({}) as Record<string, TopicSet>)
    ])
    const snap = normalize(ps, terminals, ids, Date.now(), topics)
    try {
      if(await progress.observe(snap))orca.panels.post('pod.progress.changed',{})
      progressError=null
    } catch(error) {progressError=userMessage(String((error as Error).message));orca.log('작업 기록 저장 실패')}
    // 관제 세션이 있으면 세션 지도를 갱신한다(바뀌었을 때만 쓴다).
    if (controlOn) void writeControlMap(CONTROL_DIR, snap, controlSelf).catch(() => {})
    return snap
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

  // 관제 공급자별로 세션과 기록을 분리한다. 선택만으로 추론 요청을 시작하지 않는다.
  let runtime: ControlEngine | null = null
  let provider: ControlProvider = 'claude'
  let controlInit: Promise<ControlEngine> | null = null
  let selecting = false
  let sendingControl = false
  let controlEpoch = 0
  let sharedHistory: ChatItem[] = []
  let pendingHandoff = ''
  let turns: ControlTurn[] = []
  let turnsLoaded = false
  let activeTurn: ControlTurn | null = null
  let savingTurns = Promise.resolve()
  let turnSaveFailed = false
  let topicPlan: TopicPlan | null = null
  let topicError: string | null = null
  let topicSource: {requestId:string;snapshot:Snapshot;repoId:string} | null = null
  let watchState=emptyWatch()
  let watchInit:Promise<void>|null=null
  let watchWrites:Promise<unknown>=Promise.resolve()
  let watchPending=false
  let watchSaving=false
  let watchError:string|null=null
  let watchSource:{requestId:string;context:WatchContext}|null=null
  const watchScanned=new Map<string,number>()
  const loadWatch=()=>watchInit??=(async()=>{watchState=readWatchState(await orca.storage.get(WATCH_KEY))})().catch(error=>{watchInit=null;throw error})
  const editWatch=(edit:(next:WatchState)=>void):Promise<void>=>{
    const write=watchWrites.catch(()=>{}).then(async()=>{
      await loadWatch()
      const next=structuredClone(watchState)
      edit(next)
      next.notes=next.notes.slice(-12)
      next.checkpoints=Object.fromEntries(Object.entries(next.checkpoints).sort((a,b)=>Math.max(a[1].lastAttempt,a[1].lastCheck)-Math.max(b[1].lastAttempt,b[1].lastCheck)).slice(-100))
      await orca.storage.set(WATCH_KEY,next)
      watchState=next
    })
    watchWrites=write
    return write
  }
  const TOPIC_PLAN_KEY = 'pod.topic-plan.v1'
  const withProvider = (v: ControlView, selected = provider) => {
    const latest = [...turns].reverse().find(turn => turn.kind === 'briefing' && turn.status === 'complete' && turn.answer)
    const items=mergeControlHistory(sharedHistory,v.items).filter(item=>{
      if(turns.some(turn=>turn.id===item.requestId && turn.kind==='watch')) item.controlKind='watch'
      return item.controlKind!=='watch'
    })
    return { ...v, items, provider: selected, watch:{settings:watchState.settings,configuredAt:watchState.configuredAt,notes:watchState.notes,error:watchError,saving:watchSaving},
      // 과거 브리핑 본문을 스트리밍 조각마다 모두 전송하지 않는다. 이전 작업은 개별 캐시로 조회한다.
      turns: turns.map(turn => ({ ...turn, text: '', answer: turn.id === latest?.id ? turn.answer : '' })), memoryError: turnSaveFailed, topicPlan, topicError }
  }
  const briefingKey = (targets: ControlTurn['targets']) => `pod.briefing.v1.${createHash('sha256').update(scopeKey(targets)).digest('hex')}`
  const saveTurns = (briefing?: ControlTurn): Promise<void> => {
    const value = turns.slice(-80).map(turn => ({ ...turn, targets: [...turn.targets] }))
    const savedBriefing = briefing ? { ...briefing, targets: [...briefing.targets] } : null
    const write = savingTurns.catch(() => {}).then(async () => {
      await orca.storage.set(CONTROL_TURNS_KEY, value)
      if (savedBriefing?.answer) await orca.storage.set(briefingKey(savedBriefing.targets), savedBriefing)
      const wasFailed = turnSaveFailed
      turnSaveFailed = false
      if (wasFailed && runtime) orca.panels.post('pod.control.view', withProvider(runtime.view()))
    })
    savingTurns = write
    void write.catch(() => { turnSaveFailed = true; orca.log('관제 브리핑 보관 실패'); if (runtime) orca.panels.post('pod.control.view', withProvider(runtime.view())) })
    return write
  }
  function control(): Promise<ControlEngine> {
    if (runtime) return Promise.resolve(runtime)
    controlInit ??= makeControl().finally(() => (controlInit = null))
    return controlInit
  }
  async function makeControl(): Promise<ControlEngine> {
    await loadWatch()
    if (!turnsLoaded) {
      turns = readControlTurns(await orca.storage.get(CONTROL_TURNS_KEY))
      const saved = await orca.storage.get(TOPIC_PLAN_KEY)
      topicPlan = saved && typeof saved.repoId === 'string' && Array.isArray(saved.topics) && Array.isArray(saved.assignments) ? saved as TopicPlan : null
      turnsLoaded = true
    }
    const preferred = await orca.storage.get(CONTROL_PROVIDER_KEY).catch(() => null)
    provider = isControlProvider(preferred) ? preferred : 'claude'
    const selected = provider
    const handoff = await orca.storage.get(CONTROL_HANDOFF_KEY).catch(() => null)
    sharedHistory = Array.isArray(handoff?.items) ? handoff.items : []
    pendingHandoff = handoff?.pending && handoff?.to === selected ? controlHandoff(sharedHistory) : ''
    const storageKey = selected === 'claude' ? CONTROL_KEY : `${CONTROL_KEY}-${selected}`
    const saved = (await orca.storage.get(storageKey).catch(() => null)) as { sessionId?: string; cwd?: string; pid?: number; terminal?: string; home?: string; items?: ChatItem[] } | null
    if (saved?.pid) {
      const r = await killStaleControl(saved.pid)
      if (r !== '해당 없음') orca.log(`예전 관제 프로세스 ${saved.pid}: ${r}`)
    }
    const snap = await snapshot()
    const home = saved?.home && snap.workspaces[saved.home] ? saved.home : pickControlHome(snap) ?? Object.values(snap.workspaces).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]?.id ?? null
    const cwd = selected === 'codex' || selected === 'claude' ? CONTROL_DIR : saved?.cwd && existsSync(saved.cwd) ? saved.cwd : home ? snap.workspaces[home].path : homedir()
    const session = saved?.cwd === cwd ? saved.sessionId ?? null : null
    let sessionId = session
    let pid: number | null = null
    let ownedTerminal: string | null = saved?.terminal ?? null
    controlSelf = selected !== 'claude' && selected !== 'codex' ? ownedTerminal : null
    let history = Array.isArray(saved?.items) ? saved.items.slice(-240) : []
    // The restricted adapters use a private cwd, never a user's repository configuration.
    // Preserve old visible context without resuming a process with its old tool configuration.
    if (saved?.cwd && saved.cwd !== cwd && (selected === 'claude' || selected === 'codex')) {
      sharedHistory = mergeControlHistory(sharedHistory, history)
      pendingHandoff = controlHandoff(sharedHistory)
      await orca.storage.set(CONTROL_HANDOFF_KEY, { items: sharedHistory, to: selected, pending: true })
    }
    let saving = Promise.resolve()
    const save = () => {
      const value = { sessionId, cwd, pid, terminal: ownedTerminal, home, items: history }
      saving = saving.then(() => orca.storage.set(storageKey, value)).catch(() => {})
    }
    const env = { ...process.env, USER: process.env.USER ?? userInfo().username, LOGNAME: process.env.LOGNAME ?? userInfo().username, ELECTRON_RUN_AS_NODE: undefined }
    const emit = (view: ControlView) => {
      if (provider !== selected) return
      if (activeTurn?.provider === selected && activeTurn.status === 'running' && view.outcome?.requestId === activeTurn.id) {
        const own = view.items.filter(item => item.requestId === activeTurn!.id)
        activeTurn.status = view.outcome.status
        activeTurn.endedAt = Date.now()
        if (activeTurn.status === 'complete' && (selected === 'claude' || selected === 'codex')) {
          const answer = [...own].reverse().find(item => item.k === 'text')
          if (activeTurn.kind === 'topics' && topicSource?.requestId === activeTurn.id) {
            try {
              topicPlan = parseTopicPlan(answer?.k === 'text' ? answer.text : '', topicSource.snapshot, topicSource.repoId)
              topicError = null
              void orca.storage.set(TOPIC_PLAN_KEY, topicPlan).catch(() => { topicError = '분류안을 보관하지 못했습니다'; if (runtime) orca.panels.post('pod.control.view', withProvider(runtime.view())) })
            } catch (error) { topicPlan = null; topicError = userMessage(String((error as Error).message)) }
            topicSource = null
          } else if(activeTurn.kind==='watch' && watchSource?.requestId===activeTurn.id) {
            const source=watchSource, id=activeTurn.id, at=activeTurn.endedAt!, body=answer?.k==='text'?answer.text.trim():''
            watchSource=null
            if(body) {
              watchSaving=true
                void editWatch(next=>{
                const prior=next.checkpoints[source.context.key]
                next.notes.push({id,scopeKey:source.context.key,label:source.context.label,answer:body.slice(0,12000),at,fingerprint:source.context.fingerprint,workspaceIds:source.context.workspaces.map(w=>w.id)})
                next.checkpoints[source.context.key]={fingerprint:source.context.fingerprint,signals:source.context.signals,lastAttempt:prior?.lastAttempt??at,lastSuccess:at,lastCheck:at}
              }).then(()=>{watchError=null}).catch(()=>{watchError='브리핑을 보관하지 못했습니다'}).finally(()=>{watchSaving=false;if(runtime)orca.panels.post('pod.control.view',withProvider(runtime.view()))})
            } else watchError='브리핑 응답이 비어 있습니다'
          } else activeTurn.answer = answer?.k === 'text' ? answer.text.slice(0, 24_000) : ''
        }
        if(activeTurn.kind==='watch' && activeTurn.status!=='complete') {watchSource=null;watchError=view.error??'브리핑이 중단됐습니다'}
        saveTurns(activeTurn.kind === 'briefing' && activeTurn.status === 'complete' ? activeTurn : undefined)
      }
      history = view.items; save()
      orca.panels.post('pod.control.view', withProvider(view, selected))
    }
    const saveSession = (id: string | null) => { sessionId = id; save() }
    let rt: ControlEngine
    let relayEnabled = selected !== 'claude'
    const epoch = controlEpoch
    const assertCurrent = () => { if (controlEpoch !== epoch || provider !== selected || controlRuntime !== rt) throw new Error('Control is no longer active') }
    const callRelay = (name: string, input: unknown, active: () => boolean = () => true) => {
      const requestId = activeTurn?.id
      return relayTool({
      readOnly: activeTurn?.kind === 'briefing' || activeTurn?.kind === 'topics' || activeTurn?.kind === 'watch',
      active: () => relayEnabled && active() && rt.view().busy && controlEpoch === epoch && provider === selected && controlRuntime === rt && activeTurn?.id === requestId,
      snapshot: async () => {
        assertCurrent();const value=await snapshot(0);assertCurrent()
        const source=watchSource
        if(activeTurn?.kind==='watch') {
          if(!source || source.requestId!==requestId) throw new Error('관제 브리핑이 종료됐습니다')
          const context=watchContext(value,source.context.scope)
          return {...value,workspaces:Object.fromEntries(context.workspaces.map(w=>[w.id,w]))}
        }
        return value
      },
      cli: args => { assertCurrent(); return runCli(args) }
    }, name, input)
    }
    await controlBridge?.close()
    controlBridge = null
    if (selected === 'claude') controlBridge = await createControlBridge(callRelay)
    try { await writeControlFiles(CONTROL_DIR, snap, null, controlBridge?.config) }
    catch (error) { await controlBridge?.close(); controlBridge = null; throw error }
    if (selected === 'codex') {
      rt = new CodexControlRuntime({
        spawn: () => {
          const child = spawn(codexCli(), ['app-server', '-c', `cwd=${JSON.stringify(CONTROL_DIR)}`], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
          pid = child.pid ?? null
          save()
          return child
        },
        emit, saveSession,
        tool: callRelay
      }, session, history)
    } else if (selected === 'claude') {
      const bridge = controlBridge!
      rt = new ControlRuntime({
        spawn: extra => {
          bridge.revokeSessions()
          relayEnabled = true
          const child = spawn(claudeCli(), [...controlArgs(CONTROL_DIR), ...extra], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
          pid = child.pid ?? null
          save()
          return child
        },
        emit, saveSession, onStop: () => { relayEnabled = false; bridge.revokeSessions() },
        // 저장된 표시 기록에는 공급자 transcript에 없는 requestId가 있다. 재개 시 이를 버리지 않는다.
        history: async id => history.length ? history : (await readSession(id, cwd)).items.map(visibleControlItem)
      }, session)
    } else {
      const owner = () => { if (!home) throw new CliError('관제를 실행할 워크스페이스가 없습니다'); return home }
      rt = new TerminalControlRuntime({
        launch: async prompt => {
          const response = await runCli(['agent', 'launch', '--agent', selected, '--worktree', worktreeSelector(owner()), '--surface', 'terminal', `--prompt=${prompt}`], 90_000)
          return controlLaunchResult(response)
        },
        send: (terminal, message) => runCli(['terminal', 'send', '--terminal', terminal, `--text=${message}`, '--enter', '--wait-submit', '5']),
        read: async terminal => {
          const current = await snapshot(0)
          const workspace = current.workspaces[owner()]
          const agent = workspace?.agents.find(a => a.terminal === terminal && a.type === selected)
          const tab = workspace?.terminals.find(t => t.handle === terminal && t.kind === 'agent' && t.agentType === selected && t.connected)
          if (!agent && !tab) throw new CliError('관제 터미널을 찾지 못했습니다')
          const response = await runCli(['terminal', 'read', '--terminal', terminal, '--screen'])
          return { lines: controlScreenLines(response), working: agent?.state === 'working' }
        },
        interrupt: async terminal => {
          const current = (await snapshot(0)).workspaces[owner()]
          if (!current?.agents.some(a => a.terminal === terminal && a.type === selected)) throw new CliError('관제 터미널을 찾지 못했습니다')
          await runCli(['terminal', 'send', '--terminal', terminal, '--interrupt'])
        },
        emit,
        saveTerminal: terminal => { ownedTerminal = terminal; if (provider === selected && runtime === rt) controlSelf = terminal; save() },
        saveImages: async images => {
          await mkdir(ATTACH_DIR, { recursive: true, mode: 0o700 })
          return Promise.all(images.map(async image => {
            const path = join(ATTACH_DIR, `${randomUUID()}.${IMAGE_EXT[image.type]}`)
            await writeFile(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
            return path
          }))
        }
      }, terminalControlPrompt(join(CONTROL_DIR, 'map.json')), ownedTerminal, history)
    }
    controlOn = true
    await rt.load()
    runtime = rt
    controlRuntime = rt
    return rt
  }

  orca.panels.handle('pod.control.agents', async () => {
    const active = new Set(Object.values((await snapshot()).workspaces).flatMap(w => w.agents.map(a => a.type)))
    const paths = (process.env.PATH ?? '').split(':').filter(Boolean)
    return CONTROL_AGENTS.map(agent => ({
      id: agent.id, label: agent.label,
      mode: agent.id === 'claude' || agent.id === 'codex' ? 'embedded' : 'terminal',
      detected: active.has(agent.id) || (agent.id === 'claude-agent-teams'
        ? paths.some(path => existsSync(join(path, 'claude')))
        : agent.commands.some(command => paths.some(path => existsSync(join(path, command)))))
    }))
  })
  orca.panels.handle('pod.language', async () => {
    const prefs = await orca.storage.get('pod.prefs')
    return { default: 'en', preference: prefs?.lang ?? 'en' }
  })
  orca.panels.handle('pod.control.open', async () => {
    if (!controlSelf) throw new CliError('관제 터미널을 찾지 못했습니다')
    await runCli(['terminal', 'switch', '--terminal', controlSelf])
    return { opened: true }
  })
  orca.panels.handle('pod.control.view', async () => withProvider((await control()).view()))
  orca.panels.handle('pod.control.briefing', async (input: { targets?: unknown }) => {
    const prepared = prepareControlRequest(await snapshot(), '', { targets: input?.targets, kind: 'briefing' })
    const saved = readControlTurns([await orca.storage.get(briefingKey(prepared.targets))])[0]
    return saved?.status === 'complete' && saved.kind === 'briefing' && scopeKey(saved.targets) === scopeKey(prepared.targets) ? saved : null
  })
  orca.panels.handle('pod.control.provider', async (input: { provider?: unknown }) => {
    if (!isControlProvider(input?.provider)) throw new CliError('지원하지 않는 관제 에이전트입니다')
    if (selecting) throw new CliError('관제 에이전트를 변경하는 중입니다')
    selecting = true
    try {
      const rt = await control()
      if (provider !== input.provider) {
        const before = rt.view()
        const from = provider
        const nextHistory = mergeControlHistory(sharedHistory, before.items, before.live ? [{ k: 'note', text: `미완료 응답 (${from}): ${before.live}`, at: Date.now(), ...(before.requestId ? { requestId: before.requestId } : {}) }] : [])
        if (activeTurn?.status === 'running') { activeTurn.status = 'interrupted'; activeTurn.endedAt = Date.now(); saveTurns() }
        nextHistory.push({ k: 'note', text: `관제 전환: ${controlAgentLabel(from)} → ${controlAgentLabel(input.provider)}`, at: Date.now() })
        // 전환 자체는 이전 공급자를 호출하지 않는다. 사용량 한도 오류·응답 중에도 바꿀 수 있다.
        await orca.storage.set(CONTROL_HANDOFF_KEY, { items: nextHistory, to: input.provider, pending: true })
        await orca.storage.set(CONTROL_PROVIDER_KEY, input.provider)
        controlEpoch++
        await controlBridge?.close()
        controlBridge = null
        await rt.shutdown()
        runtime = null
        controlRuntime = null
        await control()
      }
      const view = withProvider(runtime!.view())
      orca.panels.post('pod.control.view', view)
      return view
    } finally { selecting = false }
  })
  const sendControl = async (input: { text?: string; images?: unknown; scope?: unknown }) => {
    const raw: any[] = Array.isArray(input?.images) ? input.images : []
    if (raw.length > 6) throw new CliError('사진은 6장까지 보낼 수 있습니다')
    const images: ControlImage[] = raw.map((im: any) => {
      if (!im || !IMAGE_EXT[String(im.type)] || typeof im.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(im.data))
        throw new CliError('사진만 붙일 수 있습니다')
      // 모델에 바로 넘기는 사진은 장당 5MB 까지(넘으면 대화가 거절되고 이어 가기도 막힌다).
      if (im.data.length > Math.ceil((CONTROL_IMAGE_MAX * 4) / 3) + 4) throw new CliError('사진은 장당 5MB 까지 보낼 수 있습니다')
      return { type: String(im.type), data: im.data }
    })
    const body = typeof input?.text === 'string' ? input.text : ''
    if (!body.trim() && images.length === 0) throw new CliError('메시지 값이 비어 있습니다')
    if (selecting) throw new CliError('관제 에이전트를 변경하는 중입니다')
    if (sendingControl) throw new CliError('관제가 답하는 중입니다')
    sendingControl = true
    const epoch = controlEpoch
    try {
      const rt = await control()
      if (rt.view().busy) throw new CliError('관제가 답하는 중입니다')
      // 오래된 지도로는 보내지 않는다. 갱신 실패는 이번 요청의 실패로 알린다.
      const current = await snapshot(0)
      await writeControlMap(CONTROL_DIR, current, controlSelf)
      const scope = input.scope as any
      const isTopics = scope?.kind === 'topics'
      const isWatch = scope?.kind === 'watch'
      const watchJournal=isWatch?readWorkJournal(await orca.storage.get(WORK_JOURNAL_KEY)):{}
      const context=isWatch?watchContext(current,scope.watchScope,watchJournal):null
      const priorityState=isWatch?await priorities.view():{}
      const repoId = isTopics ? text(scope.repoId, 'repoId', 200) : ''
      const prepared = context ? {targets:[],label:context.label,text:watchPrompt(context,watchJournal,[...watchState.notes].reverse().find(note=>note.scopeKey===context.key),scope.watchLanguage==='en'?'en':'ko',priorityState),displayText:body,kind:'watch' as const,sourceVersion:context.fingerprint} : isTopics ? {targets:[],label:current.repos.find(r => r.id === repoId)?.name ?? repoId,text:topicPlanPrompt(current,repoId),displayText:body,kind:'topics' as const,sourceVersion:topicPlanFingerprint(current,repoId),topicRepoId:repoId} : prepareControlRequest(current, body, input.scope)
      if(!isTopics&&(!context||context.workspaces.length)) {
        try {prepared.text+=await progress.context(context?context.workspaces.map(w=>w.id):prepared.targets.map(t=>t.workspaceId),Math.max(0,(context?19000:20000)-prepared.text.length))}
        catch {orca.log('관제의 작업 이력 조회 실패');const unavailable='\nPod work history is unavailable for this request. Do not claim it was read.';if(prepared.text.length+unavailable.length<=19000)prepared.text+=unavailable}
      }
      if ((prepared.kind === 'briefing' || prepared.kind === 'topics' || prepared.kind==='watch') && provider !== 'claude' && provider !== 'codex') throw new CliError('이 에이전트에서는 조회 전용 브리핑을 지원하지 않습니다')
      activeTurn = { ...prepared, id: randomUUID(), provider, startedAt: Date.now(), endedAt: null, status: 'running', answer: '' }
      turns = [...turns, activeTurn].slice(-80)
      if (isTopics) { topicSource = {requestId:activeTurn.id,snapshot:structuredClone(current),repoId}; topicPlan = null; topicError = null }
      if(context) {watchSource={requestId:activeTurn.id,context};watchError=null}
      try {
        await saveTurns()
        if (isTopics) await orca.storage.set(TOPIC_PLAN_KEY,null)
        if(context) await editWatch(next=>{
          const previous=next.checkpoints[context.key]
          next.checkpoints[context.key]={fingerprint:previous?.fingerprint??'',signals:previous?.signals??[],lastAttempt:Date.now(),lastSuccess:previous?.lastSuccess??0,lastCheck:previous?.lastCheck??0}
        })
        if (epoch !== controlEpoch) throw new CliError('관제 에이전트를 변경하는 중입니다')
        await rt.send(activeTurn.text, images, pendingHandoff, activeTurn.id)
        if (epoch === controlEpoch && pendingHandoff) {
          pendingHandoff = ''
          await orca.storage.set(CONTROL_HANDOFF_KEY, { items: sharedHistory, to: provider, pending: false })
        }
      } catch (e: any) {
        if (activeTurn?.status === 'running') { activeTurn.status = 'failed'; activeTurn.endedAt = Date.now(); saveTurns() }
        throw new CliError(e?.message === '작업 중' ? '관제가 답하는 중입니다' : '보내지 못했습니다')
      }
    } finally { sendingControl = false }
    return { sent: true }
  }
  orca.panels.handle('pod.control.send', sendControl)
  orca.panels.handle('pod.control.watch.configure',async(input:any)=>{
    if(!input || Object.keys(input).some(key=>!['intervalMinutes','changes','scopeMode'].includes(key)) || !Number.isInteger(input.intervalMinutes) || input.intervalMinutes<0 || input.intervalMinutes>240 || typeof input.changes!=='boolean' || input.scopeMode!==undefined && !['all','current'].includes(input.scopeMode)) throw new CliError('브리핑 간격은 1~240분으로 입력하세요')
    await editWatch(next=>{next.settings=readWatchSettings(input);next.configuredAt=Date.now()})
    if(runtime)orca.panels.post('pod.control.view',withProvider(runtime.view()))
    return watchState.settings
  })
  orca.panels.handle('pod.control.watch.check',async(input:any)=>{
    const manual=input?.manual===true
    if(watchPending || watchSaving || selecting || sendingControl || runtime?.view().busy) return {started:false,reason:'busy'}
    watchPending=true
    try {
      await loadWatch()
      if(!manual && !watchState.settings.intervalMinutes && !watchState.settings.changes) return {started:false,reason:'disabled'}
      const context=watchContext(await snapshot(),input?.scope,readWorkJournal(await orca.storage.get(WORK_JOURNAL_KEY)))
      if(!manual && Date.now()-(watchScanned.get(context.key)??0)<4000) return {started:false,reason:'unchanged'}
      watchScanned.set(context.key,Date.now())
      const decision=watchDecision(watchState,context,Date.now(),manual)
      if(['baseline','checked'].includes(decision)) await editWatch(next=>{
        const old=next.checkpoints[context.key]
        next.checkpoints[context.key]={fingerprint:old?.fingerprint??context.fingerprint,signals:old?.signals??context.signals,lastAttempt:old?.lastAttempt??0,lastSuccess:old?.lastSuccess??0,lastCheck:Date.now()}
      })
      if(!['request','changes','scheduled'].includes(decision)) {
        if(manual && !context.workspaces.length) throw new CliError('브리핑할 작업이 없습니다')
        return {started:false,reason:decision}
      }
      if(selecting || sendingControl || runtime?.view().busy) return {started:false,reason:'busy'}
      await control()
      if(provider!=='claude' && provider!=='codex') {
        if(manual) throw new CliError('이 에이전트에서는 조회 전용 브리핑을 지원하지 않습니다')
        return {started:false,reason:'unsupported'}
      }
      await sendControl({text:manual?'지금 브리핑':'관제 브리핑',scope:{kind:'watch',watchScope:context.scope,watchLanguage:input?.language,targets:[]}})
      return {started:true,reason:decision}
    } catch(error) {
      watchError=userMessage(String((error as Error).message))
      if(runtime)orca.panels.post('pod.control.view',withProvider(runtime.view()))
      if(manual)throw error
      return {started:false,reason:'error'}
    } finally {watchPending=false}
  })
  orca.panels.handle('pod.control.stop', async () => {
    if (activeTurn?.status === 'running') { activeTurn.status = 'interrupted'; activeTurn.endedAt = Date.now(); saveTurns() }
    await runtime?.stop()
    return { stopped: true }
  })
  orca.panels.handle('pod.control.reset', async () => {
    if (selecting || sendingControl) throw new CliError('관제 에이전트를 변경하는 중입니다')
    const rt = await control()
    if (activeTurn?.status === 'running') { activeTurn.status = 'interrupted'; activeTurn.endedAt = Date.now(); saveTurns() }
    sharedHistory = []
    pendingHandoff = ''
    await orca.storage.set(CONTROL_HANDOFF_KEY, { items: [], to: provider, pending: false })
    await rt.reset()
    return { reset: true }
  })

  orca.panels.handle('pod.snapshot', async (input: { fresh?: boolean } | undefined) =>
    snapshot(input?.fresh ? 0 : 1_500)
  )
  orca.panels.handle('pod.dashboard.month',async(input:unknown)=>{
    const query=dashboardQuery(input),snap=await snapshot()
    if(query.repoId&&!snap.repos.some(r=>r.id===query.repoId))throw new CliError('저장소를 찾지 못했습니다')
    return dashboardSource.month(snap,query,progress)
  })
  orca.panels.handle('pod.dashboard.machine',async(input:unknown)=>{
    if(input!=null&&(typeof input!=='object'||Array.isArray(input)||Object.keys(input).length))throw new CliError('컴퓨터 조회 범위를 확인하세요')
    return machineSource.sample()
  })
  orca.panels.handle('pod.progress.view',async(input:unknown)=>({...await progress.view(input),error:progressError}))
  orca.panels.handle('pod.priority.view',()=>priorities.view())
  orca.panels.handle('pod.priority.set',async(input:unknown)=>{
    priorityChange(input)
    const result=await priorities.set(input,await snapshot())
    orca.panels.post('pod.priority.changed',{})
    return result
  })
  orca.panels.handle('pod.progress.change',async(input:unknown)=>{
    await progress.change(input)
    orca.panels.post('pod.progress.changed',{})
    return {saved:true}
  })

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

  // 터미널 탭으로 바로 이동(그 워크스페이스로 함께 전환된다).
  orca.panels.handle('pod.focusTerminal', async (input: { terminal: string }) => {
    await runCli(['terminal', 'switch', '--terminal', text(input?.terminal, 'terminal', 200)])
    return { opened: true }
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

  orca.panels.handle('pod.interrupt', async (input: { terminal: string }) => {
    const terminal = text(input?.terminal, 'terminal', 200)
    await runCli(['terminal', 'send', '--terminal', terminal, '--interrupt'])
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
    async (input: { path: string; key: string; type: string; title?: string; prompt?: string; since?: number; others?: unknown }) =>
      readConversation({
        path: text(input?.path, 'path', 2000),
        key: text(input?.key, 'key', 400),
        type: String(input?.type ?? ''),
        title: typeof input?.title === 'string' ? input.title.slice(0, 400) : undefined,
        prompt: typeof input?.prompt === 'string' ? input.prompt.slice(0, 400) : undefined,
        since: typeof input?.since === 'number' && Number.isFinite(input.since) ? input.since : undefined,
        others: Array.isArray(input?.others)
          ? input.others.filter((k): k is string => typeof k === 'string' && k.length <= 400).slice(0, 300)
          : undefined
      })
  )

  // 입력창에 붙인 사진을 임시 파일로 저장하고 경로를 돌려준다. 세션에는 이 경로를 지시와 함께 보낸다.
  orca.panels.handle('pod.saveImage', async (input: { type: string; data: string }) => {
    const ext = IMAGE_EXT[String(input?.type)]
    if (!ext) throw new CliError('사진만 붙일 수 있습니다')
    const buf = Buffer.from(text(input?.data, '사진', Math.ceil((IMAGE_MAX * 4) / 3) + 4), 'base64')
    if (buf.length === 0) throw new CliError('사진을 읽지 못했습니다')
    await mkdir(ATTACH_DIR, { recursive: true, mode: 0o700 })
    void sweepAttachments()
    const file = join(ATTACH_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`)
    await writeFile(file, buf, { mode: 0o600 })
    return { path: file }
  })

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

  // 이전 진입점도 현재 선택한 관제로 제안만 만든다. 저장은 검토 후 applyTopicPlan에서 한다.
  orca.panels.handle('pod.suggestTopics', async (input: {repoId:string}) => sendControl({text:'주제와 하위 주제를 정리해줘',scope:{kind:'topics',repoId:input?.repoId,targets:[]}}))

  orca.panels.handle('pod.topicState', async (input: {repoId:string}) => {
    const repoId = text(input?.repoId,'repoId',200)
    return (await topicSets())[repoId] ?? null
  })

  orca.panels.handle('pod.applyTopicPlan', async (input: {plan?:unknown}) => {
    const raw = input?.plan as any
    const repoId = text(raw?.repoId, 'repoId', 200)
    let count = 0
    await editTopicSet(repoId, async previous => {
      const current = await snapshot(0)
      if (raw.baseFingerprint !== topicPlanFingerprint(current,repoId)) throw new CliError('분석 뒤 작업 맥락이 바뀌었습니다. 다시 분석하세요')
      const validated = parseTopicPlan(JSON.stringify({topics:raw.topics,assignments:raw.assignments}), current, repoId)
      const next = applyTopicPlan(validated, current, repoId, previous)
      count = validated.assignments.length
      return next
    })
    if (topicPlan?.repoId === repoId) { topicPlan = null; topicError = null; await orca.storage.set(TOPIC_PLAN_KEY,null).catch(() => orca.log('주제 분류안 캐시 정리 실패')) }
    cache = null
    const changed = await afterChange({assigned:count})
    if (runtime) orca.panels.post('pod.control.view',withProvider(runtime.view()))
    return changed
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
