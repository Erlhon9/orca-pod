// 작업의 기억은 공급자나 세션 수와 무관하다. 자동 요약/완료 추정 대신 출처가 있는 최신 정보와 사람이 남긴 브리프를 분리한다.
import type { AgentView, WorkspaceView } from './model'
import { readQuestions } from './questions'

export interface WorkMemory {
  goal: string
  doneWhen: string
  nextStep: string
  note: string
  updatedAt: number
  reviewed: { fingerprint: string; at: number } | null
}

export type WorkJournal = Record<string, WorkMemory>
export type WorkReason = 'approval' | 'question' | 'checks' | 'review' | 'changed' | 'next' | 'working' | 'paused' | 'completed' | 'quiet'
export type WorkLane = 'attention' | 'ready' | 'moving' | 'parked'
export interface WorkBrief {
  workspace: WorkspaceView
  goal: string
  memory: WorkMemory
  reason: WorkReason
  lane: WorkLane
  rank: number
  target: AgentView | null
  latest: AgentView | null
  changed: boolean
}

const LIMITS = { goal: 600, doneWhen: 1200, nextStep: 600, note: 2000 } as const
export const WORK_MEMORY_LIMITS = LIMITS
export const WORK_JOURNAL_KEY = 'pod.work-journal.v1'
const safeText = (value: unknown, max: number): string => typeof value === 'string' ? value.trim().slice(0, max) : ''
const time = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

export function readWorkMemory(value?: unknown): WorkMemory {
  const raw = value && typeof value === 'object' ? value as Record<string, any> : {}
  const reviewed = raw.reviewed
  return {
    goal: safeText(raw.goal, LIMITS.goal),
    doneWhen: safeText(raw.doneWhen, LIMITS.doneWhen),
    nextStep: safeText(raw.nextStep, LIMITS.nextStep),
    note: safeText(raw.note, LIMITS.note),
    updatedAt: time(raw.updatedAt),
    reviewed: reviewed && typeof reviewed.fingerprint === 'string' && /^[a-f0-9]{8}:\d+$/.test(reviewed.fingerprint) && time(reviewed.at)
      ? { fingerprint: reviewed.fingerprint, at: time(reviewed.at) } : null
  }
}

export function readWorkJournal(value: unknown): WorkJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 2000)
    .filter(([id, entry]) => id.length > 0 && id.length <= 2000 && entry && typeof entry === 'object' && !Array.isArray(entry))
    .map(([id, entry]) => [id, readWorkMemory(entry)]))
}

/** 저장하는 것은 본문이 아닌 변화 감지용 지문이다. 갱신 시각/배열 순서만 바뀌어서는 새 작업으로 표시하지 않는다. */
export function workFingerprint(w: WorkspaceView): string {
  const text = JSON.stringify([
    w.name, w.branch, w.status, w.comment,
    w.pr && [w.pr.number, w.pr.state, w.pr.title, w.pr.checks],
    [...w.agents].sort((a, b) => a.key.localeCompare(b.key)).map(a => [a.key, a.type, a.state, a.title, a.prompt, a.lastMessage, a.tool, a.interrupted])
  ])
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`
}

export function reviewWork(w: WorkspaceView, memory: WorkMemory, now = Date.now()): WorkMemory {
  return { ...memory, reviewed: { fingerprint: workFingerprint(w), at: now } }
}

export function workBrief(w: WorkspaceView, value?: WorkMemory): WorkBrief {
  const memory = readWorkMemory(value)
  const agents = [...w.agents].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
  const approval = agents.find(a => a.state === 'blocked')
  const question = agents.find(a => a.state === 'waiting' && a.tool?.name==='AskUserQuestion' && readQuestions(a.tool.input).length)
  const working = agents.find(a => a.state === 'working')
  const latest = agents.find(a => a.lastMessage.trim()) ?? null
  const changed = memory.reviewed ? memory.reviewed.fingerprint !== workFingerprint(w) : w.unread
  let reason: WorkReason
  let lane: WorkLane
  let rank: number
  let target: AgentView | null = null
  if (approval) { reason = 'approval'; lane = 'attention'; rank = 0; target = approval }
  else if (question) { reason = 'question'; lane = 'attention'; rank = 1; target = question }
  else if (w.pr?.state === 'open' && w.pr.checks === 'failure') { reason = 'checks'; lane = 'attention'; rank = 2 }
  else if (w.status === 'completed' && !working) { reason = 'completed'; lane = 'parked'; rank = 9 }
  else if (w.status === 'on-hold' && !working) { reason = 'paused'; lane = 'parked'; rank = 8 }
  else if (w.status === 'in-review') { reason = 'review'; lane = 'ready'; rank = 3; target = latest }
  else if (changed && !working) { reason = 'changed'; lane = 'ready'; rank = 4; target = latest }
  else if (memory.nextStep) { reason = 'next'; lane = working ? 'moving' : 'ready'; rank = 5; target = working ?? null }
  else if (working) { reason = 'working'; lane = 'moving'; rank = 6; target = working }
  else { reason = 'quiet'; lane = 'parked'; rank = 7; target = latest }
  return { workspace: w, goal: memory.goal || w.name, memory, reason, lane, rank, target, latest, changed }
}

export function sortWorkBriefs(briefs: WorkBrief[]): WorkBrief[] {
  return [...briefs].sort((a, b) => a.rank - b.rank || Number(b.changed) - Number(a.changed) || b.workspace.lastActivityAt - a.workspace.lastActivityAt || a.workspace.id.localeCompare(b.workspace.id))
}

/** 잘린 인용임을 UI에서 표시한다. 내용을 재작성하거나 성공/결정을 추론하지 않는다. */
export function workExcerpt(text: string, max = 260): string {
  const plain = text.replace(/\r\n/g, '\n').trim()
  if (plain.length <= max) return plain
  return `${plain.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
