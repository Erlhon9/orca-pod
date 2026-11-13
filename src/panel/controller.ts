// 메인 화면 아래에 붙는 세션 컨트롤러. 가장 급한 세션을 자동으로 잡고(직접 고를 수도 있다)
// 그 자리에서 키를 누르고, 중단하고, 지시를 보낸다.
import type { AgentState, AgentView, Snapshot, WorkspaceView } from '../model'
import { closeMenu, openMenu, type MenuItem } from './overlays'
import { fly, shake } from './fx'
import { AGENT_STATE_LABEL, avatar, clip, duration, fill, h, icon } from './ui'

export interface ControllerApi {
  snap(): Snapshot | null
  /** 고른 디렉토리(null 이면 전체). */
  scope(): string | null
  call<T = any>(name: string, input?: unknown, quiet?: boolean): Promise<T>
  toast(message: string, kind?: 'ok' | 'err'): void
  openDetail(w: WorkspaceView, a: AgentView, from: Element | null): void
  focusAgent(w: WorkspaceView, a: AgentView): void
  /** 작업 창이 열려 있으면 컨트롤러를 숨긴다. */
  hidden(): boolean
}

interface Target {
  w: WorkspaceView
  a: AgentView
}

const RANK: Record<AgentState, number> = { blocked: 0, waiting: 1, working: 2, idle: 3, done: 9 }

const KEYS = [
  { key: 'enter', label: '⏎', title: 'Enter' },
  { key: 'esc', label: 'Esc', title: 'Esc' },
  { key: 'up', label: '↑', title: '위' },
  { key: 'down', label: '↓', title: '아래' },
  { key: '1', label: '1', title: '1' },
  { key: '2', label: '2', title: '2' },
  { key: '3', label: '3', title: '3' }
]

