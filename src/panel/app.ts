// Pod 패널: 요약 → 지금 움직이는 에이전트 → 디렉토리별 워크스페이스(상태별) / 에이전트 / 그래프.
import { currentLang, langPersisted, langPref, normalizePref, setLangPref, t, tt, type LangPref } from './i18n'
import type { AgentView, RepoView, Snapshot, TerminalRef, Topic, WorkspaceView } from '../model'
import { topicPath, topicRoot } from '../model'
import { WORK_JOURNAL_KEY, WORK_MEMORY_LIMITS, readWorkJournal, readWorkMemory, reviewWork, workFingerprint, type WorkJournal, type WorkMemory } from '../work-memory'
import { workOverview, type WorkContextApi } from './work-context'
import { agentChoice } from './agent-choice'
import { clearGraphPositions, graphPositionKey, readGraphPositions, type GraphPositions } from '../graph-layout'
import type { TopicPlan } from '../topic-plan'
import { collectTopicScopes, topicScopeIncludes, type TopicScope } from '../topic-scope'
import { controlDock, readControlPosition, type ControlPosition } from '../control-layout'
import { createController, type ControlView } from './controller'
import { createDetail } from './detail'
import { pendingQuestions, readQuestions } from '../questions'
import type { ChatItem } from '../transcript'
import { questionCard } from './questions'
import { dragJustEnded, draggableRow } from './dnd'
import { burstAt, celebrate, floatText } from './fx'
import { createGraph } from './graph'
import { createProgress } from './progress'
import { createDashboard } from './dashboard'
import { priorityBadge } from './priority-badge'
import { workPriority, type PriorityLevel, type PriorityOverrides } from '../work-priority'
import { closeMenu, hideHover, hoverable, openMenu, openSheet, refreshHover, sheetOpen, toast, type MenuItem } from './overlays'
import {
  AGENT_STATE_LABEL,
  agentGlyph,
  agentName,
  ago,
  agoFull,
  avatar,
  clip,
  duration,
  fill,
  h,
  icon,
  statusColor,
  statusLabel,
  topicColor
} from './ui'

declare const orca: any

type View = 'board' | 'agents' | 'graph' | 'dashboard'
type Filter = null | 'working' | 'attention' | 'in-progress' | 'in-review'

const state = {
  snap: null as Snapshot | null,
  view: 'graph' as View,
  query: '',
  filter: null as Filter,
  /** 숨길 워크스페이스 상태. 기본은 완료만 숨긴다. */
  hidden: new Set<string>(['completed']),
  /** 디렉토리 안을 상태별로 묶을지 주제별로 묶을지. */
  groupBy: 'topic' as 'status' | 'topic',
  collapsedRepos: new Set<string>(),
  openGroups: new Set<string>(),
  closedGroups: new Set<string>(),
  /** 그래프 섹션 접기 상태(키: 디렉토리:묶음방식:섹션). 없으면 자동. */
  graphSections: {} as Record<string, 'open' | 'closed' | 'all'>,
  graphPositions: {} as GraphPositions,
  /** 고른 디렉토리. null 은 전체, undefined 는 아직 고르지 않음(첫 스냅샷에서 가장 바쁜 곳). */
  repo: undefined as string | null | undefined,
  scopeMode: 'repo' as 'repo' | 'topic',
  topicScope: null as string | null,
  controlPosition: 'bottom' as ControlPosition,
  priorityLevel:null as PriorityLevel|null,
  error: null as string | null,
  lastSync: 0,
  syncing: false
}

const PREFS_KEY = 'pod.prefs'
let journal: WorkJournal = {}
let priorities:PriorityOverrides={}
const priorityOf=(w:WorkspaceView)=>workPriority(w,priorities)
async function loadPriorities():Promise<void> {
  try {priorities=await call<PriorityOverrides>('pod.priority.view',{},true)}
  catch {toast(t('중요도 설정을 읽지 못했습니다'),'err')}
}
function editPriority(w:WorkspaceView,anchor:HTMLElement):void {
  const current=priorityOf(w)
  openMenu(anchor,[{section:w.name},...(['P0','P1','P2'] as const).map(level=>({label:level,hint:level==='P0'?t('최우선'):level==='P1'?t('우선 확인'):t('일반'),checked:current?.source==='manual'&&current.level===level,onSelect:()=>void call<PriorityOverrides>('pod.priority.set',{id:w.id,level}).then(next=>{priorities=next;renderTop();renderBody()}).catch(()=>{})})),
    'sep',{label:t('자동 분류'),checked:current?.source==='observed',onSelect:()=>void call<PriorityOverrides>('pod.priority.set',{id:w.id,level:null}).then(next=>{priorities=next;renderTop();renderBody()}).catch(()=>{})}],anchor,{keyboard:true})
}
let memoryWrites: Promise<unknown> = Promise.resolve()

/** 같은 패널의 저장 순서를 지키고, 저장 실패를 성공으로 표시하지 않는다. 대화 본문은 이 저장소에 복사하지 않는다. */
function saveMemory(id: string, change: (current: WorkMemory) => WorkMemory): Promise<void> {
  const write = memoryWrites.catch(() => {}).then(async () => {
    try {
      if (!orca.storage?.get || !orca.storage?.set) throw new Error('storage unavailable')
      const saved = readWorkJournal(await orca.storage.get(WORK_JOURNAL_KEY))
      saved[id] = readWorkMemory(change(readWorkMemory(saved[id])))
      await orca.storage.set(WORK_JOURNAL_KEY, saved)
      journal = saved
      renderBody()
      detail.update()
    } catch (error) {
      toast(t('작업 기억을 저장하지 못했어요. 다시 시도해 주세요.'), 'err')
      throw error
    }
  })
  memoryWrites = write
  return write
}

function editBrief(w: WorkspaceView): void {
  const memory = readWorkMemory(journal[w.id])
  const field = (key: 'goal' | 'doneWhen' | 'nextStep' | 'note', label: string, placeholder: string, rows: number) => {
    const area = h('textarea', { rows, maxlength: WORK_MEMORY_LIMITS[key], placeholder }) as HTMLTextAreaElement
    area.value = memory[key]
    return { area, el: h('label', { class: 'field' }, h('span', null, label), area) }
  }
  const goal = field('goal', t('목표'), t('이 작업으로 무엇을 이루려 하나요?'), 2)
  const doneWhen = field('doneWhen', t('완료 조건'), t('끝내기 전에 무엇을 확인해야 하나요?'), 2)
  const nextStep = field('nextStep', t('다음 행동'), t('다음에 돌아오면 무엇부터 하면 되나요?'), 2)
  const note = field('note', t('기억할 것'), t('중요한 결정과 이유, 잊지 말아야 할 제약'), 3)
  openSheet({
    title: t('작업 맥락'), sub: w.name,
    body: [goal.el, doneWhen.el, nextStep.el, note.el, h('p', { class: 'muted' }, t('Pod에 저장해 두고 세션이 바뀌어도 이어서 볼 수 있어요'))],
    submitLabel: t('저장'), submitIcon: 'check',
    onSubmit: async () => {
      await saveMemory(w.id, current => ({ ...current, goal: goal.area.value, doneWhen: doneWhen.area.value, nextStep: nextStep.area.value, note: note.area.value, updatedAt: Date.now() }))
      toast(t('작업 기억을 저장했어요'))
    }
  })
}

/* ---------- 워커 호출 ---------- */

async function call<T = any>(name: string, input?: unknown, quiet = false): Promise<T> {
  try {
    return await orca.plugin.request(name, input, { timeoutMs: 120_000 })
  } catch (e: any) {
    if (!quiet) toast(e?.message ? tt(clip(String(e.message), 120)) : t('요청이 실패했습니다'), 'err')
    throw e
  }
}

let lastSig = ''

/** 워커가 한국어로 채운 기본 이름(이름 없는 세션·폴더)을 현재 언어로 바꾼다. 영어 설정일 때만 건드린다. */
function localizeSnapshot(snap: Snapshot): void {
  if (currentLang() !== 'en') return
  for (const w of Object.values(snap.workspaces)) {
    for (const a of w.agents) a.title = tt(a.title)
  }
  for (const r of snap.repos) r.name = tt(r.name)
  for (const w of Object.values(snap.workspaces)) w.repo = tt(w.repo)
}

function receive(snap: Snapshot): void {
  // 완료로 바뀐 워크스페이스는 보드에서 축하한다(그래프는 카드가 직접 축하한다).
  const prevSnap = state.snap
  if (prevSnap && state.view !== 'graph') {
    for (const w of Object.values(snap.workspaces)) {
      const was = prevSnap.workspaces[w.id]?.status
      if (!was || was === 'completed' || w.status !== 'completed') continue
      const el = document.querySelector(`[data-hk="ws:${CSS.escape(w.id)}"]`)
      const r = el?.getBoundingClientRect()
      const x = r && r.width ? r.left + r.width / 2 : window.innerWidth / 2
      const y = r && r.width ? r.top + r.height / 2 : 160
      celebrate(x, y)
      floatText(x, y, t('완료!'), 'var(--s-completed)')
    }
  }
  localizeSnapshot(snap)
  state.snap = snap
  // 보드에서 행을 끄는 중이면 다시 그리지 않는다(놓으면 새로 읽는다).
  if (document.body.classList.contains('row-dragging')) return
  if (state.repo === undefined) state.repo = snap.repos[0]?.id ?? null
  else if (state.repo && !snap.repos.some((r) => r.id === state.repo)) state.repo = null
  if (state.topicScope && !collectTopicScopes(snap, () => true).some(scope => scope.key === state.topicScope)) state.topicScope = null
  state.error = null
  state.lastSync = Date.now()
  const sig = JSON.stringify({ ...snap, at: 0 })
  renderTop()
  controller.update()
  if (sig !== lastSig) {
    lastSig = sig
    renderBody()
    refreshHover()
    detail.update()
  }
}

async function sync(fresh = false): Promise<void> {
  if (state.syncing) return
  state.syncing = true
  refreshBtn.classList.add('spin')
  try {
    receive(await call<Snapshot>('pod.snapshot', { fresh }, true))
  } catch (e: any) {
    state.error = e?.message ?? t('불러오지 못했습니다')
    renderTop()
    if (!state.snap) renderBody()
  } finally {
    state.syncing = false
    refreshBtn.classList.remove('spin')
  }
}

/* ---------- 조작 ---------- */

const ws = (id: string) => state.snap?.workspaces[id]

function openWorkspace(w: WorkspaceView): void {
  void call('pod.openWorkspace', { id: w.id }).then(() => toast(t(`{n} 열림`, { n: clip(w.name, 28) })))
}

function focusAgent(w: WorkspaceView, a: AgentView): void {
  void call('pod.focusAgent', { id: w.id, agentKey: a.key }).then(() => toast(t(`{n}(으)로 이동`, { n: clip(a.title, 28) })))
}

const armed = new Map<string, number>()

/** 중단은 실수로 누르기 쉬워서 2초 안에 한 번 더 눌러야 실행한다. */
function interrupt(btn: HTMLElement, a: AgentView): void {
  if (!a.terminal) return
  const key = a.key
  if (armed.has(key)) {
    clearTimeout(armed.get(key))
    armed.delete(key)
    void call('pod.interrupt', { terminal: a.terminal }).then(() => toast(t('중단 신호를 보냈습니다')))
    return
  }
  const label = btn.lastChild
  const prev = label?.textContent ?? ''
  if (label) label.textContent = t('한 번 더')
  btn.classList.add('danger')
  armed.set(
    key,
    window.setTimeout(() => {
      armed.delete(key)
      if (label) label.textContent = prev
    }, 2000)
  )
}

function setStatus(w: WorkspaceView, status: string): void {
  if (w.status === status) return
  void call('pod.setStatus', { id: w.id, status }).then(() => toast(`${clip(w.name, 24)} → ${statusLabel(status)}`))
}

function editComment(w: WorkspaceView): void {
  const area = h('textarea', { rows: 3, placeholder: t('메모') }) as HTMLTextAreaElement
  area.value = w.comment
  openSheet({
    title: t('메모 편집'),
    sub: w.name,
    body: [h('label', { class: 'field' }, area)],
    submitLabel: t('저장'),
    submitIcon: 'check',
    onSubmit: async () => {
      await call('pod.setComment', { id: w.id, comment: area.value.trim() })
      toast(t('메모를 저장했습니다'))
    }
  })
}

