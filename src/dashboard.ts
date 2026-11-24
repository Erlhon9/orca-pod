import { progressDate, progressMonthBounds, recordedTopicPath, type ProgressEvent } from './progress'
import type { Snapshot } from './model'
export type DashboardTab='overview'|'git'|'flow'|'agents'|'machine'|'activity'
export interface DashboardQuery {month:string;timezone:string;repoId:string|null;topicPath:string[]|null;author:'me'|'all';kind:string;search:string;cursor:string|null;refresh:boolean}
export interface DashboardRecord {id:string;kind:string;at:number;title:string;repoId:string;repo:string;workspaceId:string|null;sessionKey:string|null;evidence:string;confirmation:string|null;pr?:{number:number;url:string;base:string;author:string;createdAt:number};retracted?:boolean}
export interface DashboardMonth {query:DashboardQuery;records:DashboardRecord[];previews:{merge:DashboardRecord[]};nextCursor:string|null;count:number;totals:Record<string,number>;repos:number;stats:{mergeHours:number|null;mergeSamples:number;mergeRepos:{name:string;count:number}[];mergeDays:{date:string;count:number}[]};git:{at:number;complete:boolean;errors:string[];topicLimited:boolean};history:{startedAt:number;lastAt:number;partial:boolean;beforeCollection:boolean};}
export function dashboardQuery(input:any,now=Date.now()):DashboardQuery {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['month','timezone','repoId','topicPath','author','kind','search','cursor','refresh'].includes(k)))throw new Error('대시보드 범위를 확인하세요')
  const timezone=input.timezone??'UTC';if(typeof timezone!=='string'||timezone.length>100)throw new Error('기록 시간대를 확인하세요')
  let today:string;try{today=progressDate(now,timezone)}catch{throw new Error('기록 시간대를 확인하세요')}
  const month=input.month??today.slice(0,7)
  if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2000-01'||month>today.slice(0,7))throw new Error('기록 월을 확인하세요')
  if(!(input.repoId==null||typeof input.repoId==='string'&&input.repoId.length<=2000)||!(input.topicPath==null||Array.isArray(input.topicPath)&&input.topicPath.length<=6&&input.topicPath.every((p:unknown)=>typeof p==='string'&&p.length<=400))||!(input.cursor==null||typeof input.cursor==='string'&&input.cursor.length<=300))throw new Error('대시보드 범위를 확인하세요')
  if(input.author!==undefined&&!['me','all'].includes(input.author)||input.kind!==undefined&&!['all','merge','verification','decision','response','question','status','note','pr','investigation','completion'].includes(input.kind)||input.refresh!==undefined&&typeof input.refresh!=='boolean')throw new Error('대시보드 범위를 확인하세요')
  if(input.search!==undefined&&(typeof input.search!=='string'||input.search.length>400))throw new Error('대시보드 범위를 확인하세요')
  return {month,timezone,search:input.search??'',repoId:input.repoId??null,topicPath:input.topicPath??null,author:input.author??'me',kind:input.kind??'all',cursor:input.cursor??null,refresh:input.refresh??false}
}
export const monthBounds=progressMonthBounds
export function topicMatches(path:string[],scope:string[]|null):boolean{return scope===null||(scope.length?scope.every((p,i)=>path[i]===p):path.length===0)}
export function dashboardWorkIds(snap:Snapshot,q:Pick<DashboardQuery,'repoId'|'topicPath'>):Set<string>{return new Set(Object.values(snap.workspaces).filter(w=>{const r=snap.repos.find(r=>r.id===w.repoId);const names=recordedTopicPath({topics:r?.topics??[],topic:w.topic});return (!q.repoId||w.repoId===q.repoId)&&topicMatches(names,q.topicPath)}).map(w=>w.id))}
export function historyRecord(e:ProgressEvent):DashboardRecord{return {id:'history:'+e.id,kind:e.kind,at:e.at,title:e.title,repoId:e.workspace.repoId,repo:e.workspace.repo,workspaceId:e.workspace.id,sessionKey:e.sessionKey??null,evidence:e.evidence,confirmation:e.confirmedBy??null,...(e.retracted?{retracted:true}:{})}}
export function paginateDashboard(q:DashboardQuery,all:DashboardRecord[],git:DashboardMonth['git'],history:DashboardMonth['history']):DashboardMonth {
  const search=q.search.trim().toLowerCase();if(search)all=all.filter(r=>[r.title,r.repo,r.evidence,r.pr?.number,r.pr?.base].join(' ').toLowerCase().includes(search))
  const ids=new Set<string>();all=all.filter(r=>!ids.has(r.id)&&!!ids.add(r.id)).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));const totals:Record<string,number>={all:all.length,merge:0,verification:0,decision:0};for(const r of all)if(!r.retracted&&(r.kind!=='verification'&&r.kind!=='decision'||r.confirmation==='user'||r.confirmation==='observation'))totals[r.kind]=(totals[r.kind]??0)+1
  const merges=all.filter(r=>r.kind==='merge'),hours=merges.filter(r=>r.pr&&r.pr.createdAt>0&&r.pr.createdAt<=r.at).map(r=>(r.at-r.pr!.createdAt)/3600_000).sort((a,b)=>a-b),byRepo=new Map<string,{name:string;count:number}>(),byDay=new Map<string,number>()
  for(const r of merges){const item=byRepo.get(r.repoId)??{name:r.repo,count:0};item.count++;byRepo.set(r.repoId,item);const date=progressDate(r.at,q.timezone);byDay.set(date,(byDay.get(date)??0)+1)}
  const stats={mergeHours:hours.length&&git.complete?(hours[Math.floor((hours.length-1)/2)]+hours[Math.ceil((hours.length-1)/2)])/2:null,mergeSamples:hours.length,mergeRepos:[...byRepo.values()].sort((a,b)=>b.count-a.count),mergeDays:[...byDay].sort(([a],[b])=>a.localeCompare(b)).map(([date,count])=>({date,count}))}
  const filtered=all.filter(r=>q.kind==='all'||r.kind===q.kind&&(!['verification','decision'].includes(r.kind)||!r.retracted&&!!r.confirmation));const index=q.cursor?filtered.findIndex(r=>r.id===q.cursor)+1:0;if(q.cursor&&!index)throw new Error('기록 위치를 찾지 못했습니다')
  const records=filtered.slice(index,index+100);return {query:q,records,previews:{merge:all.filter(r=>r.kind==='merge').slice(0,5)},nextCursor:index+records.length<filtered.length?records.at(-1)!.id:null,count:filtered.length,totals,repos:new Set(all.map(r=>r.repoId)).size,stats,git,history}
}
export {recordedTopicPath}
