// 메인 화면 아래의 관제 줄. 관제는 Pod 워커가 직접 띄운 Claude 이고(Orca 터미널을 거치지 않음),
// 대화·입력은 여기서 그린다. 접으면 상태와 마지막 답 한 줄, 펼치면 대화 전체. 답은 글자 단위로 흘러나온다.
import type { AgentView, Snapshot, WorkspaceView } from '../model'
import { topicPath } from '../model'
import type { ChatItem } from '../transcript'
import { attachments } from './attach'
import { renderChat } from './chat'
import { fly, shake } from './fx'
import { clip, duration, fill, h, icon } from './ui'

export interface ControllerApi {
  snap(): Snapshot | null
  call<T = any>(name: string, input?: unknown, quiet?: boolean): Promise<T>
  toast(message: string, kind?: 'ok' | 'err'): void
  openUrl(url: string): void
  /** 작업 창이 열려 있으면 관제 줄을 숨긴다. */
  hidden(): boolean
}

export interface ControlView {
  items: ChatItem[]
  live: string
  busy: boolean
  since: number
  sessionId: string | null
  error: string | null
  rev?: number
}

/** 관제 입력창에 넣는 세션·워크스페이스 참조. 관제는 지도(map.json)에서 이 이름·핸들로 찾는다. */
export function refOf(snap: Snapshot | null, w: WorkspaceView, a?: AgentView): string {
  const repo = snap?.repos.find((r) => r.id === w.repoId)
  const topic = repo && w.topic ? topicPath(repo.topics, w.topic) : ''
  const where = [repo?.name, topic, w.name].filter(Boolean).join(' › ')
  if (!a) return `[워크스페이스 ${where}]`
  const how = a.terminal ? `터미널 ${a.terminal}` : '대화창'
  return `[세션 ${where} / ${a.title} · ${how}]`
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
  const previewEl = h('button', { class: 'dk-preview', title: '펼치기' })
  const chatBox = h('div', { class: 'convo dk-chat' })
  const chatInner = h('div', { class: 'convo-inner' })
  chatBox.append(chatInner)
  const area = h('textarea', { rows: 1, placeholder: '관제에게 (Enter 보내기 · Shift+Enter 줄바꿈)' }) as HTMLTextAreaElement
  const send = h('button', { class: 'send', title: '보내기 (Enter)', disabled: true }, icon('send')) as HTMLButtonElement
  const composer = h('div', { class: 'composer stack dk-composer' })
  let sending = false
  const syncSend = () => (send.disabled = sending || view.busy || (!area.value.trim() && pics.count() === 0))
  const pics = attachments(composer, area, { call: (n, i, q) => api.call(n, i, q), toast: (m, k) => api.toast(m, k), onChange: syncSend })
  composer.append(pics.tray, h('div', { class: 'composer-row' }, pics.button, area, send))
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
      const said = area.value.trim() || `사진 ${pics.count()}장`
      const images = await pics.images()
      await api.call('pod.control.send', { text: area.value, images })
      fly(area.getBoundingClientRect(), head.getBoundingClientRect(), said)
      area.value = ''
      pics.clear()
      stick = true
    } catch {
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
    const next = `${view.rev ?? 0}|${items.length}|${view.live.length}|${view.busy}`
    if (next === sig) return
    sig = next
    if (!items.length) {
      chatInner.replaceChildren(h('div', { class: 'chat-empty' }, icon('sparkle'), h('div', null, '새 대화')))
      return
    }
    chatInner.replaceChildren(
      ...renderChat(items, { working: view.busy, workingSince: view.since, truncated: false, open: openGroups, onLink: (u) => api.openUrl(u) })
    )
    if (stick) chatBox.scrollTop = chatBox.scrollHeight
  }

  /* ---------- 그리기 ---------- */
  let armed = 0
  function renderHead(): void {
    const stop = view.busy
      ? h(
          'button',
          {
            class: 'key danger',
            title: '중단',
            onClick: () => void api.call('pod.control.stop', {}).then(() => api.toast('중단했습니다'))
          },
          '중단'
        )
      : null
    const fresh = h('button', { class: 'icon-btn', title: '새 대화 (두 번 누르기)' }, icon('plus'))
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
      h('b', { class: 'dk-name' }, '관제'),
      view.busy
        ? h('span', { class: 'state-pill', 'data-state': 'working' }, h('i'), '작업 중')
        : view.items.length
          ? h('span', { class: 'state-pill', 'data-state': 'idle' }, h('i'), '대기')
          : null,
      view.busy && view.since ? h('span', { class: 'when', 'data-dur': view.since }, duration(view.since)) : null,
      h('span', { class: 'spacer' }),
      stop,
      view.items.length || view.sessionId ? fresh : null,
      h('button', { class: 'icon-btn dk-fold', title: open ? '접기' : '펼치기', onClick: () => setOpen(!open) }, icon('chevron'))
    )
  }

  function renderPreview(): void {
    if (open) return previewEl.replaceChildren()
    if (view.error) {
      previewEl.dataset.kind = 'prompt'
      return fill(previewEl, h('span', { class: 'dk-pk' }, icon('alert'), view.error))
    }
    previewEl.dataset.kind = 'msg'
    if (view.busy) {
      const tools = view.items.filter((i) => i.k === 'tool' && i.at >= view.since)
      const lastTool = tools[tools.length - 1]
      if (view.live) return previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(view.live.replace(/\s+/g, ' ').slice(-240), 240)))
      if (lastTool && lastTool.k === 'tool')
        return previewEl.replaceChildren(h('span', { class: 'dk-tool' }, lastTool.name), h('span', { class: 'dk-text' }, lastTool.detail))
      return previewEl.replaceChildren(h('span', { class: 'dk-text muted' }, '생각 중'))
    }
    const lastText = [...view.items].reverse().find((i) => i.k === 'text')
    if (lastText && lastText.k === 'text') previewEl.replaceChildren(h('span', { class: 'dk-text' }, clip(lastText.text.replace(/\s+/g, ' '), 240)))
    else previewEl.replaceChildren()
  }

  function update(): void {
    const hide = api.hidden()
    el.classList.toggle('off', hide)
    document.getElementById('app')?.classList.toggle('has-dock', !hide)
    if (hide) return
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
    if (view.error && view.error !== lastError) api.toast(view.error, 'err')
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
    /** 세션·워크스페이스 참조를 입력창에 넣는다. */
    insert(w: WorkspaceView, a?: AgentView) {
      const ref = refOf(api.snap(), w, a)
      area.value = area.value.trim() ? `${area.value.trimEnd()}\n${ref} ` : `${ref} `
      syncSend()
      if (el.classList.contains('off')) api.toast('관제에 넣었습니다')
      else area.focus()
      area.setSelectionRange(area.value.length, area.value.length)
    }
  }
}
