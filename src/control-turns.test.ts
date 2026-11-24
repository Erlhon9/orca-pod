import { assert, test } from 'orca/testing'
import { latestBriefing, prepareControlRequest, readControlTurns, scopeKey, turnForItem, type ControlTurn } from './control-turns'

const turn = (id: string, extra: Partial<ControlTurn> = {}): ControlTurn => ({ id, provider: 'claude', label: 'Example work', targets: [{workspaceId:'w',sessionKey:null}], text:'Original',displayText:'Brief',kind:'briefing',startedAt:1,endedAt:3,status:'complete',answer:'Confirmed context',sourceVersion:'v1',...extra })

test('같은 시각의 다른 작업 응답도 requestId로만 연결하고 출처 없는 과거 항목은 추측하지 않는다', () => {
  const a=turn('a'), b=turn('b')
  assert.equal(turnForItem({k:'text',text:'B',at:2,requestId:'b'},[a,b])?.id,'b')
  assert.equal(turnForItem({k:'text',text:'Unknown',at:2},[a,b]),undefined)
})

test('중단·실패 브리핑은 마지막 정상 브리핑을 대체하지 않고 재시작 시 running을 완료로 복원하지 않는다', () => {
  const targets=turn('ok').targets
  const restored=readControlTurns([turn('ok'),turn('running',{status:'running',endedAt:null}),turn('failed',{status:'failed'})])
  assert.equal(restored[1].status,'interrupted')
  assert.equal(restored[1].answer,'')
  assert.equal(latestBriefing(restored,targets)?.id,'ok')
})

test('저장된 요청은 입력을 검증하고 대상 집합의 순서와 중복에 영향받지 않는다', () => {
  const a={workspaceId:'a',sessionKey:null},b={workspaceId:'b',sessionKey:'s'}
  assert.equal(scopeKey([a,b,a]),scopeKey([b,a]))
  const restored=readControlTurns([turn('ok'),turn('ok'),turn('',{}),turn('invalid',{targets:[{workspaceId:'w',sessionKey:42 as any}]})])
  assert.equal(restored.length,1)
})

test('모델 참조와 표시 범위를 최신 지도에서 함께 만들고 패널의 오래된 이름·지문을 신뢰하지 않는다', () => {
  const w = {id:'w',repo:'Example',name:'Renamed work',agents:[{key:'s',title:'Current session',terminal:'term_current'}]} as any
  const snap = {workspaces:{w}} as any
  const value = prepareControlRequest(snap,'Check the results',{targets:[{workspaceId:'w',sessionKey:'s'}],kind:'briefing',displayText:'Brief',sourceVersion:'untrusted'})
  assert.ok(value.text.includes('Current session'))
  assert.ok(value.text.includes('term_current'))
  assert.ok(value.text.endsWith('Check the results'))
  assert.ok(value.label.includes('Renamed work'))
  assert.ok(value.sourceVersion !== 'untrusted')
  assert.equal(value.displayText,'Brief')
  assert.throws(()=>prepareControlRequest(snap,'Check',{targets:[{workspaceId:'w',sessionKey:'removed'}]}))
  assert.throws(()=>prepareControlRequest(snap,'x'.repeat(20_001),{targets:[]}))
})
