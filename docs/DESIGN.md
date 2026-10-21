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
| `ui/markdown.ts` | marked + DOMPurify + highlight.js |
| `ui/diff.ts` | 줄 단위 LCS diff → 통합 diff 화면 |
| `store.ts` | 최근 프로젝트, 설정 (localStorage) |

## 4. 안전 원칙

- 에이전트 출력은 모두 DOMPurify를 거친 뒤 렌더링한다(마크다운 안의 HTML·스크립트 차단).
- 권한 모드 기본값은 `default`(매번 묻기). `bypass`는 빨간 경고와 함께만 선택 가능.
- 클라이언트 측 `fs`/`terminal` 능력은 광고하지 않는다. 파일 접근은 CLI가 자기 권한 체계로 한다.
- 계정 정보(`~/.commandcode/auth.json`)는 읽지도 복사하지도 않는다.

## 5. 이후 단계 (v0.3+)

- 프로필 전환 UI (USERPROFILE 분리, v0.1에서 배선만 됨)
- 이미지 드래그 앤 드롭 외 파일 첨부(@멘션 → `resource_link`)
- 세션 포크/되감기 (ACP 미노출, TUI로 대체 중)
- 자동 업데이트, 설치 프로그램 서명
