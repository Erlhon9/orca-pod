// 터미널 세션의 대화 기록 고르기: 첫 요청 전 세션이나 다른 세션 기록을 잘못 끌어오지 않는다.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { pickFallback, readConversation } from './conversation'
import { claudeProjectDir } from './transcript'
import { readNativeContext } from './native-context'
import { DatabaseSync } from 'node:sqlite'

const now = Date.now()
const recent = [
  { file: '/p/other-session.jsonl', mtimeMs: now },
  { file: '/p/older.jsonl', mtimeMs: now - 3600_000 }
]
const free = () => false

test('첫 요청 전 세션은 같은 폴더의 최근 기록을 고르지 않는다', () => {
  assert.equal(pickFallback(recent, { prompt: '', since: now - 1000 }, free), null)
  assert.equal(pickFallback(recent, { since: now - 1000 }, free), null)
})

test('native /clear 경계는 캐시된 기록을 비우고 새 provider 기록만 읽는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pod-clear-'))
  const previous = process.env.HOME
  process.env.HOME = home
  const file = join(home, 'journal.db')
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)')
    const path = '/w/clear-demo'
    const key = 'structured-agent-session-claude_12345678_bbbb_cccc_dddd_eeeeeeeeeeee:x'
    const session = 'claude_12345678_bbbb_cccc_dddd_eeeeeeeeeeee'
    const dir = join(home, '.claude', 'projects', claudeProjectDir(path))
    await mkdir(dir, { recursive: true })
    const oldId = '11111111-1111-1111-1111-111111111111'
    const newId = '22222222-2222-2222-2222-222222222222'
    const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n'
    await writeFile(join(dir, `${oldId}.jsonl`), user('Old fictional request'))
    const query = { path, key, type: 'claude', prompt: 'Old fictional request' }
    // 먼저 기존 제목 검색의 10분 파일 캐시를 채운다.
    assert.equal((await readConversation(query, async () => null)).items.length, 1)
    const record: any = { provider: 'claude', location: { executionHostId: 'local', workspaceId: `repo::${path}` }, providerHandleChain: [] }
    const save = () => db.prepare('INSERT OR REPLACE INTO agent_session_records VALUES (?, ?)').run(session, JSON.stringify(record))
    const native = (key: string, path: string) => readNativeContext(key, path, file)
    record.providerContextBoundary = { operationId: 'clear-one', afterFence: 4, clearedAt: Date.now() }
    save()
    const cleared = await readConversation(query, native)
    assert.equal(cleared.ok, true)
    assert.equal(cleared.context, 'clear-one')
    assert.deepEqual(cleared.items, [])
    // 일시 읽기 실패도 이전 세대의 제목 검색으로 돌아가지 않는다.
    assert.deepEqual((await readConversation(query, async () => null)).items, [])
    record.providerHandleChain = [{ handle: { provider: 'claude', sessionId: newId } }]
    save()
    assert.deepEqual((await readConversation(query, native)).items, [])
    await writeFile(join(dir, `${newId}.jsonl`), user('New fictional request'))
    const fresh = await readConversation(query, native)
    assert.equal(fresh.context, 'clear-one')
    assert.deepEqual(fresh.items.map(i => i.k === 'user' ? i.text : ''), ['New fictional request'])
    record.providerHandleChain = []
    record.providerContextBoundary.operationId = 'clear-two'
    save()
    assert.equal((await readConversation(query, native)).context, 'clear-two')
    assert.deepEqual((await readConversation(query, native)).items, [])
    // 다른 작업공간/원격 호스트/알 수 없는 스키마를 초기화 완료로 취급하지 않는다.
    assert.equal(await readNativeContext(key, '/w/other', file), null)
    record.location.executionHostId = 'remote'
    save()
    assert.equal(await native(key, path), null)
    record.location.executionHostId = 'local'
    record.providerContextBoundary.afterFence = 'unknown'
    save()
    assert.equal(await native(key, path), null)
    assert.equal(await readNativeContext(key, path, join(home, 'absent.db')), null)
    assert.equal(await stat(join(home, 'absent.db')).then(() => true, () => false), false)
  } finally {
    db.close()
    process.env.HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})

test('다른 세션 것으로 알려진 기록은 고르지 않는다', () => {
  assert.equal(pickFallback(recent, { prompt: '안녕', since: now - 1000 }, (f) => f === '/p/other-session.jsonl'), null)
})

test('요청이 있고 이 세션 이후에 쓰인 기록이면 최근 기록을 쓴다', () => {
  assert.equal(pickFallback(recent, { prompt: '안녕', since: now - 1000 }, free), '/p/other-session.jsonl')
})

test('이 세션보다 오래된 기록은 쓰지 않는다', () => {
  assert.equal(pickFallback(recent, { prompt: '안녕', since: now + 3600_000 }, free), null)
})

test('대화창 세션 키의 id 로 된 기록이 없으면 첫 요청으로 찾고, 못 찾으면 아무 기록이나 쓰지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pod-home-'))
  const prev = process.env.HOME
  process.env.HOME = home
  try {
    const path = '/w/proj'
    const dir = join(home, '.claude', 'projects', claudeProjectDir(path))
    await mkdir(dir, { recursive: true })
    const user = (text: string) => `${JSON.stringify({ type: 'user', timestamp: '2026-11-13T01:00:00.000Z', message: { content: text } })}\n`
    // Orca 세션 id(aaaaaaaa-…)와 Claude 기록 id(1111…)가 다르다.
    await writeFile(join(dir, '11111111-2222-3333-4444-555555555555.jsonl'), user('고쳐줘 이거'))
    await writeFile(join(dir, '99999999-2222-3333-4444-555555555555.jsonl'), user('다른 세션 일'))
    const key = (c: string) => `structured-agent-session-claude_${c.repeat(8)}_bbbb_cccc_dddd_eeeeeeeeeeee:x`
    const hit = await readConversation({ path, key: key('a'), type: 'claude', title: 'Orca 가 붙인 이름', prompt: '고쳐줘 이거' })
    assert.equal(hit.ok, true)
    assert.deepEqual(hit.items.map((i) => (i.k === 'user' ? i.text : '')), ['고쳐줘 이거'])
    const miss = await readConversation({ path, key: key('c'), type: 'claude', title: '없는 이름', prompt: '없는 요청', since: Date.now() })
    assert.equal(miss.ok, false)
  } finally {
    process.env.HOME = prev
    await rm(home, { recursive: true, force: true })
  }
})
