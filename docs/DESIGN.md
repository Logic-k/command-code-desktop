# Command Code Desktop — v0.2 설계

## 1. 목표

v0.1 시제품은 Command Code TUI를 ConPTY + xterm.js로 창 안에 띄우는 "터미널 래퍼"였다.
v0.2의 목표는 **Command Code를 진짜 GUI 앱처럼 쓰는 것**이다.

- 폴더를 고르면 바로 대화가 시작된다 (터미널, `cd`, 명령어 입력 없음).
- 답변은 마크다운으로, 도구 실행은 카드로, 파일 수정은 diff로 보인다.
- 권한 요청은 버튼으로 답한다.
- 지난 대화를 사이드바에서 골라 이어 간다.
- 모드·모델·추론 강도를 드롭다운으로 바꾼다.
- GUI가 아직 못 하는 일(로그인, `/usage`, `/config` 같은 TUI 전용 기능)은 기존 터미널 탭으로 한다.

## 2. 핵심 결정: ACP를 주 경로로, TUI를 보조 경로로

조사 결과 Command Code CLI(v1.86.3)는 `cmd acp`로 **Agent Client Protocol** 서버를 제공한다.
Zed 에디터가 쓰는 표준 프로토콜이고, stdio 위의 줄 단위 JSON-RPC 2.0이다.

이 머신에서 직접 확인한 것:

| 항목 | 결과 |
| --- | --- |
| `initialize` | protocolVersion 1, `loadSession`, 이미지 프롬프트, `session/list`·`resume`·`close` 지원 |
| `session/new` | 모드 5개(`default`, `auto-accept`, `plan`, `dont-ask`, `bypass`)와 `configOptions`(model, effort) 반환 |
| `session/list` | **에이전트 프로세스의 cwd 기준**으로 그 폴더의 지난 세션(id, title, updatedAt) 반환 |
| `session/prompt` | 스트리밍 `session/update` 알림 후 `stopReason` 반환. 한도 초과는 JSON-RPC 에러(429 메시지 포함)로 옴 |
| 도구 호출 | `tool_call` → `tool_call_update`(in_progress/completed/failed). `write_file`/`edit_file`은 `diff` 콘텐츠(path, oldText, newText) 포함 |
| 할 일 목록 | `todo_write`가 `plan` 업데이트로 변환됨 |
| 권한 요청 | `session/request_permission` (allow_once / allow_always / reject_once / reject_always) |
| 기타 | `available_commands_update`(슬래시 명령), `usage_update`(used/size), `session_info_update`(제목), `current_mode_update`, `config_option_update` |

비교한 대안:

- **TUI 래퍼만 유지**: 가장 충실하지만 GUI 이점이 거의 없다. 복사·스크롤·diff 보기·권한 버튼 모두 터미널 수준.
- **`-p --output-format json` 반복 호출**: 매 턴 새 프로세스, 권한 요청을 대화형으로 받을 수 없음.
- **ACP**: 공식 지원, 스트리밍, 권한 왕복, 세션 이어하기까지 전부 제공. → **채택**

TUI 경로는 지우지 않는다. 로그인처럼 ACP가 다루지 않는 일을 위한 "터미널 탭"으로 남긴다.

## 3. 구조

```
┌────────────┬──────────────────────────────────────────────────────┐
│ 사이드바     │ 탭 바: [채팅: 버그 수정] [채팅: 새 대화] [터미널] [+]     │
│            ├──────────────────────────────────────────────────────┤
│ + 새 채팅    │ 헤더: 제목 · 폴더 · [모드▾] [모델▾] [강도▾] · 컨텍스트 12%  │
│            ├──────────────────────────────────────────────────────┤
│ 프로젝트     │  사용자 말풍선                                         │
│  ▸ anki    │  에이전트 답변 (마크다운, 코드 하이라이트)                  │
│  ▾ cmdc    │  ┌ 도구 카드: ✎ src/main.ts 수정  [완료]  ▸ diff ┐      │
│    대화 A   │  └─────────────────────────────────────────┘      │
│    대화 B   │  ┌ 권한 요청: 명령 실행 `pnpm test`                ┐     │
│            │  │ [한 번 허용] [항상 허용] [거부]                    │     │
│ ⚙ 설정      │ ├──────────────────────────────────────────────────────┤
│            │ 입력창 (/ 명령 자동완성, 이미지 붙여넣기)     [보내기/중지]  │
└────────────┴──────────────────────────────────────────────────────┘
```

