// 세션의 Claude 대화 기록 파일을 찾아 이어 읽는다. 파일이 자라면 새로 붙은 줄만 읽는다.
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { chatSessionId, claudeProjectDir, emptyState, feed, type ChatItem, type TranscriptState } from './transcript'

export interface ConversationQuery {
  path: string
  key: string
  type: string
  title?: string
  prompt?: string
  /** 세션이 지금 상태로 들어간 시각. 제목으로 못 찾을 때 이보다 오래된 기록은 고르지 않는다. */
  since?: number
  /** 같은 워크스페이스의 다른 세션 키. 그 세션의 기록은 이 세션 것으로 고르지 않는다. */
  others?: string[]
}

export interface Conversation {
  ok: boolean
  items: ChatItem[]
  /** 앞부분을 건너뛰고 읽었으면 true. */
  truncated: boolean
  updatedAt: number
}

/** 기록 폴더. 테스트가 HOME 을 바꿔 쓸 수 있게 부를 때마다 구한다. */
const root = () => join(homedir(), '.claude', 'projects')
/** 처음 열 때 읽는 최대 크기. 그보다 크면 끝부분만 읽는다. */
const FIRST_READ = 6 * 1024 * 1024
const SEND = 240

interface Open {
  offset: number
  state: TranscriptState
  truncated: boolean
  mtime: number
}

const files = new Map<string, Open>()
const located = new Map<string, { file: string; at: number }>()

async function readRange(file: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

const exists = (p: string) =>
  stat(p).then(
    (s) => s,
    () => null
  )

/** 대화창(채팅) 세션은 키에 세션 id 가 들어 있다. 폴더를 모르면 전체에서 찾는다. */
async function byId(id: string, path: string): Promise<string | null> {
  const ROOT = root()
  const direct = join(ROOT, claudeProjectDir(path), `${id}.jsonl`)
  if (await exists(direct)) return direct
  for (const dir of await readdir(ROOT).catch(() => [] as string[])) {
    const p = join(ROOT, dir, `${id}.jsonl`)
    if (await exists(p)) return p
  }
  return null
}

/**
 * 제목·요청으로 못 찾았을 때 가장 최근 기록을 쓸지 정한다.
 * 첫 요청 전 세션은 기록이 아직 없으므로 고르지 않는다(고르면 같은 폴더 다른 세션의 대화가 보인다).
 * 다른 세션 것으로 알려진 기록, 이 세션보다 오래된 기록도 고르지 않는다.
 */
export function pickFallback(
  recent: { file: string; mtimeMs: number }[],
  q: Pick<ConversationQuery, 'prompt' | 'since'>,
  taken: (file: string) => boolean
): string | null {
  if (!q.prompt) return null
  const newest = recent[0]
  if (!newest || taken(newest.file)) return null
  if (q.since && newest.mtimeMs < q.since - 60_000) return null
  return newest.file
}

/** 다른 세션의 기록인지: 대화창 세션은 키에 세션 id 가 있고, 이미 다른 세션에 짝지은 파일도 있다. */
function takenBy(q: ConversationQuery): (file: string) => boolean {
  const ids = new Set((q.others ?? []).map((k) => chatSessionId(k)).filter((x): x is string => !!x))
  return (file) => {
    if (ids.has(basename(file, '.jsonl'))) return true
    for (const [key, hit] of located) if (key !== q.key && hit.file === file) return true
    return false
  }
}

/**
 * 워크스페이스 폴더의 최근 기록 중 제목(또는 첫 요청)이 맞는 것.
 * strict 면 맞는 것이 없을 때 최근 기록으로 대신하지 않는다.
 */
async function byTitle(q: ConversationQuery, strict = false): Promise<string | null> {
  const dir = join(root(), claudeProjectDir(q.path))
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'))
  const withTime = (
    await Promise.all(names.map(async (n) => ({ file: join(dir, n), st: await exists(join(dir, n)) })))
  ).filter((x): x is { file: string; st: NonNullable<typeof x.st> } => x.st !== null)
  withTime.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
  const recent = withTime.slice(0, 15)
  if (recent.length === 0) return null
  const taken = takenBy(q)
  const needles: string[] = []
  if (q.title) {
    const t = JSON.stringify(q.title)
    needles.push(`"customTitle":${t}`, `"aiTitle":${t}`)
  }
  if (q.prompt) needles.push(JSON.stringify(q.prompt.slice(0, 60)).slice(0, -1))
  if (needles.length) {
    for (const { file, st } of recent) {
      if (taken(file)) continue
      const tail = (await readRange(file, Math.max(0, st.size - 768 * 1024), st.size)).toString('utf8')
      if (needles.some((n) => tail.includes(n))) return file
    }
  }
  if (strict) return null
  return pickFallback(
    recent.map((r) => ({ file: r.file, mtimeMs: r.st.mtimeMs })),
    q,
    taken
  )
}

async function locate(q: ConversationQuery): Promise<string | null> {
  const hit = located.get(q.key)
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.file
  // 대화창 세션 키의 id 는 Orca 세션 id 라 Claude 기록 id 와 다를 수 있다(확인: Orca 기록의 providerHandleChain).
  // 같은 이름 파일이 없으면 제목·첫 요청으로 찾되, 아무 최근 기록으로 대신하지는 않는다.
  const id = chatSessionId(q.key)
  const file = id ? ((await byId(id, q.path)) ?? (await byTitle(q, true))) : await byTitle(q)
  if (file) located.set(q.key, { file, at: Date.now() })
  return file
}

/** 같은 파일을 두 요청이 동시에 이어 읽으면 같은 줄이 두 번 쌓인다. 파일마다 차례로 읽는다. */
const locks = new Map<string, Promise<unknown>>()
function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(run, run)
  locks.set(
    key,
    next.catch(() => {})
  )
  return next
}

export async function readConversation(q: ConversationQuery): Promise<Conversation> {
  const none: Conversation = { ok: false, items: [], truncated: false, updatedAt: 0 }
  if (q.type !== 'claude') return none
  const file = await locate(q)
  if (!file) return none
  return serial(file, () => readFile(file, none))
}

async function readFile(file: string, none: Conversation): Promise<Conversation> {
  const st = await exists(file)
  if (!st) return none
  let cur = files.get(file)
  if (!cur || st.size < cur.offset) {
    const from = Math.max(0, st.size - FIRST_READ)
    cur = { offset: from, state: emptyState(), truncated: from > 0, mtime: 0 }
    files.set(file, cur)
  }
  if (st.size > cur.offset) {
    const buf = await readRange(file, cur.offset, st.size)
    // 끝까지 다 쓴 줄만 읽는다(여러 바이트 글자가 잘리지 않게).
    const end = buf.lastIndexOf(0x0a) + 1
    let start = 0
    if (cur.truncated && cur.offset > 0 && cur.state.items.length === 0 && cur.mtime === 0) start = buf.indexOf(0x0a) + 1
    if (end > start) {
      cur.state = feed(cur.state, buf.subarray(start, end).toString('utf8'))
      cur.offset += end
    }
  }
  cur.mtime = st.mtimeMs
  return { ok: true, items: cur.state.items.slice(-SEND), truncated: cur.truncated || cur.state.items.length > SEND, updatedAt: st.mtimeMs }
}

/** 세션 id 로 기록을 읽는다(관제처럼 id 를 아는 세션). */
export async function readSession(id: string, path: string): Promise<Conversation> {
  const none: Conversation = { ok: false, items: [], truncated: false, updatedAt: 0 }
  const file = await byId(id, path)
  if (!file) return none
  return serial(file, () => readFile(file, none))
}
