// 패널 소스에서 한글 문자열 리터럴을 찾아 t() 로 감쌌는지 검사하는 순수 도구(파일 읽기는 호출하는 쪽).
// 주석·로그(console.*, orca.log)·「i18n-skip」 표시가 있는 줄은 건너뛴다.

export interface Literal {
  /** 소스에서 따옴표 안쪽 원문(이스케이프 그대로). 템플릿은 `${…}` 를 뺀 정적 부분만 이어 붙인다. */
  raw: string
  line: number
  /** 바로 앞이 `t(` 인지 */
  wrapped: boolean
  /** 템플릿 리터럴인데 `${…}` 가 들어 있는지 */
  hasExpr: boolean
}

const HANGUL = /[ㄱ-ㆎ가-힣]/

/** 한글이 들어 있는지. */
export function hasHangul(s: string): boolean {
  return HANGUL.test(s)
}

/** 따옴표 안쪽 원문의 이스케이프를 풀어 사전 키로 만든다. */
export function unescapeLiteral(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c: string) => {
    if (c.length > 1) return String.fromCharCode(parseInt(c.slice(1), 16))
    if (c === 'n') return '\n'
    if (c === 't') return '\t'
    return c
  })
}

/**
 * 소스 문자열의 모든 문자열 리터럴을 모은다(주석·정규식 리터럴은 건너뜀).
 * @param src 소스 전체
 * @returns 리터럴 목록(중첩된 `${…}` 안의 리터럴도 포함)
 */
export function scanLiterals(src: string): Literal[] {
  const out: Literal[] = []
  let i = 0
  const lineAt = (pos: number) => src.slice(0, pos).split('\n').length
  // 정규식 리터럴이 올 수 있는 자리인지(직전 의미 있는 문자로 판단)
  const regexAllowed = (pos: number) => {
    let j = pos - 1
    while (j >= 0 && /\s/.test(src[j])) j--
    return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(src[j]) || /\breturn$/.test(src.slice(Math.max(0, j - 6), j + 1))
  }

  function readTemplate(start: number): number {
    // start 는 여는 ` 다음 위치. 닫는 ` 다음 위치를 돌려준다.
    let statics = ''
    let hasExpr = false
    let p = start
    while (p < src.length && src[p] !== '`') {
      if (src[p] === '\\') {
        statics += src.slice(p, p + 2)
        p += 2
      } else if (src[p] === '$' && src[p + 1] === '{') {
        hasExpr = true
        p = readCode(p + 2, true)
      } else statics += src[p++]
    }
    const before = src.slice(0, start - 1).replace(/\s+$/, '')
    out.push({ raw: statics, line: lineAt(start), wrapped: /\bt\($/.test(before), hasExpr })
    return p + 1
  }

  // 코드를 읽는다. inExpr 이면 짝이 맞는 `}` 에서 멈추고 그 다음 위치를 돌려준다.
  function readCode(start: number, inExpr: boolean): number {
    let p = start
    let depth = 0
    while (p < src.length) {
      const c = src[p]
      const n = src[p + 1]
      if (c === '/' && n === '/') {
        while (p < src.length && src[p] !== '\n') p++
      } else if (c === '/' && n === '*') {
        const e = src.indexOf('*/', p + 2)
        p = e < 0 ? src.length : e + 2
      } else if (c === "'" || c === '"') {
        let q = p + 1
        let raw = ''
        while (q < src.length && src[q] !== c && src[q] !== '\n') {
          if (src[q] === '\\') {
            raw += src.slice(q, q + 2)
            q += 2
          } else raw += src[q++]
        }
        const before = src.slice(0, p).replace(/\s+$/, '')
        out.push({ raw, line: lineAt(p), wrapped: /\bt\($/.test(before), hasExpr: false })
        p = q + 1
      } else if (c === '`') {
        p = readTemplate(p + 1)
      } else if (c === '/' && regexAllowed(p)) {
        let q = p + 1
        let inClass = false
        while (q < src.length && src[q] !== '\n') {
          if (src[q] === '\\') q += 2
          else if (src[q] === '[') {
            inClass = true
            q++
          } else if (src[q] === ']') {
            inClass = false
            q++
          } else if (src[q] === '/' && !inClass) break
          else q++
        }
        p = q + 1
      } else if (c === '{') {
        depth++
        p++
      } else if (c === '}') {
        if (inExpr && depth === 0) return p + 1
        depth--
        p++
      } else p++
    }
    return p
  }
  readCode(i, false)
  i = 0
  return out
}

/**
 * t() 로 감싸지 않은 한글 문자열 리터럴의 줄 번호 목록.
 * @param src 소스 전체
 * @returns 줄 번호와 원문 일부
 */
export function findUnwrapped(src: string): Array<{ line: number; text: string }> {
  const lines = src.split('\n')
  return scanLiterals(src)
    .filter((l) => hasHangul(l.raw) && !l.wrapped)
    .filter((l) => {
      const text = lines[l.line - 1] ?? ''
      return !/i18n-skip/.test(text) && !/\bconsole\.|\borca\.log\(/.test(text)
    })
    .map((l) => ({ line: l.line, text: l.raw.slice(0, 50) }))
}

/**
 * t() 로 감싼 리터럴의 사전 키 목록(변수 자리가 `${}` 로 남은 템플릿은 잘못이라 따로 돌려준다).
 * @param src 소스 전체
 * @returns 키와 줄 번호, 잘못된 템플릿 줄
 */
export function findKeys(src: string): { keys: Array<{ key: string; line: number }>; badTemplates: number[] } {
  const keys: Array<{ key: string; line: number }> = []
  const badTemplates: number[] = []
  for (const l of scanLiterals(src)) {
    if (!l.wrapped) continue
    if (l.hasExpr) badTemplates.push(l.line)
    keys.push({ key: unescapeLiteral(l.raw), line: l.line })
  }
  return { keys, badTemplates }
}