function launchAgent(w: WorkspaceView, initial = 'claude'): void {
  const choice = agentChoice(initial, call)
  const area = h('textarea', { rows: 4, placeholder: t('첫 지시 (비워 두면 빈 세션)') }) as HTMLTextAreaElement
  openSheet({
    title: t('에이전트 시작'),
    sub: w.name,
    body: [choice.el, h('label', { class: 'field' }, h('span', null, t('지시')), area)],
    submitLabel: t('시작'),
    submitIcon: 'bot',
    onSubmit: async () => {
      await call('pod.launchAgent', { id: w.id, agent: choice.value(), prompt: area.value.trim() || undefined })
      toast(t(`{n} 시작`, { n: agentName(choice.value()) }))
    }
  })
}

function createWorkspace(repo: RepoView, parent?: WorkspaceView, topicId?: string | null, from?: Element | null): void {
  const name = h('input', { placeholder: t('예: 결제-오류-수정') }) as HTMLInputElement
  const choice = agentChoice('claude', call)
  let withAgent = true
  const sw = h('span', { class: 'switch on' })
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'toggle-row',
      onClick: () => {
        withAgent = !withAgent
        sw.classList.toggle('on', withAgent)
        agentBlock.style.display = withAgent ? '' : 'none'
      }
    },
    sw,
    t('에이전트와 함께 시작')
  )
  const area = h('textarea', { rows: 3, placeholder: t('첫 지시') }) as HTMLTextAreaElement
  const agentBlock = h('div', null, choice.el, h('label', { class: 'field' }, h('span', null, t('지시')), area))
  openSheet({
    title: parent ? t('하위 워크스페이스 만들기') : t('새 워크스페이스'),
    sub: [repo.name, parent ? t(`{name} 아래`, { name: parent.name }) : null, topicId ? repo.topics.find((t) => t.id === topicId)?.name : null].filter(Boolean).join(' · '),
    body: [h('label', { class: 'field' }, h('span', null, t('이름')), name), h('div', { style: { marginTop: '10px' } }, toggle), agentBlock],
    submitLabel: t('만들기'),
    submitIcon: 'plus',
    canSubmit: () => name.value.trim().length > 0,
    onSubmit: async () => {
      const r = await call<{ id: string | null }>('pod.createWorkspace', {
        repoId: repo.id,
        name: name.value.trim(),
        parentId: parent?.id,
        topicId: topicId ?? undefined,
        agent: withAgent ? choice.value() : undefined,
        prompt: withAgent ? area.value.trim() || undefined : undefined
      })
      toast(t(`{n} 만들었습니다`, { n: name.value.trim() }))
      // 새로 만든 워크스페이스를 바로 작업실로 연다.
      if (r.id) {
        await sync(true)
        if (state.snap?.workspaces[r.id]) detail.open(r.id, undefined, from?.isConnected ? from : null, { host: detailHost() })
      }
    }
  })
}

/** 그래프 화면이면 작업실을 그래프 안 창으로 띄운다. */
const detailHost = () => (state.view === 'graph' ? stage : null)

/** 자주 쓰는 세션은 바로 추가하고 다른 공급자는 선택창에서 고른다. */
function sessionMenu(anchor: Element | null, w: WorkspaceView): void {
  const go = (kind: 'claude' | 'codex' | 'terminal') => () => detail.openWithSession(w.id, kind, anchor, { host: detailHost() })
  const items: MenuItem[] = [
    { section: t('새 세션') },
    { label: 'Claude', icon: 'bot', hint: t('에이전트'), onSelect: go('claude') },
    { label: 'Codex', icon: 'bot', hint: t('에이전트'), onSelect: go('codex') },
    { label: t('다른 에이전트 선택…'), icon: 'agents', onSelect: () => launchAgent(w) },
    { label: t('터미널'), icon: 'terminal', hint: t('셸'), onSelect: go('terminal') }
  ]
  if (anchor?.isConnected) openMenu(anchor, items)
  else openMenu({ x: window.innerWidth / 2 - 100, y: 160 }, items)
}

function addSection(repo: RepoView, parentId?: string): void {
  const parent = parentId ? repo.topics.find((t) => t.id === parentId) : undefined
  const name = h('input', { placeholder: parent ? t('예: 상품 관리') : t('예: 결제') }) as HTMLInputElement
  const keywords = h('input', { placeholder: t('쉼표로 구분, 예: 결제, payment') }) as HTMLInputElement
  openSheet({
    title: parent ? t('새 하위 주제') : t('새 주제'),
    sub: parent ? `${repo.name} › ${topicPath(repo.topics, parent.id)}` : repo.name,
    body: [h('label', { class: 'field' }, h('span', null, t('이름')), name), h('label', { class: 'field' }, h('span', null, t('분류 키워드')), keywords)],
    submitLabel: t('추가'),
    submitIcon: 'plus',
    canSubmit: () => name.value.trim().length > 0,
    onSubmit: async () => {
      const topics = [
        ...repo.topics,
        { name: name.value.trim(), keywords: keywords.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean), parent: parent?.id }
      ]
      await call('pod.saveTopics', { repoId: repo.id, topics })
      state.groupBy = 'topic'
      savePrefs()
      toast(t(`{n} 주제를 만들었습니다`, { n: name.value.trim() }))
      void sync(true)
    }
  })
}

function openPR(w: WorkspaceView): void {
  if (!w.pr?.url) return
  void Promise.resolve(orca.shell.openExternal(w.pr.url)).catch(() => toast(t('링크를 열지 못했습니다'), 'err'))
}

function statusGrid(w: WorkspaceView): HTMLElement {
  const statuses = [...new Set([...(state.snap?.statuses ?? []), 'todo', 'in-progress', 'in-review', 'completed'])]
  return h(
    'div',
    { class: 'status-grid' },
    statuses.map((st) =>
      h(
        'button',
        {
          class: `status-opt${st === w.status ? ' on' : ''}`,
          style: { '--c': statusColor(st) },
          onClick: () => {
            closeMenu()
            setStatus(w, st)
          }
        },
        h('i'),
        statusLabel(st)
      )
    )
  )
}

function topicGrid(w: WorkspaceView, topics: Topic[]): HTMLElement {
  const opt = (id: string | null, name: string) =>
    h(
      'button',
      {
        class: `status-opt${(w.topic ?? null) === id && (id !== null || !w.topic) ? ' on' : ''}`,
        style: { '--c': id ? topicColor(id) : 'var(--muted)' },
        onClick: () => {
          closeMenu()
          void call('pod.assignTopic', { repoId: w.repoId, id: w.id, topicId: id }).then(() => toast(`${clip(w.name, 20)} → ${name}`))
        }
      },
      h('i'),
      name
    )
  return h('div', { class: 'status-grid' }, topics.map((t) => opt(t.id, topicPath(topics, t.id))), opt(null, t('자동')))
}

function statusMenu(at: Element, w: WorkspaceView): void {
  openMenu(at, [{ section: t('상태') }, { custom: statusGrid(w) }])
}

function workspaceMenu(at: { x: number; y: number } | Element, w: WorkspaceView, owner?: Element): void {
  const repo = state.snap?.repos.find((r) => r.id === w.repoId)
  const grid = statusGrid(w)
  const items: MenuItem[] = [
    { label: t('작업 맥락'), icon: 'book', onSelect: () => detail.open(w.id, undefined, owner ?? null, { host: detailHost(), overview: true }) },
    { label: t('작업실'), icon: 'terminal', onSelect: () => detail.open(w.id, undefined, owner ?? null, { host: detailHost() }) },
    { label: t('세션 추가'), icon: 'plus', onSelect: () => sessionMenu(owner ?? (at instanceof Element ? at : null), w) },
    { label: t('Orca에서 열기'), icon: 'open', onSelect: () => openWorkspace(w) },
    { label: t('Claude 시작'), icon: 'bot', onSelect: () => launchAgent(w, 'claude') },
    { label: t('Codex 시작'), icon: 'bot', onSelect: () => launchAgent(w, 'codex') },
    ...(repo ? [{ label: t('하위 워크스페이스'), icon: 'sub', onSelect: () => createWorkspace(repo, w) }] : []),
    { label: t('관제에 보내기'), icon: 'sparkle', onSelect: () => controller.insert(w) },
    { label: t('메모 편집'), icon: 'edit', onSelect: () => editComment(w) },
    ...(w.unread ? [{ label: t('읽음으로 표시'), icon: 'eye', onSelect: () => void call('pod.markRead', { id: w.id }) }] : []),
    ...(w.pr?.url ? [{ label: t(`PR #{number} 열기`, { number: w.pr.number }), icon: 'pr', onSelect: () => openPR(w) }] : []),
    'sep',
    { section: t('상태') },
    { custom: grid },
    ...(repo && repo.topics.length ? (['sep', { section: t('주제') }, { custom: topicGrid(w, repo.topics) }] as MenuItem[]) : [])
  ]
  openMenu(at, items, owner)
}

/* ---------- 호버 카드 내용 ---------- */

const tails = new Map<string, { at: number; lines: string[] | null }>()

function tailBlock(terminal: string): HTMLElement {
  const pre = h('pre', { class: 'tail loading' }, t('터미널 불러오는 중…'))
  const cached = tails.get(terminal)
  const setTail = (lines: string[] | null) => {
    if (!lines || lines.length === 0) {
      pre.textContent = t('출력 없음')
      return
    }
    pre.classList.remove('loading')
    pre.textContent = lines.join('\n')
  }
  if (cached && Date.now() - cached.at < 4000) {
    setTail(cached.lines)
  } else {
    tails.set(terminal, { at: Date.now(), lines: cached?.lines ?? null })
    if (cached?.lines) setTail(cached.lines)
    void call<{ lines: string[] }>('pod.tail', { terminal }, true)
      .then((r) => {
        tails.set(terminal, { at: Date.now(), lines: r.lines })
        setTail(r.lines)
      })
      .catch(() => {
        pre.textContent = t('터미널을 읽지 못했습니다')
      })
  }
  return pre
}

function waitingQuestion(w: WorkspaceView, a: AgentView): HTMLElement {
  const box = h('div', { class: 'hc-question' })
  const known = a.tool?.name === 'AskUserQuestion' ? readQuestions(a.tool.input) : []
  const open = () => { hideHover(); focusAgent(w, a) }
  if (known.length) { box.append(questionCard(known, open)); return box }
  box.append(h('div', { class: 'v' }, t('질문을 확인하는 중…')))
  void call<{ items: ChatItem[] }>('pod.conversation', { path: w.path, key: a.key, type: a.type, title: a.title, prompt: a.prompt, since: a.since, others: w.agents.filter(other => other.key !== a.key).map(other => other.key) }, true)
    .then(r => pendingQuestions(r.items ?? []))
    .catch(() => [])
    .then(questions => box.replaceChildren(questions.length ? questionCard(questions, open) : h('div', null,
      h('div', { class: 'k' }, t('답변을 기다리는 질문')),
      a.terminal ? tailBlock(a.terminal) : h('div', { class: 'v' }, t('질문 내용을 가져오지 못했어요. Orca에서 이 세션을 열어 확인하세요')),
      h('button', { class: 'pill-btn primary sq-open', onClick: open }, icon('open'), t('Orca에서 답변하기'))
    )))
  return box
}