### Rust (src-tauri/src)

| 파일 | 역할 |
| --- | --- |
| `launch.rs` | CLI 위치 확인(npm 심 → `node …/dist/index.mjs`), 시작 폴더 |
| `pty.rs` | 터미널 탭: ConPTY로 TUI 실행 (v0.1 그대로) |
| `acp.rs` | 채팅: `node index.mjs acp`를 파이프로 실행, stdout 줄을 Channel로 전달, stdin 쓰기, 종료 이벤트 |
| `lib.rs` | 명령 등록, 플러그인(dialog, opener, notification) |

Rust는 **바이트 운반만** 한다. JSON-RPC 해석은 전부 TypeScript에서 한다. 프로토콜이 바뀌어도 프런트만 고치면 된다.

### 연결 단위

`session/list`가 프로세스 cwd 기준이므로 **프로젝트 폴더 하나당 에이전트 프로세스 하나**를 띄우고,
그 폴더의 여러 채팅 탭이 그 연결을 같이 쓴다(ACP는 한 연결에 여러 세션을 허용). 폴더의 마지막 탭이 닫히면 프로세스를 끈다.

### TypeScript (src)

| 파일 | 역할 |
| --- | --- |
| `acp/client.ts` | JSON-RPC 클라이언트: 요청/응답 매칭, 알림 구독, 에이전트→클라이언트 요청 처리 |
| `acp/types.ts` | 이 머신에서 확인한 ACP 메시지 타입 |
| `acp/pool.ts` | 폴더별 연결 풀 (참조 카운트) |
| `views/chat.ts` | 채팅 탭: 메시지 스트림, 도구 카드, 계획, 권한, 입력창 |
| `views/terminal.ts` | 터미널 탭 (v0.1 xterm 코드) |
| `views/sidebar.ts` | 프로젝트·세션 목록 |
| `views/tabs.ts` | 탭 관리 |
| `ui/markdown.ts` | marked + DOMPurify + highlight.js + KaTeX. 수식 스캐너(`findMath`)는 답변·내 말풍선·입력창 미리보기가 같이 쓴다. 내 글은 제목·목록·표 같은 구조가 있을 때만(`looksLikeMarkdown`) 마크다운으로 그린다 |
| `ui/diff.ts` | 줄 단위 LCS diff → 통합 diff 화면 |
| `store.ts` | 최근 프로젝트, 설정 (localStorage) |

## 4. 안전 원칙

