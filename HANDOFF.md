# 다른 환경에서 이어가기

기준: 2026-10-31. 이 문서는 코드·조사·계획을 넘기기 위한 인계 문서다.
설치본 배포나 라이브 제공자 통합 완료를 뜻하지 않는다.

## 먼저 읽을 문서

1. [AI 실행계획](.omo/plans/commandcode-research-platform.md)
2. [확장 리서치](docs/research/commandcode-expansion-2026-10-31.md)
3. [리서치 HTML 요약](docs/research/commandcode-expansion-2026-10-31.html)
4. [기존 구현 QA와 한계](docs/evidence/2026-10-31/QA.md)
5. [정책·현황 검토](docs/REVIEW-2026-10-31.md)
6. [공유한 조사 원장](.omo/ulw-research/20261031-commandcode-expansion/README.md)

## 현재 구현

- Tauri/Rust 데스크톱 앱과 ACP 채팅·터미널·설치·업데이트.
- 실행 탭의 역할별 그래프·결과, 리서치/팀/연구 후 구현/Taste 워크플로.
- 독립 세션 조사, 검증·수정 루프, 프로젝트 취향 저장, 학습 후보 반영,
  결과 JSON 내보내기.
- 명령: `/desktop-research`, `/desktop-team`, `/desktop-build`, `/desktop-taste`.
  목표를 붙이면 설정 화면을 열며 자동으로 추론을 시작하지 않는다.

현재 제품은 **Command Code 계정**을 사용한다. 새 Codex/SIWC(ChatGPT 구독)
어댑터는 아직 구현하지 않았다. 개발 작업의 모델 경로는 특정 구독으로 제한하지
않는다(2026-11-01 사용자 지시). 실제 계정으로 하는 검증은 오프라인 검사 뒤에
최소 범위로 하고, 쓴 모델과 대략의 비용을 기록한다.

## 다음 구현의 첫 순서

계획서의 `WP-00` 기준 검사 후 `WP-01` 권한·수명 경계를 진행한다.
기능을 무작정 늘리거나 실행기를 전면 교체하는 단계가 아니다.

2026-11-01에 해소한 한계 (오프라인 peer·단위 시험으로 확인, 라이브 모델 미검증):

- 위조한 verifier 문자열만으로 `passed`가 되던 문제: 검증 세션에서 앱이 직접 본
  완료 도구 호출(코딩은 `execute`)이 없으면 통과하지 않는다.
- 수정 후에도 최초 reflection 후보가 노출되던 문제: 수정마다 `reflect-N`을 다시 실행하고
  마지막 회고만 후보로 쓴다. 후보는 체크한 것만 취향에 반영한다.
- 자식 역할 권한이 부모의 실시간 bypass 처리기에 연결되던 문제: 시작 시 고정한 정책을 쓰고,
  읽기 전용 역할의 변경 요청은 거부한다. bypass에서도 `_meta.risk` 요청은 자동 허용하지 않는다.
- RPC 무응답: `session/prompt` 외 요청에 시간 제한, `session/close` 실패는 결과를 바꾸지 않는다.
  시작 중 `stop()`과 webview 단절(native IPC 끊김) 때 에이전트 프로세스를 정리한다.

위 수정으로 `verify-claims.mjs`는 첫 gap assertion(V-PROOF)에서 실패하는 것이 정상이다.

남은 한계:

- 검증 통과는 "명령이 실행됐다"까지만 확인한다. 명령이 목표를 실제로 검사했는지는 보증하지 않는다.
- bypass 모드의 코딩 검증 역할은 CLI가 묻지 않는 편집을 막을 수 없다(지시로만 금지).
- 실행 영속화·크래시 복구·receipt 기반 판정은 계획 단계다.
- 이전 네이티브 화면 QA는 메모리 ACP peer를 사용했다.
  Rust stdio·실제 모델 품질·macOS 검증으로 대체할 수 없다.

독립 문서 검토에서 DAG·파일 경계·상태 계약의 차단 항목을 수정했고,
재검토는 해당 항목이 해소됐다고 판정했다. 이는 구현 승인이나 라이브 동작
검증이 아니다.

## 새 환경 준비

```sh
git clone https://github.com/Logic-k/command-code-desktop.git
cd command-code-desktop
git pull --ff-only
```

게시 전 검사 환경은 Node.js `22.14.0`, pnpm `11.9.0`, Bun CLI `1.3.14`였다.
Vite의 Node 요구는 `^20.19.0 || >=22.12.0`이다. 이것을 최신 버전 추천이나
모든 운영체제에서 확인한 조합으로 해석하지 않는다.

pnpm이 없다면 해당 버전을 준비한 뒤 잠금 파일을 유지한다.

```sh
npm install --global pnpm@11.9.0
pnpm install --frozen-lockfile
pnpm build
bun scripts/qa/workflow.mjs
```

Bun은 위 QA 스크립트에 필요하다. 애플리케이션 사용자에게 Bun 설치를
요구하는 것은 아니다. Rust 데스크톱 개발은 대상 OS의 Tauri prerequisites
(Windows MSVC/WebView2 또는 macOS Xcode command-line tools)를 준비한다.

```sh
pnpm tauri dev
```

`pnpm dev`는 Vite 개발 서버만 실행한다. 일반 브라우저에서 실제 Tauri/Rust
동작이 전부 된다고 가정하지 않는다. 모델·계정은 각 환경에서 공식 경로로
다시 인증하며 token·keychain·개인 설정을 Git으로 옮기지 않는다.

## 조사 반례 재현

```sh
bun .omo/ulw-research/20261031-commandcode-expansion/verify-claims.mjs
```

이 스크립트의 exit 0은 현재 한계를 의도대로 관측했다는 뜻이다.
버그가 고쳐지면 일부 gap assertion이 실패하는 것이 맞다. 이것을 제품의
수용 시험으로 합치거나 green을 위해 버그 수용 조건을 유지하지 않는다.
원래 관측은 원장의 S1 stdout·command receipt에 보존했다.

## 연구 자료의 공유 경계

원장에는 결론·주장·관측·반박·확장 기록, 원문 URL·조회 시점·hash 색인,
자체 probe와 공개 가능한 결과를 포함했다.
제3자 문서의 전체 raw cache, 임시 브라우저 profile, 로컬 session/goal 로그,
개인 계정 디렉터리와 기계 종속 fill map은 Git에 넣지 않는다.
원문이 필요하면 색인의 URL·고정 commit에서 새로 수집하고, 내용이 바뀌면
새 관측으로 기록한다. 과거 hash와 다르다는 이유로 과거 증거를 덮어쓰지 않는다.

개인 SecondBrain 볼트가 없는 환경은 막히지 않는다. 저장소의 이 문서와
계획·보고서를 기준으로 재개한다. 개인 볼트·이전 session ID는 실행 의존성이 아니다.

## 다음 AI에게 전달할 지시

```text
HANDOFF.md와 .omo/plans/commandcode-research-platform.md를 읽고
현재 작업 트리를 확인한 뒤 WP-00부터 실행하라.
유료 추론을 쓰는 검증은 최소 범위로 하고 쓴 모델과 비용을 기록하라.
기존 사용자 변경을 보존하고 권한·종료·증거 계약을 먼저 고쳐라.
오프라인 peer, 실제 Rust stdio, 라이브 모델, 대상 OS 검증을 구분하라.
자격 없는 외부 게이트는 blocked로 남기고 가능한 기반 작업은 계속하라.
새 세션에서 commit/push/release는 그 세션의 사용자 지시에 따른다.
```