function agentCard(wsId: string, key: string): HTMLElement | null {
  const w = ws(wsId)
  const a = w?.agents.find((x) => x.key === key)
  if (!w || !a) return null
  const rows: HTMLElement[] = []
  if (a.state === 'waiting') rows.push(h('div', { class: 'hc-row' }, waitingQuestion(w, a)))
  if (a.prompt) rows.push(h('div', { class: 'hc-row' }, h('div', { class: 'k' }, t('마지막 요청')), h('div', { class: 'v' }, clip(a.prompt, 400))))
  if (a.tool && (a.state === 'working' || a.state === 'blocked'))
    rows.push(
      h(
        'div',
        { class: 'hc-row' },
        h('div', { class: 'k' }, a.state === 'blocked' ? t('승인을 기다리는 도구') : t('지금 하는 일')),
        h('div', { class: 'tool' }, h('b', null, a.tool.name), h('code', null, clip(a.tool.input, 240)))
      )
    )
  if (a.lastMessage)
    rows.push(h('div', { class: 'hc-row' }, h('div', { class: 'k' }, t('마지막 답변')), h('div', { class: 'v' }, clip(a.lastMessage, 500))))
  if (a.terminal && a.state === 'blocked') rows.push(h('div', { class: 'hc-row' }, h('div', { class: 'k' }, t('승인을 기다리고 있어요')), tailBlock(a.terminal)))
  const meta: HTMLElement[] = []
  if (a.subagents > 0) meta.push(h('span', null, icon('agents'), t(`하위 에이전트 {subagents}`, { subagents: a.subagents })))
  meta.push(h('span', null, icon(a.surface === 'chat' ? 'message' : 'terminal'), a.surface === 'chat' ? t('대화창') : t('터미널')))
  if (a.interrupted) meta.push(h('span', null, icon('stop'), t('중단됨')))
  rows.push(h('div', { class: 'hc-meta' }, meta))

  const actions: HTMLElement[] = [
    h('button', { class: 'pill-btn primary', onClick: (ev: Event) => detail.open(w.id, a.key, ev.currentTarget as Element, { host: detailHost() }) }, icon('terminal'), t('작업실')),
    h('button', { class: 'pill-btn', onClick: () => focusAgent(w, a) }, icon('open'), 'Orca'),
    h('button', { class: 'pill-btn', onClick: () => sendToControl(w, a) }, icon('sparkle'), t('관제에 보내기'))
  ]
  if (a.terminal && a.state !== 'done') {
    if (a.state === 'working') {
      const stop = h('button', { class: 'pill-btn danger' }, icon('stop'), h('span', null, t('중단')))
      stop.addEventListener('click', () => interrupt(stop, a))
      actions.push(stop)
    }
  }

  return h(
    'div',
    null,
    h(
      'div',
      { class: 'hc-head' },
      avatar(a, 'lg'),
      h(
        'div',
        { style: { minWidth: '0' } },
        h(
          'div',
          { class: 'hc-kicker' },
          h('span', { class: 'state-pill', 'data-state': a.state }, h('i'), AGENT_STATE_LABEL[a.state]),
          agentName(a.type),
          a.since && a.state !== 'done' ? h('span', { 'data-dur': a.since }, t(`· {n}째`, { n: duration(a.since) })) : null
        ),
        h('div', { class: 'hc-title' }, a.title),
        h('div', { class: 'hc-sub' }, `${w.repo} · ${w.name}`)
      )
    ),
    h('div', { class: 'hc-rows' }, rows),
    h('div', { class: 'hc-actions' }, actions)
  )
}

const PR_STATE: Record<string, string> = { open: t('열림'), merged: t('머지됨'), closed: t('닫힘'), draft: t('초안') }
const CHECKS: Record<string, string> = { success: t('체크 통과'), failure: t('체크 실패'), pending: t('체크 진행 중'), neutral: t('체크 중립') }

/* ---------- 열린 탭 ---------- */

const TAB_ORDER = (w: WorkspaceView, t: TerminalRef) => (!t.connected ? 3 : t.kind === 'agent' ? 0 : t.kind === 'shell' ? 1 : 2)

function tabIcon(t: TerminalRef): HTMLElement {
  if (t.kind === 'agent') return h('span', { class: 'tb-glyph', 'data-type': t.agentType ?? '' }, agentGlyph(t.agentType ?? 'agent'))
  return h('span', { class: `tb-ic ${t.kind}` }, icon(t.kind === 'setup' ? 'gear' : 'terminal'))
}

function tabState(w: WorkspaceView, tab: TerminalRef): { label: string; cls: string } {
  if (!tab.connected) return { label: t('끝남'), cls: 'dead' }
  const a = w.agents.find((x) => x.terminal === tab.handle)
  if (a) return { label: AGENT_STATE_LABEL[a.state], cls: a.state }
  return { label: tab.kind === 'setup' ? t('설정 중') : t('실행 중'), cls: 'live' }
}

/** 탭을 닫는다. 닫히는 줄은 접히며 사라지고 조각이 흩어진다. */
async function closeTabs(w: WorkspaceView | null, handles: string[], els: Element[] = []): Promise<void> {
  if (!handles.length) return
  for (const el of els) {
    burstAt(el, 'var(--muted)', 8, 0.6)
    ;(el as HTMLElement).animate?.([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(24px) scale(0.96)' }], { duration: 220, fill: 'forwards' })
  }
  try {
    const r = await call<{ closed: number; failed: string[] }>('pod.closeTerminals', { terminals: handles })
    toast(r.failed.length ? t(`탭 {closed}개를 닫았고 {n}개는 못 닫았습니다`, { closed: r.closed, n: r.failed.length }) : t(`탭 {closed}개를 닫았습니다`, { closed: r.closed }), r.failed.length ? 'err' : 'ok')
  } finally {
    void sync(true)
    refreshHover()
  }
  void w
}

/** 세션 참조를 관제 입력창에 넣는다. 호버 카드는 닫는다. */
function sendToControl(w: WorkspaceView, a: AgentView): void {
  hideHover()
  controller.insert(w, a)
}

/** 세션 목록 줄의 「관제에 넣기」 버튼(셸에는 보낼 수 없어 에이전트 세션에만). */
function refButton(w: WorkspaceView, a: AgentView): HTMLElement {
  return h(
    'button',
    {
      class: 'tb-ref',
      title: t('관제 입력창에 넣기'),
      onClick: (ev: Event) => {
        ev.stopPropagation()
        sendToControl(w, a)
      }
    },
    icon('sparkle')
  )
}

/** 대화창(채팅) 세션 중 아직 열려 있는 것. 터미널이 없어 닫을 수는 없다. */
const chatSessions = (w: WorkspaceView) => w.agents.filter((a) => a.surface === 'chat' && a.state !== 'done')

/** 워크스페이스의 세션 목록: 대화창 세션과 열린 터미널 탭. 줄을 누르면 열고, ×로 탭을 닫는다(살아 있는 탭은 두 번). */
function tabsBlock(w: WorkspaceView): HTMLElement | null {
  const chats = chatSessions(w)
  if (!w.terminals.length && !chats.length) return null
  const list = [...w.terminals].sort((a, b) => TAB_ORDER(w, a) - TAB_ORDER(w, b))
  const dead = list.filter((t) => !t.connected)
  const chatRows = chats.map((a) => {
    const row = h(
      'div',
      { class: 'tb-row chat', title: a.lastMessage ? clip(a.lastMessage, 200) : a.title },
      h('span', { class: 'tb-glyph chat', 'data-type': a.type }, agentGlyph(a.type)),
      h('span', { class: 'tb-title' }, a.title),
      h('span', { class: 'tb-kind' }, t('대화창')),
      h('span', { class: `tb-state ${a.state}` }, AGENT_STATE_LABEL[a.state]),
      refButton(w, a)
    )
    row.addEventListener('click', () => controller.select(w, a))
    return row
  })
  const agentOf = (tb: (typeof list)[number]) => (tb.connected ? w.agents.find((ag) => ag.terminal === tb.handle && ag.state !== 'done') : undefined)
  const rows = list.map((tb) => {
    const st = tabState(w, tb)
    const x = h('button', { class: 'tb-x', title: tb.connected ? t('닫기 (두 번 누르기)') : t('닫기') }, icon('x'))
    const row = h(
      'div',
      { class: `tb-row${tb.connected ? '' : ' dead'}`, title: tb.lastLine || tb.title },
      tabIcon(tb),
      h('span', { class: 'tb-title' }, tb.title || t('터미널')),
      h('span', { class: 'tb-kind' }, tb.kind === 'setup' ? t('초기 설정') : tb.kind === 'agent' ? t('터미널') : t('셸')),
      h('span', { class: `tb-state ${st.cls}` }, st.label),
      agentOf(tb) ? refButton(w, agentOf(tb)!) : null,
      x
    )
    row.addEventListener('click', () => {
      const a = w.agents.find((ag) => ag.terminal === tb.handle)
      detail.open(w.id, a ? a.key : `tb:${tb.handle}`, row, { host: detailHost() })
    })
    let armed = 0
    x.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (tb.connected && !armed) {
        x.classList.add('armed')
        armed = window.setTimeout(() => {
          armed = 0
          x.classList.remove('armed')
        }, 2000)
        return
      }
      window.clearTimeout(armed)
      void closeTabs(w, [tb.handle], [row])
    })
    return row
  })
  const sweep = dead.length
    ? h(
        'button',
        {
          class: 'tb-sweep',
          onClick: (ev: Event) => {
            ev.stopPropagation()
            void closeTabs(
              w,
              dead.map((t) => t.handle),
              rows.filter((r) => r.classList.contains('dead'))
            )
          }
        },
        icon('broom'),
        t(`끝난 탭 {n}개 닫기`, { n: dead.length })
      )
    : null
  return h('div', { class: 'tb' }, chatRows, rows, sweep)
}

/** 그래프 카드의 탭 줄에 올렸을 때: 탭 목록만. */
function tabsCard(wsId: string): HTMLElement | null {
  const w = ws(wsId)
  if (!w) return null
  return h('div', null, h('div', { class: 'hc-kicker' }, t(`세션 {n}`, { n: w.terminals.length + chatSessions(w).length })), h('div', { class: 'hc-title' }, w.name), tabsBlock(w))
}

function workspaceCard(wsId: string): HTMLElement | null {
  const w = ws(wsId)
  if (!w) return null
  const rows: HTMLElement[] = []
  if (w.pr)
    rows.push(
      h(
        'div',
        { class: 'hc-row' },
        h('div', { class: 'k' }, [`PR #${w.pr.number}`, PR_STATE[w.pr.state], w.pr.checks ? CHECKS[w.pr.checks] ?? w.pr.checks : null].filter(Boolean).join(' · ')),
        w.pr.title ? h('div', { class: 'v' }, w.pr.title) : null
      )
    )
  if (w.comment) rows.push(h('div', { class: 'hc-row' }, h('div', { class: 'k' }, t('메모')), h('div', { class: 'v' }, w.comment)))
  const shown = w.agents.filter((a) => a.state !== 'done').concat(w.agents.filter((a) => a.state === 'done').slice(0, 3))
  if (shown.length)
    rows.push(
      h(
        'div',
        { class: 'hc-row' },
        h('div', { class: 'k' }, t(`에이전트 {n}`, { n: w.agents.length })),
        h(
          'div',
          { class: 'hc-agents' },
          shown.map((a) =>
            h(
              'div',
              { class: 'hc-agent', onClick: (ev: Event) => detail.open(w.id, a.key, ev.currentTarget as Element, { host: detailHost() }) },
              avatar(a, 'sm'),
              h('span', null, a.title),
              h('em', null, AGENT_STATE_LABEL[a.state])
            )
          )
        )
      )
    )
  const tabs = tabsBlock(w)
  if (tabs) rows.push(h('div', { class: 'hc-row' }, h('div', { class: 'k' }, t(`세션 {n}`, { n: w.terminals.length + chatSessions(w).length })), tabs))
  const parent = w.parentId ? ws(w.parentId) : null
  rows.push(
    h(
      'div',
      { class: 'hc-meta' },
      h('span', null, icon('terminal'), t(`터미널 {liveTerminals}`, { liveTerminals: w.liveTerminals })),
      w.lastActivityAt ? h('span', null, t(`마지막 활동 {when}`, { when: agoFull(w.lastActivityAt) })) : null,
      parent ? h('span', null, icon('sub'), parent.name) : null
    ),
    h('div', { class: 'hc-path' }, w.path)
  )
  return h(
    'div',
    null,
    h(
      'div',
      { style: { minWidth: '0' } },
      h(
        'div',
        { class: 'hc-kicker' },
        h('span', { class: 'state-pill', style: { '--c': statusColor(w.status) } }, h('i'), statusLabel(w.status)),
        w.repo
      ),
      h('div', { class: 'hc-title' }, w.name),
      w.branch ? h('div', { class: 'hc-sub', style: { fontFamily: 'var(--mono)', fontSize: '10.5px' } }, w.branch) : null
    ),
    h('div', { class: 'hc-rows' }, rows),
    h(
      'div',
      { class: 'hc-actions' },
      h('button', { class: 'pill-btn primary', onClick: (ev: Event) => detail.open(w.id, undefined, ev.currentTarget as Element, { host: detailHost() }) }, icon('terminal'), t('작업실')),
      h('button', { class: 'pill-btn', onClick: () => openWorkspace(w) }, icon('open'), 'Orca'),
      h('button', { class: 'pill-btn', onClick: (ev: Event) => workspaceMenu(ev.currentTarget as Element, w) }, icon('more'), t('더보기'))
    )
  )
}