- 에이전트 출력은 모두 DOMPurify를 거친 뒤 렌더링한다(마크다운 안의 HTML·스크립트 차단).
- 권한 모드 기본값은 `default`(매번 묻기). `bypass`는 빨간 경고와 함께만 선택 가능.
- `bypass`에서도 CLI(1.88)는 `_meta.risk`가 붙은 요청(`destructive-command`, `outside-workspace`, `ask-rule`,
  `permission-config`, `sensitive-file`)과 `enter_plan_mode`는 묻는다. 위험 요청에는 "항상" 선택지가 없다. 앱은 이 모드에서 위험 표시 없는
  요청은 바로 `allow_once`로 답하고, 위험 요청은 자동으로 답하지 않는다(2026-11-01부터: CLI가 사람의 결정을 요구한 호출이므로
  카드와 알림으로 사용자에게 넘긴다).
  워크플로 역할 세션은 채팅의 실시간 모드가 아니라 시작 시 고정한 정책(`PermissionPolicy`)으로 답한다. 읽기 전용 역할의
  `edit`/`delete`/`move`/`switch_mode` 요청은 `reject_once`로 거부한다.
  `ask_user_question`은 옵션 id `option_N`, kind 전부 `allow_once`인 권한 요청으로 오므로 질문 카드로 따로 그린다. 이 모드에서는
  질문도 같은 카운트다운 뒤 첫 번째 답을 고른다(CLI가 추천 답을 앞에 둔다. 계획 모드 질문이면 "Yes (Recommended)").
  에이전트가 `bypass`에서 계획 모드로 들어가면(`current_mode_update`) 계획 승인 질문("Yes, auto-accept edits")도 같은 식으로
  고르고, CLI는 승인 뒤 계획 전 모드인 `bypass`로 돌아간다. 사용자가 직접 고른 계획 모드는 자동으로 답하지 않는다.
  `session/load`는 세션의 권한 모드를 그대로 돌려주므로(에이전트 재시작 뒤에도 `bypass` 유지 확인) 앱이 다시 걸 필요는 없다.
- 클라이언트 측 `fs`/`terminal` 능력은 광고하지 않는다. 파일 접근은 CLI가 자기 권한 체계로 한다.
- 계정 정보(`~/.commandcode/auth.json`)는 읽지도 복사하지도 않는다.

## 5. 구현 중 발견한 것

- **`session/load`가 기록을 재생하지 않는다.** 1.86에서 실제로 업데이트 0개, 응답까지 13초 이상. 그래서 채팅은
  `~/.commandcode/projects/<slug>/<id>.jsonl`을 Rust로 직접 읽어(`read_transcript`) 즉시 그리고, 뒤에서 `session/load`로
  연결한다. 에이전트가 나중에 재생을 보내면 중복을 막기 위해 무시한다(`suppressReplay`).
- **기록 파일은 트리다.** `parentId`로 연결되고, `/model` 전환 같은 비메시지 항목도 사슬 중간에 낀다. 마지막 메시지에서
  거꾸로 따라가며 메시지만 남긴다.
- **CLI 홈은 `HOME` 우선.** `HOME`이 따로 설정된 PC에서는 CLI 데이터도 그 아래에 있다. `read_transcript`는
  프로필 폴더 → `HOME` → `USERPROFILE` 순으로 찾는다.
- **CLI 콜드 스타트 10~20초.** 같은 폴더의 연결은 풀에서 공유하고 90초 동안 유지한다. 대기 중에는 이유를 화면에 표시한다.
- **Tauri는 파일 드롭을 가로챈다.** HTML5 drop 대신 창의 `onDragDropEvent`로 받는다(폴더 → 프로젝트, 이미지 → 첨부).
- **모델 출력은 아무것도 스스로 불러오면 안 된다.** 원격 `<img>`는 렌더링 순간 URL로 데이터를 흘릴 수 있으므로
  DOMPurify 훅과 CSP 양쪽에서 막는다.

### 계정 전환 (v0.3)

- **처음 방식(홈 폴더 교체)은 버렸다.** `USERPROFILE`/`HOME`을 계정 폴더로 바꾸면 대화 기록·설정·스킬·git 전역 설정까지 갈라진다.
- **CLI는 `COMMAND_CODE_API_KEY`를 `auth.json`보다 먼저 쓴다** (`getCommandAuthKey`, 1.86·1.87에서 확인). 그래서 계정 = 키 하나.
  키는 Windows 자격 증명 관리자(`keyring` crate, 서비스 `command-code-desktop`)에, 목록(id·이름)은 앱 데이터의 `accounts.json`에 둔다.
  웹뷰는 계정 id만 알고, Rust가 CLI를 띄울 때 키를 넣는다.
