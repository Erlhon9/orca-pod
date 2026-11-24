import type { WorkPriority } from '../work-priority'
import { h } from './ui'
import { t, tt } from './i18n'
export function priorityBadge(priority:WorkPriority,onClick?:(el:HTMLElement)=>void):HTMLElement {
  const el=h(onClick?'button':'span',{class:'work-priority','data-priority':priority.level,title:tt(priority.reason)+(priority.source==='manual'?' · '+t('사용자 지정'):''),'aria-label':t('중요도 {level}: {reason}',{level:priority.level,reason:tt(priority.reason)})},priority.level)
  if(onClick){el.addEventListener('pointerdown',e=>e.stopPropagation());el.addEventListener('click',e=>{e.stopPropagation();onClick(el)})}
  return el
}
