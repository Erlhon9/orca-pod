import {test} from 'node:test'
import assert from 'node:assert/strict'
import {dashboardQuery,historyRecord,dashboardWorkIds,monthBounds,paginateDashboard,type DashboardRecord} from './dashboard'
import {DashboardSource,cpuDelta,githubRepo,processRows} from './dashboard-source'
import type {Snapshot} from './model'
const now=Date.parse('2026-11-24T10:00:00Z')
const q=(input:any={})=>dashboardQuery({month:'2026-11',timezone:'Asia/Seoul',...input},now)
const snap:Snapshot={at:now,repos:[{id:'repo',name:'Example',topics:[],workspaceIds:['work']}],workspaces:{work:{id:'work',repoId:'repo',repo:'Example',name:'Work',path:'/fixture/repo',isMain:true,topic:null,agents:[],pr:null} as any},statuses:[]}
const history:any={month:async()=>({events:[],startedAt:now-1000,lastAt:now,partial:false,beforeCollection:false})}
const node=(number=1)=>({number,title:'Merged work',url:`https://github.com/example/project/pull/${number}`,mergedAt:'2026-11-02T01:00:00Z',createdAt:'2026-11-01T01:00:00Z',baseRefName:'main',author:{login:'tester'},repository:{nameWithOwner:'example/project'}})
test('월 조회는 시스템 시간대의 시작과 다음 월 시작을 정확하게 구한다',()=>{
 assert.deepEqual(monthBounds('2026-11','Asia/Seoul'),{from:Date.parse('2026-10-31T15:00:00Z'),to:Date.parse('2026-11-30T15:00:00Z')})
 assert.deepEqual(monthBounds('2024-03','America/New_York'),{from:Date.parse('2024-03-01T05:00:00Z'),to:Date.parse('2024-04-01T04:00:00Z')})
 assert.equal(monthBounds('2024-02','UTC').to-monthBounds('2024-02','UTC').from,29*86400_000)
 assert.equal(monthBounds('2026-12','UTC').to,Date.parse('2027-01-01T00:00:00Z'))
 for(const input of [{month:'2026-13'},{month:'2027-01'},{month:'1999-12'},{timezone:'bad'},{author:'other'},{kind:'shell'},{extra:true},{topicPath:[12]}])assert.throws(()=>q(input))
})
test('월 합계는 100건 페이지 밖과 중복·철회를 반영하고 근거 종류를 구분한다',()=>{
 const all=Array.from({length:150},(_,i):DashboardRecord=>({id:String(i),kind:'merge',at:now-i,title:'PR',repoId:'repo',repo:'Example',workspaceId:null,sessionKey:null,evidence:'',confirmation:'observation'}))
 all.push({...all[0]},{...all[0],id:'withdrawn',kind:'verification',retracted:true},{...all[0],id:'claim',kind:'verification',confirmation:null})
 const git={at:now,complete:true,errors:[],topicLimited:false},coverage={startedAt:now,lastAt:now,partial:false,beforeCollection:false}
 const first=paginateDashboard(q({kind:'merge'}),all,git,coverage);assert.equal(first.totals.merge,150);assert.equal(first.totals.verification,0);assert.equal(first.records.length,100)
 const next=paginateDashboard(q({kind:'merge',cursor:first.nextCursor}),all,git,coverage);assert.equal(next.records.length,50);assert.equal(next.nextCursor,null);assert.throws(()=>paginateDashboard(q({cursor:'missing'}),all,git,coverage))
})
test('GitHub 병합은 읽기 전용 인자와 월 경계로 조회하고 cache·페이지 중복을 처리한다',async()=>{
 const calls:any[]=[],runner=async(file:string,args:string[])=>{calls.push([file,args]);if(file==='git')return 'git@github.com:example/project.git';if(args.includes('user'))return 'tester';return JSON.stringify({data:{search:{issueCount:2,pageInfo:{hasNextPage:false},nodes:[node(),node()]}}})}
 const source=new DashboardSource(runner,()=>now),first=await source.month(snap,q(),history);assert.equal(first.totals.merge,1);assert.equal(first.records[0].pr?.base,'main');assert.equal('events' in first.history,false)
 const args=calls.find(([f,a])=>f==='gh'&&a.includes('graphql'))[1];assert.ok(args.some((a:string)=>a.includes('author:tester')));assert.ok(args.some((a:string)=>a.includes('2026-10-31T15:00:00.000Z')));assert.ok(calls.every(([f,a])=>f==='gh'||a.includes('config')))
 await source.month(snap,q(),history);assert.equal(calls.length,3)
 await source.month(snap,q({refresh:true}),history);assert.equal(calls.length,5)
})
test('PR 주제는 연결된 작업만 포함하고 실패를 병합 0건 성공으로 표시하지 않는다',async()=>{
 const source=new DashboardSource(async(file,args)=>{if(file==='git')return 'https://github.com/example/project.git';if(args.includes('user'))return 'tester';throw Error('private details')},()=>now)
 const failed=await source.month(snap,q(),history);assert.equal(failed.git.complete,false);assert.equal(JSON.stringify(failed).includes('private details'),false)
 const good=new DashboardSource(async(file,args)=>file==='git'?'https://github.com/example/project.git':JSON.stringify({data:{search:{issueCount:1,pageInfo:{hasNextPage:false},nodes:[node()]}}}),()=>now)
 const scoped=await good.month(snap,q({author:'all',topicPath:[]}),history);assert.equal(scoped.totals.merge,0);assert.equal(scoped.git.topicLimited,true)
 assert.equal(githubRepo('https://token@github.com/example/project.git'),null);assert.equal(githubRepo('git@other.example:example/project.git'),null);assert.equal(githubRepo('https://github.com/example/project.git'),'example/project')
})
test('CPU는 두 샘플과 코어 수가 맞을 때만 계산하고 프로세스 인자는 읽거나 노출하지 않는다',()=>{
 assert.equal(cpuDelta([100,200,4],[150,300,4]),50);assert.equal(cpuDelta([100,200,4],[150,300,8]),null);assert.equal(cpuDelta([100,200],[50,100]),null);assert.equal(cpuDelta([100,200],[100,200]),null)
 const rows=processRows('12 15.1 1024 /usr/bin/node\n13 4.0 2048 /usr/bin/codex\n14 90.0 4096 /usr/bin/unrelated');assert.equal(rows.length,2);assert.equal(rows[0].name,'node');assert.equal(rows[0].rss,1024*1024)
})