/* ---------- 필터 ---------- */

const scopedRepo = () => state.scopeMode === 'repo' ? state.repo ?? null : null
const graphScope = () => state.scopeMode === 'topic' ? `@topic:${state.topicScope ?? '*'}` : state.repo ?? null
const inScope = (w: WorkspaceView) => state.scopeMode === 'topic'
  ? !!state.snap && topicScopeIncludes(state.snap, w, state.topicScope)
  : !state.repo || w.repoId === state.repo

const ACTIVE = new Set(['working', 'blocked', 'waiting'])

/** 숨긴 상태여도 에이전트가 작업 중이거나 확인을 기다리면 보인다. 검색 중에는 숨긴 상태도 찾는다. */
function shown(w: WorkspaceView): boolean {
  if (!state.hidden.has(w.status)) return true
  if (state.query.trim()) return true
  return w.agents.some((a) => ACTIVE.has(a.state))
}

function matches(w: WorkspaceView): boolean {
  if (!inScope(w)) return false
  if (!shown(w)) return false
  if(state.priorityLevel&&priorityOf(w)?.level!==state.priorityLevel)return false
  const f = state.filter
  if (f === 'working' && !w.agents.some((a) => a.state === 'working')) return false
  if (f === 'attention' && !w.agents.some((a) => a.state === 'blocked' || a.state === 'waiting')) return false
  if ((f === 'in-progress' || f === 'in-review') && w.status !== f) return false
  const q = state.query.trim().toLowerCase()
  if (!q) return true
  const memory = journal[w.id]
  const hay = [w.name, w.branch, w.repo, w.comment, memory?.goal ?? '', memory?.doneWhen ?? '', memory?.nextStep ?? '', memory?.note ?? '', w.pr ? `#${w.pr.number} ${w.pr.title}` : '', ...w.agents.map((a) => a.title)]
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((t) => hay.includes(t))
}

const narrowing = () => state.filter !== null || state.query.trim() !== '' || state.scopeMode === 'topic' && state.topicScope !== null

/* ---------- 상단 ---------- */

const refreshBtn = h('button', { class: 'icon-btn', title: t('새로고침'), onClick: () => void sync(true) }, icon('refresh'))
const langBtn = h('button', { class: 'pill-btn', title: t('언어'), onClick: () => langMenu() }, t('언어'), ' · ', langPref() === 'auto' ? `${t('자동')} (${currentLang().toUpperCase()})` : currentLang().toUpperCase())
const syncEl = h('span', { class: 'sync' }, h('span', { class: 'dot' }), h('span', { class: 'txt' }, t('연결 중')))
const viewSeg = h('div', { class: 'seg', role: 'tablist' })
const searchInput = h('input', {
  placeholder: t('검색'),
  onInput: (ev: Event) => {
    state.query = (ev.target as HTMLInputElement).value
    renderBody()
  }
}) as HTMLInputElement
const repoBar = h('div', { class: 'repo-bar', role: 'tablist' })
const scopeKind = h('div', {class:'seg sm scope-kind',role:'tablist','aria-label':t('범위 기준')})
const topicChildren = h('div', {class:'repo-bar topic-children',role:'tablist',hidden:true})
const topicManage = h('button',{class:'pill-btn scope-topic-menu',title:t('주제 관리'),'aria-haspopup':'menu','aria-expanded':'false',onClick:()=>{
  const snap=state.snap
  if (!snap) return
  const selected=state.scopeMode==='topic' && state.topicScope ? collectTopicScopes(snap,()=>true).find(scope=>scope.key===state.topicScope)?.repoIds : null
  const repos=scopedRepo()?snap.repos.filter(repo=>repo.id===scopedRepo()):selected?snap.repos.filter(repo=>selected.includes(repo.id)):snap.repos
  const actions=(repo:RepoView)=>openMenu(topicManage,[
    {section:repo.name},
    {label:t('자동 분류 제안'),icon:'sparkle',disabled:!controller.canOrganize(),onSelect:()=>extractTopics(repo)},
    {label:t('주제 편집'),icon:'edit',onSelect:()=>editTopics(repo)}
  ],topicManage,{keyboard:true})
  if (repos.length===1) actions(repos[0])
  else openMenu(topicManage,repos.map(repo=>({label:repo.name,icon:'folder',onSelect:()=>actions(repo)})),topicManage,{keyboard:true})
}},icon('tag'),t('주제 관리'),icon('chevron'))
const priorityFilter=h('button',{class:'pill-btn priority-filter','aria-label':t('중요도 필터'),onClick:()=>openMenu(priorityFilter,[{label:t('전체 중요도'),checked:!state.priorityLevel,onSelect:()=>{state.priorityLevel=null;void savePrefs();renderTop();renderBody()}},...(['P0','P1','P2'] as const).map(level=>({label:level,checked:state.priorityLevel===level,onSelect:()=>{state.priorityLevel=level;void savePrefs();renderTop();renderBody()}}))],priorityFilter,{keyboard:true})},t('중요도'))
const scopeBar = h('div', {class:'scope-bar'},h('div',{class:'scope-main'},scopeKind,repoBar,priorityFilter,topicManage),topicChildren)
let repoBarSig = ''

function scopeChanged(): void {
  hideHover()
  closeMenu()
  graph.resetView()
  void savePrefs()
  renderTop()
  renderBody()
  body.scrollTop = 0
  repoBar.querySelector('.rchip.on')?.scrollIntoView({inline:'nearest',block:'nearest',behavior:'smooth'})
}

function selectScopeMode(mode:'repo'|'topic'): void {
  if (state.scopeMode === mode) return
  state.scopeMode = mode
  if (mode === 'topic') state.groupBy = 'topic'
  scopeChanged()
}

function selectTopicScope(key:string|null): void {
  if (state.topicScope === key) return
  state.topicScope = key
  scopeChanged()
}

function selectRepo(id: string | null): void {
  if (state.repo === id) return
  state.repo = id
  scopeChanged()
}

function cycleRepo(step: number): void {
  if (state.scopeMode === 'topic' && state.snap) {
    const roots=collectTopicScopes(state.snap,shown).filter(scope=>!scope.parent)
    const ids:(string|null)[]=[null,...roots.map(scope=>scope.key)]
    const selected=state.topicScope ? JSON.stringify(JSON.parse(state.topicScope).slice(0,1)) : null
    const index=ids.indexOf(selected)
    selectTopicScope(ids[(index+step+ids.length)%ids.length])
    return
  }
  const ids: (string | null)[] = [null, ...(state.snap?.repos.map((r) => r.id) ?? [])]
  const i = ids.indexOf(state.repo ?? null)
  selectRepo(ids[(i + step + ids.length) % ids.length])
}

/** 디렉토리 전환 칩. 내용이 같으면 다시 그리지 않아 가로 스크롤 위치가 유지된다. */
function renderRepoBar(): void {
  const snap = state.snap
  if (!snap) return
  const scopes=collectTopicScopes(snap,shown)
  const info = snap.repos.map((r) => {
    const list = r.workspaceIds.map((id) => snap.workspaces[id])
    const agents = list.flatMap((w) => w.agents)
    return {
      r,
      active: list.filter(shown).length,
      signal: agents.some((a) => a.state === 'blocked' || a.state === 'waiting')
        ? 'attention'
        : agents.some((a) => a.state === 'working')
          ? 'working'
          : ''
    }
  })
  const total = Object.values(snap.workspaces).filter(shown).length
  const sig = JSON.stringify([state.scopeMode,state.topicScope,scopes,state.repo, total, [...state.hidden], info.map((x) => [x.r.id, x.r.name, x.active, x.signal])])
  if (sig === repoBarSig) return
  repoBarSig = sig
  scopeKind.replaceChildren(...(['repo','topic'] as const).map(mode=>h('button',{
    class:state.scopeMode===mode?'on':'',role:'tab','aria-selected':String(state.scopeMode===mode),'data-scope-mode':mode,
    onClick:()=>selectScopeMode(mode)
  },mode==='repo'?t('레포'):t('주제'))))
  topicChildren.hidden = true
  if (state.scopeMode === 'topic') {
    const allScopes=collectTopicScopes(snap,()=>true)
    const selected=allScopes.find(scope=>scope.key===state.topicScope)
    const rootKey=selected ? JSON.stringify(JSON.parse(selected.key).slice(0,1)) : null
    const roots=scopes.filter(scope=>!scope.parent)
    if (rootKey && !roots.some(scope=>scope.key===rootKey)) {
      const root=allScopes.find(scope=>scope.key===rootKey)
      if (root) roots.push({...root,workspaceIds:[],signal:''})
    }
    const chip=(scope:TopicScope|null,label:string,count:number,active:boolean,onClick:()=>void)=>h('button',{
      class:`rchip${active?' on':''}`,role:'tab','aria-selected':String(active),'data-topic-scope':scope?.key ?? '',
      title:scope?scope.repoIds.map(id=>snap.repos.find(repo=>repo.id===id)?.name ?? id).join(' · '):t('전체 주제'),onClick
    },scope?h('i',{'data-signal':scope.signal}):icon('board'),h('span',{class:'rn'},label),h('span',{class:'rc'},count))
    repoBar.replaceChildren(chip(null,t('전체'),total,state.topicScope===null,()=>selectTopicScope(null)),
      ...roots.map(scope=>chip(scope,scope.name||t('기타'),scope.workspaceIds.length,scope.key===rootKey,()=>selectTopicScope(scope.key))))
    const children=scopes.filter(scope=>scope.parent===rootKey)
    if (selected?.parent && !children.some(scope=>scope.key===selected.key)) children.push({...selected,workspaceIds:[],signal:''})
    if (rootKey && children.length) {
      const root=roots.find(scope=>scope.key===rootKey)!
      topicChildren.hidden=false
      topicChildren.replaceChildren(h('span',{class:'scope-parent'},root.name),
        chip(root,t('전체'),root.workspaceIds.length,state.topicScope===rootKey,()=>selectTopicScope(rootKey)),
        ...children.map(scope=>chip(scope,scope.name,scope.workspaceIds.length,state.topicScope===scope.key,()=>selectTopicScope(scope.key))))
    }
    return
  }
  const chip = (id: string | null, label: string, count: number, signal: string, title: string) =>
    h(
      'button',
      { class: `rchip${(state.repo ?? null) === id ? ' on' : ''}`, role: 'tab', title, onClick: () => selectRepo(id) },
      id ? h('i', { 'data-signal': signal }) : icon('board'),
      h('span', { class: 'rn' }, label),
      h('span', { class: 'rc' }, count)
    )
  repoBar.replaceChildren(
    chip(null, t('전체'), total, '', t('모든 디렉토리')),
    ...info.map((x) => chip(x.r.id, x.r.name, x.active, x.signal, t(`{name} · 표시 {active} · 전체 {n}`, { name: x.r.name, active: x.active, n: x.r.workspaceIds.length })))
  )
}
const body = h('div', { class: 'body' })

function toggleStatus(st: string): void {
  if (state.hidden.has(st)) state.hidden.delete(st)
  else state.hidden.add(st)
  savePrefs()
  renderTop()
  renderBody()
}

const statusBtn = h('button', { class: 'filter-btn', title: t('보일 상태 고르기') })

function knownStatuses(): string[] {
  return [...new Set([...(state.snap?.statuses ?? []), 'todo', 'in-progress', 'in-review', 'long-running', 'on-hold', 'completed'])]
}

