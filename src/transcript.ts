// Claude Code 대화 기록(~/.claude/projects/<경로>/<세션>.jsonl)을 대화창에 그릴 항목으로 바꾼다.
// 워커와 테스트가 같이 쓰므로 Node·DOM 의존 없이 순수 함수로 둔다.
import { readQuestions, type SessionQuestion } from './questions'

export type ChatItem = (
  | { k: 'user'; text: string; at: number; images: number }
  | { k: 'text'; text: string; at: number }
  | { k: 'tool'; id: string; name: string; detail: string; at: number; error: boolean; questions?: SessionQuestion[]; resolved?: boolean }
  | { k: 'note'; text: string; at: number }
) & { requestId?: string; controlKind?: 'watch' }

type Json = Record<string, any>

/** Claude Code 가 작업 디렉토리로 기록 폴더 이름을 만드는 방식(영숫자 밖은 모두 '-'). */
export function claudeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Orca 대화창 세션 키에서 Claude 세션 id 를 꺼낸다. */
export function chatSessionId(paneKey: string): string | null {
  const m = /^structured-agent-session-claude_([0-9a-f_]{36})/.exec(paneKey)
  return m ? m[1].replace(/_/g, '-') : null
}

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

function oneLine(v: unknown, max = 160): string {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** 도구 호출을 한 줄로 줄인다. */
export function toolDetail(name: string, input: Json | undefined): string {
  const i = input ?? {}
  switch (name) {
    case 'Bash':
      return oneLine(i.description) || oneLine(i.command)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(String(i.file_path ?? i.notebook_path ?? ''))
    case 'Grep':
    case 'Glob':
      return oneLine(i.pattern)
    case 'Agent':
    case 'Task':
      return oneLine(i.description)
    case 'Skill':
      return oneLine(i.skill)
    case 'AskUserQuestion':
      return oneLine(readQuestions(i).map(q => q.question).join(' / '))
    case 'WebFetch':
      return oneLine(i.url)
    case 'WebSearch':
      return oneLine(i.query)
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `할 일 ${i.todos.length}개` : ''
  }
  for (const v of Object.values(i)) if (typeof v === 'string' && v.trim()) return oneLine(v)
  return ''
}

const COMMAND = /<command-name>([^<]*)<\/command-name>/

/** 사람이 친 말에서 시스템이 끼워 넣은 블록을 걷어 낸다. */
function cleanUserText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .trim()
}

/** jsonl 한 줄을 0개 이상의 항목으로 바꾼다. */
export function parseLine(o: Json): ChatItem[] {
  if (!o || o.isSidechain) return []
  const at = Date.parse(o.timestamp ?? '') || 0
  const msg = o.message
  if (o.type === 'user' && msg) {
    if (o.isCompactSummary) return [{ k: 'note', text: '컨텍스트 압축됨', at }]
    if (o.isMeta) return []
    const content = msg.content
    if (typeof content === 'string') return userText(content, at, 0)
    if (!Array.isArray(content)) return []
    const texts = content.filter((c: Json) => c?.type === 'text').map((c: Json) => String(c.text ?? ''))
    const images = content.filter((c: Json) => c?.type === 'image').length
    if (texts.length || images) return userText(texts.join('\n'), at, images)
    // 도구 결과는 앞의 도구 호출에 실패 여부만 붙인다(아래 applyResults).
    return []
  }
  if (o.type === 'assistant' && Array.isArray(msg?.content)) {
    const out: ChatItem[] = []
    for (const c of msg.content as Json[]) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) out.push({ k: 'text', text: String(c.text).trim(), at })
      else if (c?.type === 'tool_use') {
        const questions = c.name === 'AskUserQuestion' ? readQuestions(c.input) : []
        out.push({ k: 'tool', id: String(c.id ?? ''), name: String(c.name ?? '도구'), detail: toolDetail(String(c.name ?? ''), c.input), at, error: false, ...(questions.length ? { questions } : {}) })
      }
    }
    return out
  }
  return []
}

function userText(raw: string, at: number, images: number): ChatItem[] {
  const cmd = COMMAND.exec(raw)
  if (cmd) return [{ k: 'note', text: cmd[1].trim(), at }]
  if (/^<(local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)/.test(raw.trim())) return []
  const pics = takeAttachments(cleanUserText(raw))
  const text = pics.text
  images += pics.count
  if (/^\[Request interrupted by user/.test(text)) return [{ k: 'note', text: '사용자가 중단함', at }]
  if (!text && !images) return []
  return [{ k: 'user', text, at, images }]
}

/** Pod 입력창에서 붙인 사진은 임시 경로로 지시 앞에 붙는다. 대화 보기에서는 경로 대신 사진 수로 보인다. */
const ATTACHED = /^(?:\S*\/pod-attachments\/[\w.-]+\.(?:png|jpg|gif|webp)\s*)+/

export function takeAttachments(text: string): { text: string; count: number } {
  const m = ATTACHED.exec(text)
  if (!m) return { text, count: 0 }
  return { text: text.slice(m[0].length).trim(), count: m[0].trim().split(/\s+/).length }
}

/** 실패한 도구 결과 id 를 모은다. */
export function failedToolIds(o: Json): string[] {
  if (o?.type !== 'user' || !Array.isArray(o.message?.content)) return []
  return (o.message.content as Json[]).filter((c) => c?.type === 'tool_result' && c.is_error === true).map((c) => String(c.tool_use_id ?? ''))
}

/** 이어 읽기용 상태. 파일이 자라면 새로 붙은 부분만 읽는다. */
export interface TranscriptState {
  items: ChatItem[]
  rest: string
  /** 사용자가 붙인 제목(있으면 우선)과 자동 제목. */
  customTitle: string
  aiTitle: string
}

export function emptyState(): TranscriptState {
  return { items: [], rest: '', customTitle: '', aiTitle: '' }
}

const KEEP = 600

/** 새로 읽은 텍스트를 상태에 덧붙인다. 마지막 줄이 덜 쓰였으면 다음 번으로 넘긴다. */
export function feed(state: TranscriptState, chunk: string): TranscriptState {
  const lines = (state.rest + chunk).split('\n')
  const rest = lines.pop() ?? ''
  const items = state.items
  let { customTitle, aiTitle } = state
  const byId = new Map<string, ChatItem>()
  for (const it of items.slice(-80)) if (it.k === 'tool') byId.set(it.id, it)
  for (const line of lines) {
    if (!line.trim()) continue
    let o: Json
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'custom-title' && o.customTitle) customTitle = String(o.customTitle)
    else if (o.type === 'ai-title' && o.aiTitle) aiTitle = String(o.aiTitle)
    for (const id of failedToolIds(o)) {
      const t = byId.get(id)
      if (t && t.k === 'tool') t.error = true
    }
    if (o.type === 'user' && Array.isArray(o.message?.content)) for (const result of o.message.content) {
      if (result?.type !== 'tool_result') continue
      const tool = byId.get(String(result.tool_use_id ?? ''))
      if (tool?.k === 'tool' && tool.questions) tool.resolved = true
    }
    for (const it of parseLine(o)) {
      items.push(it)
      if (it.k === 'tool') byId.set(it.id, it)
    }
  }
  if (items.length > KEEP) items.splice(0, items.length - KEEP)
  return { items, rest, customTitle, aiTitle }
}
