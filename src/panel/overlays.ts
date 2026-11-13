// 떠 있는 것들: 호버 카드, 메뉴, 아래에서 올라오는 시트, 토스트.
import { t } from './i18n'
import { h, icon } from './ui'

/* ---------- 호버 카드 ---------- */

const card = h('div', { class: 'hovercard', role: 'tooltip' })
let anchor: Element | null = null
let builder: (() => HTMLElement | null) | null = null
let showTimer = 0
let hideTimer = 0

function place(): void {
  if (!anchor || !anchor.isConnected) return hideNow()
  const r = anchor.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const cw = card.offsetWidth
  const ch = card.offsetHeight
  const gap = 8
  let top = r.bottom + gap
  if (top + ch > vh - 8 && r.top - gap - ch > 8) top = r.top - gap - ch
  top = Math.max(8, Math.min(top, vh - ch - 8))
  let left = r.left + r.width / 2 - cw / 2
  left = Math.max(8, Math.min(left, vw - cw - 8))
  card.style.top = `${top}px`
  card.style.left = `${left}px`
}

function hideNow(): void {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  card.classList.remove('show')
  anchor = null
  builder = null
}

export function hideHover(): void {
  hideNow()
}

/** 열린 카드의 내용을 새 데이터로 다시 그린다(스냅샷 갱신 시). */
export function refreshHover(): void {
  if (!builder || !card.classList.contains('show')) return
  // 목록을 다시 그리면 기준 요소가 바뀌므로 같은 키를 가진 새 요소로 옮겨 붙인다.
  if (anchor && !anchor.isConnected) {
    const key = (anchor as HTMLElement).dataset?.hk ?? anchor.getAttribute('data-hk')
    anchor = key ? document.querySelector(`[data-hk="${CSS.escape(key)}"]`) : null
    if (!anchor) return hideNow()
  }
  const next = builder()
  if (!next) return hideNow()
  card.replaceChildren(next)
  place()
}

export function hoverable(el: Element, build: () => HTMLElement | null, delay = 160, key?: string): void {
  if (key) el.setAttribute('data-hk', key)
  el.addEventListener('mouseenter', (ev) => {
    ev.stopPropagation()
    clearTimeout(hideTimer)
    clearTimeout(showTimer)
    showTimer = window.setTimeout(() => {
      const content = build()
      if (!content) return
      anchor = el
      builder = build
      card.replaceChildren(content)
      if (!card.isConnected) document.body.append(card)
      card.classList.add('show')
      place()
    }, anchor && card.classList.contains('show') ? 40 : delay)
  })
  el.addEventListener('mouseleave', () => {
    clearTimeout(showTimer)
    hideTimer = window.setTimeout(hideNow, 180)
  })
}

card.addEventListener('mouseenter', () => clearTimeout(hideTimer))
card.addEventListener('mouseleave', () => {
  hideTimer = window.setTimeout(hideNow, 160)
})

/* ---------- 메뉴 ---------- */

export type MenuItem =
  | { label: string; icon?: string; hint?: string; danger?: boolean; checked?: boolean; onSelect: () => void }
  | { section: string }
  | { custom: HTMLElement }
  | 'sep'

let menuEl: HTMLElement | null = null
let menuOwner: Element | null = null
let menuPlace: (() => void) | null = null

export function closeMenu(restoreFocus = false): void {
  menuEl?.remove()
  menuEl = null
  menuPlace = null
  menuOwner?.classList.remove('menu-open')
  if (menuOwner?.hasAttribute('aria-expanded')) menuOwner.setAttribute('aria-expanded', 'false')
  if (restoreFocus && menuOwner instanceof HTMLElement && menuOwner.isConnected) menuOwner.focus()
  menuOwner = null
}

