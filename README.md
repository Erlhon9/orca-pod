# Pod

**See and steer every Orca workspace and agent session from one panel.**

Pod is an [Orca](https://www.onorca.dev) sidebar panel that lays out your workspaces as a map —
repository in the middle, topics around it, workspace cards around the topics — and lets you work
from there: read a Claude session like a chat, answer approval prompts, send instructions, start
new sessions, close leftover terminal tabs, and drag cards between topics.

- **Graph**: repository → topics (and sub-topics) → workspace cards with their live sessions. Collapse topics,
  throw cards onto another topic, and it stays readable with 100+ workspaces (card budget, far-zoom view).
- **Session window**: opens inside the graph. Claude sessions render as a conversation (from Claude Code's
  local transcript); terminals render as a live screen. Keys, interrupt and an instruction box.
- **Control**: a Claude session run by Pod itself (`claude -p`, streamed) that sees every session through a live map
  and relays your instructions — to terminal agents via `orca terminal send`, to chat sessions via Claude Code messages.
  It lives in the bottom bar (Enter to send, images allowed); "Send to control" on any session drops a reference in.
  Its Bash is limited to a few read/send `orca` commands, and MCP tools are off.
- **Images**: paste, drop or pick images in any instruction box.
- **Board**: workspaces grouped by status or topic; drag rows between groups.
- **Topics**: extract them with AI (`claude -p`) or make your own; new workspaces are sorted by keywords.

The UI is in Korean. 화면 문구는 한국어입니다.

### Requirements

- Orca 1.4.248 or later (macOS), with the `orca` command-line tool on your machine.
- Optional: [Claude Code](https://claude.com/claude-code) for the conversation view and AI topic extraction.

### Install

From Orca's plugin list, or load it from a clone:

```sh
git clone https://github.com/Erlhon9/orca-pod && orca plugin dev load ./orca-pod
```

Pod asks for workspace, agent, terminal and storage access because it reads your workspaces and
sends input to sessions on your behalf. Pod itself sends nothing over the network; AI topic
extraction runs your local `claude` CLI with workspace names, branches and PR titles.

---

Orca에서 관리하는 워크스페이스와 에이전트를 한 화면에서 보고 조작하는 사이드바 패널.

## 용어

| 말 | 뜻 |
|---|---|
| 디렉토리 | 저장소(예: my-app). 그래프 가운데 폴더 |
| 주제 · 하위 주제 | 워크스페이스를 묶는 이름(예: 결제 › 환불). 그래프의 색 알약 |
| 워크스페이스 | Orca 워크트리 하나. 그래프의 카드, 보드의 행 |
| 세션 | 워크스페이스 안에서 도는 Claude·Codex 대화나 터미널. 카드 안의 줄, 작업 창의 탭 |

## 화면

- **보드**: 지금 움직이는 에이전트 카드 → 디렉토리(저장소)별 워크스페이스를 상태별로 묶어 보여 준다.
  하위 워크스페이스는 부모 아래 들여 쓴다.
- **에이전트**: 확인 필요 / 작업 중 / 대기 중인 세션 / 최근 24시간 종료.
- **그래프**: 가운데 디렉토리 둘레에 주제(주제가 없는 디렉토리는 상태)가 색을 채운 알약으로 놓이고, 그 바깥쪽에
  워크스페이스 카드가 모인다. 카드 안에 제목·PR 번호·요약(메모 → PR 제목 → 브랜치)과 살아 있는 세션(이름·상태·지금 도구)이 들어 있어
  호버하지 않아도 읽힌다. 세션 줄을 누르면 그 세션이, 카드를 누르면 워크스페이스가 그래프 안 창으로 열린다. 주제에 올리면 `+`(새 워크스페이스 또는 하위 주제),
  카드에 올리면 `+`(세션 추가), 가운데 폴더를 누르면 새 최상위 주제. 하위 주제는 상위 주제 바깥쪽에 점선으로 매달리고
  색은 맨 위 주제 계열을 따르며, 상위 주제 숫자는 하위까지 합친다. 보드에서는 상위 바로 아래 `상위 › 하위` 묶음으로 들여 쓴다. 승인 대기 카드는 빨갛게 깜빡인다. 휠로 확대, 빈 곳을 끌어서 이동.
  카드를 끌어 다른 주제에 놓으면 주제가 바뀐다(상태로 나뉜 디렉토리면 상태가 바뀐다). 끄는 동안 놓을 수 있는 주제는 점선으로,
  가까이 간 주제는 커지며 표시되고, 놓을 곳이 아니면 제자리로 튕겨 돌아간다. 「기타」에 놓으면 키워드가 맞아도 기타에 남는다.
  배치가 바뀔 때 카드는 이전 자리에서 미끄러져 가고, 새 카드는 자기 주제에서 피어난다.
- **주제**: 디렉토리 안을 상태별/주제별로 바꿔 묶는다. `AI로 주제 뽑기` 는 `claude -p`(sonnet, 도구·MCP 없이 한 번)에
  워크스페이스 이름·브랜치·PR 제목·대화 제목을 넘겨 주제와 분류 키워드를 받아 플러그인 저장소에 둔다.
  새 워크스페이스는 키워드로 자동 분류되고, 주제·키워드는 `편집`에서, 워크스페이스별 주제는 메뉴에서 직접 정한다.
- **그래프 안 작업 창**: 그래프에서 세션이나 워크스페이스를 누르면 페이지가 넘어가지 않고 그래프 안에 창이 뜬다.
  넓으면 누른 노드 반대편에 세로로, 좁으면 아래쪽 시트로. 노드 자리에서 커지고 닫으면 그 노드로 줄어든다. 고른 노드는 강조되고
  확대 정도를 유지한 채 남은 공간 가운데로 옮겨진다. 창 안에서 다른 노드를 누르면 내용만 바뀌고, `크게 보기`로 전체 작업실이 된다.
- **관제**: 메인 화면 아래 줄. Pod 이 직접 띄우는 Claude(`claude -p`, stream-json)로, 세션 지도를 보고 다른 세션에 지시나 대화를
  전달한다(터미널 에이전트는 `orca terminal send`, 대화창 세션은 Claude Code 쪽지). 답은 글자 단위로 흘러나오고, 접으면 상태·마지막 답 한 줄,
  펼치면 대화 전체. Enter 보내기·Shift+Enter 줄바꿈, 사진 첨부, 중단, 새 대화. 세션 호버 카드·워크스페이스 메뉴의 `관제에 보내기`가
  그 세션 참조를 입력창에 넣는다. 관제의 Bash 는 정해진 `orca` 조회·보내기 명령만 통과하고(셸 터미널에는 못 보냄), 외부 연동(MCP)은 끈다.
  `i`로 입력창에 바로 간다. 작업 창이 열리면 숨는다.
- **사진 첨부**: 입력창에 붙여넣기·끌어놓기·고르기. 터미널 세션에는 임시 파일 경로로, 관제에는 바로 넘긴다.
- **대화 보기**: Claude 세션은 터미널 화면 대신 대화 기록(`~/.claude/projects/…/<세션>.jsonl`)을 읽어 Orca 대화창처럼 보여 준다.
  내 메시지는 말풍선, 답변은 제목·목록·표·코드를 갖춘 문서로, 이어진 도구 호출은 `도구 N개` 한 줄로 접는다(펼치면 하나씩).
  턴이 끝나면 걸린 시간을 구분선으로, 작업 중이면 마지막 도구와 경과 시간을, 승인 대기면 터미널의 질문을 카드로 띄운다.
  세션 머리의 버튼으로 터미널 화면과 오간다. 기록을 못 찾거나 Codex 세션이면 터미널 화면을 보여 준다.
  첫 요청 전의 새 세션은 빈 「새 대화」로 기다린다. 셸 탭은 머리의 버튼으로 Orca 의 그 탭으로 바로 간다.
- **작업실**: 보드·에이전트 목록에서 워크스페이스나 에이전트를 누르면 그 자리에서 펼쳐지듯 열리고, 닫으면 원래 자리로 접혀 들어간다.
  탭 오른쪽 `+ 세션`으로 Claude·Codex·터미널을 새로 열면 바로 그 탭이 선택된다(에이전트는 터미널로 띄운다). 상태·메모·PR, 세션 탭(에이전트·터미널), 터미널 화면 실시간 미러,
  키 버튼(⏎ Esc ↑ ↓ 1 2 3 Tab 중단), 지시 입력창. 대화창 세션은 마지막 요청·답변을 보여 주고 Orca 로 넘긴다.

## 세션 · 열린 탭

- 워크스페이스의 세션(Orca 대화창 세션, 에이전트 터미널, 셸, 초기 설정)을 따로 본다. 그래프 카드 아래 세션 줄에 칸으로 보이고
  (대화창 세션은 동그라미, 끝난 탭은 점선으로 흐리게), 올리면 목록이 뜬다. 보드·그래프의 워크스페이스 호버 카드에도 있다.
- 대화창 세션은 답을 마치면 Orca 가 늘 「종료」로 알려 주므로, 중단되지 않고 7일 안에 끝난 것은 「대기」로 본다.
- 줄을 누르면 그 탭을 작업 창에서 열고, `×`로 닫는다. 끝난 탭은 한 번, 살아 있는 탭은 두 번 눌러야 닫힌다.
  `끝난 탭 N개 닫기`로 한 워크스페이스의, 그래프 툴바 `끝난 탭 N`(두 번 누르기)으로 고른 디렉토리 전체(숨긴 상태 포함)의 끝난 탭을 한 번에 치운다.
- 작업 창 탭에도 `×`가 있고, 끝난 터미널을 고르면 `탭 닫기` 버튼만 보인다.

## 많을 때

- 그래프 왼쪽 위에서 주제별/상태별을 고른다(보드의 묶음 방식과 같이 바뀐다).
- 주제 알약을 누르면 접히고(카드가 주제 속으로 빨려 들어간다), 접힌 주제는 카드 더미 모양에 작업 중·확인 필요 수가 붙는다.
  다시 누르면 펼쳐지며 화면이 그 주제로 날아간다. `모두 접기/펼치기`도 있다.
- 한 디렉토리에 워크스페이스가 30개를 넘으면 화면 전체에 카드 36장 예산을 두고 확인 필요 → 작업 중 → 최근 순으로 채운다.
  한 장도 못 받은 주제는 접히고, 큰 주제는 10장까지만 보이며 나머지는 `외 N개`(누르면 전부)로 묶는다. 직접 펼치거나 접은 주제는 그대로 기억한다.
- 많이 축소하면 카드에는 제목만 크게 남고, 주제·디렉토리 이름표는 반대로 커져 멀리서도 읽힌다.
- 보드는 묶음마다 20줄까지만 그리고 나머지는 `N개 더 보기`로 접는다. 검색·필터 중에는 모두 보인다.
- 그래프는 그리는 카드 수가 예산으로 묶여 있어 워크스페이스가 수백 개여도 배치 계산이 늘지 않는다.

## 손맛

- 보드에서 워크스페이스 행을 끌어 다른 묶음(상태별이면 상태, 주제별이면 주제)에 놓으면 바뀐다. 끄는 행은 움직이는 방향으로 기울고,
  놓을 수 있는 묶음은 테두리, 손 아래 묶음은 강조된다. 묶음 머리로 빨려 들어가며 색 조각이 터지고 `+1`이 떠오른다.
  놓을 곳이 아니면 튕겨 돌아가고, 위·아래 끝으로 가면 저절로 굴러간다.
- 그래프 카드는 끌면 속도만큼 기울고, 주제 쪽으로 던지면 그 주제에 꽂힌다.
- 세션이 승인·답변 대기가 되면 카드가 흔들리고, 일을 마치면 `끝!`, 워크스페이스가 완료되면 축하 조각이 터진다.
- 관제에 보낸 말은 관제 쪽으로 날아가고, 답을 마치면 관제 줄이 살짝 흔들린다. 버튼·카드는 누르면 눌리고 올리면 뜬다.
- 시스템의 '동작 줄이기'가 켜져 있으면 효과를 끈다.

## 조작

| 어디서 | 무엇을 |
|---|---|
| 워크스페이스 행 클릭 | 작업실 열기 (Orca 화면 전환은 `Orca에서 열기`) |
| 에이전트 뱃지 클릭 | 그 에이전트를 고른 채로 작업실 열기 |
| 에이전트 뱃지 호버 | 상태·지속 시간, 마지막 요청, 지금 실행 중인 도구, 마지막 답변, 터미널 마지막 줄 |
| 카드의 보내기 / 중단 | 터미널 에이전트에 메시지 전송 / 중단 신호(두 번 눌러야 실행) |
| 행의 `⋯` 또는 우클릭 | 작업실, Orca에서 열기, 상태·주제 변경, Claude·Codex 시작, 하위 워크스페이스, 메모 편집, 읽음 표시, PR 열기 |
| 디렉토리 머리의 `+` | 새 워크스페이스(에이전트와 첫 지시를 같이 줄 수 있다) |
| 툴바 `상태`, 디렉토리 범례의 상태 칩 | 보일 워크스페이스 상태 고르기(기본: 완료 숨김). 숨긴 상태여도 에이전트가 작업 중·확인 대기면 보이고, 검색할 때는 숨긴 상태도 찾는다 |
| `/` | 검색 |
| `i` | 관제 입력창으로 |
| 위쪽 디렉토리 칩, `[` `]` | 디렉토리 전환(보드·에이전트·그래프에 모두 적용). 넓은 패널에서는 상태별 묶음이 칸반처럼 나란히 놓인다 |

## 구조

- `src/worker.ts` — `orca worktree ps`·`orca terminal list` 를 읽어 스냅샷을 만들고, 조작은 `orca` CLI
  (`terminal send/switch`, `worktree set/create`, `agent launch`)와 호스트 API(`workspace.list/open`)로 실행한다.
  에이전트·워크스페이스 이벤트가 오면 다시 읽어서 열린 패널에 보낸다.
- `src/model.ts` — CLI 결과 → 화면용 스냅샷(순수 함수, 테스트 대상).
- `src/runtime.ts`, `src/control.ts` — 관제 실행(stream-json 주고받기·이어 가기)과 지침·세션 지도·명령 제한 훅.
- `src/panel/` — HTML 패널(빌드 없이 Orca가 TS를 변환). `app.ts` 화면, `detail.ts` 작업실, `graph.ts` 그래프, `overlays.ts`
  호버 카드·메뉴·시트·토스트, `style.css` Orca 테마 변수 기반 스타일.

## 개발

```sh
orca plugin dev watch . --check --shot ./.orca/shots --json   # 저장할 때마다 다시 불러오고 화면을 찍는다
orca plugin test . --json                                      # src/*.test.ts
orca plugin validate . --json
```

CLI 경로는 `ORCA_CLI` 환경 변수 → `/usr/local/bin/orca` → `/opt/homebrew/bin/orca` → `PATH` 순으로 찾는다.
