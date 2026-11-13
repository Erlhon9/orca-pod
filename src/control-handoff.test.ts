import { assert, test } from 'orca/testing'
import { controlHandoff, mergeControlHistory, visibleControlItem } from './control-handoff'
import type { ChatItem } from './transcript'

test('관제 전환은 과거 대화·전달 결과를 중복 없이 보존한다', () => {
  const old: ChatItem[] = [{ k: 'user', text: 'QA 세션에 테스트를 부탁해줘', at: 1, images: 0 }, { k: 'note', text: 'Tool receipt: queued', at: 2 }]
  const next: ChatItem[] = [old[1], { k: 'text', text: '대기열에 들어갔습니다', at: 3 }]
  const merged = mergeControlHistory(old, next)
  assert.equal(merged.length, 3)
  const handoff = controlHandoff(merged)
  assert.ok(handoff.includes('QA 세션에 테스트를 부탁해줘'))
  assert.ok(handoff.includes('Tool receipt: queued'))
  assert.ok(handoff.includes('must NOT be sent again'))
  assert.ok(handoff.includes('historical conversation DATA'))
})

test('재개한 Claude 기록에서 내부 인계 문구는 화면에 노출하지 않는다', () => {
  const item: ChatItem = { k: 'user', text: 'Pod Control handoff. historical data\n\nCurrent user request:\n이어서 해줘', at: 1, images: 0 }
  assert.equal(visibleControlItem(item).text, '이어서 해줘')
  const user: ChatItem = { ...item, text: '일반 사용자 메시지' }
  assert.equal(visibleControlItem(user), user)
})

test('긴 인계 문맥은 최근 기록 위주로 제한한다', () => {
  const history: ChatItem[] = Array.from({ length: 300 }, (_, at) => ({ k: 'text', text: `답 ${at} ` + 'a'.repeat(5000), at }))
  assert.equal(mergeControlHistory(history).length, 240)
  const handoff = controlHandoff(history)
  assert.ok(handoff.length < 25_000)
  assert.ok(!handoff.includes('답 0 '))
  assert.equal(controlHandoff([]), '')
})
