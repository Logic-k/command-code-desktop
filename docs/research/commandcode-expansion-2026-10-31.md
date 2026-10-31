# 연구에서 제작까지 이어지는 작업대

CommandCode Desktop 확장 리서치 · 조회 기준 2026-10-31

판정 구분: **관측**은 읽거나 실행한 사실, **제안**은 이번 설계 선택,
**미확인**은 후속 실행의 게이트다. 성능·품질 향상률은 추정하지 않았다.

## 권고: 기능 수보다 신뢰 경계

**Tauri와 기존 실행기를 유지하고, 증거·복구가 가능한 연구·제작 작업대로
확장한다.** 첫 작업은 그래프 확대가 아니라 역할별 권한, 끝나는 취소,
실제 검사 영수증이다. 다음으로 저장된 연구 근거를 검토하고
**이 근거로 구현**을 선택하는 흐름을 만든다. 그 뒤에 승인 가능한 학습과
배포 품질을 더한다. 이것은 제품 제안이지 아직 입증된 사용자 효과가 아니다.
[S1][S24][S25][S28]

단기 MVP의 핵심은 한 목표에 대해
`조사 → 근거·반증 검토 → 구현 범위 승인 → 제작 → 실제 검사 → 재사용 제안`
을 끊김 없이 연결하는 것이다. 실행 DAG는 순서·대기를, 근거 그래프는
지지·반박 관계를 보여 준다. 둘을 같은 그래프로 합치지 않는다.
[S9][S24][S25]

## 관측: 현재 기능의 실제 경계

기존 소스에는 ACP 채팅, 터미널, 기록 재생, 설치·업데이트, 실행 탭,
리서치 역할 DAG와 검증·수정 루프가 있다. 새 실행 상태는 메모리에 있고
수동 내보내기를 제공한다. CLI 대화 재생은 실행기의 크래시 복구가 아니다.
이번 조사는 이전 네이티브 QA를 라이브 모델·Rust stdio 증거로 재사용하지
않았다. [S24][S25][S26][S27][S28]

| 항목 | 이번에 확인한 것 | 아직 증명하지 않은 것 |
|---|---|---|
| 검증 판정 | 아무 도구도 실행하지 않은 합성 executor가 근거 문자열을 반환하면 통과했다 | 실제 명령·출처의 진실성 |
| 학습 후보 | 최초 회고 뒤 수정이 성공해도 수정 전 교훈이 후보로 남았다 | 해당 교훈의 재사용 효과 |
| 로컬 취소 | 이벤트 barrier로 유발한 형제 실패에서 나머지가 정리되고 후속 노드가 시작되지 않았다 | 응답하지 않는 실제 provider의 취소·종료 |
| 읽기 전용 | 자식 요청이 부모 권한 처리기로 전달되고 부모 모드를 참조한다 | 실제 쓰기 탈출은 재현하지 않음 |
| 네이티브 수명 | IPC 전송 실패 분기에 명시적 kill 없이 registry 제거와 wait가 있다 | 실제 orphan 발생은 재현하지 않음 |

위 표의 실행 관측은
`bun .omo/ulw-research/20261031-commandcode-expansion/verify-claims.mjs`
로 재현된다. 정상적인 기존 JSON 가드도 함께 확인했다. probe의 exit 0은
**현재 한계를 의도한 대로 관측했다**는 뜻이며 미래 수정의 수용 시험 통과가
아니다. 정적 위험은 실행으로 재현된 취약점처럼 표현하지 않는다.
[S1][S24][S25][S26]

## 제안: 결과와 근거를 앞에 둔다

기본 화면은 요약·대안·미확인·산출물이다. 보조 화면은 근거 표, 실제 이벤트
타임라인, 변경 검토, 관계 그래프다. 그래프를 읽지 않아도 전체 작업을 수행할
수 있어야 한다. 사용자 작업, 앱 run, provider session/thread는 서로 다른
정체성으로 관리한다. 현재도 역할마다 세션을 생성하므로 이 구분은 실제
구조와 맞는다. [S25][S28]

