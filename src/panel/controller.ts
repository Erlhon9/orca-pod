// 그래프에서 선택한 작업의 맥락과 질문·지시를 한 관제에서 이어간다.
import { currentLang, t, tt } from './i18n'
import { CONTROL_AGENTS, type ControlProvider, type ControlAgentOption } from '../control-agents'
import type { AgentView, Snapshot, WorkspaceView } from '../model'
import type { ChatItem } from '../transcript'
import { attachments, type AttachmentDraftItem } from './attach'
import { latestBriefing, readControlTurns, scopeKey, turnForItem, type ControlTurn } from '../control-turns'
import { workFingerprint, type WorkMemory } from '../work-memory'
import type { WorkPriority } from '../work-priority'
import { priorityBadge } from './priority-badge'
import { readQuestions } from '../questions'
import type { TopicPlan } from '../topic-plan'
import type { ControlPosition } from '../control-layout'
import type { WatchNote, WatchScope, WatchSettings } from '../control-watch'
import { addTarget, controlMessage, ControlMessageTooLongError, MissingControlTargetError, resolveTarget, targetKey, type ControlTarget } from './control-targets'
import { markdown, renderChat } from './chat'
import { fly, shake } from './fx'
import { closeMenu, hideHover, openMenu, openSheet, type MenuItem } from './overlays'
import { agoFull, avatar, clip, duration, fill, h, icon } from './ui'

export interface ControllerApi {
  snap(): Snapshot | null
  call<T = any>(name: string, input?: unknown, quiet?: boolean): Promise<T>
  toast(message: string, kind?: 'ok' | 'err'): void
  openUrl(url: string): void
  memory(id: string): WorkMemory | undefined
  source(w: WorkspaceView, a?: AgentView): void
  select(target: ControlTarget | null): void
  onOpen(open: boolean): void
  reviewTopics(plan: TopicPlan): void
  dockPosition(): ControlPosition
  setDockPosition(position: ControlPosition): void
  watchScope(): WatchScope
  history?():{key:string;empty?:boolean;content():HTMLElement}|null
  priority(w:WorkspaceView):WorkPriority|null
  editPriority(w:WorkspaceView,anchor:HTMLElement):void
}

export interface ControlView {
  provider?: ControlProvider
  terminal?: string | null
  items: ChatItem[]
  live: string
  busy: boolean
  since: number
  sessionId: string | null
  error: string | null
  rev?: number
  requestId?: string | null
  turns?: ControlTurn[]
  memoryError?: boolean
  topicPlan?: TopicPlan | null
  topicError?: string | null
  watch?: {settings:WatchSettings;notes:WatchNote[];error:string|null;saving:boolean}
}

const OPEN_KEY = 'pod.dock.open'
const EMPTY: ControlView = { items: [], live: '', busy: false, since: 0, sessionId: null, error: null, rev: 0 }