function renderStatusBtn(): void {
  const hiddenCount = knownStatuses().filter((st) => state.hidden.has(st)).length
  statusBtn.classList.toggle('active', hiddenCount > 0)
  fill(statusBtn, icon('filter'), t('상태'), hiddenCount ? h('span', { class: 'badge' }, t(`{hiddenCount} 숨김`, { hiddenCount })) : null)
}

function statusFilterMenu(): void {
  const panel = h('div', { class: 'status-filter' })
  const draw = () => {
    const snap = state.snap
    const scoped = snap ? Object.values(snap.workspaces).filter(inScope) : []
    panel.replaceChildren(
      ...knownStatuses().map((st) => {
        const n = scoped.filter((w) => w.status === st).length
        const on = !state.hidden.has(st)
        return h(
          'button',
          {
            class: `sf-row${on ? ' on' : ''}`,
            style: { '--c': statusColor(st) },
            onClick: () => {
              toggleStatus(st)
              draw()
            }
          },
          h('span', { class: 'box' }, on ? icon('check') : null),
          h('span', { class: 'nm' }, statusLabel(st)),
          h('span', { class: 'n' }, n)
        )
      }),
      h('div', { class: 'sep' }),
      h(
        'div',
        { class: 'sf-quick' },
        h(
          'button',
          {
            class: 'mini-btn',
            onClick: () => {
              state.hidden = new Set()
              savePrefs()
              renderTop()
              renderBody()
              draw()
            }
          },
          t('모두 보기')
        ),
        h(
          'button',
          {
            class: 'mini-btn',
            onClick: () => {
              state.hidden = new Set(['completed', 'on-hold'])
              savePrefs()
              renderTop()
              renderBody()
              draw()
            }
          },
          t('완료·보류 숨기기')
        )
      )
    )
  }
  draw()
  openMenu(statusBtn, [{ section: t('보일 상태') }, { custom: panel }])
}

statusBtn.addEventListener('click', statusFilterMenu)

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: t('대시보드'), icon: 'board' },
  { id: 'graph', label: t('그래프'), icon: 'graph' },
  { id: 'board', label: t('보드'), icon: 'board' },
  { id: 'agents', label: t('에이전트'), icon: 'agents' },
]

function setView(v: View): void {
  if (detail.isOpen()) {
    detail.dispose()
    graph.select(null)
  }
  state.view = v
  hideHover()
  closeMenu()
  savePrefs()
  renderTop()
  renderBody()
}

/** 언어 설정 메뉴. 고르면 저장한 뒤 그 언어로 화면을 다시 불러온다. */
function langMenu(): void {
  const cur = langPref()
  const item = (value: LangPref, label: string): MenuItem => ({
    label,
    icon: cur === value ? 'check' : undefined,
    onSelect: () => {
      if (cur === value) return
      setLangPref(value)
      void savePrefs().then(() => location.reload())
    }
  })
  openMenu(langBtn, [{ section: t('언어') }, item('auto', t('자동')), item('ko', '한국어'), item('en', 'English')], langBtn) // i18n-skip: 언어 이름은 번역하지 않는다
}

let viewSegmentKey=''
function renderTop(): void {
  const snap = state.snap
  const stale = state.lastSync && Date.now() - state.lastSync > 20_000
  syncEl.className = `sync${state.error ? ' err' : stale ? ' stale' : ''}`
  ;(syncEl.querySelector('.txt') as HTMLElement).textContent = state.error
    ? t('연결 끊김')
    : state.lastSync
      ? t(`실시간 · {n}`, { n: ago(state.lastSync) })
      : t('연결 중')

  const nextViewSegmentKey=state.view+'|'+progress.isHistory()+'|'+currentLang()
  if(nextViewSegmentKey!==viewSegmentKey){
  viewSeg.replaceChildren(
    ...VIEWS.map((v) =>
      h('button', { class: state.view === v.id ? 'on' : '',disabled:progress.isHistory()&&v.id!=='graph', role: 'tab', 'aria-selected': String(state.view === v.id), onClick: () => setView(v.id) }, icon(v.icon), v.label)
    )
  )
    viewSegmentKey=nextViewSegmentKey
  }

  renderRepoBar()
  renderStatusBtn()
  priorityFilter.replaceChildren(state.priorityLevel??t('중요도'))
  priorityFilter.toggleAttribute('disabled',progress.isHistory()||state.view==='dashboard'&&!!dashboard.history())
  topicManage.toggleAttribute('disabled',progress.isHistory()||state.view==='dashboard'&&!!dashboard.history())
  statusBtn.toggleAttribute('disabled',progress.isHistory()||state.view==='dashboard'&&!!dashboard.history())
}

/* ---------- 본문: 보드 ---------- */

/** 워크스페이스 행 아래 세션 줄: 무엇이 어떤 상태로 무엇을 하는지 바로 읽힌다. */
function sessionLines(w: WorkspaceView): HTMLElement | null {
  const live = w.agents.filter((a) => a.state !== 'done')
  if (!live.length) return null
  const shown = live.slice(0, 4)
  return h(
    'div',
    { class: 'ws-sessions' },
    shown.map((a) => {
      const doing =
        a.tool && (a.state === 'working' || a.state === 'blocked')
          ? `${a.tool.name} ${a.tool.input}`
          : a.state === 'waiting'
            ? a.lastMessage
            : ''
      const el = h(
        'div',
        { class: 'sess', 'data-state': a.state, title: `${agentName(a.type)} · ${a.title}` },
        avatar(a, 'sm'),
        h('span', { class: 't' }, a.title),
        h('span', { class: 'st' }, AGENT_STATE_LABEL[a.state]),
        a.since && a.state !== 'idle' ? h('span', { class: 'du', 'data-dur': a.since }, duration(a.since)) : null,
        doing ? h('code', null, clip(doing, 160)) : null
      )
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        controller.select(w, a)
      })
      hoverable(el, () => agentCard(w.id, a.key), 500, `sess:${a.key}`)
      return el
    }),
    live.length > shown.length ? h('div', { class: 'sess-more' }, t(`세션 {n}개 더`, { n: live.length - shown.length })) : null
  )
}


function prChip(w: WorkspaceView): HTMLElement | null {
  if (!w.pr) return null
  return h(
    'span',
    {
      class: 'pr',
      'data-state': w.pr.state,
      title: w.pr.title,
      onClick: (ev: Event) => {
        ev.stopPropagation()
        openPR(w)
      }
    },
    icon('pr'),
    w.pr.number,
    w.pr.checks ? h('span', { class: 'ck', 'data-checks': w.pr.checks }) : null
  )
}

function topicTag(w: WorkspaceView): HTMLElement | null {
  const t = state.snap?.repos.find((r) => r.id === w.repoId)?.topics.find((x) => x.id === w.topic)
  return t ? h('span', { class: 'topic-tag', style: { '--t': topicColor(t.id) } }, t.name) : null
}

function workspaceRow(w: WorkspaceView, opts: { child?: boolean; parentHint?: string; showTopic?: boolean } = {}): HTMLElement {
  const menuBtn = h('button', { class: 'menu-btn', title: t('메뉴') }, icon('more'))
  const row = h(
    'div',
    {
      class: `ws${opts.child ? ' child' : ''}${w.activity === 'working' ? ' working' : ''}${w.unread ? ' unread' : ''}`,
      style: { '--c': statusColor(w.status) },
      onClick: (ev: Event) => {
        if (!dragJustEnded()) controller.select(w)
      },
      onContextmenu: (ev: MouseEvent) => {
        ev.preventDefault()
        workspaceMenu({ x: ev.clientX, y: ev.clientY }, w, row)
      }
    },
    h('span', { class: 'status-dot' }),
    h(
      'div',
      { class: 'main' },
      h('div', { class: 'line1' },priorityOf(w)?priorityBadge(priorityOf(w)!,anchor=>editPriority(w,anchor)):null, h('span', { class: 'nm' }, w.name), w.isMain ? h('span', { class: 'main-tag' }, 'MAIN') : null, prChip(w)),
      h(
        'div',
        { class: 'line2' },
        w.branch && w.branch !== w.name ? h('span', { class: 'br' }, icon('branch'), w.branch) : null,
        opts.parentHint ? h('span', { class: 'parent-hint' }, `↳ ${opts.parentHint}`) : null,
        opts.showTopic && w.topic ? topicTag(w) : null
      ),
      w.comment ? h('div', { class: 'cm' }, w.comment) : null,
      sessionLines(w)
    ),
    h('div', { class: 'right' }, h('span', { class: 'ago', 'data-ago': w.lastActivityAt }, ago(w.lastActivityAt)), menuBtn)
  )
  menuBtn.addEventListener('click', (ev) => {
    ev.stopPropagation()
    workspaceMenu(menuBtn, w, row)
  })
  hoverable(row, () => workspaceCard(w.id), 550, `ws:${w.id}`)
  draggableRow(row, w.repoId, (kind, id, label) => moveRow(w, kind, id, label), () => {
    hideHover()
    closeMenu()
  })
  return row
}

/** 행을 다른 묶음에 놓았을 때: 상태 또는 주제를 바꾼다. */
async function moveRow(w: WorkspaceView, kind: 'status' | 'topic', id: string, label: string): Promise<void> {
  try {
    if (kind === 'status') {
      if (id === w.status) return
      await call('pod.setStatus', { id: w.id, status: id })
    } else {
      if ((w.topic ?? '_') === id) return
      await call('pod.assignTopic', { repoId: w.repoId, id: w.id, topicId: id })
    }
    toast(`${clip(w.name, 20)} → ${label}`)
  } finally {
    void sync(true)
  }
}

/** 묶음이 크면 앞의 몇 줄만 그리고 나머지는 「더 보기」로 접는다(수백 개여도 가볍게). */
const ROW_CAP = 20
function cappedRows(ids: string[], snap: Snapshot, gkey: string, showTopic = false): HTMLElement[] {
  const all = state.openGroups.has(`${gkey}:all`) || narrowing()
  if (all || ids.length <= ROW_CAP) return groupRows(ids, snap, showTopic)
  const more = h(
    'button',
    {
      class: 'rows-more',
      onClick: () => {
        state.openGroups.add(`${gkey}:all`)
        savePrefs()
        renderBody()
      }
    },
    icon('unfold'),
    t(`{n}개 더 보기`, { n: ids.length - ROW_CAP })
  )
  return [...groupRows(ids.slice(0, ROW_CAP), snap, showTopic), more]
}

function groupRows(ids: string[], snap: Snapshot, showTopic = false): HTMLElement[] {
  const inGroup = new Set(ids)
  const out: HTMLElement[] = []
  const visit = (id: string, depth: number) => {
    const w = snap.workspaces[id]
    out.push(workspaceRow(w, { child: depth > 0, showTopic }))
    if (depth < 4) for (const c of w.childIds) if (inGroup.has(c)) visit(c, depth + 1)
  }
  for (const id of ids) {
    const w = snap.workspaces[id]
    if (w.parentId && inGroup.has(w.parentId)) continue
    if (w.parentId && snap.workspaces[w.parentId]) {
      out.push(workspaceRow(w, { parentHint: snap.workspaces[w.parentId].name, showTopic }))
      for (const c of w.childIds) if (inGroup.has(c)) visit(c, 1)
    } else visit(id, 0)
  }
  return out
}

