export interface SessionQuestion {
  header: string
  question: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

/** 질문 도구의 JSON만 읽는다. 텍스트는 실행하거나 HTML로 해석하지 않는다. */
export function readQuestions(input: unknown): SessionQuestion[] {
  if (typeof input === 'string') {
    if (input.length > 256_000) return []
    try { input = JSON.parse(input) } catch { return [] }
  }
  const list = (input as any)?.questions
  if (!Array.isArray(list)) return []
  const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 8000) : ''
  return list.slice(0, 16).flatMap(q => {
    if (!q || typeof q !== 'object' || !text(q.question)) return []
    return [{ header: text(q.header), question: text(q.question), multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options) ? q.options.slice(0, 24).flatMap((o: any) => o && text(o.label) ? [{ label: text(o.label), description: text(o.description) }] : []) : [] }]
  })
}

/** 마지막 질문이 해결됐으면 과거의 미해결 질문을 다시 표시하지 않는다. */
export function pendingQuestions(items: { k: string; questions?: SessionQuestion[]; resolved?: boolean }[]): SessionQuestion[] {
  for (const item of [...items].reverse()) if (item.k === 'tool' && item.questions?.length) return item.resolved ? [] : item.questions
  return []
}
