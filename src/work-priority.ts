import type { Snapshot, WorkspaceView } from './model'
import { readQuestions } from './questions'
export type PriorityLevel='P0'|'P1'|'P2'
export interface PriorityOverride {level:PriorityLevel;reason:string;branch:string;updatedAt:number}
export type PriorityOverrides=Record<string,PriorityOverride>
export interface WorkPriority {level:PriorityLevel;reason:string;source:'manual'|'observed'}
export const PRIORITY_KEY='pod.work-priorities.v1'
export function workPriority(w:WorkspaceView,overrides:PriorityOverrides={}):WorkPriority|null {
  if(w.status==='completed')return null
  const manual=Object.hasOwn(overrides,w.id)?overrides[w.id]:undefined
  if(manual&&manual.branch===w.branch)return {level:manual.level,reason:manual.reason||'사용자 지정',source:'manual'}
  const automatic=(level:PriorityLevel,reason:string):WorkPriority=>({level,reason,source:'observed'})
  if(w.status==='on-hold')return automatic('P2','보류 중인 작업이에요')
  if(w.agents.some(a=>a.state==='blocked'))return automatic('P1','세션에서 확인을 기다리고 있어요')
  if(w.agents.some(a=>a.state==='waiting'&&a.tool?.name==='AskUserQuestion'&&readQuestions(a.tool.input).length))return automatic('P1','답변을 기다리는 질문이 있어요')
  if(w.pr?.state==='open'&&w.pr.checks==='failure'&&!w.agents.some(a=>a.state==='working'))return automatic('P1','PR 검사 실패를 확인할 차례예요')
  return automatic('P2',w.agents.some(a=>a.state==='working')?'세션이 작업을 진행 중이에요':w.status==='in-review'?'리뷰 단계에 있는 작업이에요':'일반 우선순위 작업이에요')
}
export function readPriorities(raw:unknown):PriorityOverrides {
  if(raw==null)return {}
  if(typeof raw!=='object'||Array.isArray(raw))throw new Error('중요도 설정을 읽지 못했습니다')
  for(const v of Object.values(raw) as PriorityOverride[])if(!v||!['P0','P1','P2'].includes(v.level)||typeof v.reason!=='string'||v.reason.length>300||typeof v.branch!=='string'||!Number.isFinite(v.updatedAt))throw new Error('중요도 설정을 읽지 못했습니다')
  return raw as PriorityOverrides
}
export function priorityChange(input:any):{id:string;level:PriorityLevel|null;reason:string} {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','level','reason'].includes(k))||typeof input.id!=='string'||!input.id||input.id.length>2000||!(input.level===null||['P0','P1','P2'].includes(input.level))||!(input.reason===undefined||typeof input.reason==='string'&&input.reason.length<=300))throw new Error('중요도 설정을 확인하세요')
  return {id:input.id,level:input.level,reason:input.reason?.trim()||'사용자 지정'}
}
export class PriorityRepository {
  private queue:Promise<unknown>=Promise.resolve()
  constructor(private storage:{get(key:string):Promise<unknown>;set(key:string,value:unknown):Promise<unknown>}){}
  async view():Promise<PriorityOverrides> {await this.queue.catch(()=>{});return readPriorities(await this.storage.get(PRIORITY_KEY))}
  set(input:unknown,snap:Snapshot):Promise<PriorityOverrides> {
    const change=priorityChange(input)
    const run=this.queue.catch(()=>{}).then(async()=>{
      const w=Object.hasOwn(snap.workspaces,change.id)?snap.workspaces[change.id]:null
      if(!w||w.status==='completed')throw new Error('중요도를 변경할 현재 작업을 찾지 못했습니다')
      const next=structuredClone(readPriorities(await this.storage.get(PRIORITY_KEY)))
      if(change.level===null)delete next[w.id]
      else next[w.id]={level:change.level,reason:change.reason,branch:w.branch,updatedAt:Date.now()}
      await this.storage.set(PRIORITY_KEY,next)
      return next
    })
    this.queue=run;return run
  }
}
