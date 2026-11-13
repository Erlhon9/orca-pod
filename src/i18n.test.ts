import { assert, test } from 'orca/testing'
import { readFileSync, readdirSync } from 'node:fs'
import { EN } from './panel/i18n-en'
import { resolveLang, normalizePref, translate, translateText, setLangPref } from './panel/i18n'
import { AGENT_STATE_LABEL, ago, duration } from './panel/ui'
import { findKeys, findUnwrapped } from './i18n-scan'

test('새 사용자는 영어를 기본으로 쓰고 명시한 언어 설정은 보존한다', () => {
  assert.equal(normalizePref(null), 'en')
  assert.equal(normalizePref(undefined), 'en')
  assert.equal(normalizePref('ko'), 'ko')
  assert.equal(normalizePref('auto'), 'auto')
})

test('언어 자동 선택과 명시 설정을 구분한다', () => {
  assert.equal(resolveLang('auto', 'ko-KR'), 'ko')
  assert.equal(resolveLang('auto', 'en-US'), 'en')
  assert.equal(resolveLang('en', 'ko-KR'), 'en')
  assert.equal(resolveLang('ko', 'en-US'), 'ko')
  assert.equal(resolveLang('invalid', undefined), 'en')
})

test('번역 변수와 모르는 문구를 보존한다', () => {
  assert.equal(translate('en', '세션 {total}', { total: 3 }), 'Sessions 3')
  assert.equal(translate('ko', '세션 {total}', { total: 3 }), '세션 3')
  assert.equal(translate('en', '사용자 지정 제목'), '사용자 지정 제목')
  assert.equal(translateText('en', '메시지 값이 비어 있습니다'), 'Message is empty')
  assert.equal(translateText('ko', '중단함'), '중단함')
})

test('상태와 시간 표기는 언어 변경을 반영한다', () => {
  try {
    setLangPref('en')
    assert.equal(AGENT_STATE_LABEL.working, 'Working')
    assert.equal(ago(1000, 1000), 'just now')
    assert.equal(duration(1000, 61000), '1m')
    setLangPref('ko')
    assert.equal(AGENT_STATE_LABEL.working, '작업 중')
    assert.equal(duration(1000, 61000), '1분')
  } finally {
    setLangPref('auto')
  }
})

test('패널 문구의 번역과 자리표시자가 빠지지 않는다', () => {
  const dir = new URL('./panel/', import.meta.url)
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && !f.startsWith('i18n'))) {
    const src = readFileSync(new URL(file, dir), 'utf8')
    assert.deepEqual(findUnwrapped(src), [], file)
    const { keys, badTemplates } = findKeys(src)
    assert.deepEqual(badTemplates, [], file)
    for (const { key } of keys) {
      assert.equal(typeof EN[key], 'string', `${file}: ${key}`)
      assert.deepEqual((EN[key].match(/\{\w+\}/g) ?? []).sort(), (key.match(/\{\w+\}/g) ?? []).sort(), key)
    }
  }
})
