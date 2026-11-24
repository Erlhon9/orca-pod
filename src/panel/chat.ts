// 대화 보기: Claude 대화 기록을 Orca 대화창처럼 그린다. 내 말은 말풍선, 답변은 문서처럼, 도구 호출은 접힌 줄.
import { t, tt } from './i18n'
import type { ChatItem } from '../transcript'
import { duration, h, icon } from './ui'
import { questionCard } from './questions'

// ---------- 마크다운(필요한 만큼만, 항상 텍스트 노드로 넣어 HTML 이 해석되지 않게) ----------

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)|(\*[^*\s][^*\n]*\*)/g

function inline(text: string): Node[] {
  const out: Node[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) out.push(document.createTextNode(text.slice(last, i)))
    const t = m[0]
    if (m[1]) out.push(h('code', null, t.slice(1, -1)))
    else if (m[2]) out.push(h('strong', null, ...inline(t.slice(2, -2))))
    else if (m[3]) out.push(link(t.slice(1, t.indexOf('](')), m[4]))
    else if (m[5]) out.push(link(t, t))
    else if (m[6]) out.push(h('em', null, t.slice(1, -1)))
    last = i + t.length
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)))
  return out
}

let openExternal: (url: string) => void = () => {}
/** 링크를 열 함수를 정한다(대화 기록이 없는 대체 화면에서도 링크가 열리게). */
export function setLinkHandler(fn: (url: string) => void): void {
  openExternal = fn
}

function link(label: string, url: string): HTMLElement {
  const a = h('a', { href: '#', title: url }, label)
  a.addEventListener('click', (ev) => {
    ev.preventDefault()
    openExternal(url)
  })
  return a
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l)
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

export function markdown(src: string, depth = 0): HTMLElement {
  const root = h('div', { class: 'md' })
  // 인용·목록이 끝없이 겹쳐도 멈추도록 깊이를 제한한다.
  if (depth > 8) {
    root.append(h('p', null, src))
    return root
  }
  const lines = src.replace(/\r/g, '').split('\n')
  let i = 0
  let para: string[] = []
  const flush = () => {
    if (para.length) root.append(h('p', null, ...inline(para.join(' '))))
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)(.*)$/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      const lang = fence[2].trim()
      root.append(h('pre', { class: 'md-code' }, lang ? h('span', { class: 'lang' }, lang) : null, h('code', null, body.join('\n'))))
      continue
    }
    if (!line.trim()) {
      flush()
      i++
      continue
    }
    const head = /^(#{1,6})\s+(.*)$/.exec(line)
    if (head) {
      flush()
      root.append(h(`h${Math.min(4, head[1].length + 2)}`, null, ...inline(head[2])))
      i++
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      root.append(h('hr'))
      i++
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush()
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      root.append(
        h(
          'div',
          { class: 'md-table' },
          h('table', null, h('thead', null, h('tr', null, head.map((c) => h('th', null, ...inline(c))))), h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, ...inline(c)))))))
        )
      )
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      const q = markdown(body.join('\n'), depth + 1)
      root.append(h('blockquote', null, ...q.childNodes))
      continue
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = /\d/.test(item[2])
      const list = h(ordered ? 'ol' : 'ul')
      if (ordered) list.setAttribute('start', String(parseInt(item[2], 10) || 1))
      const baseIndent = item[1].length
      let li: HTMLElement | null = null
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (m && m[1].length <= baseIndent + 1) {
          li = h('li', null, ...inline(m[3]))
          list.append(li)
          i++
          continue
        }
        // 들여 쓴 하위 목록·이어지는 줄은 앞 항목에 붙인다.
        if (li && lines[i].trim() && /^\s{2,}/.test(lines[i])) {
          const sub: string[] = []
          while (i < lines.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) sub.push(lines[i++].slice(baseIndent + 2))
          const nested = markdown(sub.join('\n'), depth + 1)
          if (nested.firstElementChild?.tagName === 'P') li.append(' ', ...nested.firstElementChild.childNodes)
          else li.append(...nested.childNodes)
          continue
        }
        break
      }
      root.append(list)
      continue
    }
    para.push(line.trim())
    i++
  }
  flush()
  return root
}

// ---------- 대화 ----------

export function prettyTool(name: string): { name: string; via: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!m) return { name: tt(name), via: '' }
  return { name: m[2], via: m[1].replace(/^claude_ai_/, '') }
}

type Tool = Extract<ChatItem, { k: 'tool' }>

