import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { assert, test } from 'orca/testing'
import { CodexControlRuntime, type CodexDeps } from './codex-runtime'

function setup(session: string | null = null, failResume = false, tool?: CodexDeps['tool']) {
  const messages: any[] = []
  const tools: string[] = []
  const saved: (string | null)[] = []
  const procs: any[] = []
  const rt = new CodexControlRuntime({
    spawn: () => {
      const p: any = new EventEmitter()
      p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough()
      p.exitCode = null; p.signalCode = null
      p.kill = () => { p.exitCode = 0; p.emit('exit', 0); return true }
      p.stdin.on('data', (b: Buffer) => {
        for (const line of b.toString().trim().split('\n')) {
          const m = JSON.parse(line); messages.push(m)
          if (!m.method || m.id === undefined) continue
          const result = m.method === 'config/read' ? { config: { mcp_servers: { dangerous: {} }, plugins: { 'example@local': { enabled: true } } } }
            : m.method.startsWith('thread/') ? { thread: { id: 'codex-thread' } } : m.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}
          queueMicrotask(() => p.stdout.write(JSON.stringify(m.method === 'thread/resume' && failResume
            ? { id: m.id, error: { message: 'no thread' } } : { id: m.id, result }) + '\n'))
        }
      })
      procs.push(p)
      return p
    },
    emit: () => {}, saveSession: id => saved.push(id),
    tool: tool ?? (async (name) => { tools.push(name); return { accepted: true, stage: 'queued' } })
  }, session)
  const event = (method: string, params: unknown, id?: number) => procs.at(-1).stdout.write(JSON.stringify({ method, params, ...(id !== undefined ? { id } : {}) }) + '\n')
  return { rt, messages, tools, saved, procs, event }
}

test('Codex 초기화·외부 도구 차단·사진 전송·스트리밍 완료를 처리한다', async () => {
  const { rt, messages, event } = setup()
  try {
    await rt.send('정리해줘', [{ type: 'image/png', data: 'AAAA' }])
    const start = messages.find(m => m.method === 'thread/start')
    assert.equal(start.params.config.mcp_servers.dangerous.enabled, false)
    assert.equal(start.params.config.plugins['example@local'].enabled, false)
    assert.equal(start.params.config['features.shell_tool'], false)
    assert.equal(start.params.approvalPolicy, 'never')
    assert.equal(start.params.sandbox, 'read-only')
    assert.equal(start.params.dynamicTools.length, 3)
    const sent = messages.find(m => m.method === 'turn/start')
    assert.deepEqual(sent.params.input[1], { type: 'image', url: 'data:image/png;base64,AAAA' })
    assert.equal(rt.view().busy, true)
    event('item/agentMessage/delta', { threadId: 'codex-thread', delta: '답' })
    assert.equal(rt.view().live, '답')
    event('item/completed', { threadId: 'codex-thread', item: { type: 'agentMessage', text: '답변' } })
    event('turn/completed', { threadId: 'codex-thread', turn: { status: 'completed' } })
    assert.equal(rt.view().busy, false)
    assert.equal(rt.view().items.filter(i => i.k === 'text').length, 1)
  } finally { rt.shutdown() }
})

test('Codex 도구 조회 중 관제를 중단하면 이전 호출의 실행 권한도 사라진다', async () => {
  let active!: () => boolean
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const { rt, event } = setup(null, false, async (_name, _input, current) => {
    active = current!
    entered()
    await pending
    return { accepted: false }
  })
  try {
    await rt.send('전달')
    event('item/tool/call', { threadId: 'codex-thread', tool: 'pod_send_session', arguments: { key: 'key', text: 'Review' } }, 90)
    await started
    assert.equal(active(), true)
    rt.stop()
    assert.equal(active(), false)
  } finally { release(); rt.shutdown() }
})

test('등록한 도구만 워커에 전달하고 다른 스레드의 도구 요청은 거부한다', async () => {
  const { rt, tools, event, messages } = setup()
  try {
    await rt.send('조회해줘')
    event('item/tool/call', { threadId: 'other', tool: 'pod_send_session', arguments: {} }, 50)
    event('item/tool/call', { threadId: 'codex-thread', tool: 'exec_command', arguments: {} }, 52)
    event('item/tool/call', { threadId: 'codex-thread', tool: 'pod_sessions', arguments: {} }, 51)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(tools, ['pod_sessions'])
    assert.equal(messages.find(m => m.id === 50).error.code, -32601)
    assert.equal(messages.find(m => m.id === 52).error.code, -32601)
    assert.equal(messages.find(m => m.id === 51).result.success, true)
  } finally { rt.shutdown() }
})

test('Claude의 인계 문맥은 Codex 입력에 포함하고 화면의 사용자 말에는 섞지 않는다', async () => {
  const { rt, messages } = setup()
  try {
    await rt.send('이어서 해줘', [], 'Previous Claude context: delivery queued, do not resend')
    const sent = messages.find(m => m.method === 'turn/start')
    assert.ok(sent.params.input[0].text.includes('Previous Claude context'))
    assert.ok(sent.params.input[0].text.endsWith('이어서 해줘'))
    const user = rt.view().items.find(i => i.k === 'user')
    assert.equal(user?.text, '이어서 해줘')
  } finally { rt.shutdown() }
})

test('중복 요청은 거부하고 중단·초기화 뒤 예전 프로세스의 출력은 버린다', async () => {
  const { rt, procs } = setup()
  try {
    await rt.send('조회')
    await assert.rejects(() => rt.send('중복'))
    const old = procs[0]
    rt.stop()
    assert.equal(rt.view().busy, false)
    assert.equal(rt.view().sessionId, 'codex-thread')
    rt.reset()
    old.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '옛 답' } }) + '\n')
    assert.equal(rt.view().sessionId, null)
    assert.equal(rt.view().live, '')
    assert.deepEqual(rt.view().items, [])
  } finally { rt.shutdown() }
})

test('이어 가기 실패는 새 대화로 자동 재전송하지 않는다', async () => {
  const { rt, messages } = setup('old-thread', true)
  try {
    await assert.rejects(() => rt.send('전달'))
    assert.equal(messages.some(m => m.method === 'thread/start'), false)
    assert.equal(messages.some(m => m.method === 'turn/start'), false)
    assert.equal(rt.view().busy, false)
    assert.equal(rt.view().error, 'Codex 관제를 시작하지 못했습니다')
  } finally { rt.shutdown() }
})

test('Codex 요청의 사용자·도구·응답 항목에는 같은 요청 식별자를 남긴다', async () => {
  const { rt, event } = setup()
  try {
    await rt.send('조회', [], '', 'control-2')
    assert.equal(rt.view().requestId, 'control-2')
    event('item/tool/call', { threadId: 'codex-thread', tool: 'pod_sessions', arguments: {} }, 91)
    await new Promise(resolve => setImmediate(resolve))
    event('item/completed', { threadId: 'codex-thread', item: { type: 'dynamicToolCall', id: 'tool-1', tool: 'pod_sessions', arguments: {}, status: 'completed' } })
    event('item/completed', { threadId: 'codex-thread', item: { type: 'agentMessage', text: '확인함' } })
    event('turn/completed', { threadId: 'codex-thread', turn: { status: 'completed' } })
    const v = rt.view()
    assert.equal(v.requestId, null)
    assert.deepEqual(v.outcome, { requestId: 'control-2', status: 'complete' })
    assert.ok(v.items.some(item => item.k === 'note' && item.text.startsWith('Tool receipt:')))
    assert.ok(v.items.every(item => item.requestId === 'control-2'))
  } finally { rt.shutdown() }
})
