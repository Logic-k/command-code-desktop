# 발전 방향 리서치: ACP v2 · 경쟁 지형 · 배포 (2026-11-03)

작성 2026-11-03 · 대상 CommandCode_Desktop v0.5.0 (HEAD a28f93e) · 성격: 리서치 보고서 (구현 전)
판정: **관측** = 조회 시점에 확인한 사실, **제안** = 방향 판단, **미확인** = 구현 전 확인 필요.

## 1. 외부 환경이 바뀌었다 (관측)

### 1.1 ACP v2 스펙 공개 — 현재 앱은 v1 시대 구현

`agentclientprotocol.com/protocol/v2` 기준 새 메서드·알림:

| v2 기능 | 현재 앱 | 가져오면 얻는 것 |
|---|---|---|
| `session/list` `resume` `close` `delete` | JSONL 기록 파일 직독(`launch.rs`) | 프로토콜로 히스토리 열기. 파일 포맷 변경에 안 깨짐 |
| `plan_update` | CLI `todos` mod 의존 (알려진 한계) | mod 없이 Plan 패널. 공식 앱과 동급 |
| `state_update` + stop reason | 추정 로직 | 백그라운드 작업 진행·중단 이유 정확 표시 |
| `terminal_update` (에이전트 소유 터미널) | 없음 | 에이전트가 띄운 명령 출력을 채팅 안에 표시 |
| `session/set_config_option` | 커스텀 방식 추정 | 모드·모델 전환의 공식 경로 |
| `elicitation/create` | 질문 카드 (사유 방식) | 구조화된 질문 UI |
| `auth/login`/`logout` | `cmd login` 프로세스 감시 | 계정 흐름 단순화 가능성 |
| `$/cancel_request` | 타임아웃만 | WP-01 수명 계약의 공식 취소 경로 |
| compaction·사용자 notice 알림 | 사용량 게이지 자체 추정 | 컨텍스트 압축 시점·결과 정확 반영 |
| messageId 기반 메시지 update | 스트림 청크 누적 | 메시지 수정·정렬 가능 |

`cmd acp` 문서상 "Threads: New, reopen with history, list, close" — CLI는 이미 list/resume 류를 노출. 앱이 v2로 올라가면 JSONL 스크래핑 의존을 줄일 수 있다.

### 1.2 CLI 1.88.2 — 앱 문서 기준(1.87.1) 이후 변화

- 1.87.2: `cmd acp`가 `--mod`·mod 옵션 로드 — **실행 탭 역할 세션에 mod 주입 가능해짐**
- 1.87.0: `/btw` (턴 중 옆 질문)
- 1.87.3: `--permission-mode` Claude Code 별칭
- 1.88.0: 백그라운드 작업이 활성 무료 모델로 실행 (`/config` 토글)
- 1.85.1: **BYOK 모델이 ACP 모델 선택기에 표시** — `providers.json`이 스레드 열 때마다 재독됨. 앱의 "사용 가능 모델" 판정이 catalog 외 BYOK까지 넓혀야 함을 의미

### 1.3 공식 데스크톱 앱 v0.1.60 (Electron, 베타, 주 단위 릴리스)

있음: 번들 런타임(CLI 불필요), Workbench(Changes/Files/Terminal/Plan), Browser+Design 모드, **Providers 페이지(BYOK + ChatGPT 구독 + GitHub Copilot 구독 연결)**, Remote control(Telegram/Discord), Artifacts 게시, mods 패널, worktree, 아카이브, PR 링크 칩, TTFT·tok/s, RTL·스크린리더.

공식 앱에 **없는 것**: headless, `/share`, 예약 작업, 백그라운드 작업 중지, 시작 플래그, 서브커맨드, **`dont-ask` 권한 모드**, 다수 슬래시 명령.

> 핵심 관측: 공식 앱의 Providers 페이지가 WP-03이 목표로 한 "ChatGPT 구독 실행 경로"를 이미 제공한다. 우리가 같은 것을 직접 구현(SIWC·스키마 고정)할 이유가 사라졌다.

### 1.4 범용 ACP 클라이언트 100+ — 채팅 GUI 자체는 상품화

생태계에서 우리 실행 탭과 가장 가까운 것:

