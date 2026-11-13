// 터미널 세션의 대화 기록 고르기: 첫 요청 전 세션이나 다른 세션 기록을 잘못 끌어오지 않는다.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { pickFallback, readConversation } from './conversation'
import { claudeProjectDir } from './transcript'

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
