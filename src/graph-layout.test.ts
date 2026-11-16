import { assert, test } from 'orca/testing'
import { clearGraphPositions, graphPositionKey, readGraphPositions } from './graph-layout'

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