**제안 흐름**

1. 목표·완료 기준·허용되는 변경·실행 경로를 입력한다.
2. 조사 역할이 출처 스냅샷과 주장·반증·대안을 모은다.
3. 사용자가 근거 묶음의 revision과 구현 범위를 승인한다.
4. 제작은 승인된 묶음을 입력으로 고정하고 새로운 attempt에서 실행한다.
5. 실제 검사와 변경 검토를 통과한 결과만 완료로 승격한다.
6. 최종 산출물에 묶인 학습 후보를 개별 검토한다.

이 흐름은 설계 제안이다. 역할 수나 합의 수를 조사 품질의 대리 지표로 쓰지
않는다. **이번 제안은** 같은 과제·같은 예산의 단일 조사자 기준선과 팀을
비교하는 것이다. 새 외부 평가 서비스의 과금이나 저장소에 제품을 종속시키지
않는다. 아래 출처를 그 비교 실험 자체의 결과로 제시하지 않는다. [S1][S9][S19][S21]

## 구독 연동: 가능성과 출시를 구분

개발 세션의 `chatgpt-subscription` 경로와 현재 제품의 Command Code 계정은
다르다. 이번 조사 작업도 같은 구독 provider로 명시 고정했고 다른 모델
fallback을 사용하지 않았다. 이는 제품에 구독 연동이 구현됐다는 뜻이 아니다.
[S5][S18][S25]

공식 SIWC 문서는 로컬·오픈소스 앱의 동의 기반 ChatGPT plan usage 경로를
설명한다. 따라서 모든 제3자 구독 사용이 불가능하다는 일반화는 맞지 않는다.
반대로 신원 로그인만으로 추론 권한이 생기거나, 유료·호스팅 앱에도 같은
허용 범위가 적용된다고 볼 수 없다. 사용자 자격·scope·도구 지원과 credits
사용 가능성은 별도 확인해야 한다. [S3][S4][S5]

Codex app-server에는 안정 메서드 구분과 명령·전송의 실험적 지원 고지가 함께
존재한다. 안정 메서드를 쓴다는 사실만으로 production 지원을 확정하지 않는다.
기존 Codex 관리형 로그인과 앱 소유 SIWC 토큰 갱신도 서로 다른 계약이다.
새 SIWC 토큰을 내부용 auth-token 메서드에 넣는 경로는 선택하지 않는다.
[S2][S3][S4][S23]

**제안:** 기존 ACP와 별도인 provider adapter를 실험 기능으로 분리한다.
로컬 stdio, 정확한 runtime/schema 버전, 실효 인증·모델, 갱신·취소·재연결을
먼저 검증한다. production 지원과 사용자 자격이 닫히기 전에는 기본 엔진으로
출시하지 않는다. API-key/provider fallback은 없다. 앱이 allowance만 소비하고
추가 credits는 절대 소비하지 않음을 확인할 수 없다면 그 엄격 모드는 실행을
거부해야 한다. 이것은 기능 실패가 아니라 비용 계약을 지키는 동작이다.
[S2][S4][S5][S20][S23]

## 저장과 복구: 외부 효과는 별개

**제안:** 기존 TypeScript scheduler와 Rust 소유의 로컬 SQLite 저장소를
조합한다. 상태 projection과 이벤트·attempt·receipt는 같은 Rust transaction에서
저장한다. UI가 여러 IPC로 SQL BEGIN/COMMIT을 조합하는 설계는 쓰지 않는다.
최초 복구 범위는 기록 열기와 명시적 새 attempt다. [S8][S15][S16]

