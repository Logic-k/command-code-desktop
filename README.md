# Command Code Desktop

Command Code CLI를 GUI 앱처럼 쓰는 Windows 데스크톱 앱입니다 (Tauri 2).
폴더를 고르면 바로 대화가 시작되고, 터미널도 `cd`도 필요 없습니다.

```
┌ 사이드바 ─────┬ [채팅: 버그 수정] [채팅: 새 대화] [터미널] [+] ─────────────────┐
│ + 새 채팅     │ cmdc-gui        [표준 ▾] [Claude Sonnet 5.5 ▾] [high ▾] ▮▮▯ 21% │
│ 프로젝트       │                                                        │
│ ▾ cmdc-gui   │                     README에 설치 방법 추가해 줘  (사용자)     │
│   대화 A  2시간│  ▸ Read README.md                                  [완료]   │
│   대화 B  1일  │  ▾ Edit README.md                        +5 −0     [완료]   │
│ ▸ anki       │     (diff)                                                │
│              │  ⛨ 권한 요청  $ pnpm test   [1 한 번 허용] [2 항상] [3 거부]   │
│ ⚙ 설정        │  [ 무엇을 할까요? ( / 명령 · 이미지 붙여넣기 )          → ]      │
└──────────────┴────────────────────────────────────────────────────────┘
```

## 기능

- **채팅 탭 (ACP)**: `cmd acp`(Agent Client Protocol)로 CLI와 대화합니다.
  - 마크다운·코드 하이라이트 답변, 접을 수 있는 "생각" 블록
  - 도구 실행 카드 (읽기/수정/검색/명령 실행), 파일 수정은 diff로, 경로 클릭 시 파일 열기
  - 권한 요청은 버튼 또는 숫자 키 `1`~`4`로 응답
  - 할 일(todo) 진행률 패널, 컨텍스트 사용량 게이지
  - 모드(표준/편집 자동 허용/계획/묻지 않기/권한 무시)·모델·추론 강도 드롭다운, `Shift+Tab`으로 모드 순환
  - `/` 명령 자동완성, 이미지 붙여넣기·드래그 앤 드롭
  - 작업 중 입력하면 대기열에 쌓였다가 차례로 전송, `Esc`로 중지
- **지난 대화 이어 하기**: 사이드바에서 프로젝트를 펼치면 그 폴더의 세션 목록이 나옵니다. 클릭하면 기록 파일(`~/.commandcode/projects/…/<id>.jsonl`)을 바로 그려 주고, 뒤에서 세션에 다시 연결합니다.
- **터미널 탭 (TUI)**: 진짜 Command Code TUI를 ConPTY로 띄웁니다. 로그인, `/usage`, `/config`처럼 GUI에 없는 기능용. `Ctrl+C`(선택 시 복사)·`Ctrl+V`·우클릭 지원.
- **끌어다 놓기**: 폴더를 창에 놓으면 프로젝트로 열리고, 이미지를 놓으면 현재 대화에 첨부됩니다.
- **한 창으로**: 앱이 켜져 있을 때 `cmdc-gui.exe D:\project`를 다시 실행하면 새 창 대신 기존 창에 그 폴더가 열립니다. 창 크기·위치는 기억합니다.
- **알림**: 창이 뒤에 있을 때 응답 완료·권한 요청을 Windows 알림으로 알려 주고, 탭에 점을 표시합니다.
- **설정**: 새 채팅 기본 모드, 보내기 키, 테마(시스템/어둡게/밝게), 계정 프로필 폴더, 터미널 글자 크기.

### 단축키

| 키 | 동작 |
| --- | --- |
| `Ctrl+N` | 새 채팅 (현재 프로젝트) |
| `Ctrl+O` | 폴더 열기 |
| `Ctrl+T` | 터미널 탭 |
| `Ctrl+W` | 탭 닫기 |
| `Ctrl+Tab` / `Ctrl+1~9` | 탭 전환 |
| `Ctrl+B` | 사이드바 접기 |
| `Ctrl+,` | 설정 |
| `Esc` | 진행 중인 작업 중지 |
| `Shift+Tab` | 권한 모드 순환 |

## 실행

필요: Node 22+, Rust stable, pnpm, 그리고 설치·로그인된 Command Code CLI (`npm i -g command-code`, `cmd login`).

```bash
pnpm install
pnpm tauri dev
```

배포용 빌드 (설치 파일은 `src-tauri/target/release/bundle/`):

```bash
pnpm tauri build
```

폴더를 바로 열기:

```bash
cmdc-gui.exe D:\project
```

## 구조

설계와 근거는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

| 파일 | 역할 |
| --- | --- |
| `src-tauri/src/launch.rs` | CLI 위치 확인, 시작 폴더, 세션 기록 파일 읽기 |
| `src-tauri/src/acp.rs` | `cmd acp` 프로세스 실행, 줄 단위 JSON-RPC 운반, 종료 시 프로세스 트리 정리 |
| `src-tauri/src/pty.rs` | 터미널 탭: ConPTY로 TUI 실행 |
| `src/acp/client.ts` | JSON-RPC 클라이언트 (요청/응답, 알림, 권한 요청) |
| `src/acp/pool.ts` | 폴더당 에이전트 프로세스 하나를 공유 |
| `src/acp/transcript.ts` | 세션 기록 JSONL → 화면 업데이트 |
| `src/views/chat.ts` | 채팅 화면 |
| `src/views/terminal.ts` | 터미널 화면 |
| `src/main.ts` | 사이드바, 탭, 설정, 단축키, 알림 |

## 알려진 한계

- `cmd acp`가 처음 뜨는 데 10~20초 걸립니다(CLI 자체 시작 시간). 같은 폴더의 두 번째 대화부터는 연결을 재사용해 빠릅니다.
- ACP는 슬래시 명령 일부(`/compact`와 스킬)만 노출합니다. `/usage`, `/config`, `/rewind` 등은 터미널 탭에서 쓰세요.
- 할 일 패널은 CLI의 `todos` 모드가 켜져 있어야 나옵니다 (`cmd mods enable todos -g`).
- 계정 프로필 폴더를 바꾸면 그 폴더가 홈이 되므로 git 전역 설정 등도 분리됩니다.

## 범위

이미 설치하고 구독 중인 Command Code CLI를 감싸는 개인용 데스크톱 셸입니다. Command Code를 포함·재배포·재구현하지 않으며, 계정 정보(`~/.commandcode/auth.json`)는 읽거나 복사하지 않습니다.