- **경로 규칙**: CLI는 `auth.json`을 `os.homedir()`(Windows에서는 `USERPROFILE`)에서, 세션 기록은 `HOME ?? USERPROFILE`에서 읽는다.
- **계정 추가**: 앱 데이터 아래 임시 홈으로 `cmd login`을 실행하고, 끝나면 거기 생긴 키를 옮긴 뒤 임시 홈을 지운다.
  로그인 페이지를 여는 순간 Windows가 그 폴더를 사용자 프로필로 여겨 IE 캐시 폴더(숨김·시스템·리파스 포인트)를 만들기 때문에
  `remove_dir_all` 대신 `rmdir /s /q`로 지운다. 한 시간 넘은 임시 홈은 다음 계정 추가 때 정리한다.
- **연결 풀 키 = 계정 + 폴더.**
- **모든 변경은 실시간 (v0.4).** 처음 버전은 `cmd login` 프로세스가 끝날 때 키를 회수했는데, CLI는 로그인 후 종료하지 않고
  온보딩으로 넘어가서 회수가 영영 일어나지 않았다(실제 사용자 로그인 3회 모두 실패). 이제 Rust 감시 스레드(0.7초 간격 `stat`)가
  - 대기 중인 로그인 임시 홈에 `auth.json`이 생기는 순간 키를 옮기고 `accounts://login-complete`를 보낸다 → 로그인 탭 자동 종료, 계정 전환.
  - CLI의 `auth.json`(크기·수정 시각)을 지켜보다 바뀌면 `accounts://changed` → 이름 갱신, CLI 로그인 쓰던 탭 재연결.
  - 앱 시작 때 남은 임시 홈은 키가 있으면 가져오고 없으면 지운다(꺼진 앱 때문에 끊긴 로그인 복구).
- **전환은 열린 탭에도 바로 적용.** 채팅은 `setAccount` → 기존 세션을 옛 에이전트에서 닫고 새 키의 에이전트에서 `session/load`.
  화면의 대화는 그대로 두고 연결만 바꾼다. 작업 중이면 그 턴이 끝난 뒤 넘어간다. 터미널은 새 TUI로 재시작.
- **경쟁 조건 방지.** `open()`마다 세대 번호를 올리고, 오래된 `open()`은 다음 `await`에서 멈추며 자기가 만든 세션만 자기 연결에서 닫는다.
  터미널 전환은 Promise 체인으로 직렬화. 300ms 안에 세 번 전환해도 마지막 계정 하나로 정리됨을 확인.

### 모델 접근과 업데이트 (v0.4)

- **근거 세 가지를 합친다.** ① CLI가 캐시하는 모델 목록(`~/.commandcode/cache/model-catalog/v1/*.json`)의 모델별
  `minimumPlan`·가격·`free` 배지, ② CLI의 `evaluateModelAccess`(충전/보너스 크레딧 있으면 전부 허용, 아니면 요금제 순위
  `go < go-v1 < goat < pro < pro-v1 < provider < max < ultra < teams-pro`), ③ 공식 문서의 "무료 모델도 잔액 $1 이상 필요".
- **계정 상태는 CLI와 같은 API로**: `GET /alpha/whoami` → `org.id`, `/alpha/billing/subscriptions?orgId=`, `/alpha/billing/credits?orgId=`
  (api.commandcode.ai, `Authorization: Bearer <key>`). Rust(`billing.rs`, `ureq`)가 계정 키로 호출하고 결과만 웹뷰로 보낸다.
- **앱 업데이트는 소스 기반.** 원격 저장소도 서명 키도 아직 없으므로 배포 서버형 자동 업데이트(tauri-plugin-updater) 대신
  `build.rs`가 빌드 커밋을 바이너리에 넣고, 앱이 소스 폴더 HEAD와 비교한다. 업데이트는 `CARGO_TARGET_DIR`을 앱 데이터의
  `update-build`로 돌려 빌드하므로 실행 중인 exe가 잠기지 않고, 적용은 숨은 PowerShell이 앱 종료를 기다렸다가 exe를 복사·재실행한다.
  GitHub 저장소를 만들면 tauri-plugin-updater + 서명된 릴리스로 옮기는 것이 다음 단계.