| 프로젝트 | 겹치는 점 | 배울 점 |
|---|---|---|
| AiRC Orchestration | 병렬 모델 팀, 승인 제어 | 지속 목표·플랜 저장 구조 |
| Raven (`raven acp`) | 과업을 DAG로 나눠 노드별 ACP 에이전트 실행 | DAG-per-node 실행 패턴 |
| Alchemist Coder | 에이전트 트리, worktree, Arena | "같은 과업 여러 에이전트" Arena 모드 |
| OctoShell | worktree+쉘+계획 라운드+QA 패스 | 계획→실행→검증 UX 흐름 |
| Bellows | 실행 중 세션 링크 공유·제안 | 관전/제안 프로토콜 |
| opcode(구 Claudia, 22k★, Tauri 2) | 사용량 대시보드, 체크포인트 | 체크포인트/롤백 UX |

모두가 갖고 우리가 없는 것(테이블 스테이크): **worktree-격리 실행, 헝크 단위 diff 리뷰, 파일 브라우저, 브라우저 미리보기, 모바일/원격 감시, 레지스트리 원클릭 에이전트 설치**.

아무도 안 하는 것(우리 해자): **유형화된 리서치 캠페인(.research 파일), 주장 장부+출처 등급, 검증 영수증, 미해결 질문→다음 사이클 루프, dont-ask 무인 역할**.

## 2. WP-03 재평가: Codex 어댑터는 살 필요가 없다 (관측+제안)

