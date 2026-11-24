import { historicalSnapshot, progressDate, type ProgressEvent, type ProgressView } from '../progress'
import type { Snapshot } from '../model'
import { currentLang, t, tt } from './i18n'
import { avatar, clip, fill, h, icon } from './ui'
import { closeMenu, hideHover, openMenu } from './overlays'

export interface ProgressApi {
  call<T=any>(name:string,input?:unknown,quiet?:boolean):Promise<T>
  scope():{repoId:string|null;topicPath:string[]|null}
  changed():void
  select(workspaceId:string,sessionKey:string|null):void
  resume(workspaceId:string,sessionKey:string|null):boolean
}
const kindLabel=(kind:string):string=>({response:t('응답'),question:t('질문'),status:t('상태'),note:t('메모'),pr:'PR',investigation:t('조사'),decision:t('결정'),verification:t('검증'),completion:t('완료')} as Record<string,string>)[kind]??kind
export function createProgress(api:ProgressApi) {
  const el=h('div',{class:'progress-strip'})
  let date:string|null=null,view:ProgressView|null=null,viewKey='',requestKey='',generation=0,loading=false,error:string|null=null,selected:string|null=null,saving=false,workLimit=5
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'
  const today=()=>progressDate(Date.now(),timezone)
  const scopeKey=()=>JSON.stringify([date??today(),api.scope()])
  const key=()=>JSON.stringify([scopeKey(),selected])
  const ready=()=>viewKey===scopeKey()?view:null
  const announce=()=>{render();api.changed()}
  async function refresh(more=false):Promise<void> {
    const queryKey=key(),version=++generation,previous=ready()
    requestKey=queryKey;loading=true;error=null;render()
    try {
      const result=await api.call<ProgressView>('pod.progress.view',{date:date??today(),timezone,...api.scope(),workspaceId:selected,...(more&&previous?.nextCursor?{cursor:previous.nextCursor}:{})},true)
      if(version!==generation||key()!==queryKey)return
      if(!result||!Array.isArray(result.events)||!Array.isArray(result.workspaces))throw new Error(t('작업 기록을 불러오지 못했습니다'))
      view=more&&previous?{...result,events:[...previous.events,...result.events]}:result
      viewKey=scopeKey()
    } catch(e) {if(version===generation)error=tt((e as Error).message||t('작업 기록을 불러오지 못했습니다'))}
    finally {if(version===generation){loading=false;announce()}}
  }
  function choose(next:string|null):void {closeMenu();hideHover();date=next;selected=null;workLimit=5;requestKey='';announce();if(requestKey!==key())void refresh()}
  function shift(delta:number):void {const d=new Date((date??today())+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+delta);choose(d.toISOString().slice(0,10))}
  async function change(input:unknown):Promise<void> {
    if(saving)return
    saving=true;error=null;announce()
    try{await api.call('pod.progress.change',input,true);await refresh()}
    catch(e){error=tt((e as Error).message);announce()}
    finally{saving=false;announce()}
  }
  function eventRow(e:ProgressEvent):HTMLElement {
    const time=new Intl.DateTimeFormat(currentLang(),{timeZone:timezone,hour:'2-digit',minute:'2-digit',hour12:false}).format(e.at)
    const select=h('button',{class:'progress-entry-select',onClick:()=>{selected=e.workspace.id;api.select(e.workspace.id,e.sessionKey);announce()}},
      h('time',null,time),h('span',{class:'progress-entry-mark','data-kind':e.kind},icon(e.confirmedBy?'check':e.kind==='question'?'message':'book')),
      h('span',{class:'progress-entry-title'},h('strong',null,e.kind==='response'||e.confirmedBy==='user'?clip(e.evidence.replace(/[#*`]/g,'').replace(/\s+/g,' '),80):tt(e.title)),h('small',null,`${kindLabel(e.kind)} · ${e.workspace.repo} / ${e.workspace.name}`)))
    const details=h('details',{class:'progress-evidence','data-event-id':e.id},h('summary',null,t('근거')),
      h('p',null,e.evidence),h('small',null,e.retracted?t('진전 기록 취소됨'):e.confirmedBy==='user'?t('사용자 확인'):e.confirmedBy==='observation'?t('검사 결과 관측'):t('최근 관측')))
    if((['response','note'].includes(e.kind)||e.confirmedBy==='user')&&!e.retracted) {
      const confirm=h('button',{class:'mini-btn',disabled:saving,title:t('기록 분류'),onClick:()=>openMenu(confirm,(['investigation','decision','verification','completion'] as const).map(kind=>({label:kindLabel(kind),onSelect:()=>void change({id:e.id,kind})})),confirm,{keyboard:true})},t('기록 분류'))
      details.append(confirm)
    }
    if(e.confirmedBy==='user'&&!e.retracted)details.append(h('button',{class:'mini-btn',disabled:saving,onClick:()=>void change({id:e.id,retract:true})},t('진전 기록 취소')))
    return h('article',{class:'progress-entry','data-work':e.workspace.id},select,details,h('button',{class:'mini-btn progress-resume',onClick:()=>{const previous=date;date=null;if(!api.resume(e.workspace.id,e.sessionKey)){date=previous;return}selected=null;requestKey='';announce();if(requestKey!==key())void refresh()}},t('현재에서 이어가기'),icon('chevron')))
  }
  function context():HTMLElement {
    const data=ready(),root=h('div',{class:'progress-context'}),head=h('div',{class:'dk-context-head'},h('strong',null,date??today()),h('span',{class:'progress-readonly'},t('기록')))
    root.append(head)
    if(error||data?.error)root.append(h('p',{class:'error'},error||tt(data!.error!)),h('button',{class:'mini-btn',disabled:loading,onClick:()=>void refresh()},t('다시 시도')))
    if(!data) {if(loading)root.append(h('span',{class:'muted'},t('불러오는 중…')));return root}
    if(data.beforeCollection)root.append(h('p',{class:'muted'},t('기록 수집 전')))
    else if(!data.count)root.append(h('p',{class:'muted'},t('기록된 변화 없음')))
    if(data.partial)root.append(h('div',{class:'progress-coverage'},t('일부 시간의 기록이 없어요')))
    if(selected)root.append(h('button',{class:'mini-btn',onClick:()=>{selected=null;announce()}},t('이날 전체 기록')))
    if(selected) {
      if(data.workspaceId===selected){root.append(h('div',{class:'progress-entries'},data.events.map(eventRow)));if(data.nextCursor)root.append(h('button',{class:'mini-btn',disabled:loading,onClick:()=>void refresh(true)},t('이전 기록 더 보기')))}
      else root.append(h('span',{class:'muted'},t('불러오는 중…')))
    } else {
      root.append(h('div',{class:'progress-day-works'},data.workspaces.slice(0,workLimit).map(work=>{
        const mark=data.marks?.[work.id],latest=data.events.find(e=>e.workspace.id===work.id)
        return h('button',{class:'progress-day-work','data-work':work.id,onClick:()=>{selected=work.id;api.select(work.id,null);announce()}},
          h('span',{class:'progress-work-avatar'},work.agents[0]?avatar(work.agents[0],'sm'):icon('folder')),h('span',{class:'progress-work-label'},h('strong',null,work.name),h('small',null,latest?clip(latest.evidence.replace(/[#*`]/g,'').replace(/\s+/g,' '),85):work.repo)),
          h('span',{class:'progress-work-count'},t('기록 {n}건',{n:mark?.count??0})),icon('chevron'))
      })))
      if(data.workspaces.length>workLimit)root.append(h('button',{class:'mini-btn',onClick:()=>{workLimit+=5;announce()}},t('작업 더 보기')))
    }
    return root
  }
  function render():void {
    const data=ready(),label=date??today(),input=h('input',{type:'date',class:'progress-date',value:label,max:today(),'aria-label':t('날짜별 기록'),onChange:(e:Event)=>{const value=(e.target as HTMLInputElement).value;if(value&&value<=today())choose(value)}})
    fill(el,h('button',{class:`progress-now${!date?' on':''}`,onClick:()=>choose(null)},t('지금')),
      date?h('button',{class:'icon-btn',title:t('이전 날짜'),onClick:()=>shift(-1)},icon('back')):null,input,
      date?h('button',{class:'icon-btn',title:t('다음 날짜'),disabled:label>=today(),onClick:()=>shift(1)},icon('chevron')):null,
      !date?h('button',{class:'progress-today',onClick:()=>choose(today())},data?.count?t('오늘 기록 {n}건',{n:data.count}):t('오늘 기록')):h('span',{class:'progress-date-label'},t('기록')),
      error||data?.error?h('button',{class:'progress-load-error',title:error||data?.error||'',onClick:()=>void refresh()},icon('alert'),t('기록 갱신 실패')):null,
      h('span',{class:'spacer'}))
    el.dataset.history=String(!!date)
  }
  render()
  return {el,refresh,update:()=>{if(requestKey!==key())void refresh();else render()},
    history:()=>date?{key:JSON.stringify([date,viewKey,selected,workLimit,view?.events.map(e=>[e.id,e.kind,e.retracted]),loading,error,saving]),empty:!ready()?.count,content:context}:null,
    snapshot:()=>date?historicalSnapshot(ready()?.workspaces??[],ready()?.lastAt??Date.now()):null,
    isHistory:()=>!!date,
    select:(id:string,session:string|null)=>{selected=id;api.select(id,session);announce()},selection:()=>selected,
    mark:(id:string)=>{const data=ready(),mark=data?.marks?.[id];return mark?{count:mark.count,history:!!date}:null}
  }
}
