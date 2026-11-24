import { assert, test } from 'orca/testing'
import { collectTopicScopes, topicScopeIncludes } from './topic-scope'
import type { Snapshot } from './model'

const snapshot = () => ({repos:[
  {id:'a',topics:[{id:'dev-a',name:'개발'},{id:'api-a',name:'API',parent:'dev-a'},{id:'ops',name:'운영'},{id:'api-ops',name:'API',parent:'ops'}]},
  {id:'b',topics:[{id:'dev-b',name:'개발'},{id:'api-b',name:'API',parent:'dev-b'}]}
],workspaces:Object.fromEntries([
  ['a1','a','api-a'],['a2','a','api-ops'],['b1','b','api-b'],['b2','b',null]
].map(([id,repoId,topic])=>[id,{id,repoId,topic,status:'in-progress',agents:[]}]))} as unknown as Snapshot)

test('레포가 달라도 같은 전체 주제 경로는 함께 찾고 다른 부모의 동명 하위 주제는 구분한다',()=>{
  const snap=snapshot(),scopes=collectTopicScopes(snap,()=>true)
  const api=scopes.find(scope=>scope.key==='["개발","api"]')!
  assert.deepEqual(api.workspaceIds,['a1','b1'])
  assert.deepEqual(api.repoIds,['a','b'])
  assert.equal(topicScopeIncludes(snap,snap.workspaces.a1,'["개발"]'),true)
  assert.equal(topicScopeIncludes(snap,snap.workspaces.b1,api.key),true)
  assert.equal(topicScopeIncludes(snap,snap.workspaces.a2,api.key),false)
  assert.equal(topicScopeIncludes(snap,snap.workspaces.b2,'[]'),true)
})

test('표시할 작업만 집계하고 미분류와 손상된 주제 경로를 다룬다',()=>{
  const snap=snapshot()
  snap.workspaces.b1.status='completed'
  snap.workspaces.a2.topic='missing'
  const scopes=collectTopicScopes(snap,w=>w.status!=='completed')
  assert.deepEqual(scopes.find(scope=>scope.key==='["개발"]')?.workspaceIds,['a1'])
  assert.deepEqual(scopes.find(scope=>scope.key==='[]')?.workspaceIds,['a2','b2'])
  assert.equal(topicScopeIncludes(snap,snap.workspaces.a2,'not a key'),false)
  assert.equal(topicScopeIncludes(snap,snap.workspaces.a2,null),true)
})
