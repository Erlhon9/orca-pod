// 입력창 사진 첨부. 붙여넣기·끌어놓기·고르기로 받아 두었다가, 보낼 때 워커가 임시 파일로 저장한 경로를 지시 앞에 붙인다.
import { h, icon } from './ui'

type Call = <T = any>(name: string, input?: unknown, quiet?: boolean) => Promise<T>

const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** 워커의 IMAGE_MAX 와 같게. */
const MAX = 15 * 1024 * 1024
const MAX_COUNT = 6

interface Item {
  file: File
  /** 미리보기(blob URL). 빼거나 비울 때 놓아준다. */
  thumb: string
}

export interface Attach {
  /** 사진 고르기 버튼. */
  button: HTMLElement
  /** 붙인 사진 줄(없으면 숨김). */
  tray: HTMLElement
  count(): number
  /** 사진을 저장하고 보낼 본문(경로 + 지시)을 만든다. */
  compose(body: string): Promise<string>
  /** 사진을 파일 없이 그대로(base64) 꺼낸다. */
  images(): Promise<{ type: string; data: string }[]>
  clear(): void
  /** 보내는 동안 붙이기·빼기를 막는다. */
  lock(on: boolean): void
}

/** 사진 경로와 지시를 한 줄로 잇는다. */
export function withImages(paths: string[], body: string): string {
  return [...paths, body.trim()].filter(Boolean).join(' ')
}

const readBase64 = (f: File) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader()
    r.onload = () => {
      const url = String(r.result)
      ok(url.slice(url.indexOf(',') + 1))
    }
    r.onerror = () => no(r.error)
    r.readAsDataURL(f)
  })

// 입력창 밖에 사진을 놓아도 패널이 그 파일로 넘어가지 않게 한다.
let guarded = false
function guardWindowDrop(): void {
  if (guarded) return
  guarded = true
  const files = (ev: DragEvent) => [...(ev.dataTransfer?.types ?? [])].includes('Files')
  window.addEventListener('dragover', (ev) => files(ev) && ev.preventDefault())
  window.addEventListener('drop', (ev) => files(ev) && ev.preventDefault())
}

export function attachments(
  drop: HTMLElement,
  area: HTMLTextAreaElement,
  opts: { call: Call; toast: (m: string, kind?: 'ok' | 'err') => void; onChange: () => void }
): Attach {
  guardWindowDrop()
  const items: Item[] = []
  let locked = false
  const tray = h('div', { class: 'attach-tray', hidden: true })
  // 문서에 붙이지 않은 파일 입력도 click() 으로 고르기 창이 열린다.
  const input = h('input', { type: 'file', accept: [...TYPES].join(','), multiple: true }) as HTMLInputElement
  const button = h('button', { class: 'attach', title: '사진 붙이기' }, icon('image')) as HTMLButtonElement

  const render = () => {
    tray.hidden = items.length === 0
    tray.replaceChildren(
      ...items.map((it) =>
        h(
          'div',
          { class: 'attach-item' },
          h('img', { src: it.thumb, alt: '' }),
          h('button', { class: 'attach-x', title: '빼기', onClick: () => remove(it) }, icon('x'))
        )
      )
    )
    opts.onChange()
  }
  const remove = (it: Item) => {
    if (locked) return
    const i = items.indexOf(it)
    if (i < 0) return
    items.splice(i, 1)
    URL.revokeObjectURL(it.thumb)
    render()
  }

  function add(files: Iterable<File>): void {
    if (locked) return
    let skipped = false
    for (const f of files) {
      if (!TYPES.has(f.type) || f.size > MAX || items.length >= MAX_COUNT) {
        skipped = true
        continue
      }
      items.push({ file: f, thumb: URL.createObjectURL(f) })
    }
    if (skipped) opts.toast('붙일 수 없는 파일', 'err')
    render()
  }

  const imagesOf = (dt: DataTransfer | null) => [...(dt?.files ?? [])].filter((f) => f.type.startsWith('image/'))

  button.addEventListener('click', () => !locked && input.click())
  input.addEventListener('change', () => {
    add([...(input.files ?? [])])
    input.value = ''
  })
  area.addEventListener('paste', (ev) => {
    const files = imagesOf(ev.clipboardData)
    // 글도 함께 온 붙여넣기(표 셀 복사 등)는 글로 둔다.
    if (!files.length || ev.clipboardData?.getData('text/plain')) return
    ev.preventDefault()
    add(files)
  })
  drop.addEventListener('dragover', (ev) => {
    if (![...(ev.dataTransfer?.types ?? [])].includes('Files')) return
    ev.preventDefault()
    drop.classList.add('dropping')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('dropping'))
  drop.addEventListener('drop', (ev) => {
    drop.classList.remove('dropping')
    const files = imagesOf(ev.dataTransfer)
    if (!files.length) return
    ev.preventDefault()
    add(files)
  })

  return {
    button,
    tray,
    count: () => items.length,
    async compose(body) {
      const paths: string[] = []
      for (const it of items) {
        const r = await opts.call<{ path: string }>('pod.saveImage', { type: it.file.type, data: await readBase64(it.file) })
        paths.push(r.path)
      }
      return withImages(paths, body)
    },
    async images() {
      return Promise.all(items.map(async (it) => ({ type: it.file.type, data: await readBase64(it.file) })))
    },
    clear() {
      for (const it of items) URL.revokeObjectURL(it.thumb)
      items.length = 0
      render()
    },
    lock(on) {
      locked = on
      button.disabled = on
      tray.classList.toggle('locked', on)
    }
  }
}