function repoSection(repo: RepoView, snap: Snapshot): HTMLElement | null {
  const ids = repo.workspaceIds.filter((id) => matches(snap.workspaces[id]))
  if (ids.length === 0) return null
  const single = scopedRepo() === repo.id
  const open = single || !state.collapsedRepos.has(repo.id) || narrowing()
  const counts = new Map<string, number>()
  for (const id of repo.workspaceIds) counts.set(snap.workspaces[id].status, (counts.get(snap.workspaces[id].status) ?? 0) + 1)
  const active = repo.workspaceIds.filter((id) => shown(snap.workspaces[id])).length

  const head = h(
    'div',
    {
      class: `repo-head${single ? ' single' : ''}`,
      onClick: () => {
        if (single) return
        if (state.collapsedRepos.has(repo.id)) state.collapsedRepos.delete(repo.id)
        else state.collapsedRepos.add(repo.id)
        savePrefs()
        renderBody()
      }
    },
    h('span', { class: 'folder' }, icon('folder')),
    h('div', { class: 'name' }, h('b', null, repo.name), h('span', null, t(`{active} 표시 · 전체 {n}`, { active, n: repo.workspaceIds.length }))),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '2px' } },
      h(
        'button',
        {
          class: 'icon-btn',
          title: t('새 워크스페이스'),
          onClick: (ev: Event) => {
            ev.stopPropagation()
            createWorkspace(repo)
          }
        },
        icon('plus')
      ),
      single ? null : h('span', { class: 'chev' }, icon('chevron'))
    ),
    h(
      'div',
      { class: 'bar' },
      snap.statuses
        .filter((st) => counts.get(st))
        .map((st) => h('i', { title: `${statusLabel(st)} ${counts.get(st)}`, style: { background: statusColor(st), flexGrow: String(counts.get(st)) } }))
    ),
    h(
      'div',
      { class: 'legend' },
      snap.statuses
        .filter((st) => counts.get(st))
        .map((st) =>
          h(
            'button',
            {
              class: `legend-item${state.hidden.has(st) ? ' off' : ''}`,
              title: state.hidden.has(st) ? t(`{n} 보이기`, { n: statusLabel(st) }) : t(`{n} 숨기기`, { n: statusLabel(st) }),
              onClick: (ev: Event) => {
                ev.stopPropagation()
                toggleStatus(st)
              }
            },
            h('i', { style: { background: statusColor(st) } }),
            `${statusLabel(st)} ${counts.get(st)}`
          )
        )
    ),
    open ? repoTools(repo) : null
  )

  const section = h('section', { class: `repo${open ? ' open' : ''}` }, head)
  if (!open) return section

  const groups = h('div', { class: 'repo-body' })
  if (state.groupBy === 'topic') {
    groups.append(...topicGroups(repo, ids, snap))
    section.append(groups)
    return section
  }
  for (const st of snap.statuses) {
    const inSt = ids.filter((id) => snap.workspaces[id].status === st)
    if (inSt.length === 0) continue
    const gkey = `${repo.id}:${st}`
    const closed = state.closedGroups.has(gkey) && !narrowing()
    const toggle = () => {
      if (state.closedGroups.has(gkey)) state.closedGroups.delete(gkey)
      else state.closedGroups.add(gkey)
      savePrefs()
      renderBody()
    }
    groups.append(
      h(
        'div',
        { class: `group${closed ? ' closed' : ''}`, style: { '--c': statusColor(st) }, 'data-drop': `status:${st}`, 'data-repo': repo.id, 'data-label': statusLabel(st) },
        h(
          'button',
          { class: `group-head toggle${closed ? '' : ' expanded'}`, onClick: toggle },
          h('span', { class: 'tag' }, h('i'), statusLabel(st)),
          h('span', { class: 'count' }, inSt.length),
          h('span', { class: 'chev' }, icon('chevron'))
        ),
        closed ? null : cappedRows(inSt, snap, gkey, true)
      )
    )
  }
  section.append(groups)
  return section
}

/* ---------- 주제 ---------- */

function repoTools(repo: RepoView): HTMLElement {
  const seg = h(
    'div',
    { class: 'seg sm', onClick: (ev: Event) => ev.stopPropagation() },
    (['status', 'topic'] as const).map((g) =>
      h(
        'button',
        {
          class: state.groupBy === g ? 'on' : '',
          onClick: () => {
            state.groupBy = g
            savePrefs()
            renderBody()
          }
        },
        g === 'status' ? t('상태별') : t('주제별')
      )
    )
  )
  const tools: (HTMLElement | null)[] = [seg, h('span', { class: 'spacer' })]
  if (state.groupBy === 'topic') {
    const busy = controller.busy()
    tools.push(
      h(
        'button',
        {
          class: `mini-btn${busy ? ' busy' : ''}`,
          title: t('관제에서 주제를 정리합니다'),
          onClick: (ev: Event) => {
            ev.stopPropagation()
            extractTopics(repo)
          }
        },
        icon('sparkle'),
        busy ? t('주제 뽑는 중…') : t('관제로 주제 정리')
      ),
      h(
        'button',
        {
          class: 'mini-btn',
          onClick: (ev: Event) => {
            ev.stopPropagation()
            editTopics(repo)
          }
        },
        icon('edit'),
        t('편집')
      )
    )
  }
  return h('div', { class: 'repo-tools', onClick: (ev: Event) => ev.stopPropagation() }, tools)
}

function extractTopics(repo: RepoView): void {
  void controller.organize(repo.id)
}

function reviewTopicPlan(plan: TopicPlan): void {
  const repo = state.snap?.repos.find(repo => repo.id === plan.repoId)
  if (!repo) return
  const name = (id: string, list: Topic[]) => id === '_' ? t('기타') : topicPath(list, id) || t('기타')
  const proposed = plan.assignments.map(item => ({item, w:state.snap?.workspaces[item.workspaceId]}))
  const changed = proposed.filter(({item,w}) => w && name(w.topic ?? '_',repo.topics) !== name(item.topicId,plan.topics))
  const tree = h('div', {class:'topic-review-tree'}, plan.topics.filter(tp=>!tp.parent).map(parent => h('div', {class:'topic-review-root'},
    h('strong', null,parent.name, h('span',{class:'muted'}, ` · ${plan.assignments.filter(a=>a.topicId===parent.id || plan.topics.find(tp=>tp.id===a.topicId)?.parent===parent.id).length}`)), plan.topics.filter(tp=>tp.parent===parent.id).map(child=>h('div',null,child.name, h('span',{class:'muted'}, ` · ${plan.assignments.filter(a=>a.topicId===child.id).length}`))))))
  const other = plan.assignments.filter(item=>item.topicId==='_').length
  if (other) tree.append(h('div',{class:'topic-review-root'},h('strong',null,`${t('기타')} · ${other}`)))
  let close:()=>void
  const retry = h('button',{type:'button',class:'pill-btn',onClick:()=>{close();void controller.organize(repo.id)}},t('다시 분류'))
  close = openSheet({
    title:t('주제 분류안'), sub:repo.name,
    body:[tree,h('h3',null,t('이동할 작업 {n}개',{n:changed.length})),
      h('div',{class:'topic-review-changes'},changed.map(({item,w})=>h('div',{class:'topic-review-row'},h('strong',null,w!.name),
        h('div',null,`${name(w!.topic ?? '_',repo.topics)} → ${name(item.topicId,plan.topics)}`),h('small',{class:'muted'},item.reason)))),retry],
    submitLabel:t('이 분류 적용'),submitIcon:'check',
    onSubmit:async()=>{
      const result=await call<{assigned:number}>('pod.applyTopicPlan',{plan})
      state.groupBy='topic';void savePrefs();await sync(true)
      toast(t('작업 {n}개를 분류했어요',{n:result.assigned}))
    }
  })
}

function editTopics(repo: RepoView): void {
  type Row = { id?: string; name: HTMLInputElement; keywords: HTMLInputElement; el: HTMLElement }
  const rows: Row[] = []
  const list = h('div', { class: 'topic-edit' })
  const addRow = (tp?: Topic) => {
    const name = h('input', { placeholder: t('주제 이름') }) as HTMLInputElement
    const keywords = h('input', { placeholder: t('키워드, 쉼표로 구분') }) as HTMLInputElement
    name.value = tp?.name ?? ''
    keywords.value = tp?.keywords.join(', ') ?? ''
    const row: Row = { id: tp?.id, name, keywords, el: h('div') }
    row.el = h(
      'div',
      { class: 'item' },
      h('i', { style: { background: topicColor(tp?.id ?? name.value) } }),
      name,
      keywords,
      h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: t('삭제'),
          onClick: () => {
            rows.splice(rows.indexOf(row), 1)
            row.el.remove()
          }
        },
        icon('x')
      )
    )
    rows.push(row)
    list.append(row.el)
    return row
  }
  repo.topics.forEach((t) => addRow(t))
  if (!repo.topics.length) addRow()
  openSheet({
    title: t('주제 편집'),
    sub: repo.name,
    body: [
      list,
      h(
        'button',
        { type: 'button', class: 'mini-btn', style: { marginTop: '8px' }, onClick: () => addRow().name.focus() },
        icon('plus'),
        t('주제 추가')
      )
    ],
    submitLabel: t('저장'),
    submitIcon: 'check',
    onSubmit: async () => {
      const topics = rows.map((r) => ({
        id: r.id,
        parent: repo.topics.find((t) => t.id === r.id)?.parent,
        name: r.name.value.trim(),
        keywords: r.keywords.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
      }))
      await call('pod.saveTopics', { repoId: repo.id, topics })
      toast(t('주제를 저장했습니다'))
    }
  })
}

const STATUS_RANK = (snap: Snapshot, st: string) => {
  const i = snap.statuses.indexOf(st)
  return i < 0 ? 99 : i
}