function toolGroup(tools: Tool[], live: boolean, open: Set<string>): HTMLElement {
  const key = tools[0].id
  const names = [...new Set(tools.map((t) => prettyTool(t.name).name))]
  const failed = tools.filter((t) => t.error).length
  const last = tools[tools.length - 1]
  const summary = h(
    'summary',
    null,
    h('span', { class: `tg-ic${live ? ' live' : ''}` }, icon(live ? 'refresh' : 'terminal')),
    h('span', { class: 'tg-n' }, t(`도구 {n}개`, { n: tools.length })),
    h('span', { class: 'tg-names' }, live ? `${prettyTool(last.name).name} · ${tt(last.detail)}` : names.slice(0, 4).join(', ') + (names.length > 4 ? t(` 외 {n}`, { n: names.length - 4 }) : '')),
    failed ? h('span', { class: 'tg-err' }, t(`실패 {failed}`, { failed })) : null,
    h('span', { class: 'tg-chev' }, icon('chevron'))
  )
  const el = h(
    'details',
    { class: 'tool-group', 'data-k': key },
    summary,
    h(
      'div',
      { class: 'tg-list' },
      tools.map((t) => {
        const p = prettyTool(t.name)
        return h(
          'div',
          { class: `tg-row${t.error ? ' err' : ''}` },
          h('span', { class: 'tg-name' }, p.name),
          p.via ? h('span', { class: 'tg-via' }, p.via) : null,
          h('span', { class: 'tg-detail', title: tt(t.detail) }, tt(t.detail))
        )
      })
    )
  ) as HTMLDetailsElement
  if (open.has(key)) el.open = true
  el.addEventListener('toggle', () => (el.open ? open.add(key) : open.delete(key)))
  return el
}

function durLabel(ms: number): string {
  if (ms < 1000) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return t(`{sec}초`, { sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t(`{min}분 {n}초`, { min, n: sec % 60 })
  return t(`{n}시간 {n2}분`, { n: Math.floor(min / 60), n2: min % 60 })
}

export interface ChatRenderOptions {
  /** 에이전트가 지금 일하는 중이면 마지막 도구 묶음을 진행 중으로 그린다. */
  working: boolean
  workingSince: number
  truncated: boolean
  open: Set<string>
  onLink(url: string): void
  onQuestion?(): void
  scope?(item: ChatItem): { label: string; text?: string } | null
}

/** 항목을 턴 단위로 묶어 그린다. */
export function renderChat(items: ChatItem[], o: ChatRenderOptions): HTMLElement[] {
  openExternal = o.onLink
  const out: HTMLElement[] = []
  if (o.truncated) out.push(h('div', { class: 'chat-note' }, t('이전 대화는 생략')))
  let tools: Tool[] = []
  let turnStart = 0
  let turnEnd = 0
  const flushTools = (live: boolean) => {
    if (tools.length) out.push(toolGroup(tools, live, o.open))
    tools = []
  }
  const endTurn = () => {
    if (turnStart && turnEnd > turnStart) {
      const d = durLabel(turnEnd - turnStart)
      if (d) out.push(h('div', { class: 'turn-end' }, h('span', null, t(`{d} 작업`, { d }))))
    }
    turnStart = turnEnd = 0
  }
  for (const it of items) {
    if (it.k === 'tool') {
      if (it.questions?.length && !it.resolved) {
        flushTools(false)
        out.push(questionCard(it.questions, o.onQuestion))
        turnEnd = it.at
        continue
      }
      tools.push(it)
      turnEnd = it.at
      continue
    }
    flushTools(false)
    const scope = o.scope?.(it)
    if (scope && (it.k === 'user' || it.k === 'text')) out.push(h('div', { class: 'chat-scope' }, scope.label))
    if (it.k === 'user') {
      endTurn()
      turnStart = it.at
      out.push(
        h(
          'div',
          { class: 'msg-me' },
          h('div', { class: 'bubble-me' }, it.images ? h('span', { class: 'img-chip' }, t(`이미지 {images}장`, { images: it.images })) : null, scope?.text ?? it.text)
        )
      )
    } else if (it.k === 'text') {
      turnEnd = it.at
      out.push(h('div', { class: 'msg-agent' }, markdown(it.text)))
    } else {
      endTurn()
      out.push(h('div', { class: 'chat-note' }, tt(it.text)))
    }
  }
  flushTools(o.working)
  if (o.working) {
    out.push(
      h(
        'div',
        { class: 'chat-working' },
        h('span', { class: 'dots' }, h('i'), h('i'), h('i')),
        t('작업 중'),
        o.workingSince ? h('span', { class: 'when', 'data-dur': o.workingSince }, duration(o.workingSince)) : null
      )
    )
  } else endTurn()
  return out
}
