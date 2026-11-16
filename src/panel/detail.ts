// 상세(작업실): 워크스페이스의 대화와 터미널 출력을 읽는다. 지시는 하단 관제에서 보낸다.
import { t } from './i18n'
import type { AgentView, Snapshot, WorkspaceView } from '../model'
import type { ChatItem } from '../transcript'
import { markdown, renderChat, setLinkHandler } from './chat'
import { closeMenu, hideHover, openMenu } from './overlays'
import { AGENT_STATE_LABEL, agentName, agoFull, avatar, duration, fill, h, icon, statusColor, statusLabel, topicColor } from './ui'

export interface DetailApi {
  /** 상세를 펼쳐도 상단 탐색과 하단 관제는 남겨 둔다. */
  content: HTMLElement
  snap(): Snapshot | null
  call<T = any>(name: string, input?: unknown, quiet?: boolean): Promise<T>
  openWorkspace(w: WorkspaceView): void
  focusAgent(w: WorkspaceView, a: AgentView): void
  launchAgent(w: WorkspaceView, type?: string): void
  workspaceMenu(at: Element, w: WorkspaceView): void
  statusMenu(at: Element, w: WorkspaceView): void
  openPR(w: WorkspaceView): void
  toast(message: string, kind?: 'ok' | 'err'): void
  openUrl(url: string): void
  /** 새 세션을 열고 그 터미널 핸들을 돌려준다(못 찾으면 null). */
  addSession(w: WorkspaceView, kind: 'claude' | 'codex' | 'terminal'): Promise<string | null>
  /** 창이 열리고 닫힐 때(그래프에서 선택 표시용). */
  onSelect?(sel: { wsId: string; agentKey: string | null } | null): void
  /** 탭(터미널)을 닫는다. */
  closeTabs(handles: string[]): Promise<void>
  /** 창 모드에서 창이 차지한 쪽과 크기(그래프가 비켜나도록). */
  onReserve?(r: { side: 'left' | 'right' | 'bottom'; size: number } | null): void
}