- `@agentclientprotocol/codex-acp` v2.5.0 (agentclientprotocol org 공식, Codex App Server 기반, 활발): **ChatGPT 구독 인증·API 키·커스텀 게이트웨이** 내장, 세션 목록/재개, steering, 서브에이전트 세션, goals 확장, 백그라운드 작업.
- **ACP Registry** (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`): 인증 지원 에이전트 큐레이션, 배포 형식 binary(GitHub 릴리스)/npx/uvx. Athas·AcpAgentClient·Threadlines·OpenACP가 이미 이걸로 원클릭 설치를 제공.
- AIR 확장군(권장 config 값, diff patch, sessionIndex, goals, `_session/steering`, 서브에이전트 세션)이 사실상 업계 확장으로 퍼지는 중.

**제안: WP-03을 "SIWC 어댑터 직접 구현"에서 "범용 ACP 백엔드 + codex-acp 레시피"로 재정의한다.**
- WP-02의 `ProviderBinding`은 이미 다중 백엔드를 상정 → 실행 명령만 `cmd acp` 고정에서 "등록된 ACP 에이전트 프로세스"로 일반화.
- ChatGPT 구독 지원 = codex-acp 설치+실행 가이드/레지스트리 연동으로 해결. SIWC·토큰 관리·스키마 고정 작업 전량 제거 가능(미확인: codex-acp의 사용량/과금 이벤트를 우리 게이지에 어떻게 매핑할지).
- 보너스: 레지스트리 연동 시 앱이 "Command Code 전용 GUI"에서 "아무 ACP 에이전트로 돌리는 리서치 작업대"로 확장 — 사용자 층이 실질적으로 넓어진다.

## 3. 배포·검증 인프라 (관측)

- 열린 PR #1: Windows NSIS 인스톨러 CI. 병합이 전제.
- **tauri-plugin-updater + 서명 아티팩트**가 표준 경로: `tauri signer generate`로 키페어 → `createUpdaterArtifacts` → 정적 JSON 매니페스트(GitHub Releases에 둘 수 있음). 현재 "소스 폴더에서 자체 재빌드" 업데이트는 개발자용이고, 설치본 사용자에게는 updater 플러그인이 정답. 둘을 분리 유지(소스빌드 감지 시에만 자체빌드 표시).
- Windows 코드 사이닝: OV 인증서(개인 가능) 또는 Azure Trusted Signing. **공식 앱도 Windows 서명이 없는 상태** — 우리가 먼저 서명하면 SmartScreen 신뢰에서 역전.
- **acp-tck** (agentclientprotocol/acp-tck): ACP 적합성 테스트 키트, experimental. WP-01의 수명 계약 검사에 fixture 에이전트로 붙일 수 있고, `cmd acp` 자체에도 돌려 호환성 회귀를 CI로 추적 가능.

## 4. 발전 방향 종합 (제안)

우선순위는 "해자를 깊게, 테이블 스테이크는 싸게, 공식 앱과의 정면 대결은 피한다".

### P0 — ACP v2 클라이언트 업그레이드 (기존 WP-01에 병합, 가성비 최고)

1. `plan_update` 수신 → `todos` mod 없이 Plan 패널 (알려진 한계 하나 해소).
2. `session/list`+`resume` → 지난 대화를 프로토콜로 열기. JSONL 직독은 폴백으로 격하.
3. `state_update`·`$/cancel_request` → WP-01 수명 계약 구현 시 공식 경로 사용.
4. `set_config_option`·`elicitation` → 모드/모델/질문 카드 정식화.
5. acp-tck를 QA 스위트에 추가 (`cmd acp` 대상 + 자체 클라이언트 fixture).

### P1 — 리서치 해자 (11-02 설계서 그대로, 이미 합의된 방향)

- `.research/` 캠페인 저장·주장 장부·유형 프리셋: `research-system-design-2026-11-02.md` 3.6 항목 1~3을 WP-00 뒤 첫 패키지로 (설계서 자체 결론과 동일).
- 레지스트리-불가침 원칙: `.research/` 포맷은 앱 비의존. 다른 도구가 써도 앱이 읽어 보여 줌 → 포맷이 사실상 표준이 되면 해자가 된다.

### P2 — 범용 백엔드 (WP-02/WP-03 재정의)

- ProviderBinding 일반화 → Command Code 첫, codex-acp 둘째(레지스트리 설치 레시피).
- 사용량 게이지는 백엔드별 능력으로 강등(없으면 미표시, 0원·무제한 표시 금지 — 기존 계획 계약 유지).
- 미확인: CLI 백엔드의 BYOK 모델을 게이지 판정에 넣을지 (1.85.1로 ACP 표출은 됨).

### P3 — 무인 실행의 안전장치 (차별점 강화)

- build/taste 실행에 **worktree 격리 옵션**: 무인 역할이 작업 트리를 직접 만지는 것은 dont-ask의 최대 위험. CLI `enter_worktree` 도구는 에이전트 주도이므로, 앱이 실행 전 worktree를 만들고 세션 루트로 넘기는 쪽(호스트 주도)을 검토.
- 격리된 worktree + 변경 파일 목록 + diff = 검증자와 사용자가 "무엇이 바뀌었나"를 보는 최소 Changes 뷰(공식 앱의 전체 git UI까지는 불필요).

### P4 — 배포

- PR #1 병합 → tauri-plugin-updater + 서명 → (선택) 코드 사이닝.
- 자체 재빌드 업데이트는 `dev` 소스 경로에서만 표시하도록 분리.

### 보류/기각

- Browser 미리보기·Design 모드, 원격 제어(모바일), 세션 공유 링크: 시장에 널리고 리서치 미션과 무관 → 명시적 비목표 유지.
- Arena(동일 과업 다중 에이전트): P2 이후 `team` 워크플로의 자연 확장으로만 고려.
- 전체 git 워크벤치: Changes 뷰 최소 범위로 충분.

## 5. 리스크·미확인 목록

- 다중 계정: ToS 충돌 조건은 `REVIEW-2026-10-31.md` 그대로 유효. P2로 백엔드가 늘면 "계정 전환"의 의미가 "어떤 백엔드/프로필"로 자연 재정의됨 — 기능 이름·UX를 그쪽으로 옮기면 충돌 표면이 줄어든다.
- `/alpha/` 요금 API: 미확인 유지. 게이지 의존이므로 백엔드별 격리는 P2에서 필수.
- codex-acp가 노출하는 사용량/한도 정보가 없으면 ChatGPT 경로는 게이지 없이 동작함을 수용.
- ACP v2에서 `cmd acp`가 실제로 광고하는 capability 목록은 initialize 응답으로 확인 필요 — 문서의 "Threads" 표가 v2 전체 구현을 보증하지 않는다.
- acp-tck는 experimental, 커버리지 부분적. 통과=적합성 공식 선언 아님.

## 6. 공식 근거

- ACP v2: https://agentclientprotocol.com/protocol/v2/overview (session-setup, prompt-lifecycle, tool-calls, agent-plan, elicitation, cancellation 절)
- ACP Registry: https://github.com/agentclientprotocol/registry · `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
- codex-acp: https://github.com/agentclientprotocol/codex-acp (v2.5.0, 2026-10-29)
- acp-tck: https://github.com/agentclientprotocol/acp-tck · https://agentclientprotocol.com/libraries/testing
- Command Code ACP 문서: https://commandcode.ai/docs/acp (Threads·BYOK·MCP in ACP)
- 공식 데스크톱 문서: https://commandcode.ai/docs/desktop (Workbench·Providers·미지원 목록)
- Command Code 체인지로그: https://commandcode.ai/changelog (CLI 1.85~1.88, Desktop 0.1.56~0.1.60)
- npm `command-code` 1.88.2 (modified 2026-10-29)
- Tauri updater: https://v2.tauri.app/plugin/updater/ · Windows 서명: https://v2.tauri.app/distribute/sign/windows/
- 경쟁 라운드업: omniscio.com/blog/best-claude-code-gui, crystl.dev/compare/claude-code-guis, agentastic.dev/compare/best-claude-code-gui
