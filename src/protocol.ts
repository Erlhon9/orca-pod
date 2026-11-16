// 패널 <-> 워커 사이의 요청·알림 목록. 양쪽이 같은 이름을 쓰도록 한 곳에 적어 둔다.
import type { Snapshot } from './model'
import type { ChatItem } from './transcript'
import type { ControlView } from './runtime'
import type { ControlProvider } from './relay'
import type { ControlAgentOption } from './control-agents'

export {}

declare module 'orca' {
  interface PluginRequests {
    'pod.control.agents': { input: {}; output: ControlAgentOption[] }
    'pod.control.open': { input: {}; output: { opened: true } }
    'pod.language': { input: {}; output: { default: 'en'; preference: string } }
    'pod.control.view': { input: undefined | {}; output: ControlView & { provider: ControlProvider } }
    'pod.control.provider': { input: { provider: ControlProvider }; output: ControlView & { provider: ControlProvider } }
    'pod.control.send': { input: { text?: string; images?: { type: string; data: string }[] }; output: { sent: true } }
    'pod.control.stop': { input: {}; output: { stopped: true } }
    'pod.control.reset': { input: {}; output: { reset: true } }
    /** 전체 워크스페이스·에이전트 스냅샷. fresh 면 캐시를 건너뛴다. */
    'pod.snapshot': { input: { fresh?: boolean } | undefined; output: Snapshot }
    'pod.openWorkspace': { input: { id: string }; output: { opened: true } }
    'pod.focusAgent': { input: { id: string; agentKey: string }; output: { opened: true } }
    'pod.interrupt': { input: { terminal: string }; output: { sent: true } }
    'pod.tail': { input: { terminal: string }; output: { lines: string[] } }
    'pod.setStatus': { input: { id: string; status: string }; output: { ok: true } }
    'pod.setComment': { input: { id: string; comment: string }; output: { ok: true } }
    'pod.markRead': { input: { id: string }; output: { ok: true } }
    'pod.launchAgent': { input: { id: string; agent: string; prompt?: string }; output: { ok: true; terminal: string | null } }
    'pod.newTerminal': { input: { id: string; title?: string }; output: { ok: true; terminal: string | null } }
    'pod.createWorkspace': {
      input: { repoId: string; name: string; agent?: string; prompt?: string; parentId?: string; topicId?: string }
      output: { ok: true; id: string | null }
    }
    'pod.screen': { input: { terminal: string; lines?: number }; output: { lines: string[]; status: string } }
    /** 세션의 Claude 대화 기록. 못 찾으면 ok:false. */
    'pod.conversation': {
      input: { path: string; key: string; type: string; title?: string; prompt?: string }
      output: { ok: boolean; items: ChatItem[]; truncated: boolean; updatedAt: number }
    }
    'pod.closeTerminals': { input: { terminals: string[] }; output: { closed: number; failed: string[] } }
    'pod.saveTopics': { input: { repoId: string; topics: unknown }; output: { ok: true } }
    'pod.assignTopic': { input: { repoId: string; id: string; topicId: string | null }; output: { ok: true } }
    'pod.suggestTopics': { input: { repoId: string }; output: { topics: number; assigned: number } }
  }
  interface PluginPanelEvents {
    /** 에이전트·워크스페이스 이벤트 뒤 새 스냅샷. */
    'pod.changed': Snapshot
  }
}
