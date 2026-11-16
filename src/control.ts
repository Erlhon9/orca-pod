// Control configuration and native-terminal snapshots. Embedded agents receive only worker-owned tools.
import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { topicPath, type Snapshot } from './model'
import { isControlProvider } from './control-agents'
import { CODEX_CONTROL_PROMPT, RELAY_TOOLS } from './relay'

export const CONTROL_DIR = join(tmpdir(), 'pod-control')
export const CONTROL_TITLE = '관제'

export interface ControlMap {
  updatedAt: number
  /** 보내기를 허용하는 에이전트(Claude·Codex) 터미널 핸들. 셸에는 보내지 않는다. */
  agentTerminals: string[]
  workspaces: {
    repo: string
    workspace: string
    topic: string | null
    path: string
    status: string
    sessions: { key: string; address: string | null; title: string; type: string; state: string; surface: string; terminal: string | null; lastMessage: string }[]
  }[]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** 스냅샷 → 관제가 읽는 세션 지도. 끝난 세션은 빼고, 세션이 없는 워크스페이스도 뺀다. */
export function controlMap(snap: Snapshot, self: string | null = null): ControlMap {
  const agentTerminals: string[] = []
  const workspaces: ControlMap['workspaces'] = []
  for (const repo of snap.repos) {
    for (const id of repo.workspaceIds) {
      const w = snap.workspaces[id]
      if (!w) continue
      const live = w.agents.filter((a) => a.state !== 'done' && isControlProvider(a.type) && (!self || a.terminal !== self))
      for (const a of live) if (a.terminal) agentTerminals.push(a.terminal)
      if (!live.length) continue
      workspaces.push({
        repo: repo.name,
        workspace: w.name,
        topic: w.topic ? topicPath(repo.topics, w.topic) || null : null,
        path: w.path,
        status: w.status,
        sessions: live.map((a) => ({
          key: a.key,
          address: a.surface === 'chat' && a.key.startsWith('structured-agent-session-') ? `orca_session_id:${a.key.slice('structured-agent-session-'.length).split(':')[0]}` : null,
          title: a.title,
          type: a.type,
          state: a.state,
          surface: a.surface,
          terminal: a.terminal,
          lastMessage: clip(a.lastMessage || '', 160)
        }))
      })
    }
  }
  return { updatedAt: snap.at, agentTerminals, workspaces }
}

/** Embedded Claude uses the same worker-validated tools as embedded Codex. */
export function controlPrompt(_dir: string): string {
  return CODEX_CONTROL_PROMPT
}

export function controlArgs(dir: string): string[] {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--name', CONTROL_TITLE,
    '--restricted', '--permission-mode', 'dontAsk', '--tools=',
    '--disable-slash-commands',
    '--allowedTools', ...RELAY_TOOLS.map(tool => `mcp__pod__${tool.name}`),
    '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'),
    '--setting-sources=', '--settings', join(dir, 'settings.json'),
    '--append-system-prompt-file', join(dir, 'prompt.md')
  ]
}

/** Private directory: reject a symlink or a directory owned by another user. */
async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const st = await lstat(dir)
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) throw new Error('Invalid Control directory')
  await chmod(dir, 0o700)
}

/** Replace files atomically; an existing symlink is never followed by writeFile. */
async function privateFile(dir: string, name: string, body: string): Promise<void> {
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, body, { mode: 0o600, flag: 'wx' })
    await rename(temp, join(dir, name))
  } finally { await unlink(temp).catch(() => {}) }
}

export async function writeControlFiles(dir: string, snap: Snapshot | null, self: string | null, mcp: unknown = { mcpServers: {} }): Promise<void> {
  await privateDirectory(dir)
  await Promise.all([
    privateFile(dir, 'settings.json', JSON.stringify({ permissions: { defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable' } })),
    privateFile(dir, 'mcp.json', JSON.stringify(mcp)),
    privateFile(dir, 'prompt.md', controlPrompt(dir)),
    snap ? writeControlMap(dir, snap, self) : Promise.resolve()
  ])
}

/** Native terminal Control reads this snapshot. It contains no credentials. */
const mapCache = new Map<string, string>()
export async function writeControlMap(dir: string, snap: Snapshot, self: string | null, force = false): Promise<void> {
  await privateDirectory(dir)
  const body = JSON.stringify(controlMap(snap, self))
  const signature = body.replace(/"updatedAt":\d+,/, '')
  if (!force && mapCache.get(dir) === signature) return
  await privateFile(dir, 'map.json', body)
  mapCache.set(dir, signature)
}
