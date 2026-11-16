import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { request as httpRequest } from 'node:http'
import { createControlBridge } from './control-bridge'
import { relayTool } from './relay'
import type { Snapshot } from './model'

async function setup(tool: (name: string, input: any, active: () => boolean) => Promise<unknown> = async () => ({ ok: true })) {
  const bridge = await createControlBridge(tool)
  const config = bridge.config.mcpServers.pod
  const headers = { ...config.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const initial = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) })
  assert.equal(initial.status, 200)
  const session = initial.headers.get('mcp-session-id')!
  assert.ok(session)
  const rpc = async (method: string, params: unknown = {}, id: number | string = 2) => {
    const response = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
    const text = await response.text()
    return { response, body: text ? JSON.parse(text) : null }
  }
  return { bridge, config, headers, session, rpc }
}

test('관제 연결은 인증·올바른 Host·세션을 요구하고 브라우저 Origin을 거부한다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; return {} })
  try {
    const request = (headers: Record<string, string>) => fetch(s.config.url, { method: 'POST', headers, body: '{}' })
    assert.equal((await request({ 'Content-Type': 'application/json' })).status, 401)
    assert.equal((await request({ ...s.headers, Origin: 'https://example.invalid' })).status, 403)
    const hostStatus = await new Promise<number>(resolve => {
      const req = httpRequest(s.config.url, { method: 'POST', headers: { ...s.headers, Host: 'example.invalid' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.end('{}')
    })
    assert.equal(hostStatus, 403)
    assert.equal((await fetch(s.config.url, { headers: s.headers })).status, 405)
    const noSession = await fetch(s.config.url, { method: 'POST', headers: s.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) })
    assert.equal(noSession.status, 404)
    assert.equal(calls, 0)
  } finally { await s.bridge.close() }
})

test('목록·조회·전달만 노출하며 다른 도구·메서드와 잘못된 JSON은 실행하지 않는다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; return {} })
  try {
    const list = await s.rpc('tools/list')
    assert.deepEqual(list.body.result.tools.map((tool: any) => tool.name), ['pod_sessions', 'pod_read_session', 'pod_send_session'])
    assert.equal((await s.rpc('tools/call', { name: 'Bash', arguments: { command: 'echo blocked' } })).body.error.code, -32602)
    assert.equal((await s.rpc('resources/read', { uri: 'file:///demo/private' })).body.error.code, -32601)
    const invalid = await fetch(s.config.url, { method: 'POST', headers: s.headers, body: '{' })
    assert.equal(invalid.status, 400)
    assert.equal(calls, 0)
  } finally { await s.bridge.close() }
})

test('같은 요청의 동시 재전송은 한 번만 실행하고 ID 재사용으로 대상을 바꾸지 못한다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { stage: 'input_accepted', requestId: 'receipt' } })
  try {
    const params = { name: 'pod_send_session', arguments: { key: 'exact-key', text: 'Review' } }
    const [first, second] = await Promise.all([s.rpc('tools/call', params, 10), s.rpc('tools/call', params, 10)])
    assert.deepEqual(first.body, second.body)
    assert.ok(first.body.result.content[0].text.includes('input_accepted'))
    assert.equal(calls, 1)
    const reused = await s.rpc('tools/call', { ...params, arguments: { key: 'other-key', text: 'Review' } }, 10)
    assert.equal(reused.body.error.code, -32600)
    assert.equal(calls, 1)
  } finally { await s.bridge.close() }
})

test('불명확한 전송 실패는 같은 요청을 다시 실행하거나 내부 경로를 노출하지 않는다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; throw new Error('private-token-and-path') })
  try {
    const params = { name: 'pod_send_session', arguments: { key: 'exact-key', text: 'Review' } }
    const first = await s.rpc('tools/call', params, 11)
    const second = await s.rpc('tools/call', params, 11)
    assert.equal(first.body.result.isError, true)
    assert.deepEqual(first.body, second.body)
    assert.equal(JSON.stringify(first.body).includes('private-token-and-path'), false)
    assert.equal(calls, 1)
  } finally { await s.bridge.close() }
})