export interface OpenOptions {
  /** 주면 이 요소 안에 창으로 띄운다(그래프 안에서 열기). 없으면 전체 화면. */
  host?: HTMLElement | null
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

type Session = { kind: 'agent'; agent: AgentView } | { kind: 'terminal'; handle: string; title: string; connected: boolean; setup: boolean }

export function createDetail(api: DetailApi) {
  setLinkHandler((url) => api.openUrl(url))
  let wsId: string | null = null
  let sessionKey: string | null = null
  let root: HTMLElement | null = null
  let head: HTMLElement | null = null
  let tabs: HTMLElement | null = null
  let sessionHead: HTMLElement | null = null
  let sessionBody: HTMLElement | null = null
  let renderedSession = ''
  let refreshBody: ((s: Session) => void) | null = null
  let poll = 0
  let screen: HTMLPreElement | null = null
  let stickBottom = true
  let memo: HTMLTextAreaElement | null = null
  let pendingHandle: string | null = null
  let launching: string | null = null
  let origin: Element | null = null
  let host: HTMLElement | null = null
  let hostObserver: ResizeObserver | null = null
  let reserveSide: 'left' | 'right' | null = null

  const ws = () => (wsId ? (api.snap()?.workspaces[wsId] ?? null) : null)

  function sessions(w: WorkspaceView): Session[] {
    const live = w.agents.filter((a) => a.state !== 'done')
    const recent = w.agents.filter((a) => a.state === 'done').slice(0, 4)
    const agentTerms = new Set(w.agents.map((a) => a.terminal).filter(Boolean))
    const shells = w.terminals.filter((t) => !agentTerms.has(t.handle))
    const term = (tm: (typeof shells)[number]) => ({ kind: 'terminal' as const, handle: tm.handle, title: tm.title || t('터미널'), connected: tm.connected, setup: tm.kind === 'setup' })
    return [
      ...live.map((agent) => ({ kind: 'agent' as const, agent })),
      ...shells.filter((t) => t.connected).map(term),
      ...recent.map((agent) => ({ kind: 'agent' as const, agent })),
      // 끝났는데 탭만 남은 터미널은 맨 뒤에(닫을 수 있게).
      ...shells.filter((t) => !t.connected).map(term)
    ]
  }

  const keyOf = (s: Session) => (s.kind === 'agent' ? `a:${s.agent.key}` : `t:${s.handle}`)
  const terminalOf = (s: Session) => (s.kind === 'agent' ? s.agent.terminal : s.handle)

  function current(w: WorkspaceView): Session | null {
    const list = sessions(w)
    if (pendingHandle) {
      const fresh = list.find((s) => terminalOf(s) === pendingHandle)
      if (fresh) {
        sessionKey = keyOf(fresh)
        pendingHandle = null
      }
    }
    return list.find((s) => keyOf(s) === sessionKey) ?? list[0] ?? null
  }

  const LABEL = { claude: 'Claude', codex: 'Codex', terminal: t('터미널') } as const

  /** 새 세션을 열고, 만들어지면 그 탭을 고른다. */
  function startSession(w: WorkspaceView, kind: 'claude' | 'codex' | 'terminal'): void {
    closeMenu()
    const label = LABEL[kind]
    launching = label
    update()
    void api
      .addSession(w, kind)
      .then((handle) => {
        if (handle) pendingHandle = handle
      })
      .catch(() => {})
      .finally(() => {
        launching = null
        update()
      })
  }

  function addMenu(anchor: Element, w: WorkspaceView): void {
    const start = (kind: 'claude' | 'codex' | 'terminal') => startSession(w, kind)
    openMenu(anchor, [
      { section: t('새 세션') },
      { label: 'Claude', icon: 'bot', hint: t('에이전트'), onSelect: () => start('claude') },
      { label: 'Codex', icon: 'bot', hint: t('에이전트'), onSelect: () => start('codex') },
      { label: t('터미널'), icon: 'terminal', hint: t('셸'), onSelect: () => start('terminal') }
    ])
  }

  function renderHead(w: WorkspaceView): void {
    if (!head) return
    const snap = api.snap()
    const topic = w.topic ? snap?.repos.find((r) => r.id === w.repoId)?.topics.find((t) => t.id === w.topic) : null
    const pill = h(
      'button',
      { class: 'state-pill btn', style: { '--c': statusColor(w.status) }, title: t('상태 바꾸기') },
      h('i'),
      statusLabel(w.status),
      icon('chevron')
    )
    pill.addEventListener('click', () => api.statusMenu(pill, w))
    const more = h('button', { class: 'icon-btn', title: t('메뉴') }, icon('more'))
    more.addEventListener('click', () => api.workspaceMenu(more, w))
    const top = h(
      'div',
      { class: 'd-top' },
      host
        ? h('button', { class: 'icon-btn', title: t('닫기 (Esc)'), onClick: close }, icon('x'))
        : h('button', { class: 'icon-btn', title: t('뒤로'), onClick: close }, icon('back')),
      pill,
      topic ? h('span', { class: 'topic-tag', style: { '--t': topicColor(topic.id) } }, topic.name) : null,
      h('span', { class: 'spacer' }),
      host ? h('button', { class: 'icon-btn', title: t('크게 보기'), onClick: expand }, icon('fit')) : null,
      h('button', { class: host ? 'icon-btn' : 'pill-btn', title: t('Orca에서 열기'), onClick: () => api.openWorkspace(w) }, icon('open'), host ? null : t('Orca에서 열기')),
      more
    )
    const title = h(
      'div',
      { class: 'd-title' },
      h('h2', null, w.name),
      w.branch ? h('span', { class: 'br' }, icon('branch'), w.branch) : null
    )
    const meta = h(
      'div',
      { class: 'd-meta' },
      w.pr
        ? h(
            'span',
            { class: 'pr', 'data-state': w.pr.state, onClick: () => api.openPR(w) },
            icon('pr'),
            w.pr.number,
            w.pr.checks ? h('span', { class: 'ck', 'data-checks': w.pr.checks }) : null
          )
        : null,
      w.pr?.title ? h('span', { class: 'pr-title' }, w.pr.title) : null,
      h('span', null, t(`{repo} · 마지막 활동 {when}`, { repo: w.repo, when: agoFull(w.lastActivityAt) }))
    )
    // 메모를 쓰는 중이면 다시 그리지 않는다.
    if (!memo || document.activeElement !== memo) {
      memo = h('textarea', { class: 'd-memo', rows: 1, placeholder: t('메모') }) as HTMLTextAreaElement
      memo.value = w.comment
      memo.addEventListener('blur', () => {
        const cur = ws()
        if (!cur || memo!.value.trim() === cur.comment) return
        void api.call('pod.setComment', { id: cur.id, comment: memo!.value.trim() }).then(() => api.toast(t('메모 저장')))
      })
      memo.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) memo!.blur()
      })
    }
    head.replaceChildren(top, title, meta, memo)
  }

  function renderTabs(w: WorkspaceView): void {
    if (!tabs) return
    const sel = current(w)
    const prevScroll = (tabs.firstElementChild as HTMLElement | null)?.scrollLeft ?? 0
    const scroller = h('div', { class: 'd-tabs-scroll' })
    tabs.replaceChildren(scroller)
    scroller.append(
      ...sessions(w).map((s) => {
        const on = sel && keyOf(s) === keyOf(sel)
        const label = s.kind === 'agent' ? s.agent.title : s.title
        return h(
          'button',
          {
            class: `d-tab${on ? ' on' : ''}${s.kind === 'terminal' && !s.connected ? ' dead' : ''}`,
            title: label,
            onClick: () => {
              sessionKey = keyOf(s)
              update()
              if (wsId) api.onSelect?.({ wsId, agentKey: s.kind === 'agent' ? s.agent.key : null })
            }
          },
          s.kind === 'agent' ? avatar(s.agent, 'sm') : h('span', { class: 'term' }, icon(s.setup ? 'gear' : 'terminal')),
          h('span', null, label),
          closeX(s)
        )
      }),
      ...(launching ? [h('span', { class: 'd-tab on launching' }, h('span', { class: 'term spin' }, icon('refresh')), h('span', null, t(`{launching} 시작 중…`, { launching })))] : [])
    )
    scroller.scrollLeft = prevScroll
    // 탭이 많아도 보이도록 세션 추가 버튼은 오른쪽 끝에 고정한다.
    const add = h('button', { class: 'd-tab add', title: t('새 세션') }, h('span', { class: 'term' }, icon('plus')), h('span', null, t('세션')))
    add.addEventListener('click', () => addMenu(add, w))
    tabs.append(add)
  }

  /** 탭의 닫기 버튼. 살아 있는 터미널은 두 번 눌러야 닫힌다. */
  function closeX(s: Session): HTMLElement | null {
    const handle = terminalOf(s)
    if (!handle) return null
    const alive = s.kind === 'terminal' ? s.connected : true
    const x = h('span', { class: 'd-tab-x', role: 'button', title: alive ? t('탭 닫기 (두 번 누르기)') : t('탭 닫기') }, icon('x'))
    let armed = 0
    x.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (alive && !armed) {
        x.classList.add('armed')
        armed = window.setTimeout(() => {
          armed = 0
          x.classList.remove('armed')
        }, 2000)
        return
      }
      window.clearTimeout(armed)
      const tab = x.closest('.d-tab') as HTMLElement | null
      tab?.animate?.([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-6px) scale(0.9)' }], { duration: 200, fill: 'forwards' })
      void api.closeTabs([handle])
    })
    return x
  }

  function renderSessionHead(w: WorkspaceView, s: Session): void {
    if (!sessionHead) return
    if (s.kind === 'terminal') {
      fill(
        sessionHead,
        h('span', { class: 'term' }, icon(s.setup ? 'gear' : 'terminal')),
        h('span', { class: 't' }, s.title),
        s.connected
          ? h(
              'button',
              {
                class: 'icon-btn',
                title: t('Orca에서 이 탭 열기'),
                onClick: () => void api.call('pod.focusTerminal', { terminal: s.handle }).then(() => api.toast(t(`{title}(으)로 이동`, { title: s.title })))
              },
              icon('open')
            )
          : null
      )
      return
    }
    const a = s.agent
    const canChat = a.type === 'claude' && !noTranscript.has(a.key) && a.terminal
    const mode = modeOf(s)
    const seg = canChat
      ? h(
          'div',
          { class: 'seg mini' },
          h('button', { class: mode === 'chat' ? 'on' : '', title: t('대화로 보기'), onClick: () => mode !== 'chat' && setMode(s, 'chat') }, icon('message')),
          h('button', { class: mode === 'screen' ? 'on' : '', title: t('터미널 화면 보기'), onClick: () => mode !== 'screen' && setMode(s, 'screen') }, icon('terminal'))
        )
      : null
    fill(
      sessionHead,
      avatar(a, 'sm'),
      h('span', { class: 't' }, a.title),
      h('span', { class: 'state-pill', 'data-state': a.state }, h('i'), AGENT_STATE_LABEL[a.state]),
      a.state !== 'done' && a.since ? h('span', { class: 'when', 'data-dur': a.since }, duration(a.since)) : null,
      seg,
      h('button', { class: 'icon-btn', title: t('Orca에서 이 세션 열기'), onClick: () => api.focusAgent(w, a) }, icon('open'))
    )
  }

  async function pull(handle: string): Promise<void> {
    if (!screen || document.visibilityState !== 'visible') return
    // 응답이 오기 전에 탭이 바뀌면 이전 터미널 화면을 새 탭에 쓰지 않는다.
    const target = screen
    try {
      const r = await api.call<{ lines: string[] }>('pod.screen', { terminal: handle, lines: 300 }, true)
      if (screen !== target) return
      const text = r.lines.join('\n')
      if (screen.textContent !== text) {
        screen.textContent = text || ' '
        if (stickBottom) screen.scrollTop = screen.scrollHeight
      }
    } catch {
      if (screen === target && !screen.textContent) screen.textContent = t('터미널을 읽지 못했습니다')
    }
  }

  function startPoll(handle: string): void {
    stopPoll()
    void pull(handle)
    poll = window.setInterval(() => void pull(handle), 1500)
  }

  function stopPoll(): void {
    if (poll) window.clearInterval(poll)
    poll = 0
  }

  function renderSessionBody(w: WorkspaceView, s: Session | null): void {
    if (!sessionBody) return
    refreshBody = null
    stopPoll()
    screen = null
    if (!s) {
      sessionBody.replaceChildren(
        h(
          'div',
          { class: 'd-empty' },
          icon('bot'),
          h('div', null, t('열린 세션이 없어요')),
          h(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            h('button', { class: 'pill-btn primary', onClick: (ev: Event) => addMenu(ev.currentTarget as Element, w) }, icon('plus'), t('세션 추가'))
          )
        )
      )
      return
    }
    const handle = terminalOf(s)
    if (s.kind === 'terminal' && !s.connected) {
      sessionBody.replaceChildren(
        h(
          'div',
          { class: 'd-empty' },
          icon(s.setup ? 'gear' : 'terminal'),
          h('div', null, s.setup ? t('초기 설정이 끝난 탭이에요') : t('끝난 터미널이에요')),
          h('button', { class: 'pill-btn primary', onClick: () => void api.closeTabs([s.handle]) }, icon('x'), t('탭 닫기'))
        )
      )
      return
    }
    const agent = s.kind === 'agent' ? s.agent : null
    const chatOk = agent && agent.type === 'claude' && !noTranscript.has(agent.key) && modeOf(s) === 'chat'
    const main = chatOk ? buildChat(w, agent!, handle) : handle ? buildScreen(handle) : buildChatFallback(agent!)
    if (!handle) {
      // 대화창 세션: 읽기만 하고 이어서 쓰는 건 Orca 대화창에서.
      sessionBody.replaceChildren(
        main,
        h(
          'div',
          { class: 'chat-foot' },
          h('button', { class: 'pill-btn primary', onClick: () => api.focusAgent(w, agent!) }, icon('open'), t('대화창에서 이어 하기'))
        )
      )
      return
    }
    sessionBody.replaceChildren(main)
  }

  /** 세션별로 대화/터미널 보기를 기억한다. 기본은 대화. */
  const modes = new Map<string, 'chat' | 'screen'>()
  const modeOf = (s: Session) => modes.get(keyOf(s)) ?? 'chat'
  /** 대화 기록을 못 찾은 세션과 그 시각. 막 시작한 세션은 기록이 늦게 생기므로 30초 뒤 다시 시도한다. */
  const missing = new Map<string, number>()
  const noTranscript = {
    has: (key: string) => {
      const at = missing.get(key)
      if (at && Date.now() - at > 30_000) missing.delete(key)
      return missing.has(key)
    },
    add: (key: string) => void missing.set(key, Date.now())
  }

  function setMode(s: Session, m: 'chat' | 'screen'): void {
    modes.set(keyOf(s), m)
    renderedSession = ''
    update()
  }

  function buildScreen(handle: string): HTMLElement {
    screen = h('pre', { class: 'screen' }, t('불러오는 중…')) as HTMLPreElement
    stickBottom = true
    screen.addEventListener('scroll', () => {
      if (!screen) return
      stickBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24
    })
    startPoll(handle)
    return screen
  }

  const fallbackMessages = (a: AgentView) => [
    ...(a.prompt ? [h('div', { class: 'msg-me' }, h('div', { class: 'bubble-me' }, a.prompt))] : []),
    ...(a.lastMessage ? [h('div', { class: 'msg-agent' }, markdown(a.lastMessage))] : [])
  ]

  function buildChatFallback(a: AgentView): HTMLElement {
    const inner = h('div', { class: 'convo-inner' })
    const box = h('div', { class: 'convo' }, inner)
    let sig = ''
    const refresh = (cur: AgentView) => {
      const next = JSON.stringify([cur.prompt, cur.lastMessage])
      if (next === sig) return
      sig = next
      const keep = box.scrollTop
      const bottom = !box.isConnected || box.scrollHeight - keep - box.clientHeight < 40
      inner.replaceChildren(...fallbackMessages(cur))
      box.scrollTop = bottom ? box.scrollHeight : keep
    }
    refresh(a)
    refreshBody = s => { if (s.kind === 'agent') refresh(s.agent) }
    return box
  }

  /** 대화 보기. 기록 파일을 1.5초마다 이어 읽고, 바뀌었을 때만 다시 그린다. */
  function buildChat(w: WorkspaceView, a: AgentView, handle: string | null): HTMLElement {
    const box = h('div', { class: 'convo' })
    const inner = h('div', { class: 'convo-inner' }, h('div', { class: 'chat-note' }, t('대화를 불러오는 중…')))
    box.append(inner)
    stickBottom = true
    box.addEventListener('scroll', () => {
      stickBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
    })
    const openGroups = new Set<string>()
    let sig = ''
    let first = true
    let waitingSince = 0
    let promptAt = 0
    const live = () => ws()?.agents.find((x) => x.key === a.key) ?? a
    let busy = false
    const tick = async () => {
      if (busy || !box.isConnected || document.visibilityState !== 'visible') return
      busy = true
      try {
        await tickOnce()
      } finally {
        busy = false
      }
    }
    const tickOnce = async () => {
      const cur = live()
      const others = (ws()?.agents ?? []).filter((x) => x.key !== a.key).map((x) => x.key)
      let r: { ok: boolean; items: ChatItem[]; truncated: boolean; updatedAt: number }
      try {
        r = await api.call('pod.conversation', { path: w.path, key: a.key, type: a.type, title: cur.title, prompt: cur.prompt, since: cur.since, others }, true)
      } catch {
        r = { ok: false, items: [], truncated: false, updatedAt: 0 }
      }
      if (!box.isConnected) return
      if (!r.ok || r.items.length === 0) {
        // 이미 읽은 대화는 일시적인 빈 응답이나 읽기 오류로 지우지 않는다.
        if (!first) return
        // 대화창 기록이 아직 없으면 최근 요청·답변을 보여 주며 같은 창에서 계속 확인한다.
        if (!handle) {
          const next = JSON.stringify(['fallback', cur.prompt, cur.lastMessage])
          if (next !== sig) {
            sig = next
            const keep = box.scrollTop
            inner.replaceChildren(...fallbackMessages(cur))
            box.scrollTop = stickBottom ? box.scrollHeight : keep
          }
          return
        }
        // 첫 요청 전이면 기록이 아직 없다. 빈 대화로 두고 계속 읽는다.
        if (!cur.prompt && handle) {
          if (!waitingSince) inner.replaceChildren(h('div', { class: 'chat-empty' }, icon('message'), h('div', null, t('새 대화'))))
          waitingSince = waitingSince || Date.now()
          promptAt = 0
          return
        }
        // 요청을 보낸 직후엔 기록이 늦게 생길 수 있다. 잠깐 기다렸다가 그래도 없으면 아래처럼 돌아간다.
        if (waitingSince) {
          promptAt = promptAt || Date.now()
          if (Date.now() - promptAt < 15_000) return
          waitingSince = 0
        }
        if (first) {
          noTranscript.add(a.key)
          // 기록이 없으면 터미널 화면(없으면 마지막 요청·답변)으로 돌아간다.
          const sel = ws() && current(ws()!)
          if (sel) setMode(sel, 'screen')
        }
        return
      }
      first = false
      const blocked = cur.state === 'blocked' && handle
      let prompt: string[] = []
      if (blocked) {
        try {
          prompt = (await api.call<{ lines: string[] }>('pod.tail', { terminal: handle }, true)).lines
        } catch {}
      }
      const next = JSON.stringify([r.items, r.truncated, cur.state === 'working', cur.state === 'working' ? cur.since : 0, !!blocked, prompt])
      if (next === sig) return
      sig = next
      const keep = box.scrollTop
      inner.replaceChildren(
        ...renderChat(r.items, {
          working: cur.state === 'working',
          workingSince: cur.since,
          truncated: r.truncated,
          open: openGroups,
          onLink: (url) => api.openUrl(url)
        }),
        ...(blocked
          ? [
              h(
                'div',
                { class: 'chat-prompt' },
                h('div', { class: 'cp-head' }, icon('alert'), t('승인을 기다리고 있어요')),
                h('pre', null, prompt.filter((l) => l.trim()).slice(-14).join('\n'))
              )
            ]
          : [])
      )
      if (stickBottom) box.scrollTop = box.scrollHeight
      else box.scrollTop = keep
    }
    stopPoll()
    // 본문을 DOM에 붙인 직후 읽는다. 생성 중에는 isConnected가 false다.
    queueMicrotask(() => void tick())
    poll = window.setInterval(() => void tick(), 1500)
    return box
  }

  function update(): void {
    if (!root) return
    const w = ws()
    if (!w) return close()
    renderHead(w)
    renderTabs(w)
    const s = current(w)
    if (s) sessionKey = keyOf(s)
    if (s) renderSessionHead(w, s)
    else sessionHead?.replaceChildren()
    // 갱신 시각은 식별자에서 제외한다. 같은 세션의 스냅샷은 읽던 본문을 유지한다.
    const sig = s ? JSON.stringify([w.id, w.path, keyOf(s), terminalOf(s), s.kind === 'agent' ? s.agent.type : s.connected, modeOf(s)]) : 'none'
    if (sig !== renderedSession) {
      renderedSession = sig
      renderSessionBody(w, s)
    } else if (s) refreshBody?.(s)
  }

  /** 확대 보기도 본문 영역 안에 두어 관제 입력창을 가리지 않는다. */
  function placeExpanded(el: HTMLElement): void {
    const r = api.content.getBoundingClientRect()
    Object.assign(el.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto' })
  }

  /** 창 모드: 누른 노드의 반대편에 세로로 붙이고, 좁으면 아래쪽 시트로 띄운다. */
  function placeInHost(el: HTMLElement, from: Element | null): void {
    if (!host) return
    const hr = host.getBoundingClientRect()
    const W = hr.width
    const H = hr.height
    const fr = from?.isConnected ? from.getBoundingClientRect() : null
    const st = el.style
    if (W >= 760) {
      const width = Math.min(620, Math.max(420, W * 0.48))
      const nodeLeft = fr ? fr.left + fr.width / 2 - hr.left < W / 2 : true
      st.top = '52px'
      st.bottom = '12px'
      st.width = `${width}px`
      st.height = ''
      st.left = nodeLeft ? '' : '12px'
      st.right = nodeLeft ? '12px' : ''
      // 창 위치를 처음 정할 때만 쪽을 바꾼다(크기 변경 때는 유지).
      if (from || !reserveSide) reserveSide = nodeLeft ? 'right' : 'left'
      if (reserveSide === 'left') {
        st.left = '12px'
        st.right = ''
      } else {
        st.left = ''
        st.right = '12px'
      }
      api.onReserve?.({ side: reserveSide, size: width + 24 })
    } else {
      st.left = '8px'
      st.right = '8px'
      st.bottom = '8px'
      st.top = ''
      st.width = ''
      st.height = `${Math.max(320, Math.round(H * 0.66))}px`
      api.onReserve?.({ side: 'bottom', size: Math.max(320, Math.round(H * 0.66)) + 16 })
    }
  }

  /** 창 모드 열기: 노드 자리에서 창 크기로 커진다(FLIP). */
  function growFrom(el: HTMLElement, from: Element | null): void {
    const fr = from?.isConnected ? from.getBoundingClientRect() : null
    const to = el.getBoundingClientRect()
    if (!fr || !el.animate || to.width === 0) {
      el.animate?.([{ opacity: 0, transform: 'translateY(12px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE })
      return
    }
    const sx = Math.max(0.05, fr.width / to.width)
    const sy = Math.max(0.05, fr.height / to.height)
    el.animate(
      [
        { transformOrigin: '0 0', transform: `translate(${fr.left - to.left}px, ${fr.top - to.top}px) scale(${sx}, ${sy})`, opacity: 0.4, borderRadius: '6px' },
        { transformOrigin: '0 0', transform: 'none', opacity: 1, borderRadius: '14px' }
      ],
      { duration: 420, easing: EASE }
    )
    for (const [i, child] of [...el.children].entries()) {
      ;(child as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 160 + i * 40, easing: EASE, fill: 'backwards' })
    }
  }

  function build(): HTMLElement {
    head = h('div', { class: 'd-head' })
    tabs = h('div', { class: 'd-tabs' })
    sessionHead = h('div', { class: 's-head' })
    sessionBody = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } })
    return h('div', { class: 'detail' }, head, tabs, h('div', { class: 'd-session' }, sessionHead, sessionBody))
  }

  function open(id: string, agentKey?: string, from?: Element | null, opts: OpenOptions = {}): void {
    hideHover()
    closeMenu()
    const wantHost = opts.host ?? null
    // 창 모드와 전체 화면을 오가면 새로 만든다.
    if (root && wantHost !== host) dispose()
    const fresh = !root
    if (fresh) origin = from ?? null
    else if (host && from) origin = from
    wsId = id
    sessionKey = agentKey ? (agentKey.startsWith('t:') ? agentKey : `a:${agentKey}`) : null
    renderedSession = ''
    // 창 위치를 정하기 전에 선택을 알려야 그래프가 줄어들지 않고 그 노드 쪽으로 옮겨 간다.
    api.onSelect?.({ wsId: id, agentKey: agentKey && !agentKey.startsWith('t:') ? agentKey : null })
    if (!root) {
      host = wantHost
      root = build()
      if (host) {
        root.classList.add('inline')
        host.append(root)
        placeInHost(root, from ?? null)
        hostObserver = new ResizeObserver(() => root && placeInHost(root, null))
        hostObserver.observe(host)
      } else {
        document.body.append(root)
        placeExpanded(root)
        hostObserver = new ResizeObserver(() => root && placeExpanded(root))
        hostObserver.observe(api.content)
      }
    } else if (host) {
      // 이미 떠 있는 창: 다른 노드를 누르면 내용만 바꾸고 살짝 강조한다.
      root.animate?.([{ boxShadow: '0 0 0 2px var(--ring), var(--shadow)' }, { boxShadow: '0 0 0 1px var(--border), var(--shadow)' }], { duration: 500, easing: EASE })
    }
    update()
    api.onSelect?.({ wsId: id, agentKey: sessionKey?.startsWith('a:') ? sessionKey.slice(2) : null })
    if (fresh && root) {
      growFrom(root, origin)
    }
  }

  /** 애니메이션 없이 바로 치운다. */
  function dispose(): void {
    refreshBody = null
    if (host) api.onReserve?.(null)
    reserveSide = null
    stopPoll()
    hostObserver?.disconnect()
    hostObserver = null
    root?.remove()
    root = null
    head = tabs = sessionHead = sessionBody = null
    memo = null
    host = null
  }

  /** 창에서 전체 화면으로 넓힌다. */
  function expand(): void {
    if (!wsId) return
    const id = wsId
    const key = sessionKey?.startsWith('a:') ? sessionKey.slice(2) : undefined
    const from = root
    const rect = from?.getBoundingClientRect()
    dispose()
    // 창이 있던 자리에서 전체 화면으로 펼친다.
    const ghost = rect ? h('div', { style: { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, pointerEvents: 'none' } }) : null
    if (ghost) document.body.append(ghost)
    open(id, key, ghost)
    ghost?.remove()
    origin = null
  }

  function close(): void {
    refreshBody = null
    api.onSelect?.(null)
    if (host && root) {
      api.onReserve?.(null)
      reserveSide = null
      // 창 모드: 노드 자리로 줄어들며 사라진다.
      const el = root
      let target = origin
      if (target && !target.isConnected) {
        const key = target.getAttribute('data-hk')
        target = key ? document.querySelector(`[data-hk="${CSS.escape(key)}"]`) : null
      }
      const fr = target?.getBoundingClientRect()
      const to = el.getBoundingClientRect()
      stopPoll()
      hostObserver?.disconnect()
      hostObserver = null
      root = null
      head = tabs = sessionHead = sessionBody = null
      memo = null
      host = null
      wsId = null
      origin = null
      pendingHandle = null
      launching = null
      if (fr && fr.width > 0 && el.animate) {
        const anim = el.animate(
          [
            { transformOrigin: '0 0', transform: 'none', opacity: 1 },
            {
              transformOrigin: '0 0',
              transform: `translate(${fr.left - to.left}px, ${fr.top - to.top}px) scale(${Math.max(0.05, fr.width / to.width)}, ${Math.max(0.05, fr.height / to.height)})`,
              opacity: 0
            }
          ],
          { duration: 300, easing: EASE, fill: 'forwards' }
        )
        anim.onfinish = () => el.remove()
      } else {
        el.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 180, fill: 'forwards' })
        window.setTimeout(() => el.remove(), 190)
      }
      return
    }
    stopPoll()
    hostObserver?.disconnect()
    hostObserver = null
    screen = null
    memo?.blur()
    const el = root
    root = null
    head = tabs = sessionHead = sessionBody = null
    memo = null
    wsId = null
    pendingHandle = null
    launching = null
    if (!el) return
    // 처음 눌렀던 자리로 접혀 들어간다. 그 요소가 다시 그려져 없어졌으면 같은 키의 새 요소를 찾는다.
    let target = origin
    if (target && !target.isConnected) {
      const key = target.getAttribute('data-hk')
      target = key ? document.querySelector(`[data-hk="${CSS.escape(key)}"]`) : null
    }
    origin = null
    const r = target?.getBoundingClientRect()
    if (r && r.width > 0 && el.animate) {
      for (const child of el.children) (child as HTMLElement).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' })
      const to = el.getBoundingClientRect()
      const anim = el.animate([{ transformOrigin: '0 0', transform: 'none', opacity: 1 }, { transformOrigin: '0 0', transform: `translate(${r.left - to.left}px, ${r.top - to.top}px) scale(${Math.max(0.05, r.width / to.width)}, ${Math.max(0.05, r.height / to.height)})`, opacity: 0.3 }], {
        duration: 320,
        easing: EASE,
        fill: 'forwards'
      })
      anim.onfinish = () => el.remove()
    } else {
      el.classList.add('closing')
      window.setTimeout(() => el.remove(), 180)
    }
  }

  /** 작업실을 열고 바로 새 세션을 시작한다. */
  function openWithSession(id: string, kind: 'claude' | 'codex' | 'terminal', from?: Element | null, opts: OpenOptions = {}): void {
    open(id, undefined, from, opts)
    const w = ws()
    if (w) startSession(w, kind)
  }

  return { open, openWithSession, close, dispose, update, isOpen: () => root !== null, isInline: () => root !== null && host !== null }
}
