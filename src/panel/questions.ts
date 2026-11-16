import type { SessionQuestion } from '../questions'
import { t } from './i18n'
import { h, icon } from './ui'

/** 읽기 전용 질문 카드. 답변은 해당 Orca 세션에서 한다. */
export function questionCard(questions: SessionQuestion[], onOpen?: () => void): HTMLElement {
  return h('section', { class: 'session-questions' },
    h('div', { class: 'sq-heading' }, icon('message'), t('질문')),
    questions.map(q => h('div', { class: 'sq-question' },
      q.header ? h('div', { class: 'sq-label' }, q.header) : null,
      h('div', { class: 'sq-text' }, q.question),
      q.options.length ? h('ol', { class: 'sq-options' }, q.options.map(o => h('li', null, h('strong', null, o.label), o.description ? h('div', null, o.description) : null))) : null,
      q.multiSelect ? h('div', { class: 'sq-note' }, t('여러 항목을 선택할 수 있어요')) : null
    )),
    onOpen
      ? h('button', { class: 'pill-btn primary sq-open', onClick: (ev: Event) => { ev.stopPropagation(); onOpen() } }, icon('open'), t('Orca에서 답변하기'))
      : h('div', { class: 'sq-note' }, t('Orca에서 이 세션을 열어 답변하세요'))
  )
}
