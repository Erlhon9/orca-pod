// 관제 런타임: stream-json 을 주고받아 대화 항목·흘러나오는 글·작업 상태를 바르게 만든다.
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { assert, test } from 'orca/testing'
import { ControlRuntime, type ControlView } from './runtime'

function fakeProc() {
  const p: any = new EventEmitter()
  p.stdin = new PassThrough()
  p.stdout = new PassThrough()
  p.stderr = new PassThrough()
  p.exitCode = null
  p.killed = false
  p.written = [] as string[]
  p.stdin.on('data', (b: Buffer) => p.written.push(b.toString()))
  p.signals = [] as string[]
  p.kill = (sig: string) => {
    p.signals.push(sig)
    p.exitCode = 0
    p.emit('exit', 0)
    return true
  }
  return p
}

function setup(sessionId: string | null = null) {
  const procs: any[] = []
  const spawned: string[][] = []
  const saved: (string | null)[] = []
  let last: ControlView | null = null
  const rt = new ControlRuntime(
    {
      spawn: (args) => {
        spawned.push(args)
        const p = fakeProc()
        procs.push(p)
        return p
      },
      emit: (v) => (last = v),
      saveSession: (id) => saved.push(id),
      history: async () => [{ k: 'text', text: '지난 답', at: 1 }]
    },
    sessionId
  )
  return { rt, procs, spawned, saved, view: () => last ?? rt.view() }
}

const line = (o: unknown) => `${JSON.stringify(o)}\n`

test('보내면 사진과 글을 stream-json 한 줄로 쓰고, 조각은 live 로, 완성되면 대화 항목이 된다', async () => {
  const { rt, procs, spawned, saved } = setup()
  rt.send('세션 정리해줘', [{ type: 'image/png', data: 'AAAA' }])
  assert.deepEqual(spawned, [[]])
  const sent = JSON.parse(procs[0].written.join(''))
  assert.equal(sent.type, 'user')
  assert.equal(sent.message.content[0].type, 'image')
  assert.equal(sent.message.content[1].text, '세션 정리해줘')
  assert.equal(rt.view().busy, true)
  assert.deepEqual(rt.view().items.map((i) => i.k), ['user'])

  rt.onData(line({ type: 'system', subtype: 'init', session_id: 's-1' }))
  assert.deepEqual(saved, ['s-1'])
  rt.onData(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '정리' } } }))
  rt.onData(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '했어요' } } }))
  assert.equal(rt.view().live, '정리했어요')
  // 줄이 쪼개져 와도 이어 붙인다.
  const done = line({ type: 'assistant', message: { content: [{ type: 'text', text: '정리했어요' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'orca worktree ps' } }] } })
  rt.onData(done.slice(0, 20))
  rt.onData(done.slice(20))
  assert.equal(rt.view().live, '')
  rt.onData(line({ type: 'result', subtype: 'success', is_error: false }))
  const v = rt.view()
  assert.equal(v.busy, false)
  assert.deepEqual(v.items.map((i) => i.k), ['user', 'text', 'tool'])
  rt.shutdown()
})

test('하위 에이전트 메시지는 대화에 넣지 않는다', () => {
  const { rt } = setup()
  rt.send('a')
  rt.onData(line({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'text', text: '하위' }] } }))
  assert.deepEqual(rt.view().items.map((i) => i.k), ['user'])
  rt.shutdown()
})

test('이어 가는 세션은 지난 대화를 불러오고 --resume 으로 띄운다', async () => {
  const { rt, spawned } = setup('s-9')
  await rt.load()
  assert.deepEqual(rt.view().items.map((i) => (i.k === 'text' ? i.text : i.k)), ['지난 답'])
  rt.send('이어서')
  assert.deepEqual(spawned, [['--resume', 's-9']])
  rt.shutdown()
})

test('중단하면 프로세스를 내리고 「중단함」을 남기며, 다음 메시지는 같은 세션으로 다시 띄운다', () => {
  const { rt, procs, spawned } = setup()
  rt.send('오래 걸리는 일')
  rt.onData(line({ type: 'system', subtype: 'init', session_id: 's-2' }))
  rt.onData(line({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '하는 중' } } }))
  rt.stop()
  assert.deepEqual(procs[0].signals, ['SIGINT'])
  const v = rt.view()
  assert.equal(v.busy, false)
  assert.equal(v.error, null)
  assert.deepEqual(v.items.map((i) => (i.k === 'note' ? i.text : i.k)), ['user', 'text', '중단함'])
  rt.send('다시')
  assert.deepEqual(spawned[1], ['--resume', 's-2'])
  rt.shutdown()
})

test('새 대화는 세션 id 를 지우고 대화를 비운다', () => {
  const { rt, saved } = setup('s-3')
  rt.reset()
  assert.deepEqual(saved, [null])
  assert.equal(rt.view().sessionId, null)
  assert.equal(rt.view().items.length, 0)
})

test('빈 메시지는 보내지 않는다', () => {
  const { rt, spawned } = setup()
  let failed = false
  try {
    rt.send('  ')
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  assert.equal(spawned.length, 0)
})

test('새 대화 뒤에 예전 프로세스가 마저 내보낸 출력은 섞이지 않는다', () => {
  const { rt, procs, saved } = setup()
  rt.send('첫 대화')
  rt.onData(line({ type: 'system', subtype: 'init', session_id: 's-old' }), procs[0])
  rt.reset()
  rt.send('새 대화')
  // 예전 프로세스의 늦은 출력
  rt.onData(line({ type: 'system', subtype: 'init', session_id: 's-old' }), procs[0])
  rt.onData(line({ type: 'result', subtype: 'success' }), procs[0])
  assert.equal(rt.view().busy, true)
  assert.equal(rt.view().sessionId, null)
  assert.deepEqual(saved, ['s-old', null])
  rt.shutdown()
})

test('이어 가기에 실패하면 다음엔 새 대화로 시작한다', () => {
  const { rt, procs, spawned, saved } = setup('s-gone')
  rt.send('이어서')
  procs[0].exitCode = 1
  procs[0].emit('exit', 1)
  assert.equal(rt.view().error, '이전 대화를 잇지 못함')
  assert.equal(rt.view().sessionId, null)
  assert.deepEqual(saved, [null])
  rt.send('다시')
  assert.deepEqual(spawned[1], [])
  rt.shutdown()
})

test('답하는 중에는 또 보내지 않는다', () => {
  const { rt } = setup()
  rt.send('하나')
  let failed = false
  try {
    rt.send('둘')
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  rt.shutdown()
})

test('죽은 프로세스에 쓰다 난 입력 스트림 오류는 워커를 죽이지 않고 끊김으로 남긴다', () => {
  const { rt, procs } = setup()
  rt.send('하나')
  procs[0].stdin.emit('error', new Error('EPIPE'))
  assert.equal(rt.view().busy, false)
  assert.equal(rt.view().error, '관제가 종료됨')
})
