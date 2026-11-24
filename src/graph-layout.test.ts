import { assert, test } from 'orca/testing'
import { arrangeGraphTree, clearGraphPositions, graphPositionKey, readGraphPositions, graphRevealKeys, graphCamera, type GraphTreeBox } from './graph-layout'

function hierarchy(): GraphTreeBox[] {
  const boxes: GraphTreeBox[] = [{id:'repo',hw:42,hh:56}]
  for(let group=0;group<11;group++) {
    const parentId=`topic-${group}`
    boxes.push({id:parentId,parentId:'repo',hw:90,hh:28})
    for(let child=0;child<3;child++) {
      const id=`${parentId}-sub-${child}`
      boxes.push({id,parentId,hw:85,hh:22})
      for(let card=0;card<2;card++) boxes.push({id:`${id}-card-${card}`,parentId:id,hw:92,hh:45+(group%4)*24})
    }
  }
  return boxes
}

test('많은 주제·하위 주제와 높이가 다른 작업을 겹치지 않는 묶음으로 자동 정리한다',()=>{
  const boxes=hierarchy(),points=arrangeGraphTree(boxes)
  assert.equal(points.size,boxes.length)
  for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) {
    const a=boxes[i],b=boxes[j],pa=points.get(a.id)!,pb=points.get(b.id)!
    assert.ok(Math.abs(pa.x-pb.x)>=a.hw+b.hw+12 || Math.abs(pa.y-pb.y)>=a.hh+b.hh+12,`${a.id} / ${b.id}`)
  }
  for(let group=0;group<11;group++) {
    const a=points.get(`topic-${group}-sub-0-card-0`)!,b=points.get(`topic-${group}-sub-0-card-1`)!
    assert.equal(a.x,b.x)
    assert.ok(a.y<b.y)
  }
  assert.deepEqual([...arrangeGraphTree(boxes)],[...points])
})

test('여러 저장소의 전체 묶음이 겹치지 않고 수동 위치와 하위 카드의 상대 위치를 보존한다',()=>{
  const boxes=[...hierarchy(),{id:'other-repo',hw:45,hh:56},{id:'other-work',parentId:'other-repo',hw:92,hh:120}]
  const automatic=arrangeGraphTree(boxes)
  const other=automatic.get('other-work')!
  for(const box of hierarchy()) {
    const p=automatic.get(box.id)!
    assert.ok(Math.abs(p.x-other.x)>=box.hw+92+12 || Math.abs(p.y-other.y)>=box.hh+120+12)
  }
  const pinned=boxes.map(box=>box.id==='topic-0'?{...box,fixed:{x:20,y:30}}:box.id==='topic-0-sub-0-card-0'?{...box,fixed:{x:-500,y:-800}}:box)
  const arranged=arrangeGraphTree(pinned)
  assert.deepEqual(arranged.get('topic-0'),{x:20,y:30})
  assert.deepEqual(arranged.get('topic-0-sub-0-card-0'),{x:-500,y:-800})
  const child=arranged.get('topic-0-sub-0')!, oldChild=automatic.get('topic-0-sub-0')!, oldParent=automatic.get('topic-0')!
  assert.equal(child.x-20,oldChild.x-oldParent.x)
  assert.equal(child.y-30,oldChild.y-oldParent.y)
  assert.deepEqual([...arrangeGraphTree(boxes)],[...automatic])
})

test('카드 위치는 저장소 범위와 묶음별로 구분해 복원한다', () => {
  const keys = [graphPositionKey('topic', null, 'w:one'), graphPositionKey('topic', 'repo:one', 'w:one'), graphPositionKey('status', 'repo:one', 'w:one')]
  assert.equal(new Set(keys).size, 3)
  const saved = Object.fromEntries(keys.map((key, i) => [key, { x: i * 40, y: -80 }]))
  assert.deepEqual(readGraphPositions(JSON.parse(JSON.stringify(saved))), saved)
  const reset = clearGraphPositions(saved, 'topic', 'repo:one')
  assert.equal(reset[keys[1]], undefined)
  assert.deepEqual(reset[keys[0]], saved[keys[0]])
  assert.deepEqual(reset[keys[2]], saved[keys[2]])
})

