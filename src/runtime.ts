// 관제 런타임: Pod 워커가 Claude 를 직접 띄워(stream-json) 주고받는다. Orca 터미널을 거치지 않으므로
// 글자 단위로 바로 흘러나오고, 사진은 파일 없이 그대로 넘긴다. 대화는 세션 id 로 이어 간다(--resume).
import type { ChildProcess } from 'node:child_process'
import { emptyState, feed, type ChatItem, type TranscriptState } from './transcript'
import { visibleControlItem } from './control-handoff'

export interface ControlImage {
  type: string
  data: string
}

export interface ControlView {
  items: ChatItem[]
  /** 지금 흘러나오는 답(완성 전). */
  live: string
  busy: boolean
  /** 이번 요청을 보낸 시각(작업 중일 때). */
  since: number
  sessionId: string | null
  error: string | null
  /** 진행 중인 관제 요청의 불변 식별자. */
  requestId?: string | null
  /** 마지막으로 끝난 요청의 명시적 결과. 도구 영수증 같은 note로 추론하지 않는다. */
  outcome?: { requestId: string; status: 'complete' | 'failed' | 'interrupted' } | null
  /** 바뀔 때마다 늘어나는 번호(화면이 다시 그릴지 가른다). */
  rev: number
}

export interface RuntimeDeps {
  spawn(args: string[]): ChildProcess
  /** 화면에 바뀐 상태를 알린다. */
  emit(view: ControlView): void
  /** 세션 id 가 정해지거나 바뀌면 저장한다. */
  saveSession(id: string | null): void
  /** 이어 갈 세션의 지난 대화. */
  history(id: string): Promise<ChatItem[]>
  now?(): number
  onStop?(): void
}

const SEND = 240
/** 쓰지 않으면 이만큼 뒤에 프로세스를 내린다(세션 id 는 남아 다음에 이어 간다). */
const IDLE_MS = 30 * 60_000

export class ControlRuntime {
  private proc: ChildProcess | null = null
  private state: TranscriptState = emptyState()
  private rest = ''
  private live = ''
  private busy = false
  private since = 0
  private error: string | null = null
  private requestId: string | null = null
  private outcome: ControlView['outcome'] = null
  private sessionId: string | null
  private loaded = false
  private rev = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  /** 사용자가 멈추거나 Pod 이 내린 프로세스(끝나도 오류로 보지 않는다). */
  private stopped = new WeakSet<ChildProcess>()
  /** 세션을 이어 가는 데 성공한(init 을 받은) 프로세스. */
  private started = new WeakSet<ChildProcess>()

