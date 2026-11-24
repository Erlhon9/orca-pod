import type { Snapshot, WorkspaceView } from './model'

export interface GraphPoint { x: number; y: number }
export type GraphPositions = Record<string, GraphPoint>

export interface GraphArea { x: number; y: number; w: number; h: number }
export interface GraphBounds { minX: number; minY: number; maxX: number; maxY: number }

export interface GraphTreeBox {
  id: string
  parentId?: string | null
  hw: number
  hh: number
  fixed?: GraphPoint
}

/** 하위 묶음의 실제 크기로 공간을 예약한다. 저장소 양쪽으로 가지를 나눠 카드와 주제가 섞이지 않게 한다. */
export function arrangeGraphTree(boxes: GraphTreeBox[]): Map<string, GraphPoint> {
  const byId = new Map(boxes.map(box => [box.id, box]))
  const children = new Map<string, GraphTreeBox[]>()
  const roots: GraphTreeBox[] = []
  for (const box of boxes) {
    if (box.parentId && box.parentId !== box.id && byId.has(box.parentId)) children.set(box.parentId, [...(children.get(box.parentId) ?? []), box])
    else roots.push(box)
  }
  type Branch = { box: GraphTreeBox; kids: Branch[]; height: number }
  const measured = new Set<string>()
  const measure = (box: GraphTreeBox): Branch => {
    measured.add(box.id)
    const kids = (children.get(box.id) ?? []).filter(child => !measured.has(child.id)).map(measure)
    return { box, kids, height:Math.max(box.hh*2, kids.reduce((sum,k)=>sum+k.height,0) + Math.max(0,kids.length-1)*24) }
  }
  const components: {points:Map<string,GraphPoint>; bounds:GraphBounds}[] = []
  const addComponent = (root: GraphTreeBox) => {
    const tree = measure(root)
    const points = new Map<string,GraphPoint>([[root.id,{x:0,y:0}]])
    const place = (branch:Branch, x:number, y:number, direction:number) => {
      points.set(branch.box.id,{x,y})
      const height = branch.kids.reduce((sum,k)=>sum+k.height,0) + Math.max(0,branch.kids.length-1)*24
      let top = y-height/2
      for (const child of branch.kids) {
        place(child,x+direction*(branch.box.hw+72+child.box.hw),top+child.height/2,direction)
        top += child.height+24
      }
    }
    const sides:Branch[][] = [[],[]]
    const heights = [0,0]
    for (const child of tree.kids) {
      const side = heights[0] <= heights[1] ? 0 : 1
      sides[side].push(child)
      heights[side] += child.height+48
    }
    sides.forEach((side,index)=>{
      let top = -(heights[index]-(side.length?48:0))/2
      for (const branch of side) {
        place(branch,(index===0?1:-1)*(root.hw+96+branch.box.hw),top+branch.height/2,index===0?1:-1)
        top += branch.height+48
      }
    })
    const bounds = {minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity}
    for (const [id,p] of points) {
      const box=byId.get(id)!
      bounds.minX=Math.min(bounds.minX,p.x-box.hw);bounds.maxX=Math.max(bounds.maxX,p.x+box.hw)
      bounds.minY=Math.min(bounds.minY,p.y-box.hh);bounds.maxY=Math.max(bounds.maxY,p.y+box.hh)
    }
    components.push({points,bounds})
  }
  for (const root of roots) if (!measured.has(root.id)) addComponent(root)
  // 기존 데이터의 부모 경로가 순환해도 모든 노드를 유한 시간 안에 배치한다.
  for (const box of boxes) if (!measured.has(box.id)) addComponent(box)
  const result = new Map<string,GraphPoint>()
  const columns = Math.max(1,Math.ceil(Math.sqrt(components.length)))
  const widths = Array.from({length:columns},()=>0)
  const heights = Array.from({length:Math.ceil(components.length/columns)},()=>0)
  components.forEach(({bounds},i)=>{
    widths[i%columns]=Math.max(widths[i%columns],bounds.maxX-bounds.minX)
    heights[Math.floor(i/columns)]=Math.max(heights[Math.floor(i/columns)],bounds.maxY-bounds.minY)
  })
  components.forEach(({points,bounds},i)=>{
    const x=widths.slice(0,i%columns).reduce((sum,n)=>sum+n+160,0)-bounds.minX
    const y=heights.slice(0,Math.floor(i/columns)).reduce((sum,n)=>sum+n+160,0)-bounds.minY
    for(const [id,p] of points) result.set(id,{x:p.x+x,y:p.y+y})
  })
  const automatic = new Map(result)
  for (const box of boxes) {
    let ancestor:GraphTreeBox|undefined=box
    const seen=new Set<string>()
    while(ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id)
      if(ancestor.fixed) {
        const home=automatic.get(ancestor.id)!, point=automatic.get(box.id)!
        result.set(box.id,{x:point.x+ancestor.fixed.x-home.x,y:point.y+ancestor.fixed.y-home.y})
        break
      }
      ancestor=ancestor.parentId?byId.get(ancestor.parentId):undefined
    }
  }
  return result
}

/** 자동 보기는 카드의 원래 글자 크기를 지킨다. 전체 맞춤 축소는 명시적인 전체 보기에서만 한다. */
export function graphCamera(bounds: GraphBounds, area: GraphArea, focus: GraphPoint | null, overview = false): { scale: number; tx: number; ty: number; focused: boolean } {
  const fit = Math.max(0.2, Math.min((Math.max(1, area.w) - 48) / Math.max(1, bounds.maxX - bounds.minX), (Math.max(1, area.h) - 48) / Math.max(1, bounds.maxY - bounds.minY), 1.15))
  const focused = !overview && fit < 1
  const scale = focused ? 1 : fit
  const center = focused && focus ? focus : { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  return { scale, tx: area.x + area.w / 2 - center.x * scale, ty: area.y + area.h / 2 - center.y * scale, focused }
}

/** 지도 탐색으로 숨겨진 카드를 찾을 때 그 카드의 주제와 상위 주제를 함께 연다. */
export function graphRevealKeys(w: WorkspaceView, snap: Snapshot, groupBy: 'topic' | 'status'): string[] {
  const repo = snap.repos.find(r => r.id === w.repoId)
  if (groupBy === 'status' || !repo?.topics.length) return [`${w.repoId}:s:${w.status}`]
  const keys: string[] = []
  const seen = new Set<string>()
  let id: string | undefined = w.topic ?? '_'
  while (id && !seen.has(id) && keys.length < 6) {
    seen.add(id)
    keys.push(`${w.repoId}:t:${id}`)
    id = repo.topics.find(t => t.id === id)?.parent
  }
  return keys
}

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