test('손상되거나 유효하지 않은 좌표는 복원하지 않는다', () => {
  const key = graphPositionKey('topic', 'demo', 'w:one')
  for (const point of [{ x: NaN, y: 1 }, { x: Infinity, y: 2 }, { x: '12', y: 3 }, { x: 1e9, y: 0 }, null]) assert.deepEqual(readGraphPositions({ [key]: point }), {})
  assert.deepEqual(readGraphPositions({ invalid: { x: 1, y: 2 }, '["unknown",null,"a"]': { x: 1, y: 2 } }), {})
  assert.deepEqual(readGraphPositions([]), {})
})

test('주제 위치와 카드 위치를 함께 저장하고 현재 범위만 초기화한다', () => {
  const card = graphPositionKey('topic', 'demo', 'workspace-one')
  const hub = graphPositionKey('topic', 'demo', '@group:h:demo:design')
  const other = graphPositionKey('status', 'demo', '@group:h:demo:in-progress')
  const positions = { [card]: { x: 20, y: 40 }, [hub]: { x: -90, y: 10 }, [other]: { x: 80, y: -40 } }
  assert.deepEqual(readGraphPositions(positions), positions)
  assert.deepEqual(clearGraphPositions(positions, 'topic', 'demo'), { [other]: positions[other] })
})

test('확인할 카드 탐색은 접힌 상위 주제까지 열고 상태 보기·기타도 처리한다', () => {
  const w = { repoId: 'demo', topic: 'child', status: 'in-review' } as any
  const snap = { repos: [{ id: 'demo', topics: [{ id: 'parent' }, { id: 'child', parent: 'parent' }] }] } as any
  assert.deepEqual(graphRevealKeys(w, snap, 'topic'), ['demo:t:child', 'demo:t:parent'])
  assert.deepEqual(graphRevealKeys(w, snap, 'status'), ['demo:s:in-review'])
  assert.deepEqual(graphRevealKeys({ ...w, topic: null }, snap, 'topic'), ['demo:t:_'])
  assert.deepEqual(graphRevealKeys(w, { repos: [] } as any, 'topic'), ['demo:s:in-review'])
})

test('작은 지도에서는 전체 맞춤으로 글자를 줄이지 않고 선택한 카드를 원래 배율로 보여준다', () => {
  const area = { x: 0, y: 48, w: 550, h: 230 }
  const focus = { x: 800, y: -300 }
  const frame = graphCamera({ minX: -1200, minY: -900, maxX: 1400, maxY: 1100 }, area, focus)
  assert.equal(frame.scale, 1)
  assert.equal(frame.focused, true)
  assert.equal(focus.x * frame.scale + frame.tx, area.x + area.w / 2)
  assert.equal(focus.y * frame.scale + frame.ty, area.y + area.h / 2)
})

test('명시적 전체 보기는 축소를 허용하고 읽기 보기로 돌아오면 원래 크기를 회복한다', () => {
  const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 }
  const area = { x: 0, y: 48, w: 390, h: 260 }
  const overview = graphCamera(bounds, area, { x: 500, y: 800 }, true)
  assert.equal(overview.scale < 1, true)
  assert.equal(overview.focused, false)
  assert.equal(overview.tx, area.w / 2)
  const reading = graphCamera(bounds, area, { x: 500, y: 800 })
  assert.equal(reading.scale, 1)
  assert.equal(reading.focused, true)
})

test('충분히 넓은 화면은 전체를 표시하고 맥락 창의 남은 영역을 정확히 사용한다', () => {
  const frame = graphCamera({ minX: 0, minY: 0, maxX: 600, maxY: 400 }, { x: 440, y: 48, w: 1000, h: 700 }, { x: 100, y: 100 })
  assert.equal(frame.focused, false)
  assert.equal(frame.scale, 1.15)
  assert.equal(300 * frame.scale + frame.tx, 940)
  assert.equal(200 * frame.scale + frame.ty, 398)
})
