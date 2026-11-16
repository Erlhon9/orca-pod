import type { AgentView, Snapshot, WorkspaceView } from '../model'
import { topicPath } from '../model'
import { t } from './i18n'

export interface ControlTarget {
  workspaceId: string
  sessionKey: string | null
}

export const targetKey = (target: ControlTarget): string => JSON.stringify([target.workspaceId, target.sessionKey])

export function addTarget(targets: ControlTarget[], next: ControlTarget): ControlTarget[] {
  return targets.some(target => targetKey(target) === targetKey(next)) ? targets : [...targets, next]
}

export function resolveTarget(snap: Snapshot | null, target: ControlTarget): { workspace: WorkspaceView; agent?: AgentView } | null {
  const workspace = snap?.workspaces[target.workspaceId]
  if (!workspace) return null
  if (target.sessionKey === null) return { workspace }
  const agent = workspace.agents.find(agent => agent.key === target.sessionKey)
  return agent ? { workspace, agent } : null
}

/** IDs stay out of the editor; expand exact references only when submitting. */
export function refOf(snap: Snapshot | null, w: WorkspaceView, a?: AgentView): string {
  const repo = snap?.repos.find(repo => repo.id === w.repoId)
  const topic = repo && w.topic ? topicPath(repo.topics, w.topic) : ''
  const where = [repo?.name, topic, w.name].filter(Boolean).join(' › ')
  if (!a) return t(`[워크스페이스 {where} · ID {id}]`, { where, id: w.id })
  const how = a.terminal ? t(`터미널 {terminal}`, { terminal: a.terminal }) : t('대화창')
  return t(`[세션 {where} / {title} · {how} · ID {key}]`, { where, title: a.title, how, key: a.key })
}

export class MissingControlTargetError extends Error {}
export class ControlMessageTooLongError extends Error {}

export function controlMessage(snap: Snapshot | null, targets: ControlTarget[], text: string): string {
  if (!targets.length) return text
  const refs = targets.map(target => {
    const resolved = resolveTarget(snap, target)
    if (!resolved) throw new MissingControlTargetError('Selected Control target is no longer available')
    return refOf(snap, resolved.workspace, resolved.agent)
  })
  const message = [...refs, text].join('\n')
  // The worker accepts at most 20,000 characters; never silently truncate a target ID.
  if (message.length > 20_000) throw new ControlMessageTooLongError('Control message exceeds 20,000 characters')
  return message
}
