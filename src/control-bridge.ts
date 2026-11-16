// Private, worker-owned MCP transport. It never accepts commands or file paths.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { RELAY_TOOLS } from './relay'

const MAX_BODY = 64 * 1024
const MAX_RESULT = 512 * 1024
const MAX_CACHED_RESULT = 4 * 1024 * 1024
const PROTOCOLS = new Set(['2025-03-26', '2025-06-18', '2025-11-25'])

export interface ControlBridge {
  config: { mcpServers: { pod: { type: 'http'; url: string; headers: { Authorization: string } } } }
  close(): Promise<void>
  revokeSessions(): void
}

export async function createControlBridge(tool: (name: string, input: unknown, active: () => boolean) => Promise<unknown>): Promise<ControlBridge> {
  const secret = randomBytes(32).toString('hex')
  const expectedAuth = Buffer.from(`Bearer ${secret}`)
  const sessions = new Map<string, { bytes: number; requests: Map<string, { signature: string; result: Promise<unknown> }> }>()
  let closed = false
  let port = 0
  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent) reply(res, 400, rpcError(null, -32600, 'Invalid request'))
    else res.destroy()
  }) })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Native clients omit Origin. Browser-origin requests are never accepted.
    if (closed || req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port}`) return reply(res, 403)
    const auth = Buffer.from(req.headers.authorization ?? '')
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) return reply(res, 401)
    if (req.url !== '/mcp') return reply(res, 404)
    if (req.method === 'GET') { res.setHeader('Allow', 'POST, DELETE'); return reply(res, 405) }
    const sessionId = req.headers['mcp-session-id']
    if (req.method === 'DELETE') {
      if (typeof sessionId !== 'string' || !sessions.delete(sessionId)) return reply(res, 404)
      return reply(res, 200)
    }
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res, 415)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY) { reply(res, 413); req.destroy(); return }
      chunks.push(chunk)
    }
    let message: any
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return reply(res, 400, rpcError(null, -32700, 'Invalid JSON')) }
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return reply(res, 400, rpcError(null, -32600, 'Invalid request'))
    const id = message.id
    if (id !== undefined && typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) return reply(res, 400, rpcError(null, -32600, 'Invalid id'))
    if (message.method === 'initialize') {
      if (id === undefined || sessions.size >= 16) return reply(res, 400, rpcError(id ?? null, -32600, 'Session limit reached'))
      const next = randomBytes(32).toString('hex')
      sessions.set(next, { bytes: 0, requests: new Map() })
      res.setHeader('Mcp-Session-Id', next)
      return reply(res, 200, { jsonrpc: '2.0', id, result: {
        protocolVersion: PROTOCOLS.has(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} }, serverInfo: { name: 'pod-control', version: '1.0.0' }
      } })
    }
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) return reply(res, 404)
    if (id === undefined) return reply(res, message.method === 'notifications/initialized' ? 202 : 400)
    if (message.method === 'ping') return reply(res, 200, { jsonrpc: '2.0', id, result: {} })
    if (message.method === 'tools/list') return reply(res, 200, { jsonrpc: '2.0', id, result: { tools: RELAY_TOOLS.map(({ type, ...item }) => item) } })
    if (message.method !== 'tools/call') return reply(res, 200, rpcError(id, -32601, 'Unknown method'))
    const name = message.params?.name
    if (!RELAY_TOOLS.some(item => item.name === name)) return reply(res, 200, rpcError(id, -32602, 'Unknown tool'))
    const session = sessions.get(sessionId)!
    const cache = session.requests
    const key = JSON.stringify(id)
    const signature = JSON.stringify(message.params)
    const previous = cache.get(key)
    if (previous && previous.signature !== signature) return reply(res, 200, rpcError(id, -32600, 'Request id already used'))
    if (!previous && cache.size >= 1024) return reply(res, 200, rpcError(id, -32000, 'Session request limit reached'))
    const execute = async () => {
      try {
        if (closed) throw new Error('Control bridge is closed')
        const text = JSON.stringify(await tool(name, message.params.arguments ?? {}, () => !closed && sessions.has(sessionId))) ?? 'null'
        const bytes = Buffer.byteLength(text)
        if (bytes > MAX_RESULT || session.bytes + bytes > MAX_CACHED_RESULT) throw new Error('Tool result is too large')
        session.bytes += bytes
        return { content: [{ type: 'text', text }] }
      } catch {
        // Details can contain local paths or tokens. Receipts are returned only on success.
        return { isError: true, content: [{ type: 'text', text: 'The operation failed or its result is uncertain. Do not automatically retry a send. Ask the user to check the target in Orca.' }] }
      }
    }
    if (!previous) cache.set(key, { signature, result: execute() })
    return reply(res, 200, { jsonrpc: '2.0', id, result: await cache.get(key)!.result })
  }

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as { port: number }).port
  server.unref()
  return {
    config: { mcpServers: { pod: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${secret}` } } } },
    revokeSessions: () => sessions.clear(),
    async close() {
      if (closed) return
      closed = true
      sessions.clear()
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  }
}