export function createController(api: ControllerApi) {
  const el = h('div', { class: 'dock control' })
  let view: ControlView = EMPTY
  let open = false
  try {
    open = localStorage.getItem(OPEN_KEY) === '1'
  } catch {}

  const head = h('div', { class: 'dk-row' })
  const previewEl = h('button', { class: 'dk-preview', title: t('펼치기') })
  const chatBox = h('div', { class: 'convo dk-chat' })
  const chatInner = h('div', { class: 'convo-inner' })
  chatBox.append(chatInner)
  const area = h('textarea', { rows: 1, placeholder: t('관제에게 (Enter 보내기 · Shift+Enter 줄바꿈)') }) as HTMLTextAreaElement
  const send = h('button', { class: 'send', title: t('보내기 (Enter)'), disabled: true }, icon('send')) as HTMLButtonElement
  const composer = h('div', { class: 'composer stack dk-composer' })
  const contextBox = h('section', { class: 'dk-context', 'aria-label': t('작업 맥락') })
  const draftNotice = h('div', { class: 'dk-draft-note', role: 'status' })
  const targetTray = h('div', { class: 'dk-targets', hidden: true, 'aria-label': t('선택한 대상') })
  let targets: ControlTarget[] = []
  const drafts = new Map<string, { text: string; images: AttachmentDraftItem[] }>()
  const briefings = new Map<string, ControlTurn | null>()
  let sendingKey: string | null = null
  let sending = false
  let changingProvider = false
  let checkingWatch=false
  const syncSend = () => {
    send.disabled = sending || changingProvider || view.busy || (!area.value.trim() && pics.count() === 0)
    const briefButton = contextBox.querySelector<HTMLButtonElement>('.dk-request-brief')
    if (briefButton) briefButton.disabled = sending || changingProvider || view.busy || !!area.value.trim() || pics.count() > 0 || view.provider !== 'claude' && view.provider !== 'codex'
    if(api.history?.())send.disabled=true
    const locked = !!api.history?.() || sending && sendingKey === scopeKey(targets)
    area.readOnly = locked
    pics.lock(locked)
  }
  function renderTargets(): void {
    targetTray.hidden = false
    targetTray.replaceChildren(...targets.map(target => {
      const resolved = resolveTarget(api.snap(), target)
      const w = resolved?.workspace
      const a = resolved?.agent
      const name = w?.name ?? t('선택한 대상을 찾을 수 없어요. 다시 선택해 주세요.')
      const label = a ? `${name} · ${a.title}` : name
      return h('div', { class: 'dk-target', 'data-target-key': targetKey(target), title: [w?.repo, name, a?.title].filter(Boolean).join(' › ') },
        a ? avatar(a, 'sm') : icon('folder'),
        h('span', { class: 'dk-target-label' }, label),
        h('button', { type: 'button', class: 'dk-target-remove', title: t('대상 빼기'), 'aria-label': t('{name} 빼기', { name: label }), onClick: () => {
          changeTargets(targets.filter(item => targetKey(item) !== targetKey(target)))
        } }, icon('x')))
    }))
    if (!targets.length) targetTray.append(h('span', { class: 'dk-global-scope' }, icon('layers'), t('전체 작업')))
    area.placeholder = targets.length ? t('선택한 대상에 관해 질문하거나 지시하세요…') : t('관제에게 (Enter 보내기 · Shift+Enter 줄바꿈)')
  }
  const pics = attachments(composer, area, { call: (n, i, q) => api.call(n, i, q), toast: (m, k) => api.toast(m, k), onChange: syncSend })
  composer.append(targetTray, pics.tray, h('div', { class: 'composer-row' }, pics.button, area, send))
  el.append(head, previewEl, contextBox, chatBox, draftNotice, composer)
  previewEl.addEventListener('click', () => setOpen(true))

  function setOpen(v: boolean): void {
    open = v
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0')
    } catch {}
    sig = ''
    if (!open) el.classList.remove('reading')
    update()
    api.onOpen(open)
  }

  function changeTargets(next: ControlTarget[], expand = false): void {
    if (scopeKey(next) !== scopeKey(targets)) {
      const saved = { text: area.value, images: pics.take() }
      const previous = scopeKey(targets)
      if (saved.text || saved.images.length) drafts.set(previous, saved)
      else drafts.delete(previous)
      targets = next
      const restored = drafts.get(scopeKey(next))
      drafts.delete(scopeKey(next))
      area.value = restored?.text ?? ''
      pics.restore(restored?.images ?? [])
      draftNotice.textContent = saved.text || saved.images.length ? t('이전 대상의 초안을 보관했어요. 다시 선택하면 이어 쓸 수 있어요.') : ''
      contextSig = ''
    }
    api.select(targets.length === 1 ? targets[0] : null)
    if (expand && !open) setOpen(true)
    else update()
    const key = scopeKey(targets)
    if (targets.length === 1 && !briefings.has(key)) {
      briefings.set(key, null)
      void api.call<ControlTurn | null>('pod.control.briefing', { targets: targets.map(x => ({ ...x })) }, true).then(value => {
        const saved = readControlTurns([value])[0]
        if (saved && saved.status === 'complete' && scopeKey(saved.targets) === key) briefings.set(key, saved)
        if (scopeKey(targets) === key) { contextSig = ''; renderContext(); syncSend() }
      }).catch(() => {})
    }
  }

  area.addEventListener('input', syncSend)
  const submit = async (kind: 'message' | 'briefing' = 'message') => {
    if (api.history?.() || send.disabled || sending) return
    const submitted = targets.map(target => ({ ...target }))
    const submittedKey = scopeKey(submitted)
    const submittedText = area.value
    sendingKey = submittedKey
    sending = true
    syncSend()
    try {
      const said = area.value.trim() || t(`사진 {n}장`, { n: pics.count() })
      controlMessage(api.snap(), submitted, submittedText)
      const images = await pics.images()
      const workspace = submitted.length === 1 ? resolveTarget(api.snap(), submitted[0])?.workspace : null
      await api.call('pod.control.send', { text: submittedText, images, scope: { targets: submitted, displayText: kind === 'briefing' ? t('작업 맥락을 정리해줘') : submittedText, kind, sourceVersion: workspace ? workFingerprint(workspace) : '' } })
      fly(area.getBoundingClientRect(), head.getBoundingClientRect(), said)
      if (scopeKey(targets) === submittedKey) { area.value = ''; pics.clear() }
      else {
        for (const image of drafts.get(submittedKey)?.images ?? []) URL.revokeObjectURL(image.thumb)
        drafts.delete(submittedKey)
      }
      stick = true
    } catch (error) {
      if (error instanceof MissingControlTargetError) api.toast(t('선택한 대상을 찾을 수 없어요. 다시 선택해 주세요.'), 'err')
      if (error instanceof ControlMessageTooLongError) api.toast(t('내용이 너무 길어요. 대상이나 메시지를 줄여 주세요.'), 'err')
    } finally {
      sending = false
      sendingKey = null
      syncSend()
    }
  }
  send.addEventListener('click', () => void submit())
  // Enter 로 보내고 Shift+Enter 로 줄을 바꾼다. 한글 조합 중의 Enter 는 조합 확정이라 보내지 않는다.
  area.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault()
      void submit()
    } else if (ev.key === 'Escape') area.blur()
  })

  /* ---------- 대화 ---------- */
  let sig = ''
  let stick = true
  const openGroups = new Set<string>()
  chatBox.addEventListener('scroll', () => {
    stick = chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40
  })

  function renderChatBox(): void {
    if (!open) return
    const requestKind=view.turns?.find(turn=>turn.id===view.requestId)?.kind
    const topicRequest = requestKind==='topics' || requestKind==='watch'
    const notes=view.watch?.notes??[]
    const visible=view.items.filter(item=>item.controlKind!=='watch' && turnForItem(item,view.turns??[])?.kind!=='watch')
    const saved:ChatItem[]=notes.map(note=>({k:'text',text:note.answer,at:note.at,requestId:note.id}))
    const items = (view.live && !topicRequest ? [...visible,...saved, { k: 'text' as const, text: view.live, at: Date.now(), requestId: view.requestId ?? undefined }] : [...visible,...saved]).sort((a,b)=>a.at-b.at).map(item => {
      const turn = turnForItem(item, view.turns ?? [])
      if (item.k !== 'text' || turn?.kind !== 'topics') return item
      return { ...item, text: turn.id === view.requestId && view.topicError ? tt(view.topicError) : turn.status === 'complete' ? t('주제 분류안이 준비됐어요.') : turn.status === 'running' ? t('주제 정리 중…') : t('주제 정리를 마치지 못했어요.') }
    })
    const next = `${view.provider ?? 'claude'}|${view.rev ?? 0}|${items.length}|${view.live.length}|${view.busy}|${view.topicError ?? ''}|${notes.map(note=>note.id).join(',')}|${(view.turns ?? []).map(x => x.id + x.status).join(',')}`
    if (next === sig) return
    sig = next
    const scroll = chatBox.scrollTop
    chatInner.replaceChildren(
      ...renderChat(items, { working: view.busy, workingSince: view.since, truncated: false, open: openGroups, onLink: (u) => api.openUrl(u), scope: item => {
        const turn = turnForItem(item, view.turns ?? [])
        const note=notes.find(note=>note.id===item.requestId)
        if(note) return {label:`${tt(note.label)} · ${agoFull(note.at)}`}
        return turn ? { label: turn.kind !== 'topics' && turn.kind!=='watch' && Array.isArray(turn.targets) && !turn.targets.length ? t('전체 작업') : tt(turn.label), text: item.k === 'user' ? turn.displayText : undefined } : null
      } })
    )
    if (stick) chatBox.scrollTop = chatBox.scrollHeight
    else chatBox.scrollTop = scroll
  }

  /* ---------- 그리기 ---------- */
  async function checkWatch(manual=false):Promise<void> {
    if(api.history?.())return
    const settings=view.watch?.settings
    if(checkingWatch || view.busy || sending || changingProvider || view.watch?.saving) return
    if(!manual && (!settings || !settings.intervalMinutes && !settings.changes || document.visibilityState==='hidden' || area.value.trim() || pics.count())) return
    if(view.provider!=='claude' && view.provider!=='codex') return
    checkingWatch=true
    if(manual) {hideHover();setOpen(true)}
    try {
      const scope=manual || settings?.scopeMode==='current' ? api.watchScope() : {repoId:null,topicKey:null}
      const result=await api.call<{started:boolean;reason:string}>('pod.control.watch.check',{scope,manual,language:currentLang()},!manual)
      if(manual && !result.started && result.reason==='busy') api.toast(t('관제가 답하는 중입니다'),'err')
    } catch {} finally {checkingWatch=false;update()}
  }

  function watchSettings():void {
    const settings=view.watch?.settings??{intervalMinutes:0,changes:false,scopeMode:'all'}
    const periodic=h('input',{type:'checkbox'}) as HTMLInputElement
    periodic.checked=settings.intervalMinutes>0
    const interval=h('input',{type:'number',min:1,max:240,'aria-label':t('브리핑 간격(분)')}) as HTMLInputElement
    interval.value=String(settings.intervalMinutes||15);interval.disabled=!periodic.checked
    periodic.addEventListener('change',()=>{interval.disabled=!periodic.checked})
    const changes=h('input',{type:'checkbox'}) as HTMLInputElement
    changes.checked=settings.changes
    const scope=h('select',{'aria-label':t('자동 브리핑 범위')},h('option',{value:'all'},t('전체 프로젝트')),h('option',{value:'current'},t('현재 보는 범위'))) as HTMLSelectElement
    scope.value=settings.scopeMode
    openSheet({title:t('브리핑 설정'),body:[
      h('label',{class:'watch-setting'},periodic,t('정기 브리핑')),
      h('label',{class:'watch-setting'},t('브리핑 간격(분)'),interval),
      h('label',{class:'watch-setting'},changes,t('중요한 변화 알림')),
      h('label',{class:'watch-setting'},t('자동 브리핑 범위'),scope)
    ],submitLabel:t('저장'),onSubmit:async()=>{
      const minutes=periodic.checked?Number(interval.value):0
      if(!Number.isInteger(minutes) || periodic.checked && (minutes<1 || minutes>240)) throw new Error(t('브리핑 간격은 1~240분으로 입력하세요'))
      const next=await api.call<WatchSettings>('pod.control.watch.configure',{intervalMinutes:minutes,changes:changes.checked,scopeMode:scope.value})
      view.watch={settings:next,notes:view.watch?.notes??[],error:view.watch?.error??null,saving:false}
      update();void checkWatch()
    }})
  }

  let headSig = ''
  let agentChoices: ControlAgentOption[] = CONTROL_AGENTS.map(agent => ({ id: agent.id, label: agent.label, mode: agent.id === 'claude' || agent.id === 'codex' ? 'embedded' : 'terminal', detected: false }))
  // macOS/WKWebView 기본 select 팝업은 iframe 밖의 잘못된 좌표에 뜰 수 있어 패널 메뉴를 쓴다.
  const providerSelect = h('button', { type: 'button', class: 'dk-agent-select', title: t('관제 에이전트'), 'aria-label': t('관제 에이전트'), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }) as HTMLButtonElement
  function renderAgentOptions(): void {
    const selected = agentChoices.find(agent => agent.id === (view.provider ?? 'claude'))
    providerSelect.replaceChildren(h('span', { class: 'dk-agent-label' }, selected?.label ?? view.provider ?? 'Claude'), icon('chevron'))
  }
  async function chooseAgent(provider: ControlProvider): Promise<void> {
    if(api.history?.())return
    if (changingProvider || (view.provider ?? 'claude') === provider) return
    changingProvider = true
    syncSend()
    update()
    try { receive(await api.call<ControlView>('pod.control.provider', { provider })) }
    catch {}
    finally { changingProvider = false; update() }
  }
  providerSelect.addEventListener('click', () => {
    if (providerSelect.classList.contains('menu-open')) return closeMenu()
    const items: MenuItem[] = []
    for (const detected of [true, false]) {
      const group = agentChoices.filter(agent => agent.detected === detected)
      if (!group.length) continue
      items.push({ section: detected ? t('감지된 에이전트') : t('다른 Orca 에이전트') })
      for (const agent of group) items.push({
        label: agent.label, hint: agent.mode === 'embedded' ? t('패널') : t('Orca 터미널'),
        icon: agent.id === (view.provider ?? 'claude') ? 'check' : undefined,
        checked: agent.id === (view.provider ?? 'claude'), onSelect: () => void chooseAgent(agent.id)
      })
    }
    openMenu(providerSelect, items, providerSelect, { maxHeight: 360, keyboard: true })
  })
  renderAgentOptions()
  void api.call<ControlAgentOption[]>('pod.control.agents', {}, true).then(agents => {
    if (Array.isArray(agents) && agents.length) { agentChoices = agents; renderAgentOptions() }
  }).catch(() => {})
  function renderHead(): void {
    renderAgentOptions()
    providerSelect.disabled = changingProvider||!!api.history?.()
    const reading=el.classList.contains('reading')
    const positionLabels={bottom:t('아래쪽'),right:t('오른쪽'),left:t('왼쪽'),auto:t('자동')}
    const positionIcons={bottom:'dockBottom',right:'dockRight',left:'dockLeft',auto:'dockAuto'}
    const key = `${!!api.history?.()}|${view.provider}|${view.busy}|${!!view.items.length}|${!!view.sessionId}|${view.terminal}|${changingProvider}|${sending}|${checkingWatch}|${view.watch?.saving}|${open}|${api.dockPosition()}|${reading}`
    if (key === headSig) return
    headSig = key
    const stop = view.busy
      ? h(
          'button',
          {
            class: 'key danger',
            disabled:!!api.history?.(),
            title: t('중단'),
            onClick: () => void api.call('pod.control.stop', {}).then(() => api.toast(t('중단했습니다')))
          },
          t('중단')
        )
      : null
    fill(
      head,
      h('span', { class: 'dk-badge' }, icon('sparkle')),
      h('b', { class: 'dk-name' }, t('관제')),
      providerSelect,
      h('button',{class:'pill-btn dk-brief-now',title:t('현재 범위 브리핑'),disabled:!!api.history?.()||view.busy||sending||changingProvider||checkingWatch||view.watch?.saving||view.provider!=='claude'&&view.provider!=='codex',onClick:()=>void checkWatch(true)},icon('sparkle'),t('지금 브리핑')),
      view.terminal ? h('button', { class: 'key',disabled:!!api.history?.(), title: t('Orca에서 관제 열기'), onClick: () => void api.call('pod.control.open', {}) }, t('Orca에서 열기')) : null,
      view.busy
        ? h('span', { class: 'state-pill', 'data-state': 'working' }, h('i'), t('작업 중'))
        : view.items.length
          ? h('span', { class: 'state-pill', 'data-state': 'idle' }, h('i'), t('대기'))
          : null,
      view.busy && view.since ? h('span', { class: 'when', 'data-dur': view.since }, duration(view.since)) : null,
      h('span', { class: 'spacer' }),
      stop,
      h('div',{class:'dk-actions'},
      h('button',{class:'icon-btn dk-position',title:t('관제 위치: {position}',{position:positionLabels[api.dockPosition()]}),'aria-label':t('관제 위치: {position}',{position:positionLabels[api.dockPosition()]}),'aria-haspopup':'menu','data-position':api.dockPosition(),onClick:(event:MouseEvent)=>{
        openMenu(event.currentTarget as Element,[{section:t('관제 위치')},...([
          ['bottom',t('아래쪽')],['right',t('오른쪽')],['left',t('왼쪽')],['auto',t('자동')]
        ] as const).map(([position,label])=>({label,icon:positionIcons[position],checked:api.dockPosition()===position,onSelect:()=>api.setDockPosition(position)}))])
      }},icon(positionIcons[api.dockPosition()])),
      open ? h('button', { class: 'icon-btn dk-read', title: reading?t('크게 보기 끝내기'):t('크게 보기'),'aria-label':reading?t('크게 보기 끝내기'):t('크게 보기'),'aria-pressed':String(reading), onClick: () => {
        el.classList.toggle('reading')
        update()
        api.onOpen(open)
      } }, icon(reading?'restore':'expand')) : null,
      h('button',{
        class:'icon-btn dk-more',title:t('관제 메뉴'),'aria-label':t('관제 메뉴'),'aria-haspopup':'menu','aria-expanded':'false',
        onClick:(event:MouseEvent)=>openMenu(event.currentTarget as Element,[
          {label:t('브리핑 설정'),icon:'gear',onSelect:watchSettings},
          ...(view.items.length || view.sessionId || view.terminal ? ['sep' as const,{
          label:t('새 대화'),icon:'message',disabled:!!api.history?.()||view.busy || sending || changingProvider,
          onSelect:()=>{ if (!view.busy && !sending && !changingProvider) void api.call('pod.control.reset',{}) }
        }]:[])],event.currentTarget as Element,{keyboard:true})
      },icon('more')),
      h('button', { class: 'icon-btn dk-fold', title: open ? t('접기') : t('펼치기'),'aria-label':open?t('접기'):t('펼치기'),'aria-expanded':String(open), onClick: () => setOpen(!open) }, icon('chevron')))
    )
  }

  function renderPreview(): void {
    if (open) return previewEl.replaceChildren()
    if (view.error) {
      previewEl.dataset.kind = 'prompt'
      return fill(previewEl, h('span', { class: 'dk-pk' }, icon('alert'), tt(view.error)))
    }
    previewEl.dataset.kind = 'msg'
    if (view.busy) {
      if (view.turns?.find(turn => turn.id === view.requestId)?.kind === 'topics')
        return previewEl.replaceChildren(h('span', {class:'dk-text muted'}, t('주제 정리 중…')))
      const tools = view.items.filter((i) => i.k === 'tool' && i.at >= view.since)
      const lastTool = tools[tools.length - 1]
      if (view.live) return previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(view.live.replace(/\s+/g, ' ').slice(-240), 240)))
      if (lastTool && lastTool.k === 'tool')
        return previewEl.replaceChildren(h('span', { class: 'dk-tool' }, lastTool.name), h('span', { class: 'dk-text' }, lastTool.detail))
      return previewEl.replaceChildren(h('span', { class: 'dk-text muted' }, t('생각 중')))
    }
    const lastText = [...view.items,...(view.watch?.notes??[]).map(note=>({k:'text' as const,text:note.answer,at:note.at,requestId:note.id}))].sort((a,b)=>a.at-b.at).reverse().find((i) => i.k === 'text')
    const turn = lastText && turnForItem(lastText, view.turns ?? [])
    if (turn?.kind === 'topics') return previewEl.replaceChildren(h('span', {class:'dk-text'},
      turn.id === view.requestId && view.topicError ? tt(view.topicError) : turn.status === 'complete' ? t('주제 분류안이 준비됐어요.') : t('주제 정리를 마치지 못했어요.')))
    if (lastText && lastText.k === 'text') previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(lastText.text.replace(/\s+/g, ' '), 240)))
    else previewEl.replaceChildren()
  }

  async function organize(repoId: string): Promise<void> {
    if(api.history?.())return
    if (sending || changingProvider || view.busy) { api.toast(t('관제가 답하는 중입니다'), 'err'); return }
    hideHover()
    setOpen(true)
    sending = true
    sendingKey = null
    syncSend()
    update()
    try {
      await api.call('pod.control.send', {text:t('현재 프로젝트의 주제와 하위 주제를 정리해줘'), scope:{kind:'topics',repoId,targets:[]}})
    } catch {} finally { sending = false; syncSend(); update() }
  }

  let contextSig = ''
  function renderContext(): void {
    const history=api.history?.()
    if(history) {
      if(contextSig===history.key)return
      const opened=new Set([...contextBox.querySelectorAll<HTMLDetailsElement>('details[open]')].map(d=>d.dataset.eventId))
      const scroll=contextBox.scrollTop
      contextSig=history.key;contextBox.replaceChildren(history.content())
      for(const d of contextBox.querySelectorAll<HTMLDetailsElement>('details'))if(opened.has(d.dataset.eventId))d.open=true
      contextBox.scrollTop=scroll
      return
    }
    const resolved = targets.length === 1 ? resolveTarget(api.snap(), targets[0]) : null
    const w = resolved?.workspace
    const a = resolved?.agent
    const recent = latestBriefing(view.turns ?? [], targets)
    const saved = briefings.get(scopeKey(targets))
    const brief = recent && (!saved || (recent.endedAt ?? 0) >= (saved.endedAt ?? 0)) ? recent : saved
    const memory = w ? api.memory(w.id) : undefined
    const next = JSON.stringify([scopeKey(targets), w && workFingerprint(w),w&&api.priority(w), memory, brief, view.busy, view.provider, view.memoryError, view.topicPlan, view.topicError,view.watch?.error,api.snap()?.repos.map(repo=>[repo.id,repo.name])])
    if (next === contextSig) return
    contextSig = next
    const wasOpen = contextBox.querySelector('details')?.open
    const scroll = contextBox.dataset.scope === scopeKey(targets) ? contextBox.scrollTop : 0
    const source = w ? h('button', { class: 'mini-btn dk-source', onClick: () => api.source(w, a) }, icon('book'), t('원문 보기')) : null
    const nodes: (HTMLElement | null)[] = []
    if (targets.length === 1 && !w) {
      nodes.push(h('p', { class: 'muted' }, t('선택한 대상을 찾을 수 없어요. 다시 선택해 주세요.')))
    } else if (w) {
      const priority=api.priority(w)
      nodes.push(h('div', { class: 'dk-context-head' },h('div',{class:'dk-priority-title'},priority?priorityBadge(priority,anchor=>api.editPriority(w,anchor)):null,h('strong', null, a?.title || w.name)), source))
      if(priority)nodes.push(h('small',{class:'dk-priority-reason'},tt(priority.reason)))
      if (brief) {
        const details = h('details', { class: 'dk-briefing' },
          h('summary', null, clip(brief.answer.replace(/[#*`]/g, '').replace(/\s+/g, ' '), 190)), markdown(brief.answer)) as HTMLDetailsElement
        details.open = wasOpen ?? false
        nodes.push(details, h('small', { class: 'muted' }, t('브리핑 {when}', { when: agoFull(brief.endedAt ?? brief.startedAt) }), brief.sourceVersion !== workFingerprint(w) ? t(' · 이후 변경이 있어요') : ''))
      } else {
        if (memory?.goal || w.comment) nodes.push(h('p', { class: 'dk-context-note' }, clip(memory?.goal || w.comment, 300)))
        if (memory?.note) nodes.push(h('p', { class: 'muted' }, clip(memory.note, 240)))
        if (w.pr) nodes.push(h('p', { class: 'dk-context-meta' }, `PR #${w.pr.number} · ${w.pr.state} · ${w.pr.checks ?? ''}`))
        const questions = (a ? [a] : w.agents).flatMap(agent => agent.state === 'waiting' && agent.tool?.name === 'AskUserQuestion' ? readQuestions(agent.tool.input) : [])
        if (questions.length) nodes.push(h('p', { class: 'dk-context-question' }, questions.map(q => q.question).join(' / ')))
        else if (memory?.nextStep) nodes.push(h('p', { class: 'dk-context-question' }, memory.nextStep))
      }
      const requestBrief = h('button', { class: 'pill-btn dk-request-brief', title: view.provider !== 'claude' && view.provider !== 'codex' ? t('조회 전용 맥락 정리는 Claude 또는 Codex 관제에서 사용할 수 있어요.') : undefined, disabled: view.busy || sending || changingProvider || !!area.value.trim() || pics.count() > 0 || view.provider !== 'claude' && view.provider !== 'codex', onClick: () => {
        area.value = t('선택한 작업과 세션의 읽을 수 있는 기록을 확인하고, 목적과 제약, 중요한 결정과 이유, 현재 확인된 결과, 남은 판단과 다음 행동을 짧게 정리해줘. 출처와 읽지 못한 범위를 밝혀줘. 최근 발언을 최초 목표로 추정하거나 완료 주장을 검증 결과로 바꾸지 마. 이번 요청은 조회만 하고 세션에 지시를 보내지 마.')
        syncSend()
        void submit('briefing')
      } }, icon('sparkle'), brief ? t('브리핑 갱신') : t('맥락 정리')) as HTMLButtonElement
      nodes.push(h('div', { class: 'dk-context-actions' }, requestBrief,
        h('button', { class: 'mini-btn', onClick: () => { if (area.readOnly) return; area.value = t('이 작업에서 왜 이 방향으로 결정했는지 근거와 함께 설명해줘.'); syncSend(); area.focus() } }, t('결정 배경 질문'))))
    }
    if (view.topicPlan) {
      const plan = view.topicPlan
      const repo = api.snap()?.repos.find(repo => repo.id === plan.repoId)
      nodes.unshift(h('div', { class: 'dk-topic-proposal' },
        h('strong', null, t('{name} 주제 분류안', {name:repo?.name ?? plan.repoId})),
        h('button', {class:'pill-btn primary', onClick:()=>api.reviewTopics(plan)}, t('검토'))))
    }
    if (view.topicError) nodes.unshift(h('p', {class:'dk-topic-error'}, tt(view.topicError)))
    if (view.watch?.error) nodes.unshift(h('p',{class:'dk-watch-error'},tt(view.watch.error)))
    if (view.memoryError) nodes.push(h('p', { class: 'muted' }, t('브리핑을 보관하지 못했어요. 다시 열면 이번 결과가 없을 수 있어요.')))
    contextBox.replaceChildren(...nodes.filter((node): node is HTMLElement => !!node))
    contextBox.dataset.scope = scopeKey(targets)
    contextBox.scrollTop = scroll
  }

  function update(): void {
    el.classList.toggle('open', open)
    el.dataset.history=String(!!api.history?.())
    el.dataset.state = view.busy ? 'working' : ''
    el.dataset.empty = String(api.history?.()?!!api.history()?.empty:!view.items.length && !view.watch?.notes?.length && !view.live && !view.busy)
    // 받은 대화 항목이 이상해도 관제 줄이 멈추지 않게 한다.
    try {
      renderHead()
      renderTargets()
      renderContext()
      renderPreview()
      renderChatBox()
    } catch {
      sig = ''
    }
    syncSend()
  }

  let lastError: string | null = null
  function receive(v: ControlView): void {
    const wasBusy = view.busy
    // 모양이 다른 값이 와도 화면 갱신이 깨지지 않게 기본값으로 채운다.
    view = { ...EMPTY, ...(v && typeof v === 'object' ? v : {}), items: Array.isArray(v?.items) ? v.items : [] }
    for (const turn of view.turns ?? []) {
      if (turn.kind !== 'briefing' || turn.status !== 'complete' || !turn.answer) continue
      const key = scopeKey(turn.targets)
      const previous = briefings.get(key)
      if (!previous || (turn.endedAt ?? 0) >= (previous.endedAt ?? 0)) briefings.set(key, turn)
    }
    if (view.error && view.error !== lastError && view.turns?.find(turn=>turn.id===view.requestId)?.kind!=='watch') api.toast(tt(view.error), 'err')
    lastError = view.error
    update()
    // 답을 마치면 접혀 있어도 살짝 흔들어 알린다.
    if (wasBusy && !view.busy && !open) shake(el)
    void checkWatch()
  }

  queueMicrotask(update)
  void api
    .call<ControlView>('pod.control.view', {}, true)
    .then(receive)
    .catch(() => {})

  return {
    el,
    update,
    receive,
    focus: () => {
      if (el.classList.contains('off')) return
      area.focus()
    },
    organize,
    show:()=>setOpen(true),
    observeWatch:()=>void checkWatch(),
    canOrganize: () => !sending && !changingProvider && !view.busy && (view.provider === 'claude' || view.provider === 'codex'),
    busy: () => sending || changingProvider || view.busy,
    selection: () => targets.length === 1 ? targets[0] : null,
    select(w: WorkspaceView, a?: AgentView) {
      hideHover()
      changeTargets([{ workspaceId: w.id, sessionKey: a?.key ?? null }], true)
    },
    insert(w: WorkspaceView, a?: AgentView) {
      changeTargets(addTarget(targets, { workspaceId: w.id, sessionKey: a?.key ?? null }), true)
    }

  }
}
