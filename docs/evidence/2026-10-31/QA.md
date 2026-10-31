# 실행 워크플로 QA — 2026-10-31

## 검증 범위

HEAD `f5a395e` 위의 이번 소스 변경. 기존 debug Tauri executable이 최신 Vite
소스를 로드한 실제 Windows WebView2 창에서 검사했다. `scripts/qa/desktop.html`
엔트리는 실제 ChatView, AcpConnection request/receive, 실행기와 그래프를 사용하며
boot/send만 결정적 로컬 peer로 대체한다.

**증명하지 않은 것:** Rust stdio 전송, Command Code 서버의 동시 세션 동작,
실제 모델의 리서치 품질·코드 생성·검증 판정, macOS 동작. 이 세션에서는
ChatGPT 구독만 사용한다는 제약 때문에 다른 제공자 추론을 호출하지 않았다.
기존 설치본을 업데이트하거나 설치 파일을 배포한 결과가 아니다.

## 명령·관측

| 시나리오 | 실행 | 관측 | 결과 |
| --- | --- | --- | --- |
| 빈 목표 | `native.ps1 -Action click -Name "실행 시작"` | 목표 오류, session/prompt 0개 | PASS |
| 팀 실행 | 목표 입력 후 team 선택·네이티브 시작 클릭 | 3개 독립 세션, 모두 plan, model/effort 복사 | PASS |
| 검증 루프 | peer retry 모드에서 팀 실행 | verify-1 실패 → correct-2 → verify-2 통과, 8개 노드 | PASS |
| 노드 결과 | `native.ps1 -Action click -Name "verify-1: 독립 검증 (failed)"` | 실패한 검증의 원문 JSON 표시 | PASS |
| 잘못된 JSON | `qa.setMode("malformed")` 후 시작 | 실패, 다음 수정 노드 없음, 자식 세션 0개 | PASS |
| 동시 취소 | `qa.setMode("hold")`, team 시작, native 중지 클릭 | running 3→0, sessions 4→1(기본 채팅) | PASS |
| Taste | taste 선택, 취향 저장, 시작 | inspect/reflect/verify는 plan, implement는 default, 4개 완료 | PASS |
| 학습 후보 | native `학습 후보를 취향에 반영` 클릭 | 프로젝트 저장소에 후보 추가, 후속 실행에 전달 | PASS |
| 명령 | composer에 `/desktop-team Compare SQLite and DuckDB for local research` 입력·Enter | 팀 설정 열림, 목표 일치, 자동 추론 없음 | PASS |
| 이전 ULW | `qa.observe()` | plan/node 이벤트의 worker 완료·verify 상태 관찰 | PASS |
| 그래프 일치 회귀 | 완료한 team 뒤 다음 워크플로 taste 선택 | 이전 team 그래프·제목·결과가 서로 일치 | PASS |
| 내보내기 | Browser.downloadWillBegin/Progress 구독 후 native 내보내기 클릭 | completed 6,099 bytes; JSON의 kind=team/status=passed/8 output nodes | PASS |
| 보조 상태 검사 | `bun scripts/qa/workflow.mjs` | 9개 결정적 상태 시나리오, exit 0 | PASS |
| 빌드 | `pnpm build` | tsc + Vite, exit 0 | PASS |
| diff 검사 | `GIT_MASTER=1 git diff --check` | exit 0 | PASS |

네이티브 명령은 모두
`powershell -NoProfile -File scripts/qa/native.ps1` 뒤에 위 인수를 붙여 실행한다.
peer 설정·DOM 관측은 omowright가 `http://127.0.0.1:9337`의 실제 WebView2에
연결해서 수행했다. 성공 실행 JSON은 `team-run.json`에 보존했다.

## 화면 증거

- `native-final-team.png`: 팀 검증 통과 상태와 네이티브 다운로드 확인 패널.
  다운로드 패널이 있으므로 레이아웃 판정용 캡처로는 사용하지 않는다.
- `native-team-retry.png`: 실패한 검증 노드 선택.
- `native-taste-learning.png`, `native-taste-applied.png`: 학습 후보 표시·저장.
- `native-malformed.png`, `native-cancelled.png`: 실패·중지 상태.
- `native-empty.png`: 빈 목표 입력.
- `{desktop-1440,iphone-14}-{dark,light}-{research,team,build,taste}.png`:
  최종 소스의 16개 설정 화면. 실제 WebView2에 omowright `emulate()` 적용.
  1440px/390px에서 document와 panel의 가로 overflow 모두 0.
  그래프는 명시적인 가로 스크롤 영역이며 좁은 화면에서도 페이지를 밀어내지 않는다.
  16장 모두 직접 열어 blank/겹침/본문 잘림을 검사했다.

## 자체 검토

HEAVY 유지: 새 워크플로 상태·비동기 병렬 실행을 추가했다.
ulw-plan 산출물이 없으므로 별도 모델 리뷰어가 아니라 자체 검토했다.
diff와 새 실행기·패널을 다시 읽고 취소 시 자식 수명, malformed 판정,
읽기 전용 역할, 선택 모델 복사, 과거 실패의 보존을 확인했다.
타입 오류와 그래프/결과 불일치는 이번 검사에서 발견해 수정했다.
소스 내 테스트 skip/억제는 추가하지 않았고 기존 사용자 파일은 보존했다.

## 남은 운영 확인

실제 Command Code 계정으로 위 경로를 실행한 통합 검증이 필요하다.
이번 오프라인 PASS를 라이브 모델 검증이나 모든 정책 준수 승인으로 해석하면 안 된다.
앱 종료 후 실행 자동 복구, 공식 Codex 구독 어댑터, 자동 RL은 이번 구현에 없다.

## 자원 정리 영수증

- QA 세션 dispose 및 omowright 연결 close 완료.
- 소유 native/Vite 모니터 `bash_4`, `bash_2` 종료.
- PowerShell 조회: `{"processes":[],"listeners":[]}`.
  cmdc-gui 프로세스 없음, TCP 1420/9337 listening 없음.
- 소유 임시 폴더 `C:\Users\kimmi\AppData\Local\Temp\ulw-commandcode-Utrzz0`
  재귀 삭제 후 stat=ENOENT. WebView 프로필·다운로드·런타임 캐시 포함.
- 원시 성공 JSON과 화면 증거는 이 폴더에 보존했다.