### 사용량 게이지와 업데이트 대응 (v0.4)

- **숫자는 CLI `/usage`와 같다.** 크레딧 응답(`monthlyCredits`, `purchasedCredits`, `freeCredits`, `windowLimits`)과 구독의
  `currentPeriodEnd`, 요금제별 기본 크레딧(CLI의 `Tr`: Go 10, GOAT 70, Pro 80, Max 150 …)으로
  `사용률 = (기본+충전+보너스 − 잔액) ÷ (기본+충전+보너스)`. 5시간·일간·주간 창은 서버가 `windowLimits`를 보낼 때만 그리고,
  한도 오류(429, "resets at …")를 받으면 그 계정에 한도 도달 표시를 걸어 둔다. 게이지는 한도마다 이름을 붙인다
  (`5시간 12% · 주간 86% · 월간 45%`): 이름 없는 퍼센트 하나로는 어느 창인지, 언제 풀리는지 알 수 없었다.
  오류 메시지에 창 이름이 없으면 5시간으로 넘겨짚지 않고, 넘친 창 → 잔액 0이면 월간 → "사용" 순으로 정한다.
- **`windowLimits`는 크레딧 응답의 최상위에 있다** (`{credits: {...}, windowLimits: {...}}`, CLI `projectUsageView`).
  처음에 `credits` 안에서 찾느라 Go 요금제의 5시간·주간 한도가 늘 빠져 있었다. 각 창은 `{used, cap, resetAt(ms, 시작 전 0), exceeded}`,
  최상위에 `limited`와 넘친 창 이름 `exceeded`가 온다. 넘친 창은 답변을 보내기 전에도 게이지에 "한도 도달"로 띄운다.
- **CLI 업데이트 대응.** Rust가 15초마다 설치된 CLI 버전을 읽어 바뀌면 `cli://version`을 보낸다. 새 에이전트는 원래도 새 버전을
  쓰지만(실행할 때마다 설치 위치를 다시 읽음), 열린 대화는 계정 전환과 같은 재연결 경로로 새 버전에 붙인다.
- **호환성 점검.** 앱이 기대는 CLI 내부 요소를 번들 문자열로 확인하고(`getCommandApiKeyFromEnv`, `session/request_permission`,
  `session/load`, `minimumPlan`, `/alpha/billing/credits`, `windowLimits`), 실제 데이터(모델 목록, 요금 API, ACP 버전)도 함께 본다.
  CLI가 바뀐 직후 자동으로 돌고, 업데이트 창에서 언제든 다시 돌릴 수 있다.
- **업데이트 상태는 창 밖에 둔다.** 빌드 중에 업데이트 창을 닫아도 진행이 이어지고, 끝나면 "다시 시작해서 적용" 버튼이 붙은 알림이 뜬다.

### ULTRAWORK DAG (v0.5)

- **모드가 이미 그래프를 만든다.** 사용자의 `~/.commandcode/mods/ulw.ts`가 `mass ulw`/`ulw-loop` 키워드를
  지시문으로 바꾸고, `ulw_plan`·`ulw_node`·`ulw_verify`·`ulw_status` 도구와 Stop 게이트를 제공한다.
  ACP 슬래시 목록에도 `/mass-ulw`, `/ulw-loop`, `/mass-replica`, `/ulw`, `/ulw-status`, `/ulw-dag`,
  `/ulw-reset`이 그대로 올라온다. 그래서 앱은 그래프를 **새로 실행하는** 코드가 아니라 **관찰하는** 코드만 필요하다.
