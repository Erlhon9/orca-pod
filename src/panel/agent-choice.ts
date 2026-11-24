// 역할을 공급자에 고정하지 않는다. Orca의 기존 에이전트 목록에서 사용자가 직접 고른다.
import { CONTROL_AGENTS, type ControlAgentOption } from '../control-agents'
import { t } from './i18n'
import { h } from './ui'

export function agentChoice(initial: string, call: <T>(name: string, input?: unknown, quiet?: boolean) => Promise<T>): { el: HTMLElement; value: () => string } {
  const select = h('select', { class: 'agent-choice', 'aria-label': t('에이전트') }) as HTMLSelectElement
  const detected = new Set<string>()
  const draw = () => {
    const chosen = select.value || initial
    const sorted = [...CONTROL_AGENTS].sort((a, b) => Number(detected.has(b.id)) - Number(detected.has(a.id)))
    select.replaceChildren(...sorted.map(a => h('option', { value: a.id }, a.label, detected.has(a.id) ? t(' · 감지됨') : '')))
    select.value = sorted.some(a => a.id === chosen) ? chosen : 'claude'
  }
  draw()
  void call<ControlAgentOption[]>('pod.control.agents', {}, true).then(options => {
    for (const a of options) if (a.detected) detected.add(a.id)
    // 사용자가 고른 값을 비동기 목록이 덮어쓰지 않는다.
    draw()
  }).catch(() => {})
  return {
    el: h('label', { class: 'field' }, h('span', null, t('에이전트')), select, h('span', { class: 'muted' }, t('설치와 로그인 상태에 따라 Orca에서 실행할 수 있어요'))),
    value: () => select.value
  }
}
