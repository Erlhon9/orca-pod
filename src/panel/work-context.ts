// 그래프 옆 맥락 보기. 같은 창에서 작업 기억과 세션 원문을 오간다.
import type { AgentView, WorkspaceView } from '../model'
import { workBrief, workExcerpt, type WorkBrief, type WorkMemory, type WorkReason } from '../work-memory'
import { t } from './i18n'
import { AGENT_STATE_LABEL, agentName, agoFull, avatar, h, icon, statusColor, statusLabel } from './ui'

export interface WorkContextApi {
  memory(id: string): WorkMemory | undefined
  session(w: WorkspaceView, a: AgentView): void
  edit(w: WorkspaceView): void
  review(w: WorkspaceView): Promise<void>
  launch(w: WorkspaceView): void
}

export function reasonLabel(reason: WorkReason): string {
  const labels: Record<WorkReason, string> = {
    approval: t('승인을 기다려요'), question: t('답변을 기다려요'), checks: t('PR 체크가 실패했어요'),
    review: t('리뷰 단계예요'), changed: t('확인할 변경이 있어요'), next: t('다음 행동을 남겨뒀어요'),
    working: t('작업이 진행 중이에요'), paused: t('잠시 보류한 작업이에요'), completed: t('완료로 표시한 작업이에요'), quiet: t('이어서 볼 수 있어요')
  }
  return labels[reason]
}

export function nextAction(brief: WorkBrief): string {
  switch (brief.reason) {
    case 'approval': return t('요청 내용을 확인하고 Orca에서 승인 여부를 결정하세요')
    case 'question': return t('질문과 선택지를 확인하세요')
    case 'checks': return t('실패한 PR 체크를 확인하세요')
    default: return brief.memory.nextStep || (brief.reason === 'review' ? t('결과와 완료 조건을 비교해 보세요') : t('최근 맥락을 확인하고 다음 행동을 남겨보세요'))
  }
}

/** 브리프는 사람이 쓴 목표/조건과 세션 발췌를 명확히 나눠 보여준다. */
export function workOverview(w: WorkspaceView, api: WorkContextApi): HTMLElement {
  const brief = workBrief(w, api.memory(w.id))
  const m = brief.memory
  const section = (title: string, text: string, empty: string, cls = '') => h('section', { class: `brief-field ${cls}` }, h('h4', null, title), h('p', { class: text ? '' : 'muted' }, text || empty))
  const action = h('button', { class: 'pill-btn primary' }, icon('check'), t('여기까지 확인했어요')) as HTMLButtonElement
  action.addEventListener('click', () => {
    action.disabled = true
    void api.review(w).finally(() => { action.disabled = false }).catch(() => {})
  })
  const agents = [...w.agents].sort((a, b) => b.updatedAt - a.updatedAt)
  return h('div', { class: 'work-brief' },
    h('div', { class: 'brief-status', 'data-reason': brief.reason }, reasonLabel(brief.reason)),
    h('div', { class: 'brief-toolbar' },
      h('button', { class: 'pill-btn', onClick: () => api.edit(w) }, icon('edit'), t('기억 편집')),
      h('button', { class: 'pill-btn', onClick: () => api.launch(w) }, icon('plus'), t('에이전트 선택'))),
    h('div', { class: 'brief-fields' },
      m.goal ? section(t('목표'), m.goal, '') : null,
      m.doneWhen ? section(t('완료 조건'), m.doneWhen, '') : null,
      section(t('다음 행동'), nextAction(brief), '', 'brief-next'),
      brief.target && (brief.reason === 'approval' || brief.reason === 'question') ? h('button', { class: 'pill-btn brief-attention-open', onClick: () => api.session(w, brief.target!) }, icon('message'), t('대기 중인 세션 확인'), h('span', null, brief.target.title)) : null,
      m.nextStep && nextAction(brief) !== m.nextStep ? section(t('남겨둔 다음 행동'), m.nextStep, '') : null,
      m.note ? section(t('기억할 것'), m.note, '') : null,
      w.comment ? section(t('워크스페이스 메모'), w.comment, '') : null),
    brief.latest ? h('section', { class: 'brief-latest' },
      h('h4', null, t('최근 답변 발췌')),
      h('p', null, workExcerpt(brief.latest.lastMessage, 600)),
      h('button', { class: 'mini-btn', onClick: () => api.session(w, brief.latest!) }, t('세션 원문 보기'), icon('open'))) : null,
    h('div', { class: 'brief-evidence' },
      h('span', { class: 'state-pill', style: { '--c': statusColor(w.status) } }, h('i'), statusLabel(w.status)),
      w.pr ? h('span', null, `PR #${w.pr.number} · ${w.pr.state}${w.pr.checks ? ` · ${w.pr.checks}` : ''}`) : null,
      h('p', null, t('완료 조건은 직접 확인해 주세요. 세션 종료가 작업 완료를 뜻하지는 않아요.'))),
    h('div', { class: 'brief-context-heading' }, icon('book'), h('h3', null, t('맥락 자세히 보기')), h('span', { class: 'brief-count' }, agents.length)),
    h('p', { class: 'brief-context-hint' }, t('각 세션의 최근 요청과 답변 발췌예요. 원문에서 전체 흐름을 확인할 수 있어요.')),
    agents.length ? h('div', { class: 'brief-context-list' }, agents.map(a => h('details', { class: 'brief-context', 'data-context-key': a.key },
      h('summary', null, avatar(a, 'sm'), h('span', { class: 'brief-context-title' }, a.title), h('span', { class: 'brief-context-state', 'data-state': a.state }, AGENT_STATE_LABEL[a.state]), icon('chevron')),
      h('div', { class: 'brief-context-body' },
        h('div', { class: 'brief-source' }, agentName(a.type), a.updatedAt ? t(' · 세션 갱신 {when}', { when: agoFull(a.updatedAt) }) : ''),
        a.prompt ? section(t('최근 요청 발췌'), workExcerpt(a.prompt, 1800), '') : null,
        a.lastMessage ? section(t('최근 답변 발췌'), workExcerpt(a.lastMessage, 2400), '') : h('p', { class: 'muted' }, t('아직 가져온 답변이 없어요')),
        h('button', { class: 'pill-btn', onClick: () => api.session(w, a) }, icon('message'), t('세션 원문 보기'))))))
      : h('div', { class: 'brief-no-context' }, t('세션을 시작하면 이곳에서 맥락을 이어볼 수 있어요')),
    h('div', { class: 'brief-review' },
      h('span', { class: 'muted' }, m.reviewed ? t('마지막 확인 {when}', { when: agoFull(m.reviewed.at) }) : t('확인 기록이 아직 없어요')), action))
}