- **모드의 TUI 위젯은 ACP로 오지 않는다.** `cmd.ui.pane`·`widget`·`setStatus`는 터미널 화면용이고,
  ACP로 `/ulw-status`를 보내면 텍스트 한 줄만 돌아온다(실측). 그래서 GUI는 `session/update`의 도구 호출에서
  그래프를 다시 만든다: `ulw_plan`의 `rawInput.nodes`, `ulw_node`의 상태/메모, `ulw_verify`의 판정,
  그리고 각 노드가 띄운 `agent` 호출(`subagent_type`·`description`)을 짝지어 상태를 옮긴다.
- **백그라운드 에이전트는 도구 호출이 먼저 끝난다.** `run_in_background` 호출은 완료 이벤트가 와도 노드를
  `running`으로 두고, 뒤따르는 `ulw_node`가 끝을 알린다. 포그라운드 호출은 완료 이벤트가 곧 노드 완료다.
- **기록에서 복원된다.** 트랜스크립트의 `tool_use` 항목에 `name`과 `input`이 남으므로, 지난 대화를 열 때
  같은 리듀서가 `ulw_plan`부터 순서대로 재생한다. 그래서 "지금 산 그래프"와 "어제 산 그래프"가 같은 화면으로 보인다.
- **토큰 수는 ACP에 없다.** 서브에이전트 이벤트의 `tokensUsed`는 TUI 쪽 상태에만 쓰이고 `session/update`로
  변환되지 않는다. 노드별 토큰을 보여 주려면 mod가 `ulw_node` 메모에 토큰을 적어 주는 방식이어야 한다.

## 6. 검증 기록 (2026-10-22)

WebView2 디버그 포트(`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`)로 실제 앱 창을 CDP로 조작·캡처했다.

| 항목 | 결과 |
| --- | --- |
| 새 채팅 → 실제 프롬프트 → 권한 요청(diff 미리보기) → `1` 키 허용 → 파일 생성 → 답변 | 통과 (임시 폴더, `hello.txt`) |
| 탭 제목 자동 변경(`session_info_update`), 사이드바 세션 목록 갱신, 컨텍스트 게이지 | 통과 |
| 권한 대기 중 `Esc` 중지 | 0.26초 내 중지, 권한 카드·도구 카드 "취소됨", 세션 계속 사용 가능, 남은 프로세스 없음 |
| 지난 대화 열기 | 0.3초 만에 기록 표시, 연결 후 중복 없음; 53개 메시지·44개 도구 세션 정상 |
| `/model` 전환이 있는 기록 | 74개 메시지 전부 표시 |
| 도구 카드·diff·실패 카드·할 일 패널·슬래시 메뉴·설정·라이트 테마·터미널 탭 | 화면 확인 |
| 계정 추가(로그인 단계는 임시 홈에 `auth.json`을 써서 대신함) → 자격 증명 관리자 저장 → 전환 → `whoami` | 올바른 키: 계정A로 인식. 가짜 키: `auth.json`이 있는데도 401 → 주입된 키가 우선함을 확인 |
| 실제 "계정 추가…" | 임시 홈에서 Command Code 로그인 화면 표시. 탭을 닫으면 로그인 프로세스와 임시 홈이 2초 안에 정리됨 |
| 계정 지우기 | 목록·자격 증명 관리자 모두 비워짐 |
| (v0.4) 대화·터미널을 연 채로 계정 전환 | 두 탭 모두 즉시 새 계정으로 재연결, 7초 안에 다시 사용 가능, 새 터미널 `whoami` = 새 계정 |
| (v0.4) 앱 밖에서 CLI `auth.json` 변경 | 2.5초 안에 감지, CLI 로그인 쓰던 탭 재연결, 알림 표시 |
| (v0.4) 계정 추가 | `auth.json`이 생기자 로그인 탭이 저절로 닫히고 계정 추가·전환 |
| (v0.4) 300ms 안에 전환 3번 | 마지막 계정 하나로 정리, 세션 1개, 유휴 에이전트는 90초 뒤 정리 |
| (v0.4) 끊긴 로그인 복구 | 사용자가 오후에 로그인해 둔 계정이 앱 시작 때 자동으로 목록에 들어옴 |
| (v0.4) 계정별 요금제·잔액 조회 | 계정A: Go(활성) · $X.XX / 계정B: 요금제 없음 · $0.00 (CLI와 같은 API) |
| (v0.4) 잔액 $0 계정으로 채팅 | 보내기 전에 "어떤 모델도 쓸 수 없음 · 무료 모델도 $1 필요" 경고 + 계정 전환 버튼, 모델 95개 모두 비활성 |
| (v0.4) Go 요금제 계정의 모델 목록 | 사용 가능 55 · 무료 4 · 업그레이드 필요 36 (예: Claude Sonnet 5.5 → GOAT 이상) |
| (v0.4) 앱 자체 업데이트 (실제 릴리스 exe) | bba4dc1 빌드가 새 커밋 3bff700을 감지 → 별도 폴더에서 빌드(6분 54초) → 재시작 → 새 프로세스가 3bff700으로 실행, 남은 업데이트 0 |
| (v0.4) 사용량 게이지 | Go · $X.XX 남음 → "45% · $X.XX", 14일 뒤 갱신. 5시간 창 85% 주입 시 노랑, 한도 도달 보고 시 빨강 + 초기화 시각 |
| (v0.4) CLI 버전 변경 감지 | 이벤트 → 열린 대화가 "CLI 1.87.1(으)로 다시 연결" 후 바로 사용 가능, 알림 표시 |
| (v0.4) CLI 호환성 점검 (1.87.1) | 10개 항목 모두 통과 |
| (v0.4) 앱에서 `cmd update --check-only` | 7.6초, "Up to date (1.87.1)" |
| (v0.5) ULW DAG 리듀서 | `ulw_plan` 3노드 → 3열·간선 2, `agent` 역할 매칭/완료, 백그라운드 완료는 `running` 유지, `ulw_verify(false)`→검증·`true`→완료, 같은 plan의 완료 이벤트 무시; `pnpm build`(tsc+vite) 통과 |