function topicGroups(repo: RepoView, ids: string[], snap: Snapshot): HTMLElement[] {
  if (!repo.topics.length) {
    const busy = controller.busy()
    return [
      h(
        'div',
        { class: 'topic-empty' },
        icon('tag'),
        h('div', null, t('주제가 아직 없어요')),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'pill-btn primary', disabled: busy, onClick: () => extractTopics(repo) }, icon('sparkle'), busy ? t('뽑는 중…') : t('관제로 주제 정리')),
          h('button', { class: 'pill-btn', onClick: () => editTopics(repo) }, icon('edit'), t('직접 만들기'))
        )
      )
    ]
  }
  const out: HTMLElement[] = []
  // 진행 중인 것이 많은 주제가 앞에 오고, 하위 섹션은 상위 바로 아래 붙는다.
  const activeCount = (tid: string | null) => ids.filter((id) => snap.workspaces[id].topic === tid && snap.workspaces[id].status !== 'completed').length
  const known = new Set(repo.topics.map((t) => t.id))
  const kids = (pid: string | null) =>
    repo.topics.filter((t) => (pid === null ? !t.parent || !known.has(t.parent) : t.parent === pid)).sort((a, b) => activeCount(b.id) - activeCount(a.id))
  const groups: { id: string | null; name: string; depth: number }[] = []
  const walk = (pid: string | null, depth: number) => {
    for (const t of kids(pid)) {
      groups.push({ id: t.id, name: depth ? topicPath(repo.topics, t.id) : t.name, depth })
      if (depth < 5) walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  groups.push({ id: null, name: t('기타'), depth: 0 })
  for (const g of groups) {
    const inT = ids.filter((id) => snap.workspaces[id].topic === g.id)
    if (!inT.length) continue
    const live = [...inT].sort(
        (a, b) =>
          STATUS_RANK(snap, snap.workspaces[a].status) - STATUS_RANK(snap, snap.workspaces[b].status) ||
          snap.workspaces[b].lastActivityAt - snap.workspaces[a].lastActivityAt
      )
    const gkey = `${repo.id}:t:${g.id ?? '_'}`
    const closed = state.closedGroups.has(gkey)
    const toggle = (key: string, set: Set<string>) => () => {
      if (set.has(key)) set.delete(key)
      else set.add(key)
      savePrefs()
      renderBody()
    }
    const counts = new Map<string, number>()
    for (const id of live) counts.set(snap.workspaces[id].status, (counts.get(snap.workspaces[id].status) ?? 0) + 1)
    out.push(
      h(
        'div',
        {
          class: `group topic${closed ? ' closed' : ''}${g.depth ? ' sub' : ''}`,
          style: { '--t': topicColor(g.id && topicRoot(repo.topics, g.id)), '--c': topicColor(g.id && topicRoot(repo.topics, g.id)) },
          'data-drop': `topic:${g.id ?? '_'}`,
          'data-repo': repo.id,
          'data-label': g.name
        },
        h(
          'button',
          {
            class: `group-head toggle${closed ? '' : ' expanded'}`,
            onClick: toggle(gkey, state.closedGroups),
            onContextmenu: (ev: MouseEvent) => {
              ev.preventDefault()
              openMenu({ x: ev.clientX, y: ev.clientY }, [{ label: t('주제 편집'), icon: 'edit', onSelect: () => editTopics(repo) }])
            }
          },
          h('span', { class: 'tag' }, h('i'), g.name),
          h('span', { class: 'count' }, live.length),
          live.length
            ? h(
                'span',
                { class: 'mini-bar' },
                snap.statuses
                  .filter((st) => counts.get(st))
                  .map((st) => h('i', { style: { background: statusColor(st), flexGrow: String(counts.get(st)) } }))
              )
            : null,
          h('span', { class: 'chev' }, icon('chevron'))
        ),
        closed
          ? null
          : cappedRows(live, snap, gkey)
      )
    )
  }
  return out
}

function liveAgentCard(w: WorkspaceView, a: AgentView): HTMLElement {
  const actions: HTMLElement[] = [
    h(
      'button',
      {
        class: 'pill-btn',
        onClick: (ev: Event) => {
          ev.stopPropagation()
          detail.open(w.id, a.key, (ev.currentTarget as Element).closest('.agent-card'))
        }
      },
      icon('terminal'),
      t('작업실')
    ),
    h(
      'button',
      {
        class: 'pill-btn',
        onClick: (ev: Event) => {
          ev.stopPropagation()
          focusAgent(w, a)
        }
      },
      icon('open'),
      'Orca'
    )
  ]
  if (a.terminal) {
    if (a.state === 'working') {
      const stop = h('button', { class: 'pill-btn danger' }, icon('stop'), h('span', null, t('중단')))
      stop.addEventListener('click', (ev) => {
        ev.stopPropagation()
        interrupt(stop, a)
      })
      actions.push(stop)
    }
  }
  const doing =
    a.state === 'working' && a.tool
      ? h('div', { class: 'doing' }, h('b', null, a.tool.name), h('code', null, clip(a.tool.input, 120)))
      : a.state === 'blocked' && a.tool
        ? h('div', { class: 'doing' }, h('b', null, t(`{name} 승인 요청`, { name: a.tool.name })), h('code', null, clip(a.tool.input, 120)))
        : a.state !== 'working'
        ? h('div', { class: 'doing' }, h('b', null, AGENT_STATE_LABEL[a.state]), h('code', null, clip(a.lastMessage || a.prompt, 120)))
        : null
  const card = h(
    'div',
    { class: 'agent-card', 'data-state': a.state, onClick: () => controller.select(w, a) },
    avatar(a, 'lg'),
    h(
      'div',
      { style: { minWidth: '0' } },
      h('div', { class: 'title' }, a.title),
      h(
        'div',
        { class: 'where' },
        h('i', { style: { width: '6px', height: '6px', borderRadius: '50%', background: statusColor(w.status), flex: 'none' } }),
        h('span', null, `${w.repo} · ${w.name}`)
      )
    ),
    h('span', { class: 'elapsed', 'data-dur': a.since }, duration(a.since)),
    doing,
    h('div', { class: 'actions' }, actions)
  )
  hoverable(card, () => agentCard(w.id, a.key), 650, `card:${a.key}`)
  return card
}

function idleChip(w: WorkspaceView, a: AgentView): HTMLElement {
  const chip = h('button', { class: 'chip', onClick: () => controller.select(w, a) }, avatar(a, 'sm'), h('span', null, a.title))
  hoverable(chip, () => agentCard(w.id, a.key), 200, `chip:${a.key}`)
  return chip
}

function allAgents(snap: Snapshot): { w: WorkspaceView; a: AgentView }[] {
  return Object.values(snap.workspaces)
    .filter(matches)
    .flatMap((w) => w.agents.map((a) => ({ w, a })))
}

function renderBoard(snap: Snapshot): HTMLElement[] {
  const out: HTMLElement[] = []
  const pairs = allAgents(snap)
  const live = pairs
    .filter(({ a }) => a.state === 'working' || a.state === 'blocked' || a.state === 'waiting')
    .sort((x, y) => (x.a.state === 'working' ? 1 : 0) - (y.a.state === 'working' ? 1 : 0) || x.a.since - y.a.since)
  const idle = pairs.filter(({ a }) => a.state === 'idle').sort((x, y) => y.a.updatedAt - x.a.updatedAt)

  out.push(h('div', { class: 'section-title' }, t('지금'), h('span', { class: 'count' }, live.length || '')))
  if (live.length) out.push(h('div', { class: 'live-list' }, live.map(({ w, a }) => liveAgentCard(w, a))))
  else out.push(h('div', { class: 'empty' }, t('작업 중인 에이전트가 없어요')))
  if (idle.length) {
    out.push(
      h(
        'div',
        { class: 'idle-strip' },
        idle.slice(0, 8).map(({ w, a }) => idleChip(w, a)),
        idle.length > 8 ? h('button', { class: 'chip', onClick: () => setView('agents') }, h('span', null, t(`+{n} 더보기`, { n: idle.length - 8 }))) : null
      )
    )
  }

  const repoId = scopedRepo()
  const scoped = repoId ? snap.repos.filter((r) => r.id === repoId) : snap.repos
  const repos = scoped.map((r) => repoSection(r, snap)).filter((x): x is HTMLElement => x !== null)
  if (!repoId) out.push(h('div', { class: 'section-title' }, t('디렉토리'), h('span', { class: 'count' }, repos.length)))
  else out.push(h('div', { style: { height: '4px' } }))
  if (repos.length) out.push(h('div', { class: repoId ? 'repos single' : 'repos' }, repos))
  else out.push(h('div', { class: 'empty' }, t('조건에 맞는 워크스페이스가 없어요')))
  return out
}

/* ---------- 본문: 에이전트 ---------- */

function agentRow(w: WorkspaceView, a: AgentView): HTMLElement {
  const row = h(
    'div',
    { class: 'ws', style: { '--c': statusColor(w.status), gridTemplateColumns: 'auto minmax(0,1fr) auto' }, onClick: () => controller.select(w, a) },
    avatar(a, 'sm'),
    h(
      'div',
      { class: 'main' },
      h('div', { class: 'line1' }, h('span', { class: 'nm' }, a.title)),
      h('div', { class: 'line2' }, h('span', { class: 'parent-hint' }, `${w.repo} · ${w.name}`))
    ),
    h('div', { class: 'right' }, h('span', { class: 'ago', 'data-ago': a.updatedAt, style: { display: 'inline' } }, ago(a.updatedAt)))
  )
  hoverable(row, () => agentCard(w.id, a.key), 260, `row:${a.key}`)
  return row
}

function renderAgents(snap: Snapshot): HTMLElement[] {
  const pairs = allAgents(snap)
  const by = (pred: (a: AgentView) => boolean) => pairs.filter(({ a }) => pred(a))
  const attention = by((a) => a.state === 'blocked' || a.state === 'waiting')
  const working = by((a) => a.state === 'working')
  const idle = by((a) => a.state === 'idle').sort((x, y) => y.a.updatedAt - x.a.updatedAt)
  const dayAgo = Date.now() - 24 * 3600_000
  const done = by((a) => a.state === 'done' && a.updatedAt > dayAgo).sort((x, y) => y.a.updatedAt - x.a.updatedAt)
  const out: HTMLElement[] = []
  const block = (title: string, list: typeof pairs, render: (w: WorkspaceView, a: AgentView) => HTMLElement, cls = '') => {
    if (!list.length) return
    out.push(h('div', { class: 'section-title' }, title, h('span', { class: 'count' }, list.length)))
    out.push(h('div', { class: cls || 'repo', style: cls ? undefined : { padding: '4px' } }, list.map(({ w, a }) => render(w, a))))
  }
  block(t('확인 필요'), attention, liveAgentCard, 'live-list')
  block(t('작업 중'), working, liveAgentCard, 'live-list')
  block(t('대기 중인 세션'), idle, agentRow)
  block(t('최근 24시간 종료'), done.slice(0, 30), agentRow)
  if (!out.length) out.push(h('div', { class: 'empty', style: { marginTop: '14px' } }, t('표시할 에이전트가 없어요')))
  return out
}

/* ---------- 상세(작업실) ---------- */

function detailOpenUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return
  void Promise.resolve(orca.shell.openExternal(url)).catch(() => toast(t('링크를 열지 못했습니다'), 'err'))
}

const detail = createDetail({
  content: body,
  snap: () => state.snap,
  call,
  openWorkspace,
  focusAgent,
  launchAgent,
  overview: (w) => workOverview(w, contextApi),
  overviewSignature: (w) => JSON.stringify([workFingerprint(w), journal[w.id]]),
  workspaceMenu: (at, w) => workspaceMenu(at, w),
  statusMenu,
  openPR,
  toast,
  closeTabs: (handles) => closeTabs(null, handles),
  openUrl: (url) => detailOpenUrl(url),
  onSelect: (sel) => {
    const target = controller.selection()
    graph.select(target ? { wsId: target.workspaceId, agentKey: target.sessionKey } : sel)
    queueMicrotask(() => controller.update())
  },
  onReserve: (r) => graph.setReserve(r),
  addSession: async (w, kind) => {
    const r =
      kind === 'terminal'
        ? await call<{ terminal: string | null }>('pod.newTerminal', { id: w.id })
        : await call<{ terminal: string | null }>('pod.launchAgent', { id: w.id, agent: kind })
    toast(kind === 'terminal' ? t('터미널을 열었습니다') : t(`{n} 시작`, { n: agentName(kind) }))
    await sync(true)
    return r.terminal
  }
})

const contextApi: WorkContextApi = {
  memory: id => journal[id],
  session: (w, a) => detail.open(w.id, a.key, undefined, { host: detailHost() }),
  edit: editBrief,
  review: async w => {
    await saveMemory(w.id, current => reviewWork(w, current))
    toast(t('여기까지 확인했어요'))
  },
  launch: w => launchAgent(w, w.agents[0]?.type ?? 'claude')
}

const progress=createProgress({
  call,
  scope:()=>({repoId:scopedRepo(),topicPath:state.scopeMode==='topic'&&state.topicScope&&state.snap?collectTopicScopes(state.snap,()=>true).find(s=>s.key===state.topicScope)?.path??null:null}),
  changed:()=>{
    if(progress.isHistory()) {state.view='graph';if(!controller.el.classList.contains('open'))controller.show()}
    renderTop();renderBody()
  },
  select:(id,key)=>{graph.select({wsId:id,agentKey:key});graph.revealWorkspace(id)},
  resume:(id,key)=>{
    const w=ws(id)
    if(!w){toast(t('현재 작업을 찾지 못했습니다'),'err');return false}
    if(!matches(w)){state.scopeMode='repo';state.repo=w.repoId;state.topicScope=null;state.query='';searchInput.value='';state.filter=null;state.priorityLevel=null;state.hidden.delete(w.status)}
    renderTop();renderBody();controller.select(w,w.agents.find(a=>a.key===key));graph.revealWorkspace(id)
    return true
  }
})

const controller = createController({
  snap: () => state.snap,
  call,
  toast,
  openUrl: (url) => detailOpenUrl(url),
  memory: id => journal[id],
  watchScope:()=>({repoId:scopedRepo(),topicKey:state.scopeMode==='topic'?state.topicScope:null}),
  history:()=>state.view==='dashboard'?dashboard.history():progress.history(),
  priority:priorityOf,
  editPriority,
  reviewTopics: reviewTopicPlan,
  dockPosition: () => state.controlPosition,
  setDockPosition: position => {
    state.controlPosition=position
    void savePrefs()
    applyControlLayout()
    controller.update()
  },
  source: (w, a) => {
    controller.el.classList.remove('reading')
    workspaceShell.classList.remove('control-full')
    detail.open(w.id, a?.key, undefined, { host: detailHost() })
  },
  select: target => graph.select(target ? { wsId: target.workspaceId, agentKey: target.sessionKey } : null),
  onOpen: open => {
    workspaceShell.classList.toggle('control-collapsed', !open)
    workspaceShell.classList.toggle('control-full', controller.el.classList.contains('reading'))
    applyControlLayout()
  }
})

/* ---------- 본문: 그래프 ---------- */

