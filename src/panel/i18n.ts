// 화면 문구 번역. 한국어 원문을 키로 쓰고, 영어는 사전(i18n-en.ts)에서 찾는다. DOM 에 의존하지 않는 순수 로직이다.
import { EN } from './i18n-en'

export type Lang = 'ko' | 'en'
export type LangPref = 'auto' | 'ko' | 'en'

/** 언어 설정을 동기로 읽기 위해 localStorage 에 같이 둔다(패널 설정 pod.prefs 는 비동기라 첫 그리기에 늦다). */
export const LANG_STORAGE_KEY = 'pod.lang'

/**
 * 설정값과 브라우저 언어로 실제 쓸 언어를 정한다.
 * @param pref 설정값. 모르는 값은 auto 로 본다.
 * @param navLang `navigator.language`. auto 일 때 ko 로 시작하면 한국어, 아니면 영어.
 * @returns 'ko' 또는 'en'
 */
export function resolveLang(pref: unknown, navLang: string | undefined): Lang {
  if (pref === 'ko' || pref === 'en') return pref
  return (navLang ?? '').toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

/** 설정값으로 정규화한다(설정이 없으면 영어를 기본으로 쓴다). */
export function normalizePref(v: unknown): LangPref {
  return v === 'ko' || v === 'en' || v === 'auto' ? v : 'en'
}

/** `{이름}` 자리를 vars 값으로 바꾼다. 값이 없는 자리는 그대로 둔다. */
export function fillVars(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/**
 * 한국어 원문을 지정한 언어로 바꾼다.
 * @param lang 대상 언어
 * @param ko 한국어 원문(사전 키)
 * @param vars `{n}` 자리표시자 값
 * @param dict 영어 사전(테스트에서 바꿔 끼울 수 있음)
 * @returns ko 면 원문, en 이면 사전값(없으면 원문)에 변수를 채운 문구
 */
export function translate(lang: Lang, ko: string, vars?: Record<string, string | number>, dict: Record<string, string> = EN): string {
  const base = lang === 'en' ? (dict[ko] ?? ko) : ko
  return fillVars(base, vars)
}

const patternCache = new WeakMap<Record<string, string>, Array<{ re: RegExp; names: string[]; en: string }>>()

/** 자리표시자가 있는 사전 항목을 정규식으로 만든다(워커가 보낸 완성 문구를 되짚어 찾는 용도). */
function patterns(dict: Record<string, string>): Array<{ re: RegExp; names: string[]; en: string }> {
  let list = patternCache.get(dict)
  if (list) return list
  list = []
  for (const [ko, en] of Object.entries(dict)) {
    if (!/\{\w+\}/.test(ko)) continue
    const names: string[] = []
    const src = ko
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part)
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        names.push(m[1])
        return '(.+?)'
      })
      .join('')
    list.push({ re: new RegExp(`^${src}$`), names, en })
  }
  patternCache.set(dict, list)
  return list
}

/**
 * 이미 완성된 한국어 문구(워커 오류·메모 등)를 번역한다. 사전에 그대로 있으면 그 값,
 * 자리표시자 항목과 모양이 맞으면 채워 넣은 값(채운 값도 사전에 있으면 번역), 아니면 원문.
 * @param lang 대상 언어
 * @param text 한국어 완성 문구
 * @param dict 영어 사전
 * @returns 번역된 문구
 */
export function translateText(lang: Lang, text: string, dict: Record<string, string> = EN): string {
  if (lang !== 'en') return text
  if (dict[text] !== undefined) return dict[text]
  for (const p of patterns(dict)) {
    const m = p.re.exec(text)
    if (!m) continue
    const vars: Record<string, string> = {}
    p.names.forEach((name, i) => {
      vars[name] = dict[m[i + 1]] ?? m[i + 1]
    })
    return fillVars(p.en, vars)
  }
  return text
}

function readStoredPref(): LangPref {
  try {
    return normalizePref(typeof localStorage === 'undefined' ? null : localStorage.getItem(LANG_STORAGE_KEY))
  } catch {
    return 'en'
  }
}

function browserLang(): string | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.language
}

let pref: LangPref = readStoredPref()
let lang: Lang = resolveLang(pref, browserLang())

/** 지금 설정값(auto·ko·en). */
export function langPref(): LangPref {
  return pref
}

/** 지금 쓰는 언어. */
export function currentLang(): Lang {
  return lang
}

/**
 * 언어 설정을 바꾸고 다음 로드를 위해 localStorage 에 남긴다. 화면은 호출하는 쪽이 다시 그린다.
 * @param next 설정값
 */
export function setLangPref(next: unknown): void {
  pref = normalizePref(next)
  lang = resolveLang(pref, browserLang())
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(LANG_STORAGE_KEY, pref)
  } catch {
    /* 저장 불가면 이번 로드에서만 적용 */
  }
}

/** 방금 저장한 설정이 localStorage 에서 다시 읽히는지(다시 불러올 때 같은 언어로 뜰지) 확인한다. */
export function langPersisted(): boolean {
  return readStoredPref() === pref
}

/**
 * 화면 문구. 한국어 원문을 쓰고, 영어 설정이면 사전값으로 바꾼다.
 * @param ko 한국어 원문(사전 키). 변수는 `{n}` 자리표시자
 * @param vars 자리표시자 값
 * @returns 현재 언어의 문구
 */
export function t(ko: string, vars?: Record<string, string | number>): string {
  return translate(lang, ko, vars)
}

/**
 * 워커가 보낸 완성 문구(오류·메모)를 현재 언어로 바꾼다.
 * @param text 한국어 완성 문구
 * @returns 번역된 문구(모르는 문구는 원문)
 */
export function tt(text: string): string {
  return translateText(lang, text)
}