## 7. 이후 단계 (v0.3+)

- 프로필 전환 UI (USERPROFILE 분리, v0.1에서 배선만 됨)
- 이미지 드래그 앤 드롭 외 파일 첨부(@멘션 → `resource_link`)
- 세션 포크/되감기 (ACP 미노출, TUI로 대체 중)
- 자동 업데이트, 설치 프로그램 서명

## 8. 실행 탭과 연구 워크플로 (2026-10-31)

기존 `src/styles.css`의 dark/light 색상, `--sans`, `--mono`, `--radius`,
chip/select/button 스타일을 재사용한다. 새 브랜드나 시각 효과는 도입하지 않는다.
Primary action: 목표와 워크플로를 선택한 뒤 실행 시작.
Information priorities: 실행 상태와 반복 횟수, 의존 그래프, 선택한 노드의 전체 결과.
Required content: 채팅/실행 탭, 연구/팀/연구 후 구현/taste 선택, 목표,
최대 반복, 취향 편집·저장, 시작/중지, 근거 내보내기, 실패 이유, 기존 ULW 그래프.
No decorative metrics; no invented token counts or progress events.

Layout: 실행 탭 - bounded tool workspace -> scroll-body-shell (existing chat shell);
scroll owner: .execution-panel; graph-only horizontal scroll: .execution-graph;
anti-patterns: document scrolling, nested vertical scrollbars, hidden permission prompts.
The fixed chat header and tabs remain outside the panel. At narrow widths controls
wrap and graph remains an explicitly labeled two-dimensional viewport; node output
wraps instead of forcing page overflow. Tabs and fields have accessible names.
Native minimum window width remains 760px; web panel stress-check also uses 390px.

The app owns research stages and a bounded verify/correct loop. Independent research
roles use separate ACP sessions in parallel, in plan mode. Implementation roles run
only in workflows explicitly labeled as modifying code. New sessions copy the selected
model and effort and never select another provider. Local taste is project-scoped
browser storage, not model training and not silent modification of user taste files.
