// Claude 대화 기록 → 대화 보기 항목 변환 규칙을 고정한다.
import { assert, test } from 'orca/testing'
import { chatSessionId, claudeProjectDir, emptyState, feed, takeAttachments, toolDetail } from './transcript'

const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`
const at = '2026-11-13T01:00:00.000Z'

test('기록 폴더 이름은 영숫자 밖을 모두 - 로 바꾼다', () => {
  assert.equal(claudeProjectDir('/Users/me/projects/새-기능'), '-Users-me-projects-----')
})

test('대화창 세션 키에서 Claude 세션 id 를 꺼낸다', () => {
  assert.equal(
    chatSessionId('structured-agent-session-claude_a7ea9ab9_f831_4f6d_b447_69ac30910310:5fa076b2-41'),
    'a7ea9ab9-f831-4f6d-b447-69ac30910310'
  )
  assert.equal(chatSessionId('tab:leaf'), null)
})

test('사람 말·답변·도구 호출을 순서대로 뽑고 시스템 블록은 걷어 낸다', () => {
  const s = feed(
    emptyState(),
    line({ type: 'user', timestamp: at, message: { content: '고쳐줘<system-reminder>숨김</system-reminder>' } }) +
      line({ type: 'user', timestamp: at, isMeta: true, message: { content: '메타' } }) +
      line({
        type: 'assistant',
        timestamp: at,
        message: {
          content: [
            { type: 'thinking', thinking: '생각' },
            { type: 'text', text: '보겠습니다' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'List files' } }
          ]
        }
      }) +
      line({ type: 'user', timestamp: at, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x' }] } }) +
      line({ type: 'user', timestamp: at, message: { content: '<command-name>/compact</command-name>' } }) +
      line({ type: 'user', timestamp: at, isSidechain: true, message: { content: '서브에이전트' } })
  )
  assert.deepEqual(
    s.items.map((i) => i.k),
    ['user', 'text', 'tool', 'note']
  )
  assert.equal((s.items[0] as { text: string }).text, '고쳐줘')
  const tool = s.items[2] as { detail: string; error: boolean }
  assert.equal(tool.detail, 'List files')
  assert.equal(tool.error, true)
  assert.equal((s.items[3] as { text: string }).text, '/compact')
})

test('덜 쓰인 마지막 줄은 다음에 이어 읽는다', () => {
  const full = line({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text: '끝' }] } })
  let s = feed(emptyState(), full.slice(0, 20))
  assert.equal(s.items.length, 0)
  s = feed(s, full.slice(20))
  assert.equal(s.items.length, 1)
})

test('사용자 제목이 자동 제목보다 앞선다', () => {
  const s = feed(
    emptyState(),
    line({ type: 'ai-title', aiTitle: '자동' }) + line({ type: 'custom-title', customTitle: '내 제목' }) + line({ type: 'ai-title', aiTitle: '자동2' })
  )
  assert.equal(s.customTitle || s.aiTitle, '내 제목')
})

test('도구 요약: 파일은 이름만, MCP 는 첫 문자열', () => {
  assert.equal(toolDetail('Read', { file_path: '/a/b/c.ts' }), 'c.ts')
  assert.equal(toolDetail('mcp__x__y', { q: '  찾기  ' }), '찾기')
})

test('입력창에서 붙인 사진 경로는 사진 수로 바꾸고 지시만 남긴다', () => {
  const dir = '/var/folders/x/T/pod-attachments'
  assert.deepEqual(takeAttachments(`${dir}/1-a.png ${dir}/2-b.jpg 이거 봐줘`), { text: '이거 봐줘', count: 2 })
  assert.deepEqual(takeAttachments(`${dir}/1-a.png`), { text: '', count: 1 })
  assert.deepEqual(takeAttachments('그냥 /tmp/a.png 경로'), { text: '그냥 /tmp/a.png 경로', count: 0 })
  const s = feed(emptyState(), JSON.stringify({ type: 'user', timestamp: '2026-11-13T01:00:00.000Z', message: { content: `${dir}/1-a.png 봐줘` } }) + '\n')
  assert.deepEqual(s.items.map((i) => (i.k === 'user' ? [i.text, i.images] : null)), [['봐줘', 1]])
})