export function createController(api: ControllerApi) {
  const el = h('div', { class: 'dock' })
  let pinned: string | null = null
  let current: Target | null = null
  let shownKey = ''
  let lastState = ''
  let preview: string[] = []
  let previewFor = ''
  let poll = 0
  let armed = 0

  const picker = h('button', { class: 'dk-target', title: '세션 고르기' })
  const previewEl = h('button', { class: 'dk-preview', title: '작업 창으로 열기' })
  const keysEl = h('div', { class: 'dk-keys' })
  const stop = h('button', { class: 'key danger', title: '중단 (두 번 누르기)' }, '중단')
  const area = h('textarea', { rows: 1, placeholder: '지시 보내기' }) as HTMLTextAreaElement
  const send = h('button', { class: 'send', title: '보내기 (⌘Enter)', disabled: true }, icon('send')) as HTMLButtonElement
  const composer = h('div', { class: 'composer dk-composer' }, area, send)
  const openBtn = h('button', { class: 'icon-btn', title: '작업 창으로 열기' }, icon('open'))
  const chatOnly = h('button', { class: 'pill-btn', title: 'Orca 대화창에서 열기' }, icon('message'), '대화창에서 이어 하기')
  const attention = h('button', { class: 'dk-attn', title: '다음 확인 필요 세션' })
  const foldBtn = h('button', { class: 'icon-btn dk-fold', title: '접기' }, icon('chevron'))
  const MINI_KEY = 'pod.dock.mini'
  let mini = false
  try {
    mini = localStorage.getItem(MINI_KEY) === '1'
  } catch {}
  const setMini = (v: boolean) => {
    mini = v
    el.classList.toggle('mini', v)
    foldBtn.title = v ? '펼치기' : '접기'
    try {
      localStorage.setItem(MINI_KEY, v ? '1' : '0')
    } catch {}
  }
  foldBtn.addEventListener('click', () => setMini(!mini))

  el.append(
    h('div', { class: 'dk-row' }, picker, attention, h('span', { class: 'spacer' }), openBtn, foldBtn),
    previewEl,
    h('div', { class: 'dk-row dk-ctl' }, keysEl, stop),
    composer,
    chatOnly
  )

  setMini(mini)

  keysEl.append(
    ...KEYS.map((k) =>
      h('button', { class: 'key', title: k.title, onClick: () => pressKey(k.key) }, k.label)
    )
  )

  function pressKey(key: string): void {
    const term = current?.a.terminal
    if (term) void api.call('pod.key', { terminal: term, key }).then(refreshSoon)
  }

  function candidates(): Target[] {
    const snap = api.snap()
    if (!snap) return []
    const scope = api.scope()
    const out: Target[] = []
    for (const w of Object.values(snap.workspaces)) {
      if (scope && w.repoId !== scope) continue
      for (const a of w.agents) if (a.state !== 'done') out.push({ w, a })
    }
    return out.sort((x, y) => RANK[x.a.state] - RANK[y.a.state] || y.a.updatedAt - x.a.updatedAt)
  }

  function pick(): Target | null {
    const list = candidates()
    if (pinned) {
      const hit = list.find((t) => t.a.key === pinned)
      if (hit) return hit
      pinned = null
    }
    return list[0] ?? null
  }

  function choose(key: string | null): void {
    pinned = key
    area.value = ''
    send.disabled = true
    update()
    if (key) area.focus()
  }

  function pickerMenu(): void {
    const list = candidates()
    const items: MenuItem[] = [{ label: '자동 · 가장 급한 세션', icon: 'sparkle', hint: pinned ? '' : '선택됨', onSelect: () => choose(null) }]
    const groups: [string, AgentState[]][] = [
      ['확인 필요', ['blocked', 'waiting']],
      ['작업 중', ['working']],
      ['대기', ['idle']]
    ]
    for (const [label, states] of groups) {
      const g = list.filter((t) => states.includes(t.a.state))
      if (!g.length) continue
      items.push({ section: `${label} ${g.length}` })
      for (const t of g.slice(0, 14))
        items.push({
          label: clip(t.a.title, 34),
          icon: t.a.surface === 'chat' ? 'message' : 'bot',
          hint: clip(t.w.name, 18),
          onSelect: () => choose(t.a.key)
        })
    }
    if (list.length === 0) items.push({ section: '열린 세션이 없어요' })
    openMenu(picker, items, picker)
  }

  picker.addEventListener('click', () => pickerMenu())
  attention.addEventListener('click', () => {
    const urgent = candidates().filter((t) => t.a.state === 'blocked' || t.a.state === 'waiting')
    if (!urgent.length) return
    const i = urgent.findIndex((t) => t.a.key === current?.a.key)
    choose(urgent[(i + 1) % urgent.length].a.key)
  })
  const openCurrent = (from: Element) => current && api.openDetail(current.w, current.a, from)
  openBtn.addEventListener('click', () => openCurrent(el))
  previewEl.addEventListener('click', () => openCurrent(el))
  chatOnly.addEventListener('click', () => current && api.focusAgent(current.w, current.a))

  area.addEventListener('input', () => (send.disabled = !area.value.trim() || !current?.a.terminal))
  const submit = async () => {
    const body = area.value.trim()
    const t = current
    if (!body || !t?.a.terminal) return
    send.disabled = true
    try {
      await api.call('pod.send', { terminal: t.a.terminal, text: body })
      // 보낸 말이 세션 쪽으로 날아간다.
      const to = picker.querySelector('.av') ?? picker
      fly(area.getBoundingClientRect(), to.getBoundingClientRect(), body)
      area.value = ''
      api.toast(`${clip(t.a.title, 24)}에 보냈습니다`)
      refreshSoon()
    } catch {
      send.disabled = false
    }
  }
  send.addEventListener('click', () => void submit())
  area.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault()
      void submit()
    } else if (ev.key === 'Escape') area.blur()
  })
  stop.addEventListener('click', () => {
    const term = current?.a.terminal
    if (!term) return
    if (!armed) {
      stop.textContent = '한 번 더'
      armed = window.setTimeout(() => {
        armed = 0
        stop.textContent = '중단'
      }, 2000)
      return
    }
    window.clearTimeout(armed)
    armed = 0
    stop.textContent = '중단'
    void api.call('pod.interrupt', { terminal: term }).then(() => api.toast('중단 신호를 보냈습니다'))
  })

  /** 승인 대기면 터미널의 질문을 읽어 온다. */
  async function pullPreview(): Promise<void> {
    const t = current
    if (!t || t.a.state !== 'blocked' || !t.a.terminal || document.visibilityState !== 'visible') return
    try {
      const r = await api.call<{ lines: string[] }>('pod.tail', { terminal: t.a.terminal }, true)
      if (current?.a.key !== t.a.key) return
      const next = r.lines.filter((l) => l.trim()).slice(-6)
      if (next.join('\n') !== preview.join('\n') || previewFor !== t.a.key) {
        preview = next
        previewFor = t.a.key
        renderPreview()
      }
    } catch {}
  }

  function refreshSoon(): void {
    window.setTimeout(() => void pullPreview(), 400)
  }

  function renderPreview(): void {
    const t = current
    if (!t) return previewEl.replaceChildren()
    const a = t.a
    if (a.state === 'blocked') {
      previewEl.dataset.kind = 'prompt'
      fill(
        previewEl,
        h('span', { class: 'dk-pk' }, icon('alert'), '승인을 기다리고 있어요'),
        previewFor === a.key && preview.length ? h('pre', null, preview.join('\n')) : null
      )
    } else if (a.state === 'working' && a.tool) {
      previewEl.dataset.kind = 'tool'
      previewEl.replaceChildren(h('span', { class: 'dk-tool' }, a.tool.name), h('span', { class: 'dk-text' }, clip(a.tool.input || a.lastMessage, 200)))
    } else if (a.lastMessage) {
      previewEl.dataset.kind = 'msg'
      previewEl.replaceChildren(h('span', { class: 'dk-text two' }, clip(a.lastMessage, 320)))
    } else {
      previewEl.dataset.kind = 'none'
      previewEl.replaceChildren(h('span', { class: 'dk-text muted' }, a.prompt ? `요청: ${clip(a.prompt, 200)}` : '아직 주고받은 내용이 없어요'))
    }
  }

  function update(): void {
    const hide = api.hidden()
    const t = hide ? current : pick()
    el.classList.toggle('off', hide || !t)
    document.getElementById('app')?.classList.toggle('has-dock', !hide && !!t)
    if (hide) return
    current = t
    if (!t) {
      stopPoll()
      return
    }
    const a = t.a
    const urgent = candidates().filter((x) => x.a.state === 'blocked' || x.a.state === 'waiting').length
    fill(
      picker,
      avatar(a, 'sm'),
      h('span', { class: 'dk-title' }, h('b', null, a.title), h('span', { class: 'dk-ws' }, t.w.name)),
      h('span', { class: 'state-pill', 'data-state': a.state }, h('i'), AGENT_STATE_LABEL[a.state]),
      a.since ? h('span', { class: 'when', 'data-dur': a.since }, duration(a.since)) : null,
      pinned ? null : h('span', { class: 'dk-auto', title: '가장 급한 세션을 자동으로 따라갑니다' }, '자동'),
      icon('chevron')
    )
    attention.hidden = urgent === 0 || (urgent === 1 && (a.state === 'blocked' || a.state === 'waiting'))
    attention.replaceChildren(h('i'), `확인 필요 ${urgent}`)
    const term = !!a.terminal
    el.dataset.state = a.state
    el.classList.toggle('chat', !term)
    area.placeholder = term ? `${clip(a.title, 20)}에 지시 보내기 (⌘Enter)` : ''
    send.disabled = !area.value.trim() || !term
    renderPreview()
    // 대상이 바뀌면 살짝 흔들어 알린다.
    // 같은 세션이 승인 대기로 바뀌면 흔들어 알린다.
    if (shownKey === a.key && lastState && lastState !== a.state && (a.state === 'blocked' || a.state === 'waiting')) shake(el)
    lastState = a.state
    if (shownKey !== a.key) {
      if (shownKey) el.animate?.([{ transform: 'translateY(4px)', opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      shownKey = a.key
      preview = []
      closeMenu()
    }
    if (a.state === 'blocked' && a.terminal) {
      if (!poll) {
        void pullPreview()
        poll = window.setInterval(() => void pullPreview(), 2000)
      }
    } else stopPoll()
  }

  function stopPoll(): void {
    if (poll) window.clearInterval(poll)
    poll = 0
  }

  return {
    el,
    update,
    focus: () => {
      if (el.classList.contains('off')) return
      if (mini) setMini(false)
      area.focus()
    }
  }
}
