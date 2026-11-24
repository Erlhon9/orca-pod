import { assert, test } from 'orca/testing'
import { workPriority, PriorityRepository, PRIORITY_KEY, priorityChange, readPriorities } from './work-priority'
import type { Snapshot, WorkspaceView } from './model'
const work=():WorkspaceView=>({id:'w',branch:'example',status:'in-progress',agents:[{key:'s',state:'waiting',tool:null}],pr:null} as unknown as WorkspaceView)
const snap=(w=work()):Snapshot=>({workspaces:{w}} as unknown as Snapshot)
const question=()=>({name:'AskUserQuestion',input:JSON.stringify({questions:[{question:'Choose',options:[{label:'A'}]}]})})

test('일반 대기와 작업 중 조사에 긴급도를 부풀리지 않고 실제 질문·실패·차단만 P1로 제안한다',()=>{
 const w=work();assert.equal(workPriority(w)?.level,'P2')
 w.agents[0].tool=question();assert.equal(workPriority(w)?.level,'P1')
 w.agents[0].tool=null;w.agents[0].state='blocked';assert.equal(workPriority(w)?.level,'P1')
 w.agents[0].state='idle';w.pr={number:1,state:'open',checks:'failure',title:'Example',url:''};assert.equal(workPriority(w)?.level,'P1')
 w.agents[0].state='working';assert.equal(workPriority(w)?.level,'P2')
 w.agents[0].state='blocked';w.status='on-hold';assert.equal(workPriority(w)?.level,'P2')
 w.status='completed';assert.equal(workPriority(w),null)
})

test('P0는 사용자 지정으로만 생기고 자동 분류 복귀·재시작·브랜치 변경을 구분한다',async()=>{
 const data=new Map<string,unknown>(),store={get:async(k:string)=>structuredClone(data.get(k)),set:async(k:string,v:unknown)=>{data.set(k,structuredClone(v))}},repo=new PriorityRepository(store),w=work()
 const overrides=await repo.set({id:'w',level:'P0',reason:'오늘 먼저 확인'},snap(w))
 assert.equal(workPriority(w,overrides)?.level,'P0');assert.equal(workPriority(w,overrides)?.source,'manual')
 assert.equal(workPriority(w,await new PriorityRepository(store).view())?.reason,'오늘 먼저 확인')
 assert.equal(workPriority({...w,branch:'other'},overrides)?.level,'P2')
 w.status='completed';assert.equal(workPriority(w,overrides),null);w.status='in-progress'
 assert.equal(workPriority(w,await repo.set({id:'w',level:null},snap(w)))?.source,'observed')
})

test('잘못된 입력·존재하지 않는 작업·저장 실패는 기존 중요도를 덮어쓰지 않는다',async()=>{
 for(const v of [{id:'w',level:'P3'},{id:'w',level:'P0',xp:100},{id:'',level:'P1'},{id:'w',level:'P2',reason:'x'.repeat(301)}])assert.throws(()=>priorityChange(v))
 assert.throws(()=>readPriorities([]));assert.throws(()=>readPriorities({w:{level:'P9'}}))
 const existing={w:{level:'P1' as const,reason:'Keep',branch:'example',updatedAt:1}},repo=new PriorityRepository({get:async()=>existing,set:async()=>{throw new Error('fictional failure')}})
 for(const id of ['missing','__proto__','w']){let failed=false;try{await repo.set({id,level:'P0'},snap())}catch{failed=true}assert.equal(failed,true)}
 assert.equal(existing.w.level,'P1')
 assert.equal((await repo.view()).w.level,'P1');assert.equal(PRIORITY_KEY,'pod.work-priorities.v1')
})