전송 직전이나 외부 변경 후 응답 전의 크래시는 결과가 불명확하다. DB가
정상이라는 이유로 불투명한 agent의 변경을 자동 재실행하면 안 된다.
`cancel_requested`, 종료 확인, 연결 유실, 효과 불명을 구분한다. lease도 이전
worker의 종료 증명이 아니다. 현재 단일 데스크톱에 분산 lease와 원격 worker를
도입할 이유는 없으며, exactly-once 외부 효과는 보장하지 않는다.
[S16][S25][S26]

SQLite 후보는 번들 버전과 빌드 옵션을 확인하고 고정한다. WAL의 내구성·수정
버전과 라이브 DB 백업 조건을 확인해야 한다. WAL checkpoint와 앱 실행
checkpoint도 다른 개념이다. 자세한 채택 게이트는 실행계획에 둔다.
[S8][S15][S30][S31]

## 리서치 근거: 문자열보다 영수증

**제안:** 모델의 `agentVerdict`, 호스트 관측 `checkReceipt`, 완료 기준의
`acceptanceDecision`을 분리한다. receipt도 내용의 참을 보장하지 않으므로,
원문 무결성과 주장 함의를 별도로 검토한다. 출처는 URL 언급, 수집 성공,
실제 인용 구간, 의미 검토를 구분한다. 차단 페이지나 검색 요약은 본문을
읽었다는 증거로 승격하지 않는다. [S1][S24]

명령 검사는 사용자가 승인한 check 정의를 호스트가 실행해 수집한다.
모델이 직접 exit code나 receipt를 등록할 수 없어야 한다. provider tool
이벤트는 `provider-reported`, 호스트가 실행한 명령은 `host-observed`로 남긴다.
검증하지 못한 호출까지 하나의 신뢰 등급으로 합치지 않는다. [S1][S25]

출처·동료 결과·가져온 스킬은 비신뢰 데이터다. 읽기 전용 프롬프트나
`allowed-tools` metadata는 샌드박스가 아니다. 권한은 역할·run·attempt에
묶고 취소 후 늦은 요청은 거부한다. 승인 ID에는 provider session도 포함해
서로 다른 역할의 같은 tool ID가 섞이지 않게 한다. [S9][S14][S25]

## Taste: 승인된 절차의 재사용

Hermes의 memory/skills 경로는 환경 사실·선호·절차 문서를 관리하고 필요할 때
컨텍스트에 로드한다. 이것을 Hermes 전체의 RL과 같은 기능이라고 부르면
안 된다. Command Code `taste-1`의 내부 구현이나 효과 역시 공개 문서만으로
독립 검증하지 못했다. [S11][S12]

**제안:** `preference`, `procedure`, `environmentFact`를 구분한다.
명시적 사용자 선호와 성능·성공을 주장하는 절차의 근거 요건도 다르다.
절차는 최종 attempt·산출물 hash·receipt에 묶고 수정이 생기면 이전 후보를
stale 처리한다. 후보별 승인, diff, 버전 철회가 필요하다. 실행 시작 시 승인된
revision을 고정하며 중간에 조용히 학습 내용을 바꾸지 않는다. [S1][S9][S22][S24]

자동 회고를 무조건 승격하거나 기본 background learning을 켜지 않는다.
Markdown 스킬도 스크립트나 보조 모델을 호출할 수 있다. 상위 모델만 고정하면
모든 호출이 구독 경로를 지킨다는 가정은 실제 오픈소스 helper 코드가 반증한다.
개인화의 품질 향상은 후속 비교 평가 전까지 미확인이다. [S20][S21][S22]

## 재사용: 런타임보다 필요한 부품

