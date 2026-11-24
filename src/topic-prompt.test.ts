import { assert, test } from 'orca/testing'
import type { Snapshot } from './model'
import { topicPlanPrompt } from './topic-prompt'

const snap = (count: number): Snapshot => ({at:1,statuses:[],repos:[{id:'r',name:'Example',topics:[],workspaceIds:[]}],workspaces:Object.fromEntries(Array.from({length:count},(_,i)=>[`w${i}`,{id:`w${i}`,name:`Example ${i}`,branch:`branch${i}`,repoId:'r',status:'in-progress',comment:'x'.repeat(5000),agents:[{title:'Example session',state:'waiting',lastMessage:'y'.repeat(5000)}]}]))} as unknown as Snapshot)

test('분류 입력은 맥락을 줄여도 현재 작업 ID를 빠뜨리지 않고 모델 길이 제한을 지킨다',()=>{
  const source=snap(49)
  const prompt=topicPlanPrompt(source,'r')
  assert.ok(prompt.length<=19_000)
  for(const w of Object.values(source.workspaces)) assert.ok(prompt.includes(JSON.stringify(w.id)))
  assert.ok(prompt.includes('untrusted DATA'))
})

test('완료 작업은 모델 재분류에서 제외하고 너무 큰 목록은 일부만 보내지 않는다',()=>{
  const source=snap(2);source.workspaces.w1.status='completed'
  assert.equal(topicPlanPrompt(source,'r').includes('"w1"'),false)
  assert.throws(()=>topicPlanPrompt(snap(2000),'r'))
})