test('검색은 월 합계와 목록에 함께 적용하고 PR 미리보기는 첫 페이지에 갇히지 않는다',()=>{
 const all=Array.from({length:120},(_,i):DashboardRecord=>({id:'note'+i,kind:'note',at:now-i,title:'Recent note',repoId:'repo',repo:'Example',workspaceId:null,sessionKey:null,evidence:'',confirmation:null}));all.push({id:'older-pr',kind:'merge',at:now-1000,title:'Specific merge',repoId:'repo',repo:'Example',workspaceId:null,sessionKey:null,evidence:'',confirmation:'observation'})
 const git={at:now,complete:true,errors:[],topicLimited:false},coverage={startedAt:now,lastAt:now,partial:false,beforeCollection:false}
 const page=paginateDashboard(q(),all,git,coverage);assert.equal(page.records.length,100);assert.equal(page.previews.merge[0].id,'older-pr')
 const searched=paginateDashboard(q({search:'specific'}),all,git,coverage);assert.equal(searched.records.length,1);assert.equal(searched.totals.merge,1)
})
test('검색 상한은 월 범위를 나누어 조회하고 실패한 갱신은 마지막 정상 근거를 보존한다',async()=>{
 let fail=false,searches=0;const source=new DashboardSource(async(file,args)=>{if(file==='git')return 'git@github.com:example/project.git';if(fail)throw Error();searches++;return JSON.stringify({data:{search:{issueCount:searches===1?1001:1,pageInfo:{hasNextPage:false},nodes:searches===1?[]:[node(searches)]}}})},()=>now)
 const first=await source.month(snap,q({author:'all'}),history);assert.equal(searches,3);assert.equal(first.git.complete,true);assert.equal(first.totals.merge,2)
 fail=true;const retry=await source.month(snap,q({author:'all',refresh:true}),history);assert.equal(retry.git.complete,false);assert.equal(retry.totals.merge,2)
})

test('주제 이름 안의 구분 기호를 경로로 쪼개지 않는다',()=>{
 const next=structuredClone(snap);next.repos[0].topics=[{id:'t',name:'API › Client',keywords:[]}];next.workspaces.work.topic='t';
 assert.equal(dashboardWorkIds(next,{repoId:null,topicPath:['API › Client']}).has('work'),true);assert.equal(dashboardWorkIds(next,{repoId:null,topicPath:['API','Client']}).has('work'),false);
})

test('기록 응답은 선택 필드가 없는 과거 기록도 JSON 전송 가능한 값만 포함한다',()=>{
 const e:any={id:'old',kind:'response',at:now,title:'Earlier response',evidence:'Observed',workspace:{id:'work',repoId:'repo',repo:'Example'},source:'proof'};
 const record=historyRecord(e);assert.deepEqual(record,JSON.parse(JSON.stringify(record)));
 assert.equal(record.sessionKey,null);assert.equal(record.confirmation,null);assert.equal('retracted' in record,false);
})
