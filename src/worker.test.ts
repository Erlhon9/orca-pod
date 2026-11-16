// 워커의 입력 검증: 빈 값이나 엉뚱한 값은 CLI 를 부르기 전에 거절한다.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'
import { readFile, unlink } from 'node:fs/promises'
import { ATTACH_DIR, cleanTopics, mergeSuggested, pickControlHome, userMessage } from './worker'

test('빈 메시지는 보내지 않는다', async () => {
  const worker = await mountWorker(main, { host: mockHost({}) })
  let failed = false
  try {
    await worker.request('pod.control.send', { text: '' })
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  await worker.deactivate()
})

test('터미널 핸들이 없으면 중단 신호를 보내지 않는다', async () => {
  const worker = await mountWorker(main, { host: mockHost({}) })
  let failed = false
  try {
    await worker.request('pod.interrupt', { terminal: '' })
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  await worker.deactivate()
})

test('주제 정리: 빈 이름은 버리고 같은 이름은 다른 id 를 준다', () => {
  const out = cleanTopics([
    { name: '결제', keywords: ['결제', ' 결제 ', ''] },
    { name: '' },
    { name: '결제', keywords: [] }
  ])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0].keywords, ['결제'])
  assert.notEqual(out[0].id, out[1].id)
})

test('하위 섹션: 상위 id 는 남기고, 없는 상위·순환은 끊는다', () => {
  const out = cleanTopics([
    { id: 'a', name: '결제', keywords: [] },
    { id: 'b', name: '상품', keywords: [], parent: 'a' },
    { id: 'c', name: '고아', keywords: [], parent: 'zzz' },
    { id: 'd', name: '순환1', keywords: [], parent: 'e' },
    { id: 'e', name: '순환2', keywords: [], parent: 'd' }
  ])
  const by = Object.fromEntries(out.map((t) => [t.id, t.parent]))
  assert.equal(by.b, 'a')
  assert.equal(by.c, undefined)
  assert.ok(by.d === undefined || by.e === undefined)
})

test('AI 로 다시 뽑아도 같은 이름 주제 id·하위 주제·「기타」 고정은 남는다', () => {
  const prev = {
    topics: [
      { id: 'pay', name: '결제', keywords: [] },
      { id: 'prod', name: '상품', keywords: [], parent: 'pay' },
      { id: 'old', name: '없어질 주제', keywords: [] }
    ],
    assign: { w1: 'prod', w2: '_', w3: 'old' }
  }
  const fresh = [
    { id: 'payx', name: '결제', keywords: ['결제'] },
    { id: 'settle', name: '정산', keywords: [] }
  ]
  const out = mergeSuggested(prev, fresh, { w3: 'settle', w4: 'payx' })
  assert.deepEqual(out.topics.map((t) => t.id), ['pay', 'settle', 'prod'])
  assert.equal(out.assign.w1, 'prod')
  assert.equal(out.assign.w2, '_')
  assert.equal(out.assign.w3, 'settle')
  assert.equal(out.assign.w4, 'pay')
})

test('주제 id 「_」(기타 예약)는 받지 않는다', () => {
  const out = cleanTopics([{ id: '_', name: '기타2', keywords: [] }])
  assert.notEqual(out[0].id, '_')
})

test('실패 문구: 한국어 원문은 첫 줄, 영어·명령 경로는 고정 문구', () => {
  assert.equal(userMessage('워크트리를 찾지 못했습니다\n자세히'), '워크트리를 찾지 못했습니다')
  assert.equal(userMessage('Command failed: /usr/local/bin/orca worktree set'), 'Orca 명령이 실패했습니다')
})

test('붙인 사진은 임시 폴더에 저장하고 경로를 돌려준다', async () => {
  const worker = await mountWorker(main, { host: mockHost({}) })
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const r = (await worker.request('pod.saveImage', { type: 'image/png', data: png.toString('base64') })) as { path: string }
  assert.equal(r.path.startsWith(ATTACH_DIR), true)
  assert.equal(r.path.endsWith('.png'), true)
  assert.equal(Buffer.compare(await readFile(r.path), png), 0)
  await unlink(r.path)
  await worker.deactivate()
})

test('사진이 아닌 파일은 저장하지 않는다', async () => {
  const worker = await mountWorker(main, { host: mockHost({}) })
  let failed = false
  try {
    await worker.request('pod.saveImage', { type: 'text/html', data: Buffer.from('<b>x</b>').toString('base64') })
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  await worker.deactivate()
})

test('터미널 핸들이 없으면 탭으로 이동하지 않는다', async () => {
  const worker = await mountWorker(main, { host: mockHost({}) })
  let failed = false
  try {
    await worker.request('pod.focusTerminal', {})
  } catch {
    failed = true
  }
  assert.equal(failed, true)
  await worker.deactivate()
})

test('관제는 Claude 가 최근에 돈 저장소에, 그 저장소 메인 워크트리에서 Claude 가 돈 적이 있으면 거기서 띄운다', () => {
  const w = (id: string, repoId: string, isMain: boolean, at: number) =>
    ({ id, repoId, isMain, agents: at ? [{ type: 'claude', updatedAt: at }] : [] }) as any
  const snap = (ws: any[]) => ({ workspaces: Object.fromEntries(ws.map((x) => [x.id, x])) }) as any
  assert.equal(pickControlHome(snap([w('a', 'r1', true, 0), w('b', 'r2', false, 50), w('c', 'r2', true, 10)])), 'c')
  assert.equal(pickControlHome(snap([w('a', 'r1', true, 0), w('b', 'r2', false, 50)])), 'b')
  assert.equal(pickControlHome(snap([w('a', 'r1', true, 0)])), null)
})
