import { assert, test } from 'orca/testing'
import { emptyWatch, readWatchState, watchContext, watchDecision, watchPrompt } from './control-watch'
import { readWorkMemory } from './work-memory'
import type { Snapshot } from './model'

const snap=()=>({at:10,repos:[{id:'a',name:'A',topics:[],workspaceIds:['w']},{id:'b',name:'B',topics:[],workspaceIds:['other']}],workspaces:{
  w:{id:'w',name:'Current work',repo:'A',repoId:'a',status:'in-progress',comment:'',branch:'work',pr:null,agents:[{key:'session-a',type:'claude',state:'waiting',title:'Session A',prompt:'',lastMessage:'Finished normally.',tool:null,interrupted:false,updatedAt:10}]},
  other:{id:'other',name:'Outside work',repo:'B',repoId:'b',status:'in-progress',comment:'',branch:'other',pr:null,agents:[]}
}} as unknown as Snapshot)
const scope={repoId:'a',topicKey:null}

test('일반 대기는 질문으로 승격하지 않고 실제 질문·승인 신호·실패한 PR을 구분한다',()=>{
  const source=snap()
  assert.equal(watchContext(source,scope).signals.length,0)
  source.workspaces.w.agents[0].tool={name:'AskUserQuestion',input:JSON.stringify({questions:[{question:'Which option?',options:[{label:'A'},{label:'B'}]}]})}
  assert.equal(watchContext(source,scope).signals.length,1)
  source.workspaces.w.agents[0].state='blocked'
  source.workspaces.w.pr={number:1,state:'open',checks:'failure',title:'Change',url:''}
  assert.equal(watchContext(source,scope).signals.length,2)
  source.workspaces.w.status='completed'
  assert.equal(watchContext(source,scope).workspaces.length,0)
})

test('정기 주기·중요 변화·on demand는 독립적으로 작동하며 같은 상태를 반복 브리핑하지 않는다',()=>{
  const source=snap(),context=watchContext(source,scope),state=emptyWatch(),now=1_000_000
  assert.equal(watchDecision(state,context,now,false),'skip')
  assert.equal(watchDecision(state,context,now,true),'request')
  state.settings={intervalMinutes:15,changes:true,scopeMode:'all'}
  assert.equal(watchDecision(state,context,now,false),'scheduled')
  state.checkpoints[context.key]={fingerprint:context.fingerprint,signals:[],lastAttempt:now,lastSuccess:now,lastCheck:now}
  assert.equal(watchDecision(state,context,now+900_000,false),'checked')
  source.workspaces.w.comment='A new result'
  const changed=watchContext(source,scope)
  assert.equal(watchDecision(state,changed,now+899_000,false),'skip')
  assert.equal(watchDecision(state,changed,now+900_000,false),'scheduled')
  source.workspaces.w.agents[0].state='blocked'
  assert.equal(watchDecision(state,watchContext(source,scope),now+61_000,false),'changes')
  assert.equal(watchDecision(state,watchContext(source,scope),now+10_000,false),'skip')
  state.checkpoints[context.key].lastSuccess=0
  assert.equal(watchDecision(state,changed,now+61_000,false),'skip')
  assert.equal(watchDecision(state,changed,now+61_000,true),'request')
})

test('시간·열람 표시만 바뀌면 같은 입력이며 실제 사람 메모 변경은 새 입력이다',()=>{
  const source=snap(),memory=readWorkMemory({goal:'Goal',updatedAt:1}),before=watchContext(source,scope,{w:memory})
  source.at=300;source.workspaces.w.agents[0].updatedAt=300
  assert.equal(watchContext(source,scope,{w:{...memory,updatedAt:300}}).fingerprint,before.fingerprint)
  assert.notEqual(watchContext(source,scope,{w:{...memory,note:'New decision'}}).fingerprint,before.fingerprint)
})

test('보류 작업의 과거 질문은 초기 알림에서 제외하고 이후 새 질문은 알린다',()=>{
  const source=snap(),state=emptyWatch(),now=1_000_000
  source.workspaces.w.status='on-hold';source.workspaces.w.agents[0].state='blocked'
  state.settings={intervalMinutes:0,changes:true,scopeMode:'all'}
  const before=watchContext(source,scope)
  assert.equal(watchDecision(state,before,now,false),'baseline')
  state.checkpoints[before.key]={fingerprint:before.fingerprint,signals:before.signals,lastAttempt:0,lastSuccess:0,lastCheck:now}
  source.workspaces.w.agents[0].tool={name:'Bash',input:'A new approval request'}
  assert.equal(watchDecision(state,watchContext(source,scope),now+10_000,false),'changes')
})

test('범위 밖 작업은 입력에 없고 잘못된 범위와 잘린 전체 목록은 거절한다',()=>{
  const source=snap(),context=watchContext(source,scope)
  const prompt=watchPrompt(context,{})
  assert.ok(prompt.includes('untrusted DATA'))
  assert.equal(prompt.includes('Outside work'),false)
  assert.throws(()=>watchContext(source,{repoId:'missing',topicKey:null}))
  assert.throws(()=>watchContext(source,{repoId:'a',topicKey:'[]'}))
  source.workspaces.w.name='x'.repeat(20_000)
  assert.throws(()=>watchPrompt(watchContext(source,scope),{}))
})

test('저장된 주기·최근 브리핑은 공급자 대화와 별도로 읽고 손상된 항목은 버린다',()=>{
  const restored=readWatchState({settings:{intervalMinutes:15,changes:true},checkpoints:{a:{fingerprint:'old',signals:[],lastAttempt:10,lastSuccess:20,lastCheck:20}},notes:[{id:'n',scopeKey:'a',label:'A',answer:'A saved briefing',at:20,fingerprint:'old',workspaceIds:['w']},{id:1}]})
  assert.equal(restored.settings.intervalMinutes,15)
  assert.equal(restored.notes.length,1)
  assert.equal(restored.notes[0].answer,'A saved briefing')
  assert.equal(readWatchState({settings:{intervalMinutes:9999,changes:'yes'}}).settings.intervalMinutes,0)
})

test('넓은 범위의 발췌를 줄여도 작업 ID와 추가 조회할 세션 키는 남긴다',()=>{
  const source=snap(),original=source.workspaces.w
  source.workspaces={}
  for(let index=0;index<49;index++) {
    const id=`work-${'x'.repeat(90)}-${index}`,agent={...original.agents[0],key:`session-${'y'.repeat(35)}-${index}`,lastMessage:'Evidence '.repeat(1000)}
    source.workspaces[id]={...original,id,comment:'Human decision '.repeat(500),agents:[agent]}
  }
  const prompt=watchPrompt(watchContext(source,scope),{})
  assert.ok(prompt.length<=19_000)
  for(const workspace of Object.values(source.workspaces)) {
    assert.ok(prompt.includes(JSON.stringify(workspace.id)))
    assert.ok(prompt.includes(JSON.stringify(workspace.agents[0].key)))
  }
  assert.ok(prompt.includes('Do not delegate source reading'))
})

test('관제는 현재 범위의 중요도를 읽되 P0를 장애·실행 권한으로 단정하지 않는다',()=>{
 const source=snap(),context=watchContext(source,scope),prompt=watchPrompt(context,{},undefined,'ko',{w:{level:'P0',reason:'먼저 확인',branch:'work',updatedAt:1}})
 assert.ok(prompt.includes('P0'));assert.ok(prompt.includes('P0 is user-designated'));assert.ok(prompt.includes('not as evidence of an incident'));assert.equal(prompt.includes('Outside work'),false)
})
