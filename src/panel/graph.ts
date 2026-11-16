// 그래프 보기(궤도): 디렉토리 → 섹션(주제, 주제가 없으면 상태) → 워크스페이스 카드를 힘 기반 배치로 그린다.
// 카드 안에 제목·요약·세션이 들어가 있어 호버하지 않아도 읽힌다. 갱신 때 기존 좌표를 이어 받아 튀지 않게 한다.
import { t } from './i18n'
import type { AgentView, Snapshot, WorkspaceView } from '../model'
import type { GraphPoint } from '../graph-layout'
import { topicRoot } from '../model'
import { openMenu, setHoverDragging } from './overlays'
import { burstAt, celebrate, floatAt, pop, shake } from './fx'
import { AGENT_STATE_LABEL, agentGlyph, clip, h, icon, s, statusColor, statusLabel, topicColor } from './ui'

interface GNode {
  id: string
  kind: 'repo' | 'hub' | 'ws' | 'more'
  /** 반폭·반높이(충돌 계산용). */
  hw: number
  hh: number
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
  /** 디렉토리끼리 떨어뜨릴 때 쓰는 반지름(섹션까지 포함). */
  extent?: number
  label: string
  color: string
  hot: boolean
  repoId: string
  wsId?: string
  topicId?: string | null
  count?: number
  /** 끌려가는 노드(섹션 또는 부모 카드). */
  anchor?: GNode
  /** 섹션: 디렉토리 기준 고정 위치. */
  off?: { x: number; y: number }
  /** 섹션: 주제 id('_' 는 기타) 또는 상태. */
  section?: string
  /** 섹션: 접기 상태 저장 키와 접혔는지, 안에 살아 있는 세션 수. */
  skey?: string
  collapsed?: boolean
  working?: number
  attention?: number
  /** 하위 섹션. */
  sub?: boolean
}

interface GEdge {
  a: GNode
  b: GNode
  len: number
  kind: 'repo' | 'hub' | 'parent' | 'sub'
  live: boolean
}

export interface GraphHooks {
  openWorkspace(w: WorkspaceView, el?: Element): void
  focusAgent(w: WorkspaceView, a: AgentView, el?: Element): void
  hoverWorkspace(el: Element, wsId: string): void
  hoverAgent(el: Element, wsId: string, agentKey: string): void
  hoverTabs(el: Element, wsId: string): void
  /** 세션 참조를 관제 입력창에 넣는다. */
  sendToControl(w: WorkspaceView, a: AgentView, from: Element): void
  /** 고른 범위에서 끝났는데 탭만 남은 터미널. */
  deadTabs(): string[]
  closeTabs(handles: string[]): Promise<void>
  menuWorkspace(at: { x: number; y: number }, w: WorkspaceView, owner: Element): void
  groupBy(): 'topic' | 'status'
  setGroupBy(v: 'topic' | 'status'): void
  /** 섹션 접기 상태. undefined 면 자동(카드가 많을 때 조용한 섹션은 접힘). */
  sectionState(key: string): 'open' | 'closed' | 'all' | undefined
  setSectionState(keys: string[], v: 'open' | 'closed' | 'all' | null): void
  scopeRepo(): string | null
  position(id: string): GraphPoint | undefined
  setPosition(id: string, point: GraphPoint | null): void
  resetPositions(): void
  /** 섹션 추가. parentId 를 주면 그 아래 하위 섹션. */
  addSection(repoId: string, parentId?: string): void
  addSession(repoId: string, topicId: string | null, anchor: Element): void
  addToWorkspace(w: WorkspaceView, anchor: Element): void
  /** 카드를 다른 섹션에 놓았을 때. 주제 묶음이면 topicId('_' 는 기타), 상태 묶음이면 status. */
  moveToSection(w: WorkspaceView, to: { topicId?: string; status?: string; label: string }): Promise<void>
}

const CARD_W = 184
const STATUS_RANK: Record<string, number> = { 'in-progress': 0, 'in-review': 1, todo: 2, 'long-running': 3, 'on-hold': 4, completed: 5 }
const LIVE = new Set(['working', 'blocked', 'waiting'])

function seeded(seed: string): () => number {
  let x = 2166136261
  for (const ch of seed) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 10000) / 10000
  }
}