test('연결을 통해 호출해도 현재 지도·정확한 세션 키·입력 스키마를 검증한다', async () => {
  let calls = 0
  const snap = { workspaces: { w: { agents: [{ key: 'key', type: 'claude', state: 'idle', surface: 'terminal', terminal: 'term_target' }] } } } as unknown as Snapshot
  const s = await setup((name, input) => relayTool({ snapshot: async () => snap, cli: async () => { calls++; return { accepted: true } } }, name, input))
  try {
    const valid = { name: 'pod_send_session', arguments: { key: 'key', text: 'Review' } }
    const extra = await s.rpc('tools/call', { ...valid, arguments: { ...valid.arguments, command: 'blocked' } }, 12)
    assert.equal(extra.body.result.isError, true)
    assert.equal(calls, 0)
    assert.equal((await s.rpc('tools/call', valid, 13)).body.result.isError, undefined)
    snap.workspaces.w.agents = []
    assert.equal((await s.rpc('tools/call', valid, 14)).body.result.isError, true)
    assert.equal(calls, 1)
    const removed = await fetch(s.config.url, { method: 'DELETE', headers: { ...s.headers, 'mcp-session-id': s.session } })
    assert.equal(removed.status, 200)
    assert.equal((await s.rpc('tools/list')).response.status, 404)
  } finally { await s.bridge.close() }
})

test('관제 종료 시 로컬 연결도 닫는다', async () => {
  const s = await setup()
  await s.bridge.close()
  await s.bridge.close()
  await assert.rejects(() => fetch(s.config.url, { method: 'POST', headers: s.headers, body: '{}' }))
})

test('중단으로 세션을 폐기하면 진행 중 조회 뒤의 전송과 기존 연결 재사용을 막는다', async () => {
  let release!: (value: Snapshot) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let calls = 0
  const s = await setup((name, input, active) => relayTool({
    active,
    snapshot: () => new Promise(resolve => { release = resolve; entered() }),
    cli: async () => { calls++; return {} }
  }, name, input))
  try {
    const pending = s.rpc('tools/call', { name: 'pod_send_session', arguments: { key: 'key', text: 'Review' } })
    await started
    s.bridge.revokeSessions()
    release({ workspaces: {} } as Snapshot)
    assert.equal((await pending).body.result.isError, true)
    assert.equal(calls, 0)
    assert.equal((await s.rpc('tools/list')).response.status, 404)
  } finally { await s.bridge.close() }
})

test('큰 요청은 실행하지 않고 큰 도구 결과는 모델에 전달하지 않는다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; return 'x'.repeat(512 * 1024) })
  try {
    try {
      const response = await fetch(s.config.url, { method: 'POST', headers: { ...s.headers, 'mcp-session-id': s.session }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'pod_send_session', arguments: { key: 'key', text: 'x'.repeat(64 * 1024) } } }) })
      assert.equal(response.status, 413)
    } catch (error) { assert.ok(error instanceof TypeError && error.message === 'fetch failed') }
    assert.equal(calls, 0)
    const result = await s.rpc('tools/call', { name: 'pod_sessions', arguments: {} })
    assert.equal(result.body.result.isError, true)
    assert.ok(JSON.stringify(result.body).length < 1000)
  } finally { await s.bridge.close() }
})

test('결과 캐시의 총량을 넘으면 결과를 제한하며 실패한 요청도 다시 실행하지 않는다', async () => {
  let calls = 0
  const s = await setup(async () => { calls++; return 'x'.repeat(400 * 1024) })
  try {
    const params = { name: 'pod_sessions', arguments: {} }
    for (let id = 100; id < 110; id++) assert.equal((await s.rpc('tools/call', params, id)).body.result.isError, undefined)
    const limited = await s.rpc('tools/call', params, 110)
    assert.equal(limited.body.result.isError, true)
    assert.deepEqual((await s.rpc('tools/call', params, 110)).body, limited.body)
    assert.equal(calls, 11)
  } finally { await s.bridge.close() }
})
