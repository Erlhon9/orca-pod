import {execFile} from 'node:child_process'
import {cpus,freemem,totalmem,hostname,platform} from 'node:os'
import {statfs} from 'node:fs/promises'
import {basename} from 'node:path'
import type {Snapshot} from './model'
import {dashboardWorkIds,historyRecord,monthBounds,paginateDashboard,type DashboardQuery,type DashboardRecord,type DashboardMonth} from './dashboard'
import type {ProgressRepository} from './progress'
export type ReadCommand=(file:string,args:string[],cwd?:string)=>Promise<string>
export const readCommand:ReadCommand=(file,args,cwd)=>new Promise((resolve,reject)=>execFile(file,args,{cwd,timeout:15_000,maxBuffer:4*1024*1024,env:{...process.env,GH_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'}},(error,out)=>error?reject(new Error('조회 명령이 실패했습니다')):resolve(out)))
export function githubRepo(remote:string):string|null {
  const match=/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());return match&&match[1].split('/').every(s=>s!=='.'&&s!=='..')?match[1]:null
}
const SEARCH='query($q:String!,$cursor:String){search(query:$q,type:ISSUE,first:100,after:$cursor){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{number title url mergedAt createdAt baseRefName author{login} repository{nameWithOwner}}}}}'
interface GitResult {records:DashboardRecord[];at:number;complete:boolean;errors:string[]}
export class DashboardSource {
  private cache=new Map<string,{at:number;value:GitResult}>();private pending=new Map<string,Promise<GitResult>>();private login:{at:number;value:string}|null=null
  constructor(private run:ReadCommand=readCommand,private now:()=>number=Date.now){}
  private async git(snap:Snapshot,q:DashboardQuery):Promise<GitResult> {
    const repos=snap.repos.filter(r=>!q.repoId||q.repoId===r.id),roots=repos.map(r=>({repo:r,path:Object.values(snap.workspaces).filter(w=>w.repoId===r.id).sort((a,b)=>Number(b.isMain)-Number(a.isMain))[0]?.path}));const key=JSON.stringify([q.month,q.timezone,q.author,roots.map(r=>[r.repo.id,r.path])]);const old=this.cache.get(key)
    if(!q.refresh&&old&&this.now()-old.at<120_000)return old.value
    if(this.pending.has(key))return this.pending.get(key)!
    const task=(async()=>{
      const result:GitResult={records:[],at:this.now(),complete:true,errors:[]},bounds=monthBounds(q.month,q.timezone);let requests=0,user='';const deadline=this.now()+45_000
      const fail=(repo:string,message:string)=>{result.complete=false;result.errors.push(repo+': '+message)}
      if(q.author==='me')try{if(!this.login||this.now()-this.login.at>300_000){const value=(await this.run('gh',['api','user','--jq','.login'])).trim();if(!/^[a-z\d][a-z\d-]{0,38}$/i.test(value))throw Error();this.login={at:this.now(),value}}user=this.login.value}catch{fail('GitHub','로그인 또는 CLI를 확인하세요');return result}
      const seenRepos=new Set<string>()
      for(const root of roots.slice(0,30)) {
        if(this.now()>deadline||result.records.length>=5000){fail('GitHub','조회 한도에 도달해 일부 기록만 표시합니다');break}
        if(!root.path){fail(root.repo.name,'저장소 경로를 확인할 수 없습니다');continue}
        try {
          const name=githubRepo(await this.run('git',['-C',root.path,'config','--get','remote.origin.url']));if(!name){fail(root.repo.name,'지원되는 GitHub 원격 저장소가 없습니다');continue}
          if(seenRepos.has(name))continue;seenRepos.add(name)
          const search=async(from:number,to:number):Promise<void>=>{
            let cursor:string|null=null,pages=0
            do {
              if(++requests>120||this.now()>deadline||result.records.length>=5000){fail(root.repo.name,'조회 한도에 도달해 일부 기록만 표시합니다');return}
              const query=`repo:${name} is:pr is:merged merged:>=${new Date(from).toISOString()} merged:<${new Date(to).toISOString()}${user?' author:'+user:''}`
              const args=['api','graphql','-f','query='+SEARCH,'-f','q='+query,...(cursor?['-f','cursor='+cursor]:[])]
              const response=JSON.parse(await this.run('gh',args));if(response.errors?.length||!response.data?.search)throw Error()
              const data=response.data.search
              if(!cursor&&data.issueCount>1000){if(to-from<=60_000){fail(root.repo.name,'조회 한도에 도달해 일부 기록만 표시합니다');return}const mid=Math.floor((from+to)/2);await search(from,mid);await search(mid,to);return}
              for(const p of data.nodes??[]) {const at=Date.parse(p.mergedAt);if(p.repository?.nameWithOwner?.toLowerCase()!==name.toLowerCase()||!Number.isFinite(at)||at<bounds.from||at>=bounds.to||!Number.isInteger(p.number)||p.number<1||typeof p.title!=='string'||typeof p.url!=='string'||p.url.toLowerCase()!==`https://github.com/${name}/pull/${p.number}`.toLowerCase())continue
                result.records.push({id:`merge:${name.toLowerCase()}:${p.number}`,kind:'merge',at,title:p.title.slice(0,600),repoId:root.repo.id,repo:root.repo.name,workspaceId:null,sessionKey:null,evidence:p.baseRefName||'',confirmation:'observation',pr:{number:p.number,url:p.url,base:String(p.baseRefName??'').slice(0,300),author:String(p.author?.login??'').slice(0,100),createdAt:Date.parse(p.createdAt)||0}})
              }
              cursor=data.pageInfo?.hasNextPage?data.pageInfo.endCursor:null
              if(cursor&&typeof cursor!=='string')throw Error()
              if(++pages>=10&&cursor){fail(root.repo.name,'조회 한도에 도달해 일부 기록만 표시합니다');return}
            }while(cursor)
          }
          await search(bounds.from,bounds.to)
        }catch{fail(root.repo.name,'GitHub 이력을 조회하지 못했습니다')}
      }
      if(roots.length>30)fail('GitHub','저장소가 많아 일부만 조회했습니다')
      return result
    })()
    this.pending.set(key,task)
    try{let value=await task;if(!value.complete&&old?.value.complete)value={...old.value,complete:false,errors:value.errors};this.cache.set(key,{at:this.now(),value});if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);return value}finally{this.pending.delete(key)}
  }
  async month(snap:Snapshot,q:DashboardQuery,progress:ProgressRepository):Promise<DashboardMonth> {
    const [git,history]=await Promise.all([this.git(snap,q),progress.month(q)]),allowed=dashboardWorkIds(snap,q)
    const mappings=new Map<string,string>()
    for(const w of Object.values(snap.workspaces))if(w.pr?.number&&(!q.repoId||w.repoId===q.repoId)&&(q.topicPath===null||allowed.has(w.id)))mappings.set(`${w.repoId}:${w.pr.number}`,w.id)
    for(const e of history.events)if(e.workspace.pr?.number&&!mappings.has(`${e.workspace.repoId}:${e.workspace.pr.number}`))mappings.set(`${e.workspace.repoId}:${e.workspace.pr.number}`,e.workspace.id)
    const merged=git.records.map(r=>({...r,workspaceId:mappings.get(`${r.repoId}:${r.pr!.number}`)??null})).filter(r=>q.topicPath===null||!!r.workspaceId)
    return paginateDashboard(q,[...merged,...history.events.map(historyRecord)],{at:git.at,complete:git.complete,errors:git.errors,topicLimited:q.topicPath!==null},{startedAt:history.startedAt,lastAt:history.lastAt,partial:history.partial,beforeCollection:history.beforeCollection})
  }
}
export interface MachineView {at:number;host:string;platform:string;cpu:number|null;cpuCount:number;memory:{total:number;free:number};disk:{total:number;free:number}|null;battery:number|null;processes:{pid:number;name:string;cpu:number;rss:number}[];samples:{at:number;cpu:number|null}[];errors:string[]}
export function cpuDelta(previous:number[],current:number[]):number|null {if(previous.length!==current.length||previous.length<2||(previous.length>2&&previous[2]!==current[2]))return null;const idle=current[0]-previous[0],total=current[1]-previous[1];return total>0&&idle>=0&&idle<=total?Math.max(0,Math.min(100,100*(1-idle/total))):null}
export function processRows(text:string):MachineView['processes'] {return text.split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);if(!m)return [];const name=basename(m[4].trim());if(!/^(orca(?:[ .-]|$)|claude(?:[ .-]|$)|codex(?:[ .-]|$)|node$|bun$)/i.test(name))return [];const [pid,cpu,rss]=m.slice(1,4).map(Number);return Number.isFinite(cpu)&&pid>0?[{pid,cpu,rss:rss*1024,name:name.slice(0,100)}]:[]}).sort((a,b)=>b.cpu-a.cpu).slice(0,12)}
export class MachineSource {
  private previous:{at:number;times:number[]}|null=null;private cached:MachineView|null=null;private inflight:Promise<MachineView>|null=null;private samples:MachineView['samples']=[]
  constructor(private run:ReadCommand=readCommand){}
  async sample():Promise<MachineView>{if(this.cached&&Date.now()-this.cached.at<8000)return this.cached;if(this.inflight)return this.inflight
    this.inflight=(async()=>{const at=Date.now(),cores=cpus(),times=[cores.reduce((n,c)=>n+c.times.idle,0),cores.reduce((n,c)=>n+Object.values(c.times).reduce((a,b)=>a+b,0),0),cores.length];const cpu=this.previous&&at-this.previous.at<30_000?cpuDelta(this.previous.times,times):null;this.previous={at,times};this.samples.push({at,cpu});this.samples=this.samples.filter(s=>at-s.at<=600_000).slice(-80)
      const errors:string[]=[],disk=await statfs(process.cwd()).then(s=>({total:s.blocks*s.bsize,free:s.bavail*s.bsize})).catch(()=>{errors.push('디스크를 읽지 못했습니다');return null})
      const processes=platform()==='win32'?[]:await this.run('/bin/ps',['-A','-o','pid=,pcpu=,rss=,comm=']).then(processRows).catch(()=>{errors.push('프로세스를 읽지 못했습니다');return []})
      const battery=platform()==='darwin'?await this.run('/usr/bin/pmset',['-g','batt']).then(s=>{const m=/(\d+)%/.exec(s);return m?Number(m[1]):null}).catch(()=>null):null
      return this.cached={at,host:hostname(),platform:platform(),cpu,cpuCount:cores.length,memory:{total:totalmem(),free:freemem()},disk,battery,processes,samples:[...this.samples],errors}
    })();try{return await this.inflight}finally{this.inflight=null}
  }
}