| 대상 | 선택 | 이유와 경계 |
|---|---|---|
| 기존 Tauri·DOM/SVG·ACP | 유지 | 이미 있는 실행·화면 경계를 보강; 전면 재작성 안 함 |
| Rust SQLite wrapper | 고정 후보 채택 | 단일 writer와 원자적 상태 변경; 채택 전 runtime 확인 |
| Agent Skills | 형식·선별 코드 재사용 | 개별 라이선스·경로·스크립트 검사와 승인 별도 |
| Hermes | 설계·작은 코드 선별 | MIT 고지 보존; Python agent 전체 내장은 보류 |
| LangGraph | 패턴 차용, 도입 보류 | WebView 저장소와 외부 효과 문제는 남음 |
| Temporal | 원격 worker 요구 때 재검토 | 현재 로컬 앱에는 별도 운영 경계가 추가됨 |
| 연구 예제 실행기 전체 | 보류 | 보조 API/모델·검색 과금과 실패 전파를 별도 감사해야 함 |
| 새 그래프 라이브러리 | 현재 보류 | 기존 SVG와 표로 시작; 관계 탐색 한계가 실측될 때 비교 |
| Command Code CLI 번들 | 허가 전 제외 | 설치본의 UNLICENSED와 MIT shell을 혼동하지 않음 |

위는 제품 선택이다. 도구 간 성능 우열을 측정했다는 뜻이 아니다. Agent Skills의
코드·문서 라이선스와 개별 skill 자산을 분리한다. source reference를 둔다고
복사한 코드의 고지 의무가 사라지지 않는다. [S9][S15][S16][S21][S28][S29][S30][S32][S33]

## 실행 순서: 안전한 한 경로부터

| 우선 구간 | 결과 | 하지 않을 것 |
|---|---|---|
| 기반 | 실패하는 무추론 fixture, 역할 권한, bounded RPC·정리, 최종 revision 교훈 | 모형의 성공 문자열로 수용 판정 |
| 저장 | Rust 이벤트·attempt·receipt 저장, 기록 재구성, 수동 복구 | 불명확한 쓰기 자동 재실행 |
| 제품 MVP | 근거 표·결과·승인·변경·그래프, 연구에서 제작으로 전환 | 그래프를 보기 위한 앱 |
| 구독 실험 | 고정 adapter의 인증·실효 모델·비용·취소 게이트 | 지원 범위 미확인 production 기본값 |
| 개인화 | 개별 승인·철회·고정 revision·비교 평가 | 자동 RL 또는 개선율 마케팅 |
| 배포 | 서명 업데이트, 깨끗한 OS의 실제 설치·복구 | 소스 재빌드를 일반 업데이트로 배포 |

세부 선후 관계와 파일별 작업은
`../../.omo/plans/commandcode-research-platform.md`에 있다.
역할 권한과 종료 경계가 저장보다 먼저 고정돼야 잘못된 상태를 영구화하지
않는다. 제품 효과는 한 실제 연구·제작 과제의 완주로 먼저 검증한다.
[S1][S8][S13][S14][S24][S25][S26]

## 중단 게이트와 미확인

- **구독 게이트:** 사용자 자격, 허용 scope, 실효 모델·과금 출처가 확인되지
  않으면 해당 adapter 추론을 시작하지 않는다.
- **권한 게이트:** 실제 read-only 집행을 확인하지 못하면 best-effort라고
  표시하고 자율 조사·구현으로 승격하지 않는다.
- **복구 게이트:** 효과가 불명확한 attempt는 성공·실패를 추정하거나 자동
  replay하지 않는다.
- **품질 게이트:** 라이브 연구·코드 품질과 개인화 효과는 아직 미확인이다.
  오프라인 fixture 통과를 그 증거로 대체하지 않는다.
- **배포 게이트:** CLI 재배포 허가, 요금 API 지원 범위, 서명·대상 OS 설치
  확인이 없으면 일반 사용자 배포를 완료했다고 하지 않는다.

Command Code의 개인 복수 계정 제한은 정책 확인 사항이며 실제 계정 운영의
위반 여부를 단정하지 않았다. 약관 개정일은 확인되지 않아 조회일만 썼다.
계정·인증·제품 소스는 이번 조사에서 변경하지 않았다. [S2][S3][S4][S17][S26][S29]

## 방법과 검증 범위