const historySections:Record<string,'open'|'closed'|'all'>={}
const graph = createGraph({
  openWorkspace: w => progress.isHistory()?progress.select(w.id,null):controller.select(w),
  memory: id => journal[id],
  readOnly:progress.isHistory,
  progress:progress.mark,
  priority:priorityOf,
  editPriority,
  focusAgent: (w, a) => progress.isHistory()?progress.select(w.id,a.key):controller.select(w,a),
  hoverWorkspace: (el, id) => {if(!progress.isHistory())hoverable(el, () => workspaceCard(id), 450, `gw:${id}`)},
  hoverAgent: (el, id, key) => {if(!progress.isHistory())hoverable(el, () => agentCard(id, key), 250, `ga:${key}`)},
  hoverTabs: (el, id) => {if(!progress.isHistory())hoverable(el, () => tabsCard(id), 150, `gt:${id}`)},
  sendToControl: (w, a) => sendToControl(w, a),
  deadTabs: () =>
    Object.values(state.snap?.workspaces ?? {})
      .filter((w) => inScope(w))
      .flatMap((w) => w.terminals.filter((t) => !t.connected).map((t) => t.handle)),
  closeTabs: (handles) => closeTabs(null, handles),
  menuWorkspace: (at, w, owner) => workspaceMenu(at, w, owner),
  groupBy: () => state.groupBy,
  setGroupBy: (v) => {
    state.groupBy = v
    savePrefs()
    renderBody()
  },
  sectionState: (key) => progress.isHistory()?historySections[key]??state.graphSections[key]:state.graphSections[key],
  setSectionState: (keys, v) => {
    const sections=progress.isHistory()?historySections:state.graphSections
    for (const k of keys) {
      if (v) sections[k] = v
      else delete sections[k]
    }
    if(!progress.isHistory())savePrefs()
    renderBody()
  },
  scopeRepo: graphScope,
  position: (id) => state.graphPositions[graphPositionKey(state.groupBy, graphScope(), id)],
  setPosition: (id, point) => {
    if(progress.isHistory())return
    const key = graphPositionKey(state.groupBy, graphScope(), id)
    if (point) state.graphPositions[key] = point
    else delete state.graphPositions[key]
    void savePrefs()
  },
  resetPositions: () => {
    state.graphPositions = clearGraphPositions(state.graphPositions, state.groupBy, graphScope())
    void savePrefs()
  },
  addSection: (repoId, parentId) => {
    const repo = state.snap?.repos.find((r) => r.id === repoId)
    if (repo) addSection(repo, parentId)
  },
  addSession: (repoId, topicId, anchor) => {
    const repo = state.snap?.repos.find((r) => r.id === repoId)
    if (repo) createWorkspace(repo, undefined, topicId, anchor)
  },
  addToWorkspace: (w, anchor) => sessionMenu(anchor, w),
  moveToSection: async (w, to) => {
    try {
      if (to.topicId !== undefined) await call('pod.assignTopic', { repoId: w.repoId, id: w.id, topicId: to.topicId })
      else if (to.status) await call('pod.setStatus', { id: w.id, status: to.status })
      toast(`${clip(w.name, 20)} → ${to.label}`)
    } catch (e) {
      // 그래프가 화면을 먼저 옮겨 두었으므로, 실패하면 서버 값으로 다시 그린다.
      lastSig = ''
      void sync(true)
      throw e
    }
  }
})

const dashboard=createDashboard({
  call,snap:()=>state.snap,search:()=>state.query,
  scope:()=>({repoId:scopedRepo(),topicPath:state.scopeMode==='topic'&&state.topicScope&&state.snap?collectTopicScopes(state.snap,()=>true).find(s=>s.key===state.topicScope)?.path??null:null}),
  priority:priorityOf,editPriority,
  select:(w,a)=>controller.select(w,a),
  resume:(id,key)=>{const w=ws(id);if(!w){toast(t('현재 작업을 찾지 못했습니다'),'err');return false}controller.select(w,w.agents.find(a=>a.key===key));return true},
  changed:()=>{if(state.view==='dashboard'){renderTop();if(dashboard.history()&&!controller.el.classList.contains('open'))controller.show();controller.update()}},
  openUrl:url=>detailOpenUrl(url),
  load:()=>orca.storage.get('pod.dashboard.prefs.v1'),
  save:value=>orca.storage.set('pod.dashboard.prefs.v1',value)
})

const workspaceShell = h('main', { class: 'workspace-shell control-collapsed' })
function applyControlLayout(): void {
  workspaceShell.dataset.controlPosition=state.controlPosition
  workspaceShell.dataset.controlDock=controlDock(state.controlPosition,workspaceShell.clientWidth,state.view==='graph',controller.el.classList.contains('open'))
}
const controlSizeObserver=new ResizeObserver(applyControlLayout)
const stage = h('div', { class: 'graph-stage', style: { position: 'relative', width: '100%', height: '100%' } })

function renderGraph(snap: Snapshot): void {
  const historical=progress.snapshot()
  if(historical)snap=historical
  const view = graph
  if (view.el.parentElement !== stage) {
    if (detail.isInline()) detail.dispose()
    stage.replaceChildren(progress.el,view.el)
  }
  const visible = new Set(
    Object.values(snap.workspaces)
      .filter(w=>historical?true:matches(w))
      .map((w) => w.id)
  )
  view.update(snap, visible)
  if(historical)view.select(progress.selection()?{wsId:progress.selection()!,agentKey:null}:null)
  else {const target=controller.selection();view.select(target?{wsId:target.workspaceId,agentKey:target.sessionKey}:null)}
  requestAnimationFrame(() => view.attached())
}


/* ---------- 그리기 ---------- */

function renderBody(): void {
  const snap = state.snap
  dashboard.setVisible(state.view==='dashboard')
  controller.update()
  progress.update()
  body.classList.toggle('graph-mode', state.view === 'graph')
  workspaceShell.classList.toggle('graph-workspace', state.view === 'graph')
  applyControlLayout()
  if (!snap) {
    body.replaceChildren(
      state.error
        ? h('div', { class: 'banner' }, h('b', null, t('불러오지 못했습니다')), h('div', { style: { marginTop: '4px', color: 'var(--muted)' } }, tt(state.error)))
        : h('div', null, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))
    )
    return
  }
  if(state.view==='dashboard'){
    if(dashboard.el.parentElement!==body)body.replaceChildren(dashboard.el)
    dashboard.update(snap,Object.values(snap.workspaces).filter(matches))
    return
  }
  if (state.view === 'graph') {
    if (stage.parentElement !== body) body.replaceChildren(stage)
    renderGraph(snap)
    return
  }
  const scroll = body.scrollTop
  body.replaceChildren(...(state.view === 'board' ? renderBoard(snap) : renderAgents(snap)))
  body.scrollTop = scroll
}

/** 상대 시간 글자만 갱신한다(다시 그리지 않음). */
function tick(): void {
  const now = Date.now()
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => {
    el.textContent = ago(Number(el.dataset.ago), now)
  })
  document.querySelectorAll<HTMLElement>('[data-dur]').forEach((el) => {
    const v = duration(Number(el.dataset.dur), now)
    el.textContent = el.closest('.hc-kicker') ? t(`· {v}째`, { v }) : v
  })
  renderTop()
}

/* ---------- 설정 저장 ---------- */

function savePrefs(): Promise<void> {
  const prefs = {
    lang: langPref(),
    view: state.view,
    hidden: [...state.hidden],
    collapsedRepos: [...state.collapsedRepos],
    openGroups: [...state.openGroups],
    closedGroups: [...state.closedGroups],
    repo: state.repo ?? null,
    scopeMode: state.scopeMode,
    topicScope: state.topicScope,
    controlPosition: state.controlPosition,
    priorityLevel:state.priorityLevel,
    groupBy: state.groupBy,
    graphSections: state.graphSections,
    graphPositions: state.graphPositions
  }
  return Promise.resolve(orca.storage?.set?.(PREFS_KEY, prefs)).then(() => undefined, () => undefined)
}

async function loadPrefs(): Promise<void> {
  try {
    const p = await orca.storage?.get?.(PREFS_KEY)
    if (!p || typeof p !== 'object') return
    // 저장된 언어가 지금 화면 언어와 다르면 그 언어로 다시 불러온다(다시 읽혀야만 — 저장이 안 되면 무한 반복하므로 건너뜀).
    if (p.lang !== undefined && normalizePref(p.lang) !== langPref()) {
      setLangPref(p.lang)
      if (langPersisted()) {
        location.reload()
        return
      }
    }
    if (p.view === 'board' || p.view === 'agents' || p.view === 'graph' || p.view === 'dashboard') state.view = p.view
    if (Array.isArray(p.hidden)) state.hidden = new Set(p.hidden.filter((x: unknown) => typeof x === 'string'))
    state.collapsedRepos = new Set(Array.isArray(p.collapsedRepos) ? p.collapsedRepos : [])
    state.openGroups = new Set(Array.isArray(p.openGroups) ? p.openGroups : [])
    state.closedGroups = new Set(Array.isArray(p.closedGroups) ? p.closedGroups : [])
    if (typeof p.repo === 'string' || p.repo === null) state.repo = p.repo
    if (p.scopeMode === 'repo' || p.scopeMode === 'topic') state.scopeMode = p.scopeMode
    if (typeof p.topicScope === 'string' && p.topicScope.length <= 2000) state.topicScope = p.topicScope
    state.controlPosition=readControlPosition(p.controlPosition)
    state.priorityLevel=['P0','P1','P2'].includes(p.priorityLevel)?p.priorityLevel:null
    if (p.groupBy === 'topic' || p.groupBy === 'status') state.groupBy = p.groupBy
    state.graphPositions = readGraphPositions(p.graphPositions)
    if (p.graphSections && typeof p.graphSections === 'object') {
      for (const [k, v] of Object.entries(p.graphSections)) if (v === 'open' || v === 'closed' || v === 'all') state.graphSections[k] = v
    }
  } catch {
    /* 저장된 설정이 없으면 기본값 */
  }
}

/* ---------- 시작 ---------- */

function mount(): void {
  const top = h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('h1', null, 'Pod'), syncEl, h('span', { class: 'spacer' }),langBtn, refreshBtn),
    h('div', { class: 'toolbar' }, viewSeg, h('label', { class: 'search' }, icon('search'), searchInput, h('kbd', null, '/')), statusBtn),
    scopeBar
  )
  const app = document.getElementById('app')!
  workspaceShell.replaceChildren(body, controller.el)
  workspaceShell.classList.toggle('control-collapsed', !controller.el.classList.contains('open'))
  app.replaceChildren(top, workspaceShell)
  applyControlLayout()
  controlSizeObserver.observe(workspaceShell)
  body.addEventListener('scroll', () => {
    hideHover()
    closeMenu()
  })
  document.addEventListener('keydown', (ev) => {
    const typing = (ev.target as HTMLElement)?.closest?.('input, textarea')
    if (ev.key === '/' && !typing && !sheetOpen()) {
      ev.preventDefault()
      searchInput.focus()
    } else if (ev.key === 'i' && !typing && !sheetOpen() && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault()
      controller.focus()
    } else if ((ev.key === '[' || ev.key === ']') && !typing && !sheetOpen()) {
      ev.preventDefault()
      cycleRepo(ev.key === ']' ? 1 : -1)
    } else if (ev.key === 'Escape' && detail.isOpen() && !typing) {
      detail.close()
    } else if (ev.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.value = ''
      state.query = ''
      searchInput.blur()
      renderBody()
    }
  })
}

async function start(): Promise<void> {
  mount()
  await Promise.all([loadPrefs(),loadPriorities(), (async () => {
    try { journal = readWorkJournal(await orca.storage?.get?.(WORK_JOURNAL_KEY)) }
    catch { toast(t('작업 기억을 불러오지 못했어요. 새로고침해 주세요.'), 'err') }
  })()])
  renderTop()
  renderBody()
  orca.plugin?.on?.('pod.changed', (snap: Snapshot) => receive(snap))
  orca.plugin?.on?.('pod.control.view', (v: ControlView) => controller.receive(v))
  orca.plugin?.on?.('pod.progress.changed',()=>{void progress.refresh();dashboard.invalidate()})
  orca.plugin?.on?.('pod.priority.changed',()=>void loadPriorities().then(()=>{renderTop();renderBody()}))
  await sync(true)
  controller.observeWatch()
  // 이벤트가 오지 않는 변화(도구 호출, 메시지)를 위해 화면이 보일 때만 주기적으로 맞춘다.
  window.setInterval(() => {
    if (document.visibilityState === 'visible') {void sync();controller.observeWatch();dashboard.tick()}
  }, 4000)
  window.setInterval(tick, 10_000)
}

void start()
