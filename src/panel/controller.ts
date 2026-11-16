// 메인 화면 아래의 관제 줄. 관제는 Pod 워커가 직접 띄운 Claude 이고(Orca 터미널을 거치지 않음),
// 대화·입력은 여기서 그린다. 접으면 상태와 마지막 답 한 줄, 펼치면 대화 전체. 답은 글자 단위로 흘러나온다.
import { t, tt } from './i18n'
import { CONTROL_AGENTS, type ControlProvider, type ControlAgentOption } from '../control-agents'
import type { AgentView, Snapshot, WorkspaceView } from '../model'
import type { ChatItem } from '../transcript'
import { attachments } from './attach'
import { addTarget, controlMessage, ControlMessageTooLongError, MissingControlTargetError, resolveTarget, targetKey, type ControlTarget } from './control-targets'
import { renderChat } from './chat'
import { fly, shake } from './fx'
import { closeMenu, openMenu, type MenuItem } from './overlays'
import { avatar, clip, duration, fill, h, icon } from './ui'

export interface ControllerApi {
  snap(): Snapshot | null
  call<T = any>(name: string, input?: unknown, quiet?: boolean): Promise<T>
  toast(message: string, kind?: 'ok' | 'err'): void
  openUrl(url: string): void
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
  const targetTray = h('div', { class: 'dk-targets', hidden: true, 'aria-label': t('선택한 대상') })
  let targets: ControlTarget[] = []
  let sending = false
  let changingProvider = false
  const syncSend = () => {
    send.disabled = sending || changingProvider || view.busy || (!area.value.trim() && pics.count() === 0)
    targetTray.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.disabled = sending)
  }
  function renderTargets(): void {
    targetTray.hidden = targets.length === 0
    targetTray.replaceChildren(...targets.map(target => {
      const resolved = resolveTarget(api.snap(), target)
      const w = resolved?.workspace
      const a = resolved?.agent
      const name = w?.name ?? t('세션')
      const label = a ? `${name} · ${a.title}` : name
      return h('div', { class: 'dk-target', 'data-target-key': targetKey(target), title: [w?.repo, name, a?.title].filter(Boolean).join(' › ') },
        a ? avatar(a, 'sm') : icon('folder'),
        h('span', { class: 'dk-target-label' }, label),
        h('button', { type: 'button', class: 'dk-target-remove', title: t('대상 빼기'), 'aria-label': t('{name} 빼기', { name: label }), disabled: sending, onClick: () => {
          if (sending) return
          targets = targets.filter(item => targetKey(item) !== targetKey(target))
          renderTargets()
          area.focus()
        } }, icon('x')))
    }))
  }
  const pics = attachments(composer, area, { call: (n, i, q) => api.call(n, i, q), toast: (m, k) => api.toast(m, k), onChange: syncSend })
  composer.append(targetTray, pics.tray, h('div', { class: 'composer-row' }, pics.button, area, send))
  el.append(head, previewEl, chatBox, composer)
  previewEl.addEventListener('click', () => setOpen(true))

  function setOpen(v: boolean): void {
    open = v
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0')
    } catch {}
    stick = true
    sig = ''
    update()
  }

  area.addEventListener('input', syncSend)
  const submit = async () => {
    if (send.disabled || sending) return
    sending = true
    syncSend()
    area.readOnly = true
    pics.lock(true)
    try {
      const said = area.value.trim() || t(`사진 {n}장`, { n: pics.count() })
      const text = controlMessage(api.snap(), targets, area.value)
      const images = await pics.images()
      await api.call('pod.control.send', { text, images })
      fly(area.getBoundingClientRect(), head.getBoundingClientRect(), said)
      area.value = ''
      pics.clear()
      targets = []
      renderTargets()
      stick = true
    } catch (error) {
      if (error instanceof MissingControlTargetError) api.toast(t('선택한 대상을 찾을 수 없어요. 다시 선택해 주세요.'), 'err')
      if (error instanceof ControlMessageTooLongError) api.toast(t('내용이 너무 길어요. 대상이나 메시지를 줄여 주세요.'), 'err')
    } finally {
      sending = false
      area.readOnly = false
      pics.lock(false)
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
    const items = view.live ? [...view.items, { k: 'text' as const, text: view.live, at: Date.now() }] : view.items
    const next = `${view.provider ?? 'claude'}|${view.rev ?? 0}|${items.length}|${view.live.length}|${view.busy}|${showGuide}`
    if (next === sig) return
    sig = next
    if (!items.length || showGuide) {
      chatInner.replaceChildren(guide())
      if (showGuide) chatBox.scrollTop = 0
      return
    }
    chatInner.replaceChildren(
      ...renderChat(items, { working: view.busy, workingSince: view.since, truncated: false, open: openGroups, onLink: (u) => api.openUrl(u) })
    )
    if (stick) chatBox.scrollTop = chatBox.scrollHeight
  }

  /* ---------- 그리기 ---------- */
  let armed = 0
  let headSig = ''
  let agentChoices: ControlAgentOption[] = CONTROL_AGENTS.map(agent => ({ id: agent.id, label: agent.label, mode: agent.id === 'claude' || agent.id === 'codex' ? 'embedded' : 'terminal', detected: false }))
  // macOS/WKWebView 기본 select 팝업은 iframe 밖의 잘못된 좌표에 뜰 수 있어 패널 메뉴를 쓴다.
  const providerSelect = h('button', { type: 'button', class: 'dk-agent-select', title: t('관제 에이전트'), 'aria-label': t('관제 에이전트'), 'aria-haspopup': 'menu', 'aria-expanded': 'false' }) as HTMLButtonElement
  function renderAgentOptions(): void {
    const selected = agentChoices.find(agent => agent.id === (view.provider ?? 'claude'))
    providerSelect.replaceChildren(h('span', { class: 'dk-agent-label' }, selected?.label ?? view.provider ?? 'Claude'), icon('chevron'))
  }
  async function chooseAgent(provider: ControlProvider): Promise<void> {
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
    providerSelect.disabled = changingProvider
    const key = `${view.provider}|${view.busy}|${!!view.items.length}|${!!view.sessionId}|${view.terminal}|${showGuide}|${changingProvider}`
    if (key === headSig) return
    headSig = key
    const stop = view.busy
      ? h(
          'button',
          {
            class: 'key danger',
            title: t('중단'),
            onClick: () => void api.call('pod.control.stop', {}).then(() => api.toast(t('중단했습니다')))
          },
          t('중단')
        )
      : null
    const fresh = h('button', { class: 'icon-btn', title: t('새 대화 (두 번 누르기)') }, icon('plus'))
    fresh.addEventListener('click', () => {
      if (!armed) {
        fresh.classList.add('armed')
        armed = window.setTimeout(() => {
          armed = 0
          fresh.classList.remove('armed')
        }, 2000)
        return
      }
      window.clearTimeout(armed)
      armed = 0
      void api.call('pod.control.reset', {})
    })
    fill(
      head,
      h('span', { class: 'dk-badge' }, icon('sparkle')),
      h('b', { class: 'dk-name' }, t('관제')),
      providerSelect,
      view.terminal ? h('button', { class: 'key', title: t('Orca에서 관제 열기'), onClick: () => void api.call('pod.control.open', {}) }, t('Orca에서 열기')) : null,
      view.busy
        ? h('span', { class: 'state-pill', 'data-state': 'working' }, h('i'), t('작업 중'))
        : view.items.length
          ? h('span', { class: 'state-pill', 'data-state': 'idle' }, h('i'), t('대기'))
          : null,
      view.busy && view.since ? h('span', { class: 'when', 'data-dur': view.since }, duration(view.since)) : null,
      h('span', { class: 'spacer' }),
      stop,
      h(
        'button',
        {
          class: `icon-btn${showGuide ? ' on' : ''}`,
          title: t('사용법'),
          onClick: () => {
            showGuide = !showGuide
            sig = ''
            if (showGuide && !open) setOpen(true)
            else update()
          }
        },
        h('span', { class: 'dk-q' }, '?')
      ),
      view.items.length || view.sessionId || view.terminal ? fresh : null,
      h('button', { class: 'icon-btn dk-fold', title: open ? t('접기') : t('펼치기'), onClick: () => setOpen(!open) }, icon('chevron'))
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
      const tools = view.items.filter((i) => i.k === 'tool' && i.at >= view.since)
      const lastTool = tools[tools.length - 1]
      if (view.live) return previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(view.live.replace(/\s+/g, ' ').slice(-240), 240)))
      if (lastTool && lastTool.k === 'tool')
        return previewEl.replaceChildren(h('span', { class: 'dk-tool' }, lastTool.name), h('span', { class: 'dk-text' }, lastTool.detail))
      return previewEl.replaceChildren(h('span', { class: 'dk-text muted' }, t('생각 중')))
    }
    const lastText = [...view.items].reverse().find((i) => i.k === 'text')
    if (lastText && lastText.k === 'text') previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(lastText.text.replace(/\s+/g, ' '), 240)))
    else {
      // 아직 주고받은 게 없으면 쓰는 법을 한 줄로.
      previewEl.dataset.kind = 'msg'
      previewEl.replaceChildren(h('span', { class: 'dk-text muted' }, t('모든 세션을 보고 지시를 전달하는 관제예요. 세션 줄의 ✦ 로 대상을 넣고 할 말을 쓰세요 — 펼쳐서 사용법 보기')))
    }
  }

  /** 사용법(대화가 없을 때 펼친 화면, 머리의 ? 버튼). 예시는 누르면 입력창에 들어간다. */
  function guide(): HTMLElement {
    const example = (text: string) =>
      h(
        'button',
        {
          class: 'dk-ex',
          onClick: () => {
            area.value = text
            syncSend()
            area.focus()
          }
        },
        text
      )
    return h(
      'div',
      { class: 'dk-guide' },
      h('div', { class: 'dk-guide-head' }, h('span', { class: 'dk-badge' }, icon('sparkle')), h('b', null, t('관제'))),
      h('p', null, t('모든 세션의 상태를 보고, 다른 세션에 지시나 대화를 대신 전달해요. 위에서 관제 에이전트를 선택하세요. 사용량이 소진되면 다른 에이전트로 바꿔 대화를 이어갈 수 있어요.')),
      h(
        'ol',
        null,
        h('li', null, t('그래프 카드의 세션 줄에 올리거나 세션 목록을 열고 '), h('span', { class: 'dk-key' }, '✦'), t(' 버튼을 누르면 대상 칩이 추가돼요.')),
        h('li', null, t('할 말을 이어 쓰고 '), h('span', { class: 'dk-key' }, 'Enter'), t('. 줄바꿈은 '), h('span', { class: 'dk-key' }, 'Shift+Enter'), t(', 사진은 붙여넣기·끌어놓기.')),
        h('li', null, t('이름으로 말해도 돼요. 대상이 애매하면 관제가 되물어요.'))
      ),
      h('div', { class: 'dk-guide-sub' }, t('예시')),
      h(
        'div',
        { class: 'dk-exs' },
        example(t('승인 대기·답변 대기 중인 세션 알려줘')),
        example(t('작업 중인 세션들 지금 뭐 하는지 한 줄씩 요약해줘')),
        example(t('이 세션 대화 요약해서 저 세션에 전달해줘: '))
      ),
      h(
        'div',
        { class: 'dk-guide-sub' },
        t('보낼 수 있는 곳')
      ),
      h(
        'ul',
        null,
        h('li', null, t('에이전트 터미널 세션 — 입력창에 지시를 전달해요')),
        h('li', null, (view.provider ?? 'claude') === 'claude' ? t('Claude 대화창 — Claude 관제에서 쪽지로 전달해요. Codex 대화창에는 보낼 수 없어요') : view.provider === 'codex' ? t('대화창 — 최근 요청·답변을 조회할 수 있지만 Codex 관제에서 전달은 지원하지 않아요') : t('이 에이전트는 Orca 터미널에서 실행돼요. 로그인·승인은 Orca에서 처리하세요')),
        h('li', null, t('셸 터미널에는 보내지 않아요. 관제는 코드를 고치지 않고 orca 조회·보내기만 해요'))
      )
    )
  }

  let showGuide = false

  function update(): void {
    el.classList.toggle('open', open)
    el.dataset.state = view.busy ? 'working' : ''
    // 받은 대화 항목이 이상해도 관제 줄이 멈추지 않게 한다.
    try {
      renderHead()
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
    if (view.error && view.error !== lastError) api.toast(tt(view.error), 'err')
    lastError = view.error
    update()
    // 답을 마치면 접혀 있어도 살짝 흔들어 알린다.
    if (wasBusy && !view.busy && !open) shake(el)
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
    /** 대상은 칩으로 모으고 사용자가 작성 중인 글은 그대로 둔다. */
    insert(w: WorkspaceView, a?: AgentView) {
      if (sending) return
      targets = addTarget(targets, { workspaceId: w.id, sessionKey: a?.key ?? null })
      renderTargets()
      syncSend()
      area.focus()
      composer.classList.remove('got-ref')
      void composer.offsetWidth
      composer.classList.add('got-ref')
      area.setSelectionRange(area.value.length, area.value.length)
    }
  }
}