const canvas = document.createElement('canvas')
const ctx = canvas.getContext('2d')!
function textWidth(text: string, size: number, weight = 650): number {
  ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`
  return ctx.measureText(text).width
}

/** 카드에 한 줄로 보일 요약: 메모 → PR 제목 → 브랜치. */
function recap(w: WorkspaceView): string {
  return (w.comment || w.pr?.title || (w.branch && w.branch !== w.name ? w.branch : '')).replace(/\s+/g, ' ').trim()
}

/** 카드에 보일 세션: 살아 있는 것만, 급한 순. */
function cardSessions(w: WorkspaceView): AgentView[] {
  return w.agents.filter((a) => a.state !== 'done')
}

function cardHeight(w: WorkspaceView): number {
  const r = recap(w)
  const lines = r ? (textWidth(r, 11, 400) > CARD_W - 24 ? 2 : 1) : 0
  const sess = cardSessions(w)
  const rows = Math.min(sess.length, 3) + (sess.length > 3 ? 0.7 : 0)
  const strip = w.terminals.length || w.agents.some((a) => a.surface === 'chat' && a.state !== 'done')
  return 14 + 18 + lines * 15 + (rows ? 6 + rows * 23 : 0) + (strip ? 26 : 0) + 10
}

function simulate(nodes: GNode[], edges: GEdge[], ticks: number): void {
  const n = nodes.length
  const homes = new Map<string, GNode>()
  for (const p of nodes) if (p.kind === 'repo') homes.set(p.repoId, p)
  for (let t = 0; t < ticks; t++) {
    const alpha = 0.3 * (1 - t / ticks) + 0.02
    for (let i = 0; i < n; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (i % 7) - 3 || 1
          dy = (j % 5) - 2 || 1
          d2 = dx * dx + dy * dy
        }
        const d = Math.sqrt(d2)
        // 다른 디렉토리끼리는 섹션까지 감싼 원으로 떨어뜨린다.
        if (a.kind === 'repo' && b.kind === 'repo') {
          const min = (a.extent ?? 60) + (b.extent ?? 60)
          if (d < min) {
            const f = ((min - d) / d) * 0.25
            a.vx -= dx * f
            a.vy -= dy * f
            b.vx += dx * f
            b.vy += dy * f
          }
          continue
        }
        if (a.repoId !== b.repoId || d2 > 640000) continue
        const strength = (a.kind === 'hub' && b.kind === 'hub' ? 14000 : a.kind === 'repo' || b.kind === 'repo' ? 1200 : a.anchor !== b.anchor ? 2600 : 400) / d2
        const fx = (dx / d) * strength * alpha
        const fy = (dy / d) * strength * alpha
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x
      const dy = e.b.y - e.a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const k = ((d - e.len) / d) * (e.kind === 'repo' ? 0.5 : e.kind === 'sub' ? 0.45 : 0.3) * alpha
      const wa = e.a.kind === 'repo' ? 0.1 : 0.5
      e.a.vx += dx * k * wa
      e.a.vy += dy * k * wa
      e.b.vx -= dx * k
      e.b.vy -= dy * k
    }
    for (const p of nodes) {
      if (p.fixed) { p.vx = p.vy = 0; continue }
      // 카드는 자기 섹션 쪽으로, 섹션은 디렉토리 쪽으로 당겨 묶음이 흩어지지 않게 한다.
      const home = p.kind === 'repo' ? { x: 0, y: 0 } : (p.anchor ?? homes.get(p.repoId) ?? { x: 0, y: 0 })
      const pull = p.kind === 'repo' ? 0.009 : p.kind === 'hub' ? (p.off ? 0.006 : 0.03) : 0.06
      p.vx -= (p.x - home.x) * pull * alpha
      p.vy -= (p.y - home.y) * pull * alpha
      const v = Math.hypot(p.vx, p.vy)
      if (v > 30) {
        p.vx = (p.vx / v) * 30
        p.vy = (p.vy / v) * 30
      }
      if (p.kind === 'hub' && p.off) {
        const r = homes.get(p.repoId)
        p.x = (r?.x ?? 0) + p.off.x
        p.y = (r?.y ?? 0) + p.off.y
        p.vx = p.vy = 0
        continue
      }
      p.x += p.vx
      p.y += p.vy
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        p.x = (Math.random() - 0.5) * 50
        p.y = (Math.random() - 0.5) * 50
        p.vx = p.vy = 0
      }
      p.vx *= 0.55
      p.vy *= 0.55
    }
    collide(nodes, 0.5)
  }
  // 마지막에 겹침이 남지 않게 충돌만 몇 번 더 푼다.
  for (let k = 0; k < 40; k++) if (!collide(nodes, 0.6)) break
}

/** 사각형끼리 겹치면 덜 겹친 축으로 밀어낸다. 겹침이 있었으면 true. */
function collide(nodes: GNode[], amount: number): boolean {
  let any = false
  const gap = 14
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]
      if (a.kind === 'repo' && b.kind === 'repo') continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const ox = a.hw + b.hw + gap - Math.abs(dx)
      const oy = a.hh + b.hh + gap - Math.abs(dy)
      if (ox <= 0 || oy <= 0) continue
      any = true
      const still = (n: GNode) => !!n.fixed || n.kind === 'repo' || (n.kind === 'hub' && !!n.off)
      if (still(a) && still(b)) continue
      const wa = still(a) ? 0 : still(b) ? 1 : 0.5
      const wb = 1 - wa
      if (ox < oy) {
        const m = ox * amount * (dx >= 0 ? 1 : -1)
        a.x -= m * wa
        b.x += m * wb
      } else {
        const m = oy * amount * (dy >= 0 ? 1 : -1)
        a.y -= m * wa
        b.y += m * wb
      }
    }
  }
  return any
}

export function createGraph(hooks: GraphHooks) {
  const viewport = s('g')
  const edgeLayer = s('g')
  const nodeLayer = s('g')
  viewport.append(edgeLayer, nodeLayer)
  const svg = s('svg', { class: 'g' }, viewport) as SVGSVGElement
  const wrap = h('div', { class: 'graph-wrap' }, svg)

  let scale = 1
  let tx = 0
  let ty = 0
  let fitted = false
  let userMoved = false
  let visibleKey = ''
  let positions = new Map<string, { x: number; y: number }>()
  let current: { nodes: GNode[]; snap: Snapshot } | null = null
  let lastKey = ''
  let selected: string | null = null
  let reserve: { side: 'left' | 'right' | 'bottom'; size: number } | null = null
  let tween = 0

  function applyTransform(): void {
    if (!Number.isFinite(scale) || scale <= 0) scale = 1
    if (!Number.isFinite(tx)) tx = 0
    if (!Number.isFinite(ty)) ty = 0
    viewport.setAttribute('transform', `translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(4)})`)
    wrap.style.setProperty('--k', (1 / scale).toFixed(4))
    // 멀리서 볼 때는 카드에 제목만 크게 남긴다.
    wrap.classList.toggle('far', scale < 0.55)
    const next = Math.min(1.3, Math.max(1, 0.6 / scale))
    if (Math.abs(next - lod) > 0.01) {
      lod = next
      for (const it of nodeEls) if (it.g.dataset.lod) moveTo(it.g, shown.get(it.n.id)?.x ?? it.n.x, shown.get(it.n.id)?.y ?? it.n.y)
    }
  }

  function animateTo(ns: number, ntx: number, nty: number): void {
    cancelAnimationFrame(tween)
    const s0 = scale
    const x0 = tx
    const y0 = ty
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 420)
      const e = 1 - Math.pow(1 - t, 3)
      scale = s0 + (ns - s0) * e
      tx = x0 + (ntx - x0) * e
      ty = y0 + (nty - y0) * e
      applyTransform()
      if (t < 1) tween = requestAnimationFrame(step)
    }
    tween = requestAnimationFrame(step)
  }

  /** 작업 창이 차지하지 않은 영역. */
  function freeArea(): { x: number; y: number; w: number; h: number } {
    const W = wrap.clientWidth || 380
    const H = wrap.clientHeight || 600
    const top = 48
    if (!reserve) return { x: 0, y: top, w: W, h: H - top }
    return {
      x: reserve.side === 'left' ? reserve.size : 0,
      y: top,
      w: W - (reserve.side === 'bottom' ? 0 : reserve.size),
      h: H - top - (reserve.side === 'bottom' ? reserve.size : 0)
    }
  }

  function fit(smooth = false): void {
    if (!current || current.nodes.length === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of current.nodes) {
      minX = Math.min(minX, p.x - p.hw)
      minY = Math.min(minY, p.y - p.hh)
      maxX = Math.max(maxX, p.x + p.hw)
      maxY = Math.max(maxY, p.y + p.hh + (p.kind === 'repo' ? 20 : 0))
    }
    const a = freeArea()
    const pad = 24
    const ns = Math.max(0.2, Math.min((a.w - pad * 2) / (maxX - minX), (a.h - pad * 2) / (maxY - minY), 1.15))
    const ntx = a.x + a.w / 2 - ((minX + maxX) / 2) * ns
    const nty = a.y + a.h / 2 - ((minY + maxY) / 2) * ns
    if (smooth) animateTo(ns, ntx, nty)
    else {
      scale = ns
      tx = ntx
      ty = nty
      applyTransform()
    }
  }

  function zoomAt(factor: number, cx: number, cy: number): void {
    cancelAnimationFrame(tween)
    const next = Math.max(0.2, Math.min(3, scale * factor))
    tx = cx - ((cx - tx) * next) / scale
    ty = cy - ((cy - ty) * next) / scale
    scale = next
    applyTransform()
  }

  wrap.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      const r = wrap.getBoundingClientRect()
      userMoved = true
      zoomAt(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0025)), ev.clientX - r.left, ev.clientY - r.top)
    },
    { passive: false }
  )

  let drag: { x: number; y: number; tx: number; ty: number } | null = null
  svg.addEventListener('pointerdown', (ev) => {
    window.getSelection()?.removeAllRanges()
    if ((ev.target as Element).closest('.g-node')) return
    cancelAnimationFrame(tween)
    drag = { x: ev.clientX, y: ev.clientY, tx, ty }
    svg.setPointerCapture(ev.pointerId)
    wrap.classList.add('dragging')
  })
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return
    const dx = ev.clientX - drag.x
    const dy = ev.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) userMoved = true
    tx = drag.tx + dx
    ty = drag.ty + dy
    applyTransform()
  })
  const endDrag = () => {
    drag = null
    wrap.classList.remove('dragging')
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)

  const tools = h(
    'div',
    { class: 'graph-tools' },
    h('button', { class: 'icon-btn', title: t('확대'), onClick: () => zoomAt(1.25, wrap.clientWidth / 2, wrap.clientHeight / 2) }, icon('zoomIn')),
    h('button', { class: 'icon-btn', title: t('축소'), onClick: () => zoomAt(0.8, wrap.clientWidth / 2, wrap.clientHeight / 2) }, icon('zoomOut')),
    h(
      'button',
      {
        class: 'icon-btn',
        title: t('전체 보기'),
        onClick: () => {
          userMoved = false
          fit(true)
        }
      },
      icon('fit')
    )
  )
  const groupSeg = h('div', { class: 'seg sm' })
  const resetPositionsBtn = h('button', { class: 'pill-btn', title: t('저장한 위치를 자동 배치로 되돌리기'), onClick: () => {
    hooks.resetPositions()
    positions.clear()
    relayout = true
    lastKey = ''
    if (current) {
      self.update(current.snap, visibleRef)
      userMoved = false
      fit(true)
    }
  } }, icon('refresh'), t('자동 배치'))
  const foldBtn = h('button', { class: 'pill-btn', title: t('주제 모두 접기·펼치기') })
  foldBtn.addEventListener('click', () => {
    const anyOpen = nodeEls.some((x) => x.n.kind === 'hub' && !x.n.collapsed)
    lastKey = ''
    hooks.setSectionState(sectionKeys, anyOpen ? 'closed' : 'open')
  })
  const sweepBtn = h('button', { class: 'pill-btn g-sweep', title: t('끝났는데 탭만 남은 터미널(초기 설정 등) 닫기') })
  let sweepArmed = 0
  sweepBtn.addEventListener('click', () => {
    const handles = hooks.deadTabs()
    if (!handles.length) return
    if (!sweepArmed) {
      sweepBtn.classList.add('armed')
      sweepBtn.replaceChildren(icon('broom'), t(`한 번 더 누르면 {n}개 닫기`, { n: handles.length }))
      sweepArmed = window.setTimeout(() => {
        sweepArmed = 0
        renderBar()
      }, 2500)
      return
    }
    window.clearTimeout(sweepArmed)
    sweepArmed = 0
    // 카드마다 끝난 탭 칸이 터지며 사라진다.
    const chips = [...nodeLayer.querySelectorAll('.gc-tab.dead')]
    chips.forEach((c, i) => window.setTimeout(() => burstAt(c, 'var(--muted)', 6, 0.5), i * 25))
    void hooks.closeTabs(handles)
  })
  const bar = h('div', { class: 'g-bar' }, groupSeg, foldBtn, resetPositionsBtn, sweepBtn)
  function renderBar(): void {
    resetPositionsBtn.hidden = !nodeEls.some(({ n }) => n.fixed)
    const mode = hooks.groupBy()
    groupSeg.replaceChildren(
      ...(
        [
          ['topic', t('주제별')],
          ['status', t('상태별')]
        ] as const
      ).map(([id, label]) =>
        h(
          'button',
          {
            class: mode === id ? 'on' : '',
            onClick: () => {
              if (hooks.groupBy() === id) return
              lastKey = ''
              hooks.setGroupBy(id)
            }
          },
          label
        )
      )
    )
    const anyOpen = nodeEls.some((x) => x.n.kind === 'hub' && !x.n.collapsed)
    foldBtn.replaceChildren(icon(anyOpen ? 'fold' : 'unfold'), anyOpen ? t('모두 접기') : t('모두 펼치기'))
    if (!sweepArmed) {
      const n = hooks.deadTabs().length
      sweepBtn.classList.remove('armed')
      sweepBtn.hidden = n === 0
      sweepBtn.replaceChildren(icon('broom'), t(`끝난 탭 {n}`, { n }))
    }
  }
  const legend = h('div', { class: 'graph-legend' })
  wrap.append(tools, legend, bar)

  /** 이번에 그린 섹션들의 접기 키(모두 접기·펼치기용). */
  let sectionKeys: string[] = []

  function build(snap: Snapshot, visible: Set<string>): { nodes: GNode[]; edges: GEdge[] } {
    sectionKeys = []
    const nodes: GNode[] = []
    const edges: GEdge[] = []
    const byId = new Map<string, GNode>()
    const add = (n: GNode) => {
      const prev = positions.get(n.id)
      if (prev) {
        n.x = prev.x
        n.y = prev.y
      }
      const positionId = n.kind === 'ws' ? n.wsId : n.kind === 'hub' ? `@group:${n.id}` : null
      const fixed = positionId ? hooks.position(positionId) : undefined
      if (fixed) { n.x = fixed.x; n.y = fixed.y; n.fixed = true }
      nodes.push(n)
      byId.set(n.id, n)
      return n
    }
    const repos = snap.repos.filter((r) => r.workspaceIds.some((id) => visible.has(id)))
    repos.forEach((repo, i) => {
      const angle = (i / Math.max(1, repos.length)) * Math.PI * 2
      const radius = repos.length > 1 ? 500 + repos.length * 40 : 0
      add({ id: `r:${repo.id}`, kind: 'repo', hw: 26, hh: 26, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, label: repo.name, color: 'var(--fg)', hot: true, repoId: repo.id })
    })
    for (const repo of repos) {
      const hub = byId.get(`r:${repo.id}`)!
      const ids = repo.workspaceIds.filter((id) => visible.has(id))
      // 주제별(주제가 없으면 상태별)로 섹션을 나눈다. 주제에는 하위 섹션이 있을 수 있다.
      const byTopic = hooks.groupBy() === 'topic' && repo.topics.length > 0
      const mode = byTopic ? 't' : 's'
      const keyOf = (w: WorkspaceView) => (byTopic ? (w.topic ?? '_') : w.status)
      const known = new Set(repo.topics.map((t) => t.id))
      type Sec = { id: string; name: string; color: string; parent: string | null }
      const sections: Sec[] = byTopic
        ? [
            ...repo.topics.map((t) => ({ id: t.id, name: t.name, color: topicColor(topicRoot(repo.topics, t.id)), parent: t.parent && known.has(t.parent) ? t.parent : null })),
            { id: '_', name: t('기타'), color: 'var(--muted)', parent: null }
          ]
        : [...new Set(ids.map((id) => snap.workspaces[id].status))]
            .sort((a, b) => (STATUS_RANK[a] ?? 3.5) - (STATUS_RANK[b] ?? 3.5))
            .map((st) => ({ id: st, name: statusLabel(st), color: statusColor(st), parent: null }))
      const members = new Map<string, string[]>()
      for (const id of ids) {
        const k = keyOf(snap.workspaces[id])
        members.set(k, [...(members.get(k) ?? []), id])
      }
      const childrenOf = (id: string | null) => sections.filter((x) => x.parent === id)
      const subtree = (id: string, depth = 0): string[] =>
        depth > 6 ? [] : [...(members.get(id) ?? []), ...childrenOf(id).flatMap((c) => subtree(c.id, depth + 1))]
      const used = sections.filter((t) => subtree(t.id).length > 0)
      const usedIds = new Set(used.map((t) => t.id))
      // 카드가 많으면 화면 전체에 예산을 두고 급한 것·최근 것부터 채운다. 하나도 못 받은 섹션은 접힌다.
      const big = ids.length > 30
      const limit = big ? 10 : 16
      const urgency = (id: string) => {
        const ag = snap.workspaces[id].agents
        return ag.some((a) => a.state === 'blocked' || a.state === 'waiting') ? 0 : ag.some((a) => a.state === 'working') ? 1 : 2
      }
      const rank = (a: string, b: string) => urgency(a) - urgency(b) || snap.workspaces[b].lastActivityAt - snap.workspaces[a].lastActivityAt
      const budgeted = new Set(big ? [...ids].sort(rank).slice(0, 36) : ids)
      type Plan = { t: Sec; skey: string; all: string[]; tree: string[]; show: string[]; collapsed: boolean; hidden: number; working: number; attention: number; kids: Plan[] }
      const planOf = (t: Sec, depth = 0): Plan => {
        const all = members.get(t.id) ?? []
        const skey = `${repo.id}:${mode}:${t.id}`
        const st = hooks.sectionState(skey)
        let show: string[]
        if (st === 'closed') show = []
        else if (st === 'all') show = all
        else if (st === 'open') show = [...all].sort(rank).slice(0, 16)
        else show = all.filter((id) => budgeted.has(id)).sort(rank).slice(0, limit)
        const kids = depth > 5 ? [] : childrenOf(t.id).filter((c) => usedIds.has(c.id)).map((c) => planOf(c, depth + 1))
        const openKids = kids.some((k) => !k.collapsed)
        const collapsed = st === 'closed' || (st === undefined && show.length === 0 && !openKids)
        const tree = subtree(t.id)
        const agents = tree.flatMap((id) => snap.workspaces[id].agents)
        return {
          t,
          skey,
          all,
          tree,
          show: collapsed ? [] : show,
          collapsed,
          hidden: collapsed ? 0 : all.length - show.length,
          working: agents.filter((a) => a.state === 'working').length,
          attention: agents.filter((a) => a.state === 'blocked' || a.state === 'waiting').length,
          kids
        }
      }
      const plan = used.filter((t) => t.parent === null).map((t) => planOf(t))
      // 접히지 않은 섹션만 펼쳐 그린다(접힌 섹션의 하위는 그리지 않는다).
      const drawn: Plan[] = []
      const collect = (x: Plan) => {
        drawn.push(x)
        if (!x.collapsed) x.kids.forEach(collect)
      }
      plan.forEach(collect)
      sectionKeys.push(...drawn.map((x) => x.skey))
      const visibleCards = new Set(drawn.flatMap((x) => x.show))
      const weight = (x: Plan): number => (x.collapsed ? 1 : x.show.length + (x.hidden ? 1 : 0) + x.kids.reduce((n, k) => n + 1 + weight(k), 0))
      // 최상위 섹션마다 (하위까지) 보이는 카드 수만큼 둘레를 나눠 갖고, 둘레가 모자라면 고리를 넓힌다.
      const share = plan.map((x) => (x.collapsed ? 120 : 80 + Math.sqrt(weight(x)) * 80))
      const total = share.reduce((a, b) => a + b, 0)
      const ring = Math.max(plan.length > 1 ? 190 : 120, total / (Math.PI * 2))
      const hubs = new Map<string, GNode>()
      const hubNode = (x: Plan, at: { x: number; y: number }, parent: GNode, off?: { x: number; y: number }, sub = false) => {
        const t = x.t
        const width = textWidth(t.name, sub ? 12.5 : 14, 700) + (sub ? 50 : 58) + (x.collapsed && (x.working || x.attention) ? 44 : 0)
        const node = add({
          id: `h:${repo.id}:${t.id}`,
          kind: 'hub',
          hw: width / 2,
          hh: x.collapsed ? (sub ? 20 : 24) : sub ? 15 : 18,
          x: at.x,
          y: at.y,
          vx: 0,
          vy: 0,
          label: t.name,
          color: t.color,
          hot: false,
          repoId: repo.id,
          topicId: byTopic ? (t.id === '_' ? null : t.id) : undefined,
          count: x.tree.length,
          off,
          section: t.id,
          anchor: parent,
          skey: x.skey,
          collapsed: x.collapsed,
          working: x.working,
          attention: x.attention,
          sub
        })
        hubs.set(t.id, node)
        return node
      }
      const addMore = (x: Plan, node: GNode, ang: number) => {
        if (!x.hidden) return
        const more = add({
          id: `m:${repo.id}:${x.t.id}`,
          kind: 'more',
          hw: 62,
          hh: 15,
          x: node.x + Math.cos(ang) * 120,
          y: node.y + Math.sin(ang) * 120,
          vx: 0,
          vy: 0,
          label: t(`외 {hidden}개`, { hidden: x.hidden }),
          color: x.t.color,
          hot: false,
          repoId: repo.id,
          anchor: node,
          skey: x.skey
        })
        edges.push({ a: node, b: more, len: 120, kind: 'hub', live: false })
      }
      /** 하위 섹션은 상위 섹션 바깥쪽에 부채꼴로 매단다. */
      const addKids = (x: Plan, node: GNode, depth: number) => {
        if (x.collapsed || depth > 5) return
        const base = Math.atan2(node.y - hub.y, node.x - hub.x)
        x.kids.forEach((k, i) => {
          const spread = (i - (x.kids.length - 1) / 2) * 0.75
          const len = node.hw + 150
          const at = { x: node.x + Math.cos(base + spread) * len, y: node.y + Math.sin(base + spread) * len }
          const child = hubNode(k, at, node, undefined, true)
          edges.push({ a: node, b: child, len, kind: 'sub', live: false })
          addMore(k, child, base + spread)
          addKids(k, child, depth + 1)
        })
      }
      let acc = 0
      plan.forEach((x, i) => {
        const ang = ((acc + share[i] / 2) / total) * Math.PI * 2 - Math.PI / 2
        acc += share[i]
        const off = { x: Math.cos(ang) * ring, y: Math.sin(ang) * ring * 0.72 }
        const node = hubNode(x, { x: hub.x + off.x, y: hub.y + off.y }, hub, off)
        edges.push({ a: hub, b: node, len: ring, kind: 'repo', live: false })
        addMore(x, node, Math.atan2(off.y, off.x))
        addKids(x, node, 1)
      })
      hub.extent = ring + 300
      // 부모가 먼저 놓이도록 깊이 순으로
      const depth = (id: string): number => {
        let d = 0
        let p = snap.workspaces[id]?.parentId
        while (p && d < 8) {
          d++
          p = snap.workspaces[p]?.parentId
        }
        return d
      }
      const shownIds = ids.filter((id) => visibleCards.has(id)).sort((a, b) => depth(a) - depth(b))
      for (const id of shownIds) {
        const w = snap.workspaces[id]
        const rand = seeded(id)
        const parent = w.parentId && visibleCards.has(w.parentId) ? byId.get(`w:${w.parentId}`) : undefined
        const sec = hubs.get(keyOf(w))!
        const origin = parent ?? sec
        // 바깥쪽(디렉토리 반대편)으로 퍼지게 놓는다.
        const out = Math.atan2(origin.y - hub.y, origin.x - hub.x)
        const angle = out + (rand() - 0.5) * 1.6
        const siblings = members.get(keyOf(w))?.length ?? 1
        const len = parent ? 110 : sec.hw + CARD_W / 2 + 4 + Math.sqrt(siblings) * 6
        const hh = cardHeight(w) / 2
        const live = cardSessions(w)
        const node = add({
          id: `w:${id}`,
          kind: 'ws',
          hw: CARD_W / 2,
          hh,
          x: origin.x + Math.cos(angle) * len,
          y: origin.y + Math.sin(angle) * len,
          vx: 0,
          vy: 0,
          label: w.name,
          color: statusColor(w.status),
          hot: live.some((a) => LIVE.has(a.state)),
          repoId: repo.id,
          wsId: id,
          anchor: origin
        })
        edges.push({ a: origin, b: node, len, kind: parent ? 'parent' : 'hub', live: live.some((a) => a.state === 'working') })
      }
    }
    return { nodes, edges }
  }

  function sessionRow(w: WorkspaceView, a: AgentView): HTMLElement {
    // 줄 자체가 버튼이라 안에는 span 으로 둔다. 올렸을 때만 보인다.
    const ref = h('span', { class: 'gc-ref', role: 'button', title: t('관제 입력창에 넣기') }, icon('sparkle'))
    ref.addEventListener('pointerdown', (ev) => ev.stopPropagation())
    ref.addEventListener('click', (ev) => {
      ev.stopPropagation()
      hooks.sendToControl(w, a, ref)
    })
    const row = h(
      'button',
      { class: 'gc-sess', 'data-state': a.state, 'data-sel': `s:${a.key}`, title: a.title },
      h('span', { class: 'gc-glyph', 'data-type': a.type }, agentGlyph(a.type)),
      h('span', { class: 'gc-st' }, a.title),
      h('span', { class: 'gc-state' }, a.state === 'working' && a.tool ? a.tool.name : AGENT_STATE_LABEL[a.state]),
      ref
    )
    row.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (suppressClick) return
      hooks.focusAgent(w, a, row)
    })
    hooks.hoverAgent(row, w.id, a.key)
    return row
  }

  /** 카드 아래 세션 줄: 대화창 세션(동그라미)·에이전트 터미널·셸·초기 설정을 작은 칸으로, 끝난 탭은 흐리게. 올리면 목록이 뜬다. */
  function tabStrip(w: WorkspaceView): HTMLElement | null {
    const chats = w.agents.filter((a) => a.surface === 'chat' && a.state !== 'done')
    if (!w.terminals.length && !chats.length) return null
    const order = (t: (typeof w.terminals)[number]) => (!t.connected ? 3 : t.kind === 'agent' ? 0 : t.kind === 'shell' ? 1 : 2)
    const list = [...w.terminals].sort((a, b) => order(a) - order(b))
    const dead = list.filter((t) => !t.connected).length
    const chips = [
      ...chats.map((a) => h('span', { class: 'gc-tab agent chat', 'data-type': a.type, title: t(`{title} · 대화창`, { title: a.title }) }, agentGlyph(a.type))),
      ...list.map((t) =>
        h(
          'span',
          { class: `gc-tab ${t.kind}${t.connected ? '' : ' dead'}`, 'data-type': t.agentType ?? '', 'data-term': t.handle },
          t.kind === 'agent' ? agentGlyph(t.agentType ?? 'agent') : icon(t.kind === 'setup' ? 'gear' : 'terminal')
        )
      )
    ]
    const total = chips.length
    const strip = h(
      'div',
      { class: 'gc-tabs' },
      chips.slice(0, 7),
      total > 7 ? h('span', { class: 'gc-tab-more' }, `+${total - 7}`) : null,
      h('span', { class: 'gc-tab-label' }, t(`세션 {total}`, { total })),
      dead ? h('span', { class: 'gc-tab-dead' }, t(`끝남 {dead}`, { dead })) : null
    )
    strip.addEventListener('click', (ev) => ev.stopPropagation())
    hooks.hoverTabs(strip, w.id)
    return strip
  }

  function card(p: GNode, w: WorkspaceView): HTMLElement {
    const r = recap(w)
    const sess = cardSessions(w)
    const plus = h('button', { class: 'gc-add', title: t('세션 추가') }, icon('plus'))
    plus.addEventListener('click', (ev) => {
      ev.stopPropagation()
      hooks.addToWorkspace(w, plus)
    })
    const state = sess.some((a) => a.state === 'blocked') ? 'blocked' : sess.some((a) => a.state === 'waiting') ? 'waiting' : sess.some((a) => a.state === 'working') ? 'working' : ''
    const el = h(
      'div',
      { class: `gc${w.unread ? ' unread' : ''}`, 'data-attn': state, style: { '--c': p.color } },
      h(
        'div',
        { class: 'gc-head' },
        h('span', { class: 'gc-title' }, w.name),
        w.pr ? h('span', { class: 'gc-pr', 'data-state': w.pr.state }, `#${w.pr.number}`) : null,
        plus
      ),
      r ? h('div', { class: 'gc-recap', title: r }, clip(r, 120)) : null,
      sess.length
        ? h(
            'div',
            { class: 'gc-sessions' },
            sess.slice(0, 3).map((a) => sessionRow(w, a)),
            sess.length > 3 ? h('span', { class: 'gc-more' }, t(`세션 {n}개 더`, { n: sess.length - 3 })) : null
          )
        : null,
      tabStrip(w)
    )
    return el
  }

  /** 지금 화면에 그려진 좌표(애니메이션 중간값 포함). 다음 그리기는 여기서 출발한다. */
  const shown = new Map<string, { x: number; y: number }>()
  let settle = 0
  let nodeEls: { n: GNode; g: SVGElement; from: { x: number; y: number }; fresh: boolean }[] = []
  let edgeEls: { e: GEdge; path: SVGElement }[] = []
  let dragging: GNode | null = null
  let suppressClick = false
  let visibleRef = new Set<string>()
  let relayout = false
  let pendingUpdate: { snap: Snapshot; visible: Set<string> } | null = null

  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    // 살짝 휜 선으로 잇는다.
    const mx = (a.x + b.x) / 2 - (b.y - a.y) * 0.08
    const my = (a.y + b.y) / 2 + (b.x - a.x) * 0.08
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }
  /** 섹션·디렉토리 표시는 축소할수록 반대로 키워 멀리서도 읽힌다. */
  let lod = 1
  const moveTo = (g: SVGElement, x: number, y: number) =>
    g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})${g.dataset.lod && lod !== 1 ? ` scale(${lod.toFixed(3)})` : ''}`)

  function redrawEdges(only?: GNode): void {
    for (const it of edgeEls) {
      if (only && it.e.a !== only && it.e.b !== only) continue
      const a = shown.get(it.e.a.id) ?? it.e.a
      const b = shown.get(it.e.b.id) ?? it.e.b
      it.path.setAttribute('d', curve(a, b))
    }
  }

  function place(t: number): void {
    const e = 1 - Math.pow(1 - t, 3)
    for (const it of nodeEls) {
      if (it.n === dragging) continue
      const x = it.from.x + (it.n.x - it.from.x) * e
      const y = it.from.y + (it.n.y - it.from.y) * e
      moveTo(it.g, x, y)
      shown.set(it.n.id, { x, y })
      if (it.fresh) it.g.style.opacity = t < 1 ? String(Math.min(1, t * 1.8)) : ''
    }
    redrawEdges()
  }

  /** 이전 자리에서 새 자리로 미끄러지듯 옮긴다. 새 카드는 자기 섹션에서 피어난다. */
  function animateLayout(): void {
    cancelAnimationFrame(settle)
    const t0 = performance.now()
    place(0)
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 560)
      place(t)
      if (t < 1) settle = requestAnimationFrame(step)
    }
    settle = requestAnimationFrame(step)
  }

  function draw(snap: Snapshot, nodes: GNode[], edges: GEdge[]): void {
    cancelAnimationFrame(settle)
    const start = new Map<string, { x: number; y: number }>()
    const startOf = (n: GNode): { x: number; y: number } => {
      const got = start.get(n.id) ?? shown.get(n.id) ?? (n.anchor ? startOf(n.anchor) : { x: n.x, y: n.y })
      start.set(n.id, got)
      return got
    }
    edgeEls = edges.map((e) => ({
      e,
      path: s('path', { class: `g-edge ${e.kind}${e.live ? ' live' : ''}`, stroke: e.kind === 'repo' ? e.b.color : undefined })
    }))
    edgeLayer.replaceChildren(...edgeEls.map((x) => x.path))
    nodeEls = []
    for (const p of nodes) {
      const g = s('g', { class: `g-node g-${p.kind}`, 'data-lod': p.kind === 'hub' || p.kind === 'repo' ? '1' : undefined })
      if (p.kind === 'repo') {
        g.append(
          s('rect', { class: 'halo', x: -32, y: -32, width: 64, height: 64, rx: 16 }),
          s('rect', { class: 'core', x: -26, y: -26, width: 52, height: 52, rx: 14 })
        )
        const ic = icon('folder')
        ic.setAttribute('x', '-9')
        ic.setAttribute('y', '-9')
        ic.setAttribute('width', '18')
        ic.setAttribute('height', '18')
        const plus = s('g', { class: 'g-repo-plus', transform: 'translate(19 -19)' }, s('circle', { r: 9 }), s('path', { d: 'M-4 0h8M0 -4v8' }))
        g.append(ic, plus, s('text', { class: 'g-label repo', y: 46, 'text-anchor': 'middle' }, p.label), s('title', null, t('눌러서 주제 추가')))
        g.addEventListener('click', () => {
          pop(g.querySelector('.core'))
          hooks.addSection(p.repoId)
        })
      } else if (p.kind === 'hub') {
        const fo = s('foreignObject', { x: -p.hw - 8, y: -p.hh - 8, width: p.hw * 2 + 16, height: p.hh * 2 + 16 })
        const pill = h(
          'div',
          { class: `gh${p.collapsed ? ' collapsed' : ''}${p.sub ? ' sub' : ''}`, style: { '--t': p.color }, title: p.collapsed ? t('눌러서 펼치기') : t('눌러서 접기') },
          h('span', { class: 'gh-name' }, p.label),
          p.collapsed && p.attention ? h('span', { class: 'gh-live attn' }, h('i'), p.attention) : null,
          p.collapsed && p.working ? h('span', { class: 'gh-live work' }, h('i'), p.working) : null,
          h('span', { class: 'gh-n' }, p.count ?? 0)
        )
        if (p.topicId !== undefined) {
          const add = h('button', { class: 'gh-add', title: p.topicId ? t('새 워크스페이스 · 하위 주제') : t('여기에 새 워크스페이스') }, icon('plus'))
          add.addEventListener('click', (ev) => {
            ev.stopPropagation()
            if (!p.topicId) return hooks.addSession(p.repoId, null, add)
            openMenu(add, [
              { section: p.label },
              { label: t('새 워크스페이스'), icon: 'plus', onSelect: () => hooks.addSession(p.repoId, p.topicId ?? null, add) },
              { label: t('하위 주제 추가'), icon: 'sub', onSelect: () => hooks.addSection(p.repoId, p.topicId ?? undefined) }
            ])
          })
          pill.append(add)
        }
        pill.addEventListener('click', () => { if (!suppressClick) toggleSection(p) })
        pill.addEventListener('pointerdown', (ev) => startDrag(ev, p, null, g))
        fo.append(h('div', { class: 'gh-wrap' }, pill))
        g.append(fo)
      } else if (p.kind === 'more') {
        const fo = s('foreignObject', { x: -p.hw - 6, y: -p.hh - 6, width: p.hw * 2 + 12, height: p.hh * 2 + 12 })
        const btn = h('button', { class: 'g-more', style: { '--t': p.color }, title: t('이 주제의 워크스페이스 모두 보기') }, h('span', { class: 'stack' }), p.label)
        btn.addEventListener('click', () => {
          pendingFocus = p.anchor?.id ?? null
          lastKey = ''
          hooks.setSectionState([p.skey!], 'all')
        })
        fo.append(h('div', { class: 'gh-wrap' }, btn))
        g.append(fo)
      } else {
        const w = snap.workspaces[p.wsId!]
        g.setAttribute('data-sel', `w:${w.id}`)
        const fo = s('foreignObject', { x: -p.hw - 10, y: -p.hh - 10, width: p.hw * 2 + 20, height: p.hh * 2 + 26 })
        const c = card(p, w)
        fo.append(h('div', { class: 'gc-wrap' }, c))
        g.append(fo)
        c.addEventListener('click', () => {
          if (!suppressClick) hooks.openWorkspace(w, c)
        })
        c.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          hooks.menuWorkspace({ x: ev.clientX, y: ev.clientY }, w, c)
        })
        c.addEventListener('pointerdown', (ev) => startDrag(ev, p, w, g))
        hooks.hoverWorkspace(c.querySelector('.gc-head')!, w.id)
      }
      const from = startOf(p)
      nodeEls.push({ n: p, g, from, fresh: !shown.has(p.id) })
    }
    nodeLayer.replaceChildren(...nodeEls.map((x) => x.g))
    markSelected()
    animateLayout()

    const used = [...new Set(nodes.filter((n) => n.kind === 'ws').map((n) => snap.workspaces[n.wsId!].status))]
    legend.replaceChildren(
      ...snap.statuses.filter((st) => used.includes(st)).map((st) => h('span', null, h('i', { style: { background: statusColor(st) } }), statusLabel(st)))
    )
    renderBar()
  }

  /** 빈 곳에 놓으면 위치를 보관하고, 섹션 위에 직접 놓으면 소속을 바꾼다. */
  function startDrag(ev: PointerEvent, n: GNode, w: WorkspaceView | null, g: SVGElement): void {
    if (ev.button !== 0 || (ev.target as Element).closest('button, .gc-add') || !current) return
    const sx = ev.clientX
    const sy = ev.clientY
    const origin = { ...(shown.get(n.id) ?? { x: n.x, y: n.y }) }
    const hubs = w ? nodeEls.filter((x) => x.n.kind === 'hub' && x.n.repoId === n.repoId) : []
    const home = n.anchor?.kind === 'hub' ? n.anchor : null
    const line = s('path', { class: 'g-drag-line' })
    let active = false
    let target: (typeof hubs)[number] | null = null
    // 최근 움직임으로 카드를 기울인다. 소속 변경은 실제 놓은 섹션에만 적용한다.
    const trail: { x: number; y: number; t: number }[] = []
    let tilt = 0
    const cardEl = g.querySelector('.gc') as HTMLElement | null
    const toGraph = (cx: number, cy: number) => {
      const r = svg.getBoundingClientRect()
      return { x: (cx - r.left - tx) / scale, y: (cy - r.top - ty) / scale }
    }
    const move = (e: PointerEvent) => {
      const dx = e.clientX - sx
      const dy = e.clientY - sy
      if (!active) {
        if (Math.hypot(dx, dy) < 6) return
        active = true
        dragging = n
        setHoverDragging(true)
        window.getSelection()?.removeAllRanges()
        cancelAnimationFrame(settle)
        place(1)
        wrap.classList.add('moving')
        wrap.classList.toggle('moving-hub', n.kind === 'hub')
        g.classList.add('lifted')
        nodeLayer.append(g)
        edgeLayer.append(line)
        for (const hb of hubs) hb.g.classList.toggle('home', hb.n === home)
      }
      const x = origin.x + dx / scale
      const y = origin.y + dy / scale
      moveTo(g, x, y)
      shown.set(n.id, { x, y })
      redrawEdges(n)
      const now = performance.now()
      trail.push({ x: e.clientX, y: e.clientY, t: now })
      while (trail.length > 2 && now - trail[0].t > 90) trail.shift()
      const first = trail[0]
      const vx = trail.length > 1 ? (e.clientX - first.x) / Math.max(8, now - first.t) : 0
      tilt = tilt * 0.6 + Math.max(-14, Math.min(14, vx * 9)) * 0.4
      cardEl?.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`)
      const pt = toGraph(e.clientX, e.clientY)
      let best: (typeof hubs)[number] | null = null
      let bd = Infinity
      for (const hb of hubs) {
        if (Math.abs(pt.x - hb.n.x) > hb.n.hw * lod || Math.abs(pt.y - hb.n.y) > hb.n.hh * lod) continue
        const d = Math.hypot(Math.max(0, Math.abs(pt.x - hb.n.x) - hb.n.hw), Math.max(0, Math.abs(pt.y - hb.n.y) - hb.n.hh))
        if (d < bd) {
          bd = d
          best = hb
        }
      }
      if (best !== target) {
        target?.g.classList.remove('drop')
        target = best
        if (target) {
          target.g.classList.add('drop')
          // 놓을 섹션이 끄는 카드에 가리지 않게 맨 위로 올린다.
          nodeLayer.append(target.g)
        }
      }
      if (target && target.n !== home) line.setAttribute('d', curve({ x, y }, target.n))
      else line.removeAttribute('d')
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (!active) return
      setHoverDragging(false)
      // 끌기 끝에 따라오는 click 은 무시한다.
      suppressClick = true
      window.setTimeout(() => (suppressClick = false), 0)
      line.remove()
      wrap.classList.remove('moving', 'moving-hub')
      g.classList.remove('lifted')
      cardEl?.style.removeProperty('--tilt')
      for (const hb of hubs) hb.g.classList.remove('home', 'drop')
      dragging = null
      const at = shown.get(n.id) ?? origin
      const to = target && target.n !== home ? target.n : null
      const later = pendingUpdate
      pendingUpdate = null
      if (ev.type === 'pointercancel' || !current) {
        springBack(n, g, at, origin)
        if (later) window.setTimeout(() => self.update(later.snap, later.visible), 480)
        return
      }
      if (!to || !w) {
        n.x = at.x; n.y = at.y; n.vx = n.vy = 0; n.fixed = true
        positions.set(n.id, { ...at })
        hooks.setPosition(w?.id ?? `@group:${n.id}`, { ...at })
        lastKey = ''
        self.update(later?.snap ?? current.snap, later?.visible ?? visibleRef)
        return
      }
      const pill = target!.g.querySelector('.gh') as HTMLElement | null
      pill?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(0.95)' }, { transform: 'scale(1)' }], { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
      burstAt(pill, to.color, 18)
      floatAt(pill, '+1', to.color)
      // 바로 새 섹션으로 옮겨 그리고(낙관적), 저장은 뒤에서 한다. 실패하면 다음 갱신 때 제자리로 돌아간다.
      const sec = to.section ?? '_'
      const previousPosition = hooks.position(w.id)
      hooks.setPosition(w.id, null)
      const base = later?.snap ?? current.snap
      if (later) visibleRef = later.visible
      const live = base.workspaces[w.id] ?? current.snap.workspaces[w.id]
      const byTopic = to.topicId !== undefined
      if (byTopic) live.topic = sec === '_' ? null : sec
      else live.status = sec
      positions.set(n.id, at)
      relayout = true
      lastKey = ''
      self.update(base, visibleRef)
      void hooks.moveToSection(w, byTopic ? { topicId: sec, label: to.label } : { status: sec, label: to.label }).catch(() => {
        if (previousPosition) hooks.setPosition(w.id, previousPosition)
        lastKey = ''
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /** n 이 hub 자신이거나 그 아래(하위 섹션·카드)에 매달려 있는지. */
  const under = (n: GNode, hubNode: GNode): boolean => {
    let cur: GNode | undefined = n
    for (let i = 0; cur && i < 10; i++) {
      if (cur === hubNode) return true
      cur = cur.anchor
    }
    return false
  }

  /** 펼친 뒤 카메라를 옮길 섹션. */
  let pendingFocus: string | null = null

  /** 섹션을 접으면 카드가 섹션 속으로 빨려 들어가고, 펼치면 피어나며 화면이 그 섹션으로 날아간다. */
  function toggleSection(hubNode: GNode): void {
    if (!hubNode.skey) return
    if (hubNode.collapsed) {
      pendingFocus = hubNode.id
      lastKey = ''
      hooks.setSectionState([hubNode.skey], 'open')
      return
    }
    const kids = nodeEls.filter((x) => x.n !== hubNode && under(x.n, hubNode))
    const from = kids.map((x) => ({ x, p: { ...(shown.get(x.n.id) ?? x.n) } }))
    const to = shown.get(hubNode.id) ?? hubNode
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 240)
      const e = t * t
      for (const { x, p } of from) {
        moveTo(x.g, p.x + (to.x - p.x) * e, p.y + (to.y - p.y) * e)
        x.g.style.opacity = String(1 - e)
      }
      if (t < 1) requestAnimationFrame(step)
      else {
        lastKey = ''
        hooks.setSectionState([hubNode.skey!], 'closed')
      }
    }
    requestAnimationFrame(step)
  }

  /** 섹션과 그 카드가 남은 공간에 들어오도록 카메라를 옮긴다(확대는 1배까지). */
  function focusSection(id: string): void {
    const hubNode = current?.nodes.find((n) => n.id === id)
    if (!hubNode) return
    const group = current!.nodes.filter((n) => under(n, hubNode))
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of group) {
      minX = Math.min(minX, p.x - p.hw)
      minY = Math.min(minY, p.y - p.hh)
      maxX = Math.max(maxX, p.x + p.hw)
      maxY = Math.max(maxY, p.y + p.hh)
    }
    const a = freeArea()
    const ns = Math.max(scale, Math.min((a.w - 80) / (maxX - minX), (a.h - 80) / (maxY - minY), 1))
    userMoved = true
    animateTo(ns, a.x + a.w / 2 - ((minX + maxX) / 2) * ns, a.y + a.h / 2 - ((minY + maxY) / 2) * ns)
  }

  let agentStates = new Map<string, string>()
  let wsStatus = new Map<string, string>()

  /** 세션 상태가 바뀌면 카드가 반응한다: 승인 대기는 흔들고, 일을 마치면 터트리고, 완료되면 축하. */
  function react(snap: Snapshot, prev: Map<string, string>, prevStatus: Map<string, string>): void {
    for (const w of Object.values(snap.workspaces)) {
      const g = nodeLayer.querySelector(`[data-sel="w:${CSS.escape(w.id)}"]`)
      const c = g?.querySelector('.gc') ?? null
      if (!c) continue
      if (prevStatus.get(w.id) && prevStatus.get(w.id) !== 'completed' && w.status === 'completed') {
        const r = c.getBoundingClientRect()
        celebrate(r.left + r.width / 2, r.top + r.height / 2)
        floatAt(c, t('완료!'), 'var(--s-completed)')
        continue
      }
      for (const a of w.agents) {
        const before = prev.get(a.key)
        if (!before || before === a.state) continue
        const row = c.querySelector(`[data-sel="s:${CSS.escape(a.key)}"]`)
        if (a.state === 'blocked' || a.state === 'waiting') {
          shake(c)
          burstAt(row ?? c, a.state === 'blocked' ? 'var(--a-blocked)' : 'var(--a-waiting)', 10, 0.7)
        } else if (before === 'working' && (a.state === 'idle' || a.state === 'done')) {
          burstAt(row ?? c, '#3ecf8e', 14, 0.9)
          floatAt(row ?? c, t('끝!'), '#3ecf8e')
        } else if (a.state === 'working' && before !== 'working') {
          burstAt(row ?? c, 'var(--a-working)', 8, 0.6)
        }
      }
    }
  }

  /** 놓을 곳이 없으면 고무줄처럼 제자리로 돌아간다. */
  function springBack(n: GNode, g: SVGElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / 460)
      const c = 1.70158
      const e = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
      const x = from.x + (to.x - from.x) * e
      const y = from.y + (to.y - from.y) * e
      moveTo(g, x, y)
      shown.set(n.id, { x, y })
      redrawEdges(n)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  function markSelected(): void {
    nodeLayer.querySelectorAll('.selected').forEach((el) => el.classList.remove('selected'))
    if (!selected) return
    const el = nodeLayer.querySelector(`[data-sel="${CSS.escape(selected)}"]`)
    if (!el) return
    el.classList.add('selected')
    el.closest('.g-ws')?.classList.add('selected')
  }

  /** 고른 노드의 그래프 좌표. */
  function selectedPoint(): { x: number; y: number } | null {
    if (!selected || !current) return null
    const wsId = selected.startsWith('w:') ? selected.slice(2) : current.snap ? Object.values(current.snap.workspaces).find((w) => w.agents.some((a) => `s:${a.key}` === selected))?.id : undefined
    const n = wsId ? current.nodes.find((x) => x.wsId === wsId) : undefined
    return n ? { x: n.x, y: n.y } : null
  }

  new ResizeObserver(() => {
    if (current && !userMoved && !reserve && wrap.clientWidth > 0) fit()
  }).observe(wrap)

  const self = {
    el: wrap,
    fit,
    update(snap: Snapshot, visible: Set<string>): void {
      // 카드를 끄는 중에는 다시 그리지 않고 미뤄 둔다(놓을 때 적용).
      if (dragging) {
        pendingUpdate = { snap, visible }
        return
      }
      visibleRef = visible
      const key = JSON.stringify([
        hooks.scopeRepo(),
        hooks.groupBy(),
        snap.repos.map((r) => r.topics.map((t) => t.id + t.name)),
        [...visible].sort().map((id) => {
          const w = snap.workspaces[id]
          return [id, w.name, w.status, w.topic, w.parentId, w.unread, w.comment, w.pr?.number, w.pr?.state, w.pr?.title, w.agents.map((a) => [a.key, a.state, a.title, a.tool?.name]), w.terminals.map((t) => [t.handle, t.connected, t.kind])]
        })
      ])
      if (key === lastKey && current) {
        current.snap = snap
        return
      }
      lastKey = key
      const prevStates = agentStates
      agentStates = new Map(Object.values(snap.workspaces).flatMap((w) => w.agents.map((a) => [a.key, a.state] as const)))
      const prevStatus = wsStatus
      wsStatus = new Map(Object.values(snap.workspaces).map((w) => [w.id, w.status] as const))
      const { nodes, edges } = build(snap, visible)
      const fresh = nodes.filter((n) => !positions.has(n.id)).length
      simulate(nodes, edges, positions.size === 0 ? 360 : fresh > 0 || relayout ? 160 : 30)
      relayout = false
      positions = new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]))
      current = { nodes, snap }
      draw(snap, nodes, edges)
      if (prevStates.size) window.setTimeout(() => react(snap, prevStates, prevStatus), 600)
      if (pendingFocus) {
        const id = pendingFocus
        pendingFocus = null
        focusSection(id)
      }
      const vkey = [hooks.scopeRepo(), hooks.groupBy(), ...[...visible].sort()].join('|')
      const setChanged = vkey !== visibleKey
      visibleKey = vkey
      if ((!fitted || (setChanged && !userMoved)) && !reserve && wrap.isConnected && wrap.clientWidth > 0) {
        fit()
        fitted = true
      }
    },
    attached(): void {
      if (!fitted && wrap.clientWidth > 0) {
        fit()
        fitted = true
      }
    },
    select(sel: { wsId: string; agentKey: string | null } | null): void {
      selected = sel ? (sel.agentKey ? `s:${sel.agentKey}` : `w:${sel.wsId}`) : null
      markSelected()
    },
    /** 작업 창이 열리고 닫힐 때 남은 공간으로 비켜난다. */
    setReserve(next: { side: 'left' | 'right' | 'bottom'; size: number } | null): void {
      const same = JSON.stringify(next) === JSON.stringify(reserve)
      reserve = next
      if (same || wrap.clientWidth === 0) return
      if (!next) {
        if (!userMoved) fit(true)
        return
      }
      const pt = selectedPoint()
      if (!pt) return fit(true)
      const a = freeArea()
      animateTo(scale, a.x + a.w / 2 - pt.x * scale, a.y + a.h / 2 - pt.y * scale)
    },
    resetView(): void {
      userMoved = false
      lastKey = ''
    }
  }
  return self
}
