export interface GraphPoint { x: number; y: number }
export type GraphPositions = Record<string, GraphPoint>

/** 전체/개별 저장소와 주제/상태 배치는 각각 보관한다. */
export function graphPositionKey(mode: 'topic' | 'status', repo: string | null, id: string): string {
  return JSON.stringify([mode, repo, id])
}

/** 저장 데이터가 잘못돼도 카드가 무한대나 NaN 좌표로 사라지지 않게 한다. */
export function readGraphPositions(value: unknown): GraphPositions {
  const out: GraphPositions = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, point] of Object.entries(value).slice(0, 5000)) {
    try {
      const parts = JSON.parse(key)
      if (!Array.isArray(parts) || parts.length !== 3 || !['topic', 'status'].includes(parts[0]) || !(parts[1] === null || typeof parts[1] === 'string') || typeof parts[2] !== 'string') continue
      if (!point || typeof point !== 'object') continue
      const { x, y } = point as GraphPoint
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000) out[graphPositionKey(parts[0], parts[1], parts[2])] = { x, y }
    } catch { /* 알 수 없는 저장 형식은 건너뛴다. */ }
  }
  return out
}

export function clearGraphPositions(positions: GraphPositions, mode: 'topic' | 'status', repo: string | null): GraphPositions {
  const prefix = JSON.stringify([mode, repo]).slice(0, -1) + ','
  return Object.fromEntries(Object.entries(positions).filter(([key]) => !key.startsWith(prefix)))
}