export function openMenu(at: { x: number; y: number } | Element, items: MenuItem[], owner?: Element, options?: { maxHeight?: number; keyboard?: boolean }): void {
  closeMenu()
  hideNow()
  const el = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((item) => {
      if (item === 'sep') return h('div', { class: 'sep' })
      if ('section' in item) return h('div', { class: 'label' }, item.section)
      if ('custom' in item) return item.custom
      return h(
        'button',
        {
          class: 'mi',
          role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
          'aria-checked': item.checked === undefined ? undefined : String(item.checked),
          style: item.danger ? { color: 'var(--a-blocked)' } : undefined,
          onClick: (ev: Event) => {
            ev.stopPropagation()
            closeMenu(options?.keyboard ?? false)
            item.onSelect()
          }
        },
        item.icon ? icon(item.icon) : null,
        item.label,
        item.hint ? h('span', { class: 'hint' }, item.hint) : null
      )
    })
  )
  document.body.append(el)
  menuEl = el
  if (owner) {
    menuOwner = owner
    owner.classList.add('menu-open')
    if (owner.hasAttribute('aria-expanded')) owner.setAttribute('aria-expanded', 'true')
  }
  const position = () => {
    if (at instanceof Element && !at.isConnected) return closeMenu()
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (options?.maxHeight) {
      el.style.maxHeight = `${Math.max(0, Math.min(options.maxHeight, vh - 16))}px`
      el.style.overflowY = 'auto'
      el.style.overscrollBehavior = 'contain'
    }
    let x: number
    let y: number
    if (at instanceof Element) {
      const r = at.getBoundingClientRect()
      x = r.right - el.offsetWidth
      y = r.bottom + 4
      if (y + el.offsetHeight > vh - 8) y = r.top - el.offsetHeight - 4
    } else {
      x = at.x
      y = at.y
      if (y + el.offsetHeight > vh - 8) y = at.y - el.offsetHeight
    }
    el.style.left = `${Math.max(8, Math.min(x, vw - el.offsetWidth - 8))}px`
    el.style.top = `${Math.max(8, Math.min(y, vh - el.offsetHeight - 8))}px`
  }
  menuPlace = position
  position()
  if (options?.keyboard) {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button.mi')]
    el.addEventListener('keydown', ev => {
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      let next = index
      if (ev.key === 'ArrowDown') next = (index + 1) % buttons.length
      else if (ev.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
      else if (ev.key === 'Home') next = 0
      else if (ev.key === 'End') next = buttons.length - 1
      else return
      ev.preventDefault()
      ev.stopPropagation()
      buttons[next]?.focus({ preventScroll: true })
      buttons[next]?.scrollIntoView({ block: 'nearest' })
    })
    const selected = el.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? buttons[0]
    selected?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'nearest' })
  }
}

document.addEventListener(
  'mousedown',
  (ev) => {
    if (menuEl && !menuEl.contains(ev.target as Node) && !menuOwner?.contains(ev.target as Node)) closeMenu()
  },
  true
)

/* ---------- 시트(대화상자) ---------- */

export interface SheetOptions {
  title: string
  sub?: string
  body: HTMLElement[]
  submitLabel: string
  submitIcon?: string
  onSubmit: () => Promise<unknown> | unknown
  canSubmit?: () => boolean
}

let sheetClose: (() => void) | null = null

export function openSheet(opts: SheetOptions): () => void {
  sheetClose?.()
  closeMenu()
  hideNow()
  const submit = h(
    'button',
    { class: 'pill-btn primary', type: 'submit' },
    opts.submitIcon ? icon(opts.submitIcon) : null,
    opts.submitLabel
  ) as HTMLButtonElement
  const form = h(
    'form',
    { class: 'sheet' },
    h('h2', null, opts.title),
    opts.sub ? h('div', { class: 'sub' }, opts.sub) : null,
    opts.body,
    h(
      'div',
      { class: 'sheet-actions' },
      h('span', { class: 'hint' }, h('kbd', null, '⌘'), ' ', h('kbd', null, 'Enter'), t(' 실행 · '), h('kbd', null, 'Esc'), t(' 닫기')),
      h('button', { class: 'pill-btn', type: 'button', onClick: () => close() }, t('취소')),
      submit
    )
  ) as HTMLFormElement
  const scrim = h('div', { class: 'scrim', onMousedown: (ev: Event) => ev.target === scrim && close() }, form)

  const sync = () => {
    submit.disabled = opts.canSubmit ? !opts.canSubmit() : false
  }
  form.addEventListener('input', sync)
  form.addEventListener('click', () => queueMicrotask(sync))

  let busy = false
  const run = async () => {
    if (busy || submit.disabled) return
    busy = true
    submit.disabled = true
    submit.style.opacity = '0.7'
    try {
      await opts.onSubmit()
      close()
    } catch {
      submit.disabled = false
      submit.style.opacity = ''
    } finally {
      busy = false
    }
  }
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    void run()
  })
  form.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault()
      void run()
    }
  })

  function close(): void {
    scrim.remove()
    if (sheetClose === close) sheetClose = null
  }
  sheetClose = close
  document.body.append(scrim)
  sync()
  queueMicrotask(() => (form.querySelector('textarea, input') as HTMLElement | null)?.focus())
  return close
}

export function sheetOpen(): boolean {
  return sheetClose !== null
}

/* ---------- 토스트 ---------- */

const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' })

export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  if (!toasts.isConnected) document.body.append(toasts)
  const el = h('div', { class: `toast ${kind}` }, icon(kind === 'ok' ? 'check' : 'alert'), message)
  toasts.append(el)
  window.setTimeout(() => el.remove(), kind === 'err' ? 5200 : 2400)
}

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return
  const handled = sheetClose !== null || menuEl !== null || card.classList.contains('show')
  if (sheetClose) sheetClose()
  else if (menuEl) closeMenu(true)
  else hideNow()
  // 떠 있는 것을 닫았으면 상세 화면까지 닫히지 않게 여기서 멈춘다.
  if (handled) ev.stopImmediatePropagation()
})

window.addEventListener('resize', () => {
  menuPlace?.()
  hideNow()
})
