// 보드에서 워크스페이스 행을 끌어 다른 묶음(상태·주제)에 놓는다.
// 묶음 요소에 data-drop="status:<id>" 또는 "topic:<id|_>", data-repo, data-label 을 달아 두면 놓을 곳이 된다.
import { burstAt, floatAt, pop } from './fx'

let suppress = false
/** 끌기가 막 끝났으면 뒤따르는 click 을 무시해야 한다. */
export const dragJustEnded = () => suppress

export function draggableRow(
  row: HTMLElement,
  repoId: string,
  onDrop: (kind: 'status' | 'topic', id: string, label: string) => Promise<void> | void,
  onStart?: () => void
): void {
  row.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || (ev.target as Element).closest('button, a, textarea, input, .sess')) return
    const sx = ev.clientX
    const sy = ev.clientY
    const r0 = row.getBoundingClientRect()
    const own = row.closest<HTMLElement>('[data-drop]')
    const scroller = row.closest<HTMLElement>('.body')
    let ghost: HTMLElement | null = null
    let zones: HTMLElement[] = []
    let target: HTMLElement | null = null
    let tilt = 0
    let lastX = sx
    let lastT = performance.now()
    let scrollTimer = 0
    let pointer = { x: sx, y: sy }

    const hitTest = () => {
      const hit = zones.find((z) => {
        const r = z.getBoundingClientRect()
        return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom
      })
      const next = hit && hit !== own ? hit : null
      if (next !== target) {
        target?.classList.remove('drop-over')
        target = next
        if (target) {
          target.classList.add('drop-over')
          pop(target.querySelector('.group-head .tag'), 1.08)
        }
      }
    }

    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY }
      const dx = e.clientX - sx
      const dy = e.clientY - sy
      if (!ghost) {
        if (Math.hypot(dx, dy) < 6) return
        onStart?.()
        ghost = row.cloneNode(true) as HTMLElement
        ghost.classList.add('drag-ghost')
        // 잡은 자리를 기준으로 폭을 줄여 손에 들린 느낌을 준다.
        const gw = Math.min(r0.width, 440)
        const gl = Math.min(Math.max(r0.left, sx - gw * ((sx - r0.left) / r0.width)), r0.right - gw)
        Object.assign(ghost.style, { left: `${gl}px`, top: `${r0.top}px`, width: `${gw}px` })
        document.body.append(ghost)
        row.classList.add('drag-src')
        document.body.classList.add('row-dragging')
        zones = [...document.querySelectorAll<HTMLElement>('[data-drop]')].filter((z) => z.dataset.repo === repoId)
        for (const z of zones) z.classList.toggle('drop-home', z === own)
        // 끄는 동안 위·아래 끝에 가면 저절로 굴러간다.
        scrollTimer = window.setInterval(() => {
          if (!scroller) return
          const r = scroller.getBoundingClientRect()
          const edge = 56
          const v = pointer.y < r.top + edge ? -(r.top + edge - pointer.y) / 3 : pointer.y > r.bottom - edge ? (pointer.y - (r.bottom - edge)) / 3 : 0
          if (v) {
            scroller.scrollTop += v
            hitTest()
          }
        }, 16)
      }
      const now = performance.now()
      const vx = (e.clientX - lastX) / Math.max(8, now - lastT)
      lastX = e.clientX
      lastT = now
      tilt = tilt * 0.7 + Math.max(-5, Math.min(5, vx * 5)) * 0.3
      ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(${tilt.toFixed(2)}deg) scale(1.03)`
      hitTest()
    }

    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.clearInterval(scrollTimer)
      if (!ghost) return
      suppress = true
      window.setTimeout(() => (suppress = false), 0)
      document.body.classList.remove('row-dragging')
      for (const z of zones) z.classList.remove('drop-home', 'drop-over')
      const g = ghost
      const cur = g.getBoundingClientRect()
      if (target) {
        // 묶음 머리로 빨려 들어가며 작아진다.
        const head = target.querySelector<HTMLElement>('.group-head') ?? target
        const hr = head.getBoundingClientRect()
        const tx = hr.left + 40 - (cur.left + cur.width / 2)
        const ty = hr.top + hr.height / 2 - (cur.top + cur.height / 2)
        const base = g.style.transform
        const anim = g.animate?.(
          [
            { transform: base, opacity: 1 },
            { transform: `${base} translate(${tx}px, ${ty}px) scale(0.2)`, opacity: 0 }
          ],
          { duration: 320, easing: 'cubic-bezier(0.5, 0, 0.75, 0)' }
        )
        const [kind, ...rest] = (target.dataset.drop ?? '').split(':')
        const id = rest.join(':')
        const label = target.dataset.label ?? id
        const color = getComputedStyle(target).getPropertyValue('--c').trim() || 'var(--ring)'
        const done = () => {
          g.remove()
          burstAt(head.querySelector('.tag') ?? head, color, 16)
          floatAt(head.querySelector('.tag') ?? head, '+1', color)
          pop(head.querySelector('.tag'), 1.15)
          void onDrop(kind as 'status' | 'topic', id, label)
        }
        if (anim) anim.onfinish = done
        else done()
      } else {
        // 놓을 곳이 아니면 원래 자리로 튕겨 돌아간다.
        const anim = g.animate?.([{ transform: g.style.transform }, { transform: 'translate(0, 0) rotate(0deg) scale(1)' }], {
          duration: 420,
          easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
        })
        const done = () => {
          g.remove()
          row.classList.remove('drag-src')
        }
        if (anim) anim.onfinish = done
        else done()
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  })
}
