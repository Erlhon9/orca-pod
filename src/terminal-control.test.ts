import { assert, test } from 'orca/testing'
import { TerminalControlRuntime, controlLaunchResult, controlScreenLines } from './terminal-control'
import { CONTROL_AGENTS, isControlProvider } from './control-agents'

function setup(saved: string | null = null) {
  const launched: string[] = [], sent: string[][] = [], interrupted: string[] = [], terminals: (string | null)[] = []
  let launchError = false, readError = false
  const runtime = new TerminalControlRuntime({
    launch: async prompt => { launched.push(prompt); if (launchError) throw new Error('transport lost'); return { terminal: 'term_owned', receipt: { prompt: { outcome: 'journaled' } } } },
    send: async (terminal, text) => { sent.push([terminal, text]); return { stage: 'input_accepted' } },
    read: async () => { if (readError) throw new Error('owner mismatch'); return { lines: ['example reply'], working: false } },
    interrupt: async terminal => { interrupted.push(terminal) },
    saveTerminal: terminal => { terminals.push(terminal) }, emit: () => {},
    saveImages: async () => ['/demo/image.png']
  }, 'Control instructions', saved)
  return { runtime, launched, sent, interrupted, terminals, failLaunch: () => { launchError = true }, failRead: () => { readError = true } }
}

test('Orca의 다양한 에이전트 ID를 선택할 수 있고 셸은 선택할 수 없다', () => {
  assert.equal(new Set(CONTROL_AGENTS.map(a => a.id)).size, CONTROL_AGENTS.length)
  for (const id of ['gemini', 'pi', 'omp', 'grok', 'copilot', 'opencode', 'qwen-code']) assert.equal(isControlProvider(id), true)
  assert.equal(isControlProvider('shell'), false)
  assert.equal(isControlProvider('gemini; echo x'), false)
})

test('처음 보낼 때 한 번만 실행하고 이후에는 같은 터미널로 보낸다', async () => {
  const { runtime, launched, sent } = setup()
  try {
    await runtime.send('첫 요청', [], 'Previous Control context')
    assert.equal(launched.length, 1)
    assert.ok(launched[0].includes('Previous Control context'))
    assert.ok(launched[0].includes('첫 요청'))
    await runtime.send('다음 요청')
    assert.equal(launched.length, 1)
    assert.deepEqual(sent, [['term_owned', '다음 요청']])
    assert.equal(runtime.view().items.filter(i => i.k === 'user').length, 2)
  } finally { await runtime.shutdown() }
})

test('저장된 터미널은 새로 실행하지 않고 소유 확인 후 재사용한다', async () => {
  const { runtime, launched, sent, failRead } = setup('term_saved')
  try {
    await runtime.load()
    await runtime.send('계속')
    assert.equal(launched.length, 0)
    assert.equal(sent[0][0], 'term_saved')
    failRead()
    await assert.rejects(() => runtime.send('잘못된 대상'))
    assert.equal(sent.length, 1)
  } finally { await runtime.shutdown() }
})

test('실행 결과가 불명확하면 새 에이전트를 자동으로 중복 실행하지 않는다', async () => {
  const { runtime, launched, failLaunch } = setup()
  try {
    failLaunch()
    await assert.rejects(() => runtime.send('첫 요청'))
    await assert.rejects(() => runtime.send('다시 요청'))
    assert.equal(launched.length, 1)
    assert.equal(runtime.view().busy, false)
    assert.equal(runtime.view().items.find(item => item.k === 'user')?.text, '첫 요청')
  } finally { await runtime.shutdown() }
})

test('이미지는 로컬 첨부 경로로 전달하고 초기화하면 터미널 참조를 지운다', async () => {
  const { runtime, launched, terminals } = setup()
  try {
    await runtime.send('확인', [{ type: 'image/png', data: 'AAAA' }])
    assert.ok(launched[0].includes('/demo/image.png'))
    assert.ok(!launched[0].includes('AAAA'))
    await runtime.reset()
    assert.equal(terminals.at(-1), null)
    assert.deepEqual(runtime.view().items, [])
  } finally { await runtime.shutdown() }
})

test('CLI 실행 결과에서 정확한 핸들만 고르고 터미널 화면 tail을 읽는다', () => {
  assert.equal(controlLaunchResult({ result: { outcome: { kind: 'terminal', handle: 'term_exact' } } }).terminal, 'term_exact')
  assert.equal(controlLaunchResult({ result: { agentTerminalHandle: 'term_old' } }).terminal, 'term_old')
  assert.throws(() => controlLaunchResult({ result: { outcome: { kind: 'structured', handle: 'session-id' } } }))
  assert.throws(() => controlLaunchResult({ result: { terminal: 'guessed-terminal' } }))
  assert.deepEqual(controlScreenLines({ result: { terminal: { tail: ['first', 'second'] } } }), ['first', 'second'])
})

test('전환 뒤 늦게 끝난 실행은 다시 메시지를 보내지 않고 해당 터미널을 중단한다', async () => {
  let finishLaunch!: (value: { terminal: string; receipt: unknown }) => void
  const interrupted: string[] = [], sent: string[] = []
  const rt = new TerminalControlRuntime({
    launch: () => new Promise(resolve => { finishLaunch = resolve }),
    send: async terminal => { sent.push(terminal) },
    read: async () => ({ lines: ['late output'], working: false }),
    interrupt: async terminal => { interrupted.push(terminal) },
    emit: () => {}, saveTerminal: () => {}, saveImages: async () => []
  }, 'Control')
  const pending = rt.send('전달 요청')
  const rejected = assert.rejects(() => pending)
  await rt.shutdown()
  finishLaunch({ terminal: 'term_late', receipt: { stage: 'queued' } })
  await rejected
  assert.deepEqual(interrupted, ['term_late'])
  assert.deepEqual(sent, [])
  assert.equal(rt.view().live, '')
  await rt.shutdown()
})
