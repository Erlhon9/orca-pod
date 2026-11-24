// Codex app-server stdio 어댑터. 모델이 실행할 수 있는 관제 도구는 워커에 등록한 세 개뿐이다.
import type { ChildProcess } from 'node:child_process'
import type { ChatItem } from './transcript'
import type { ControlImage, ControlView } from './runtime'
import { CODEX_CONTROL_PROMPT, RELAY_TOOLS } from './relay'

export interface CodexDeps {
  spawn(): ChildProcess
  emit(view: ControlView): void
  saveSession(id: string | null): void
  tool(name: string, input: unknown, active?: () => boolean): Promise<unknown>
  now?(): number
}

export class CodexControlRuntime {
  private proc: ChildProcess | null = null
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private seq = 0
  private rest = ''
  private ready: Promise<void> | null = null
  private thread: string | null
  private turn: string | null = null
  private items: ChatItem[]
  private live = ''
  private busy = false
  private since = 0
  private rev = 0
  private error: string | null = null
  private requestId: string | null = null
  private outcome: ControlView['outcome'] = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private deps: CodexDeps, sessionId: string | null = null, history: ChatItem[] = []) {
    this.thread = sessionId
    this.items = history.slice(-240)
  }
  private now() { return this.deps.now?.() ?? Date.now() }
  async load(): Promise<void> {}
  view(): ControlView {
    return { items: this.items.slice(-240), live: this.live, busy: this.busy, since: this.since, sessionId: this.thread, error: this.error, requestId: this.busy ? this.requestId : null, outcome: this.outcome, rev: this.rev }
  }
  private changed(): void {
    this.rev++
    this.deps.emit(this.view())
  }
  private push(item: ChatItem): void {
    this.items.push(item)
    if (this.items.length > 600) this.items.splice(0, this.items.length - 600)
  }
  private write(value: unknown): void {
    if (!this.proc?.stdin?.writable) throw new Error('Codex 관제를 시작하지 못했습니다')
    this.proc.stdin.write(JSON.stringify(value) + '\n')
  }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex 관제 응답 시간이 초과되었습니다'))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }
  private clearPending(): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('관제가 종료됨')) }
    this.pending.clear()
  }
  private async initialize(): Promise<void> {
    const p = this.deps.spawn()
    this.proc = p
    this.rest = ''
    p.stdout?.setEncoding('utf8')
    p.stdout?.on('data', (chunk: string) => this.onData(chunk, p))
    p.stderr?.on('data', () => {})
    const exited = () => {
      if (p !== this.proc) return
      this.proc = null
      this.ready = null
      this.clearPending()
      if (this.busy) this.finish('관제가 종료됨')
    }
    p.on('exit', exited)
    p.on('error', exited)
    p.stdin?.on('error', exited)
    await this.request('initialize', { clientInfo: { name: 'pod_control', version: '0.4.0' }, capabilities: { experimentalApi: true } })
    this.write({ method: 'initialized' })
    // mcp_servers={}는 사용자 테이블을 지우지 않는다. 이름을 조회해 각각 명시적으로 끈다.
    const loaded = await this.request('config/read', { includeLayers: false })
    const config: Record<string, unknown> = {
      'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false,
      'features.multi_agent': false, 'features.multi_agent_v2': false, 'features.apps': false,
      'features.code_mode': false, 'features.js_repl': false, 'features.memory_tool': false,
      'features.browser_use': false, 'features.computer_use': false, 'web_search': 'disabled',
      'plugins._default.enabled': false
    }
    config.mcp_servers = Object.fromEntries(Object.entries(loaded.config?.mcp_servers ?? {}).map(([name, value]) => [name, { ...(value as object), enabled: false }]))
    config.plugins = Object.fromEntries(Object.entries(loaded.config?.plugins ?? {}).map(([name, value]) => [name, { ...(value as object), enabled: false }]))
    ;(config.plugins as Record<string, unknown>)._default = { enabled: false }
    // config/read는 기본값 null도 돌려준다. TOML 재입력에서 null은 빈 문자열이 되므로 제외한다.
    const prune = (value: any): any => Array.isArray(value) ? value.map(prune) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, prune(v)])) : value
    const options = { approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: CODEX_CONTROL_PROMPT, config: prune(config) }
    let response: any
    if (this.thread) {
      // 이어 가기 실패 시 이번 요청을 실패로 처리한다. 새 대화에 자동 재전송하지 않는다.
      try { response = await this.request('thread/resume', { ...options, threadId: this.thread }) }
      catch (e) { this.thread = null; this.deps.saveSession(null); throw e }
    } else response = await this.request('thread/start', { ...options, dynamicTools: RELAY_TOOLS })
    if (typeof response.thread?.id !== 'string') throw new Error('Codex 관제를 시작하지 못했습니다')
    this.thread = response.thread.id
    this.deps.saveSession(this.thread)
  }
  private ensure(): Promise<void> {
    this.ready ??= this.initialize()
    return this.ready
  }
  async send(text: string, images: ControlImage[] = [], context = '', requestId?: string): Promise<void> {
    const body = text.trim()
    if (!body && !images.length) throw new Error('빈 메시지')
    if (this.busy) throw new Error('작업 중')
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.busy = true
    this.since = this.now()
    this.error = null
    this.requestId = requestId ?? null
    this.outcome = null
    const generation = this.generation
    this.changed()
    try {
      await this.ensure()
      if (generation !== this.generation) throw new Error('중단함')
      const input = [
        ...((body || context) ? [{ type: 'text', text: context ? `${context}\n\nCurrent user request:\n${body}` : body, text_elements: [] }] : []),
        ...images.map(im => ({ type: 'image', url: `data:${im.type};base64,${im.data}` }))
      ]
      // 미리 올려 두어 turn/start 응답보다 먼저 도착하는 완료 알림도 사용자 말 뒤에 놓는다.
      this.push({ k: 'user', text: body, at: this.since, images: images.length, ...(this.requestId ? { requestId: this.requestId } : {}) })
      const result = await this.request('turn/start', { threadId: this.thread, input })
      if (generation !== this.generation) return
      this.turn = this.busy ? result.turn?.id ?? null : null
      this.changed()
    } catch (e) {
      if (generation === this.generation) {
        this.closeProcess()
        this.finish('Codex 관제를 시작하지 못했습니다')
      }
      throw e
    }
  }
  private finish(error: string | null = null): void {
    if (this.live.trim()) this.push({ k: 'text', text: this.live.trim(), at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
    this.live = ''
    this.busy = false
    this.turn = null
    this.error = error
    if (error) this.push({ k: 'note', text: error, at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
    if (this.requestId) this.outcome = { requestId: this.requestId, status: error === '중단함' ? 'interrupted' : error ? 'failed' : 'complete' }
    this.requestId = null
    this.changed()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.shutdown(), 30 * 60_000)
    this.idleTimer.unref?.()
  }
  onData(chunk: string, from: ChildProcess | null = this.proc): void {
    if (from !== this.proc) return
    const lines = (this.rest + chunk).split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) {
      let o: any
      try { o = JSON.parse(line) } catch { continue }
      if (o.id !== undefined && !o.method) {
        const pending = this.pending.get(o.id)
        if (!pending) continue
        clearTimeout(pending.timer)
        this.pending.delete(o.id)
        if (o.error) pending.reject(new Error(String(o.error.message)))
        else pending.resolve(o.result)
        continue
      }
      const v = o.params ?? {}
      if (o.id !== undefined) {
        // 허용한 동적 도구만 처리한다. 파일 변경·명령 승인 등 나머지 서버 요청은 거부한다.
        if (o.method === 'item/tool/call' && this.busy && v.threadId === this.thread && RELAY_TOOLS.some(tool => tool.name === v.tool)) {
          const generation = this.generation
          Promise.resolve().then(() => {
            if (generation !== this.generation || from !== this.proc) throw new Error('중단함')
            return this.deps.tool(v.tool, v.arguments, () => generation === this.generation && from === this.proc && this.busy)
          }).then(
            result => this.toolResult(o.id, result, true, from),
            e => this.toolResult(o.id, String(e?.message ?? e), false, from)
          )
        } else {
          try { this.write({ id: o.id, error: { code: -32601, message: 'Pod Control only supports its relay tools' } }) } catch {}
        }
        continue
      }
      if (v.threadId && v.threadId !== this.thread) continue
      if (o.method === 'turn/started') this.turn = v.turn?.id ?? null
      else if (o.method === 'item/agentMessage/delta') { this.live += v.delta ?? ''; this.changed() }
      else if (o.method === 'item/completed' && v.item?.type === 'agentMessage') {
        this.live = ''
        this.push({ k: 'text', text: v.item.text, at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
        this.changed()
      } else if (o.method === 'item/completed' && v.item?.type === 'dynamicToolCall') {
        this.push({ k: 'tool', id: v.item.id, name: v.item.tool, detail: JSON.stringify(v.item.arguments ?? {}).slice(0, 240), at: this.now(), error: v.item.status !== 'completed', ...(this.requestId ? { requestId: this.requestId } : {}) })
        this.changed()
      } else if (o.method === 'turn/completed') {
        this.finish(v.turn?.status === 'failed' ? '응답 오류' : v.turn?.status === 'interrupted' ? '중단함' : null)
      } else if (o.method === 'error' && !v.willRetry) this.finish('응답 오류')
    }
  }
  private toolResult(id: number | string, result: unknown, success: boolean, from: ChildProcess | null): void {
    if (from !== this.proc) return
    const text = JSON.stringify(result) ?? 'null'
    this.push({ k: 'note', text: `Tool receipt: ${text.slice(0, 4000)}`, at: this.now(), ...(this.requestId ? { requestId: this.requestId } : {}) })
    this.changed()
    try { this.write({ id, result: { contentItems: [{ type: 'inputText', text }], success } }) } catch {}
  }
  stop(): void {
    if (this.busy) this.shutdown()
  }
  reset(): void {
    this.shutdown()
    this.thread = null
    this.items = []
    this.error = null
    this.outcome = null
    this.deps.saveSession(null)
    this.changed()
  }
  private closeProcess(): void {
    this.generation++
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const p = this.proc
    this.proc = null
    this.ready = null
    this.clearPending()
    p?.stdin?.end()
    p?.kill('SIGTERM')
    if (p) {
      const timer = setTimeout(() => p.exitCode === null && p.signalCode === null && p.kill('SIGKILL'), 3000)
      timer.unref?.()
    }
  }
  shutdown(): void {
    this.closeProcess()
    if (this.busy) this.finish('중단함')
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