  constructor(
    private deps: RuntimeDeps,
    sessionId: string | null
  ) {
    this.sessionId = sessionId
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  view(): ControlView {
    return {
      items: this.state.items.slice(-SEND),
      live: this.live,
      busy: this.busy,
      since: this.since,
      sessionId: this.sessionId,
      error: this.error,
      requestId: this.busy ? this.requestId : null,
      outcome: this.outcome,
      rev: this.rev
    }
  }

  /** 지난 대화를 한 번 불러 둔다(이어 가는 세션일 때). */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.sessionId) return
    try {
      const items = await this.deps.history(this.sessionId)
      this.state = { ...emptyState(), items: [...items, ...this.state.items] }
    } catch {}
  }

  private changed(now = false): void {
    this.rev++
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = null
      this.deps.emit(this.view())
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.deps.emit(this.view())
    }, 80)
  }

  private ensure(): ChildProcess {
    if (this.proc) return this.proc
    const resuming = this.sessionId
    const p = this.deps.spawn(resuming ? ['--resume', resuming] : [])
    this.proc = p
    this.rest = ''
    p.stdout?.setEncoding('utf8')
    // 프로세스마다 출력을 따로 받는다. 이미 내린 프로세스가 마저 내보내는 출력은 버린다.
    p.stdout?.on('data', (chunk: string) => this.onData(chunk, p))
    p.stderr?.on('data', () => {})
    // 죽은 프로세스에 쓰면 입력 스트림 오류가 난다. 잡지 않으면 워커가 통째로 내려간다.
    p.stdin?.on('error', () => this.onExit(p, 1))
    p.on('error', () => this.onExit(p, 1))
    p.on('exit', (code) => this.onExit(p, code, resuming))
    return p
  }

  private onExit(p: ChildProcess, code: number | null, resuming: string | null = null): void {
    if (this.proc !== p) return
    this.proc = null
    const stopped = this.stopped.has(p)
    if (!stopped) this.deps.onStop?.()
    if (this.busy) {
      this.busy = false
      if (this.live.trim()) this.push({ k: 'text', text: this.live.trim(), at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
      this.live = ''
      this.push({ k: 'note', text: stopped ? '중단함' : '응답이 끊김', at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
      if (this.requestId) this.outcome = { requestId: this.requestId, status: stopped ? 'interrupted' : 'failed' }
      this.requestId = null
    }
    if (!stopped && code) {
      // 이어 가기에 실패했으면(세션을 못 열면 init 전에 끝난다) 다음엔 새 대화로 시작한다. 같은 실패를 되풀이하지 않게.
      if (resuming && !this.started.has(p) && this.sessionId === resuming) {
        this.sessionId = null
        this.deps.saveSession(null)
        this.error = '이전 대화를 잇지 못함'
      } else this.error = '관제가 종료됨'
    }
    this.changed(true)
  }

  private push(it: ChatItem): void {
    this.state.items.push(it)
    if (this.state.items.length > 600) this.state.items.splice(0, this.state.items.length - 600)
  }

  /** stream-json 출력 한 덩어리. 완성된 메시지는 대화 기록과 같은 파서로, 조각은 live 에 붙인다. */
  onData(chunk: string, from: ChildProcess | null = this.proc): void {
    if (from !== this.proc) return
    const lines = (this.rest + chunk).split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let o: any
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (o.type === 'system' && o.subtype === 'init' && typeof o.session_id === 'string') {
        if (from) this.started.add(from)
        if (o.session_id !== this.sessionId) {
          this.sessionId = o.session_id
          this.deps.saveSession(o.session_id)
        }
      } else if (o.type === 'stream_event') {
        const d = o.event?.delta
        if (o.event?.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string') {
          this.live += d.text
          this.changed()
        }
      } else if ((o.type === 'assistant' || o.type === 'user') && !o.parent_tool_use_id) {
        if (o.type === 'assistant') this.live = ''
        // 기록 파일과 같은 모양이라 같은 파서를 쓴다(시각만 붙인다).
        const itemStart = this.state.items.length
        this.state = feed(this.state, `${JSON.stringify({ ...o, timestamp: new Date(this.now()).toISOString() })}\n`)
        this.state.items = this.state.items.map((item, index) => visibleControlItem(index < itemStart || !this.requestId ? item : { ...item, requestId: this.requestId }))
        this.changed()
      } else if (o.type === 'result') {
        this.busy = false
        if (this.live.trim()) this.push({ k: 'text', text: this.live.trim(), at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
        this.live = ''
        if (from && this.stopped.has(from)) this.push({ k: 'note', text: '중단함', at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
        else if (o.is_error) this.push({ k: 'note', text: '응답 오류', at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
        if (this.requestId) this.outcome = { requestId: this.requestId, status: from && this.stopped.has(from) ? 'interrupted' : o.is_error ? 'failed' : 'complete' }
        this.requestId = null
        this.changed(true)
        this.armIdle()
      }
    }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (!this.busy) this.shutdown()
    }, IDLE_MS)
    this.idleTimer.unref?.()
  }

  send(text: string, images: ControlImage[] = [], context = '', requestId?: string): void {
    const body = text.trim()
    if (!body && images.length === 0) throw new Error('빈 메시지')
    // 한 번에 한 요청만. 겹쳐 보내면 첫 답이 끝날 때 작업 중 표시가 꺼져 버린다.
    if (this.busy) throw new Error('작업 중')
    const p = this.ensure()
    const content = [
      ...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })),
      ...((body || context) ? [{ type: 'text', text: context ? `${context}\n\nCurrent user request:\n${body}` : body }] : [])
    ]
    p.stdin?.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
    this.requestId = requestId ?? null
    this.outcome = null
    this.push({ k: 'user', text: body, at: this.now(), images: images.length, ...(this.requestId ? { requestId: this.requestId } : {}) })
    this.busy = true
    this.since = this.now()
    this.error = null
    this.changed(true)
  }

  /** 지금 답을 멈춘다. 프로세스를 내리고, 다음 메시지에서 같은 세션으로 이어 간다. */
  stop(): void {
    this.deps.onStop?.()
    const p = this.proc
    if (!p) return
    this.stopped.add(p)
    p.kill('SIGINT')
    // SIGINT 로 안 내려가면 3초 뒤 강제로 내린다(그 사이 끝났으면 아무것도 안 한다).
    const t = setTimeout(() => p.exitCode === null && p.signalCode === null && p.kill('SIGKILL'), 3000)
    t.unref?.()
  }

  /** 새 대화. */
  reset(): void {
    this.shutdown()
    this.sessionId = null
    this.deps.saveSession(null)
    this.state = emptyState()
    this.live = ''
    this.busy = false
    this.error = null
    this.outcome = null
    this.loaded = true
    this.changed(true)
  }

  /** 프로세스를 내린다. 바로 떼어 내므로 그 뒤의 출력·종료는 새 대화에 섞이지 않는다. */
  shutdown(): void {
    this.deps.onStop?.()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const p = this.proc
    if (!p) return
    this.stopped.add(p)
    this.proc = null
    if (this.busy) {
      this.busy = false
      this.live = ''
      if (this.requestId) this.outcome = { requestId: this.requestId, status: 'interrupted' }
      this.requestId = null
      this.changed(true)
    }
    p.stdin?.end()
    p.kill('SIGTERM')
  }
}