구독 모델로 명시 고정한 독립 조사와 리드의 원문·코드·실행 반례를 종합했다.
별도 역할의 합의를 독립적인 진실 증명으로 세지 않았다. 팀 도구는 멤버별
모델 고정을 전달하지 않아 사용하지 않았다. 확장·반박은 원장의 wave 기록과
claim graph에 남겼다. [S1][S24][S25]

사용자 브라우저는 연결 권한이 승인되지 않아 자료를 읽지 못했다.
공개 공식 HTTP 원문과 고정 커밋, 로컬 코드를 사용했으며 브라우저로 읽었다고
표현하지 않는다. BrowserSkill 연결 준비는 수행했지만 제품·추론 runtime을
설치하지 않았다. 로그인·API-key 추론·외부 모델·제품 빌드는 수행하지 않았다.
제품의 라이브 추론, Rust stdio, OS별 설치 QA는 후속 계획의 별도 게이트다.
[S1][S26]

주장·출처·반박·실행 증거 원장:
`.omo/ulw-research/20261031-commandcode-expansion/`.
공유한 결론·출처 색인·관측·독립 교정 결과는 같은 폴더의 `README.md`,
`source-index.json`, `review-verdict.md`, `expansion-log.md`에서 확인한다.
기계 종속 `outcome.json`·`journal.md`와 전체 raw cache는 원래 환경에만 보존한다.
새 환경의 재개는 루트 `HANDOFF.md`를 따른다.

## 출처

아래는 선택한 원문이다. 공유 원장에는 URL·조회 시점·원래 snapshot hash를
보존하며 제3자 전체 본문은 배포하지 않는다. 원본 raw bytes와 sentence index는
원래 조사 환경의 로컬 cache에 있다. S29는 라이선스 관련 선택 필드만 공유한다.

[S1]: ../../.omo/ulw-research/20261031-commandcode-expansion/sources/S1/text.txt
[S2]: https://learn.chatgpt.com/docs/app-server
[S3]: https://developers.openai.com/siwc/token-sharing-open-source
[S4]: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
[S5]: https://developers.openai.com/codex/auth
[S8]: https://sqlite.org/wal.html
[S9]: https://agentskills.io/specification
[S11]: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
[S12]: https://hermes-agent.nousresearch.com/docs/user-guide/features/memory
[S13]: https://v2.tauri.app/plugin/updater/
[S14]: https://v2.tauri.app/security/capabilities/
[S15]: https://v2.tauri.app/plugin/sql/
[S16]: https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance
[S17]: https://commandcode.ai/terms
[S18]: https://commandcode.ai/docs/acp
[S19]: https://developers.openai.com/api/docs/deprecations
[S20]: https://github.com/promptfoo/promptfoo/blob/5582f347bbc5359b201ce2d48c9c7fbebd8dcbd9/src/providers/openai/codexApiKeyGating.ts
[S21]: https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/examples/open_deep_research/scripts/visual_qa.py
[S22]: https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/tools/write_approval.py
[S23]: https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/app-server-protocol/src/protocol/v2/account.rs
[S24]: ../../src/workflow.ts
[S25]: ../../src/views/chat.ts
[S26]: ../../src-tauri/src/acp.rs
[S27]: ../../src/store.ts
[S28]: ../../package.json
[S29]: ../../.omo/ulw-research/20261031-commandcode-expansion/sources/S29/license-summary.json
[S30]: https://github.com/rusqlite/rusqlite/blob/18ee76dbb976d5ef7e37ad5a8fffae678ca21a78/Cargo.toml
[S31]: https://github.com/rusqlite/rusqlite/blob/18ee76dbb976d5ef7e37ad5a8fffae678ca21a78/libsqlite3-sys/sqlite3/sqlite3.h
[S32]: https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/README.md
[S33]: https://github.com/NousResearch/hermes-agent/blob/c419cf7c864ac0ee511dbd9f7091a8bba0b567ee/LICENSE
