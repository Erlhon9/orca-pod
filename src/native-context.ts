// 공개 API에 없는 native chat의 현재 기록 식별자만 로컬 journal에서 읽는다.
// 내부 스키마가 달라지거나 읽을 수 없으면 null: 초기화 완료로 추측하지 않는다.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatSessionId } from './transcript'

export interface NativeContext {
  providerId: string | null
  boundary: string | null
}

function journalPath(): string {
  const home = homedir()
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA || join(home, 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || join(home, '.config')
  return join(base, 'orca', 'agent-session-journal.db')
}

export async function readNativeContext(key: string, path: string, file = journalPath()): Promise<NativeContext | null> {
  const id = chatSessionId(key)
  if (!id) return null
  try {
    // 동적 import: SQLite 없는 Node에서도 기존 기록 보기는 계속 동작한다.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true, allowExtension: false, timeout: 50 })
    try {
      // 대화 본문·다른 세션은 조회하지 않는다. bind로 정확한 Orca 세션만 고른다.
      const row = db.prepare(`SELECT json_extract(record_json, '$.provider') AS provider,
        json_extract(record_json, '$.location') AS location,
        json_extract(record_json, '$.providerHandleChain') AS chain,
        json_extract(record_json, '$.providerContextBoundary') AS boundary
        FROM agent_session_records WHERE session_id = ?`).get(`claude_${id.replaceAll('-', '_')}`)
      if (!row || row.provider !== 'claude' || typeof row.location !== 'string' || typeof row.chain !== 'string') return null
      const location = JSON.parse(row.location)
      if (location.executionHostId !== 'local' || location.wslDistro || typeof location.workspaceId !== 'string' || !location.workspaceId.endsWith(`::${path}`)) return null
      const chain = JSON.parse(row.chain)
      if (!Array.isArray(chain)) return null
      const head = chain.at(-1)
      const providerId = head?.handle?.sessionId
      if (head && (head.handle?.provider !== 'claude' || typeof providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(providerId))) return null
      const boundary = typeof row.boundary === 'string' ? JSON.parse(row.boundary) : null
      if (boundary && (typeof boundary.operationId !== 'string' || !boundary.operationId || boundary.operationId.length > 512 || !Number.isSafeInteger(boundary.afterFence) || boundary.afterFence < 0 || !Number.isSafeInteger(boundary.clearedAt) || boundary.clearedAt < 0)) return null
      return { providerId: providerId ?? null, boundary: boundary?.operationId ?? null }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}
