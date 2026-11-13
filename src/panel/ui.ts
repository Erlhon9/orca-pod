// DOM 을 만드는 작은 도우미, 아이콘, 표시용 문구.
import type { AgentState, AgentView } from '../model'

type Child = Node | string | number | null | undefined | false | Child[]
type Props = Record<string, unknown> | null

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    if (Array.isArray(c)) append(el, c)
    else el.append(c instanceof Node ? c : String(c))
  }
}

function apply(el: Element, props: Props): void {
  if (!props) return
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
        if (sk.startsWith('--')) (el as HTMLElement).style.setProperty(sk, sv)
        else ((el as HTMLElement).style as any)[sk] = sv
      }
    } else if (k === 'class') {
      el.setAttribute('class', String(v))
    } else if (v === true) {
      el.setAttribute(k, '')
    } else {
      el.setAttribute(k, String(v))
    }
  }
}

export function h(tag: string, props: Props = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag)
  apply(el, props)
  append(el, children)
  return el
}

/** 자식을 갈아 끼운다. DOM 의 replaceChildren 과 달리 null·false 는 건너뛴다("null" 글자가 찍히지 않게). */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren()
  append(el, children)
}

const SVG = 'http://www.w3.org/2000/svg'

export function s(tag: string, props: Props = null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG, tag)
  apply(el, props)
  append(el, children)
  return el
}

const PATHS: Record<string, string> = {
  refresh:
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  open: '<path d="M7 17 17 7M8 7h9v9"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  branch:
    '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="7" r="2.2"/><path d="M6 7.2v9.6M18 9.2c0 4.5-6 3.5-11.2 7.6"/>',
  pr: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2V21M18 15.8V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-2.5 3 2.5 3"/>',
  board:
    '<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>',
  graph:
    '<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M10.8 7.2 6.2 15.8M13.2 7.2l4.6 8.6M7.4 18h9.2"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3.5"/><path d="M12 4v4M9 13.5v1M15 13.5v1"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  send: '<path d="M21 3 10 14M21 3l-6.5 18-4-8-8-4z"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  sub: '<path d="M6 3v10a4 4 0 0 0 4 4h9"/><path d="m15 13 4 4-4 4"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
  sparkle: '<path d="M12 3.5 13.7 9 19 10.5 13.7 12 12 17.5 10.3 12 5 10.5 10.3 9z"/><path d="M19 3v4M17 5h4"/>',
  back: '<path d="M15 18 9 12l6-6"/>',
  tag: '<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  broom: '<path d="M19 3 12 10"/><path d="M8.5 9.5 14.5 15.5 11 21H4l-1-7z"/><path d="M6.5 14.5 9 17"/>',
  fold: '<path d="m7 20 5-5 5 5M7 4l5 5 5-5"/>',
  unfold: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  agents: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2a5 5 0 0 1 5 5"/>'
}

export function icon(name: keyof typeof PATHS | string): SVGElement {
  const el = document.createElementNS(SVG, 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('class', 'i')
  el.innerHTML = PATHS[name] ?? ''
  return el
}

/** 에이전트 종류별 글리프. Claude 는 별꽃, Codex 는 겹원, 나머지는 첫 글자. */
export function agentGlyph(type: string): Node {
  if (type === 'claude') {
    const el = document.createElementNS(SVG, 'svg')
    el.setAttribute('viewBox', '0 0 24 24')
    el.innerHTML =
      '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>'
    return el
  }
  if (type === 'codex') {
    const el = document.createElementNS(SVG, 'svg')
    el.setAttribute('viewBox', '0 0 24 24')
    el.innerHTML = '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'
    return el
  }
  return h('span', { class: 'letter' }, (type[0] ?? '?').toUpperCase())
}

export function avatar(agent: Pick<AgentView, 'type' | 'state'>, size: '' | 'sm' | 'lg' = ''): HTMLElement {
  return h('span', { class: `av ${size}`, 'data-type': agent.type, 'data-state': agent.state }, agentGlyph(agent.type))
}

export const STATUS_LABEL: Record<string, string> = {
  todo: '할 일',
  'in-progress': '진행 중',
  'in-review': '리뷰 중',
  'long-running': '장기 실행',
  'on-hold': '보류',
  completed: '완료'
}

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: '작업 중',
  blocked: '승인 대기',
  waiting: '답변 대기',
  idle: '대기',
  done: '종료'
}

export const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

export function agentName(type: string): string {
  return AGENT_NAME[type] ?? type.charAt(0).toUpperCase() + type.slice(1)
}

export function statusLabel(id: string): string {
  return STATUS_LABEL[id] ?? id
}

export function statusColor(id: string): string {
  if (STATUS_LABEL[id]) return `var(--s-${id})`
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 62% 60%)`
}

export function ago(at: number, now = Date.now()): string {
  if (!at) return ''
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 45) return '방금'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}분`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}시간`
  const day = Math.round(hr / 24)
  if (day < 30) return `${day}일`
  return `${Math.round(day / 30)}개월`
}

/** 상태가 얼마나 이어졌는지. 1분 미만이면 초 단위. */
export function duration(at: number, now = Date.now()): string {
  if (!at) return ''
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 ${min % 60}분`
  return `${Math.floor(hr / 24)}일`
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 주제마다 고정된 색. 이름이 같으면 항상 같은 색. */
export function topicColor(id: string | null): string {
  if (!id) return 'var(--muted)'
  let hash = 7
  for (const ch of id) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0
  const hues = [12, 32, 48, 140, 168, 190, 212, 236, 262, 290, 320, 345]
  return `hsl(${hues[hash % hues.length]} 62% 60%)`
}
