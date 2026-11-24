import { assert, test } from 'orca/testing'
import { controlDock, readControlPosition } from './control-layout'

test('고정 관제 위치는 창 너비·접기·보기 변경으로 이동하지 않는다',()=>{
  for (const position of ['left','right','bottom'] as const) for (const width of [390,1099,1100,1600]) {
    for (const graph of [true,false]) for (const open of [true,false]) assert.equal(controlDock(position,width,graph,open),position)
    assert.equal(readControlPosition(position),position)
  }
})

test('자동 배치만 반응형 이동을 허용하고 저장값이 없거나 잘못됐으면 아래쪽에 고정한다',()=>{
  assert.equal(controlDock('auto',1099,true,true),'bottom')
  assert.equal(controlDock('auto',1100,true,true),'right')
  assert.equal(controlDock('auto',1600,true,false),'bottom')
  assert.equal(controlDock('auto',1600,false,true),'bottom')
  for (const value of [undefined,null,'unknown',{},false]) assert.equal(readControlPosition(value),'bottom')
  assert.equal(readControlPosition('auto'),'auto')
})
