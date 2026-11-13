// 손맛을 내는 작은 효과들: 파티클, 떠오르는 글자, 흔들기, 튀기기, 숫자 굴리기, 날아가기.
// 모두 화면 위 고정 레이어에 잠깐 그렸다가 지운다. 움직임 줄이기 설정이면 아무것도 하지 않는다.

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

let layer: HTMLElement | null = null
function fxLayer(): HTMLElement {
  if (layer?.isConnected) return layer
  layer = document.createElement('div')
  layer.className = 'fx-layer'
  document.body.append(layer)
  return layer
}

const center = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

/** 한 점에서 색 조각이 터져 나와 떨어진다. */
export function burst(x: number, y: number, color: string, count = 16, power = 1): void {
  if (reduced() || !document.body.animate) return
  const root = fxLayer()
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i')
    p.className = `fx-p${i % 3 === 0 ? ' round' : ''}`
    p.style.left = `${x}px`
    p.style.top = `${y}px`
    p.style.background = i % 4 === 0 ? '#fff' : color
    root.append(p)
    const ang = (i / count) * Math.PI * 2 + Math.random() * 0.5
    const dist = (40 + Math.random() * 46) * power
    const dx = Math.cos(ang) * dist
    const dy = Math.sin(ang) * dist - 18 * power
    const rot = (Math.random() - 0.5) * 540
    const a = p.animate(
      [
        { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.9) rotate(${rot / 2}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 34 * power}px)) scale(0.4) rotate(${rot}deg)`, opacity: 0 }
      ],
      { duration: 620 + Math.random() * 260, easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)' }
    )
    a.onfinish = () => p.remove()
  }
}

/** 큰 축하: 여러 번 나눠 터진다. */
export function celebrate(x: number, y: number): void {
  const colors = ['#4f8cff', '#3ecf8e', '#f5a524', '#ff5d6c', '#b58cff']
  colors.forEach((c, i) => window.setTimeout(() => burst(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 30, c, 14, 1.4), i * 70))
}

export function burstAt(el: Element | null, color: string, count = 16, power = 1): void {
  if (!el?.isConnected) return
  const c = center(el.getBoundingClientRect())
  burst(c.x, c.y, color, count, power)
}

/** 글자가 떠올랐다가 사라진다(+1, 완료 같은 것). */
export function floatText(x: number, y: number, text: string, color = 'var(--fg)'): void {
  if (reduced() || !document.body.animate) return
  const t = document.createElement('span')
  t.className = 'fx-float'
  t.textContent = text
  t.style.left = `${x}px`
  t.style.top = `${y}px`
  t.style.color = color
  fxLayer().append(t)
  const a = t.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
      { transform: 'translate(-50%, -110%) scale(1.15)', opacity: 1, offset: 0.25 },
      { transform: 'translate(-50%, -260%) scale(1)', opacity: 0 }
    ],
    { duration: 1000, easing: EASE }
  )
  a.onfinish = () => t.remove()
}

export function floatAt(el: Element | null, text: string, color?: string): void {
  if (!el?.isConnected) return
  const r = el.getBoundingClientRect()
  floatText(r.left + r.width / 2, r.top, text, color)
}

/** 좌우로 흔든다(주의가 필요할 때). */
export function shake(el: Element | null): void {
  if (reduced() || !(el as HTMLElement | null)?.animate) return
  ;(el as HTMLElement).animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-6px) rotate(-1deg)' },
      { transform: 'translateX(5px) rotate(1deg)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(0)' }
    ],
    { duration: 420, easing: 'ease-out' }
  )
}

/** 한 번 통 튄다. */
export function pop(el: Element | null, amount = 1.12): void {
  if (reduced() || !(el as HTMLElement | null)?.animate) return
  ;(el as HTMLElement).animate([{ transform: 'scale(1)' }, { transform: `scale(${amount})` }, { transform: 'scale(0.97)' }, { transform: 'scale(1)' }], {
    duration: 420,
    easing: EASE
  })
}

/** 숫자가 이전 값에서 굴러 바뀐다. */
export function roll(el: HTMLElement, from: number, to: number): void {
  if (reduced() || !el.animate || from === to) return
  const up = to > from
  el.animate(
    [
      { transform: `translateY(${up ? 60 : -60}%)`, opacity: 0, filter: 'blur(2px)' },
      { transform: `translateY(${up ? -12 : 12}%)`, opacity: 1, filter: 'blur(0)', offset: 0.6 },
      { transform: 'translateY(0)', opacity: 1 }
    ],
    { duration: 460, easing: EASE }
  )
}

/** 글자 조각이 한 자리에서 다른 자리로 포물선을 그리며 날아간다(보내기). */
export function fly(from: DOMRect, to: DOMRect, text: string): void {
  if (reduced() || !document.body.animate) return
  const t = document.createElement('span')
  t.className = 'fx-fly'
  t.textContent = text.length > 28 ? `${text.slice(0, 27)}…` : text
  const a = center(from)
  const b = center(to)
  t.style.left = `${a.x}px`
  t.style.top = `${a.y}px`
  fxLayer().append(t)
  const dx = b.x - a.x
  const dy = b.y - a.y
  const anim = t.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 60}px)) scale(0.85)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`, opacity: 0 }
    ],
    { duration: 560, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }
  )
  anim.onfinish = () => {
    t.remove()
    burst(b.x, b.y, 'var(--ring)', 10, 0.6)
  }
}
