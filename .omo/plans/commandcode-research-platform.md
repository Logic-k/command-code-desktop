# CommandCode 연구·제작 작업대 실행계획

문서 버전: 2026-10-31 · 상태: 독립 검토의 실행 차단 항목 해소

목적: 후속 AI 에이전트가 실행할 의사결정 완료형 작업 명세.
**이번 리서치 요청은 구현 승인이 아니다. 사용자가 실행을 지시한 뒤 착수한다.**

## 시작할 에이전트에게

1. 이 파일과 `docs/research/commandcode-expansion-2026-10-31.md`를 끝까지 읽는다.
2. 저장소 지침·기억과 현재 Git 상태를 확인한다. 원래 환경의
   `E:/SecondBrain/AGENTS.md`가 있으면 참조하되 개인 볼트가 없는 새 환경은
   `HANDOFF.md`와 이 계획서로 재개한다. 개인 볼트는 실행 의존성이 아니다.
3. 이전 세션의 미커밋 제품 변경을 기준 상태로 보존한다. HEAD만 체크아웃하거나
   변경을 되돌려 시작하지 않는다. 커밋은 별도 지시가 있을 때만 한다.
4. 모델 호출 경로는 특정 구독으로 제한하지 않는다(2026-11-01 사용자 지시로
   이전의 ChatGPT 구독 전용 제약을 폐지). Command Code 크레딧 등 유료 추론을
   쓰는 검증은 범위를 최소로 하고, 쓴 모델·대략의 비용을 증거에 기록한다.
5. `WP-00`부터 선행 게이트 순서대로 실행한다. 시간·컨텍스트 부족을 이유로
   실패를 성공 처리하지 않는다. 중단 시 현재 패키지·증거·미확인을 기록한다.

이 계획의 설계 상수는 제품 선택이며 성능 측정값이 아니다.
실제 제공자 자격·production 지원·allowance-only 보장이 확인되지 않으면
`WP-03`의 live 게이트는 닫히지 않는다. 이 때문에 오프라인 기반 작업을 막지는
않지만 “ChatGPT 구독 지원 출시 완료”로 보고하면 안 된다.

## 결과와 비목표

### 사용자에게 제공할 결과

목표를 등록하고, 근거가 연결된 조사 결과를 검토한 뒤, 고정한 근거 묶음으로
제작을 시작한다. 진행·승인·변경·검사 결과를 확인하고 앱 재시작 후에도
기록을 다시 연다. 최종 결과에서 나온 절차는 개별 승인·철회할 수 있다.

### 최소 버전에서 하지 않을 것

- Hermes/Python agent 또는 LangGraph/Temporal 전체 런타임 도입.
- 분산 worker, 서버 orchestration, 다중 장치 동기화, multi-writer lease.
- 불투명한 외부 효과의 exactly-once 또는 자동 crash replay.
- 자동 RL, 자동 background learning, 품질 향상률 보장.
- 그래프 때문에 React로 전환하거나 새 graph library를 기본 의존성으로 추가.
- 사용자 `.commandcode/taste/`, 기존 계정·token 파일을 암묵적으로 수정.
- provider의 raw RPC·shell·토큰을 원격 서비스에 노출.
- CLI의 복사·번들 배포, 일반 사용자용 source-rebuild updater.

## 기준 상태와 출발 증거

조사 시 HEAD는 `f5a395e`였지만 실행기·Taste·QA 변경은 작업 트리에 있었다.
따라서 후속 에이전트는 현재 파일을 읽고 baseline 해시를 기록해야 한다.
핵심 파일:

| 현재 경로 | 실제 역할 |
|---|---|
| `src/workflow.ts` | 메모리 DAG, 모델 JSON verifier, correction, reflection |
| `src/views/chat.ts` | 자식 ACP 세션·권한·설정·취소 연결 |
| `src/acp/client.ts`, `pool.ts` | JSON-RPC와 공유 CLI 프로세스 |
| `src/ui/execution.ts`, `dag.ts` | 실행 패널·SVG와 CLI 관찰 그래프 |
| `src/store.ts` | 설정·프로젝트 localStorage |
| `src-tauri/src/acp.rs`, `launch.rs` | 프로세스·stdio·환경 전달 |
| `src-tauri/src/lib.rs` | Rust command 등록·앱 수명 |
| `scripts/qa/workflow.mjs`, `desktop.ts`, `native.ps1` | 기존 무추론·네이티브 peer QA |

리서치 반례:
`bun .omo/ulw-research/20261031-commandcode-expansion/verify-claims.mjs`.
이는 위조 verdict와 오래된 reflection을 **현재 받아들임**을 관측하는 probe다.
수정 후에는 같은 증상이 재현되지 않음을 제품 acceptance에서 검사한다.
프로브의 현행 gap assertion을 테스트 성공의 증거로 가져오지 않는다.

## 결정 기록

| 결정 | 채택 | 기각·조건 |
|---|---|---|
| 실행기 | 기존 TS scheduler 보강 | 전면 재작성하지 않음 |
| 저장 | Rust 단일 writer + SQLite | frontend 임의 SQL, localStorage 실행 원장 금지 |
| 구독 backend | 별도 실험 Codex adapter spike | 기존 ACP를 Codex RPC로 바꾸지 않음 |
| 증거 | 호스트 receipt와 모델 verdict 분리 | URL·문자열·모델 합의만으로 완료 금지 |
| 연구 UI | 결과/근거 우선, 활동/변경/관계 보조 | 실행 DAG와 근거 graph 혼합 금지 |
| 개인화 | 승인된 revision의 선호·절차·환경 사실 | 최초 reflect의 무조건 승격 금지 |
| 반복 | bounded attempts, 수정 후 재검사 | 무한 루프, unknown 효과 자동 재실행 금지 |
| 배포 | 서명 artifact와 대상 OS 실설치 | MIT shell을 제3자 CLI 라이선스로 간주 금지 |

근거: 보고서의 [S1], [S2]–[S5], [S8], [S9], [S15], [S16],
[S20]–[S26], [S29]–[S33]. 대시 범위는 출처 ID 범위다.

## 불변 계약

### 정체성과 관측 등급

앱의 `ProjectId`, `TaskId`, `RunId`, `NodeId`, `AttemptId`와 provider의
`SessionId/ThreadId`, `TurnId`, `ItemId`, JSON-RPC request ID를 분리한다.
영속 ID는 Rust에서 생성하고 테스트에서는 ID 생성기를 주입한다.
표시용 `Date.now()`를 실행 정체성으로 사용하지 않는다.

```ts
type ObservationTrust = "host-observed" | "provider-reported" | "agent-claimed" | "user-attested";
type ExecutionState =
  | "queued" | "running" | "waiting-approval" | "cancelling"
  | "completed" | "failed" | "interrupted" | "unknown";
type IntegrityState = "not-run" | "passed" | "failed" | "unknown";
type SemanticState = "unassessed" | "supported" | "contested" | "insufficient";
type AcceptanceState = "pending" | "accepted" | "rejected" | "needs-review";
type DispatchState = "not-dispatched" | "dispatch-intent" | "acknowledged" | "unknown";
```

`completed`는 실행 완료일 뿐 검사·의미·사용자 검토의 통과가 아니다.
모델은 `agentVerdict`만 제안한다. 호스트 receipt와 acceptance의 쓰기 권한은
Rust 서비스가 소유한다. 자체 서버가 아닌 provider 이벤트도 그대로 호스트
명령 receipt로 승격하지 않는다.

### 실행·권한

```ts
interface RolePolicy {
  role: "research" | "critic" | "implement" | "verify";
  projectId: string;
  readOnlyRequired: boolean;
  network: "public-sources" | "approved" | "none";
  allowedCheckIds: string[];
  allowedWriteRoots: string[];
}
interface ProviderBinding {
  backendId: string;
  runtimeVersion: string;
  schemaHash: string;
  authKind: "chatgpt-managed-local" | "chatgpt-siwc" | "legacy-acp";
  requestedModel: string;
  effectiveModel: string | null;
  billingRoute: "chatgpt-plan" | "api-key" | "unknown";
  fallbackAllowed: false;
}
interface TurnHandle {
  events: AsyncIterable<NormalizedEvent>;
  done: Promise<ExecutionOutcome>;
  interrupt(reason: string): Promise<CancelReceipt>;
}
```

위 코드의 `NormalizedEvent`, `ExecutionOutcome`, `CancelReceipt`는
`WP-02`에서 discriminated union으로 정의한다. 원시 provider payload와
correlation ID를 보존한다. `done`은 한 번만 settle하며 terminal 결과 없는
EOF·부분 스트림·timeout은 `completed`가 아니다.

권한 키는 `{runId, attemptId, backendSessionId, rpcRequestId}`다.
부모 탭의 bypass·카운트다운·첫 선택 자동 응답을 연구 역할에 상속하지 않는다.
readOnly를 provider나 host sandbox가 집행하지 못하면
`readOnlyEnforcement="best-effort"`로 표시하고 strict 연구 실행을 거부한다.
UI 힌트인 tool kind나 프롬프트만으로 집행을 주장하지 않는다.

취소 요청을 받은 뒤 새 승인·dispatch를 금지하고 대기 승인에 cancelled로
응답한다. 늦은 완료는 감사 이벤트로 남기되 다음 노드를 깨우지 않는다.
워크플로는 채팅 공유 풀과 격리된 프로세스 소유권을 갖는다.

**제안 기본값:** control RPC deadline 30,000ms, cancel acknowledgement 10,000ms,
close 5,000ms. 추론 turn은 사용자가 설정한 실행 예산으로 제한한다.
정상 요청의 무조건 재시도는 없다. provider 확인 없는 취소는 unknown/interrupted다.
이 수치는 측정 결과가 아니라 테스트 가능한 초기 정책값이며 실제 운영 전에
조정할 수 있다. 테스트는 주입 clock·이벤트 gate로 수행하고 실제 sleep은 쓰지 않는다.

병렬 연구는 최대 두 역할, 프로젝트별 쓰기 attempt는 하나가 기본이다.
이는 내부 앱 실행 admission 정책이지 사용자·외부 에디터를 잠그는 장치가 아니다.
provider의 동시 세션 능력이 확인되지 않으면 병렬 모드를 제공하지 않는다.
직렬 대안은 명시적으로 사용자가 고르게 하며 조용히 바꾸지 않는다.

### 저장과 이벤트

신규 정본은 `src-tauri/src/workflow_store.rs`. `rusqlite = "=0.41.1"`의
`bundled`, `backup`을 채택 후보로 고정하고 `WP-04`에서 실제 호환·SQLite
버전을 확인한다. 후보 교체가 필요하면 이유·license·runtime version을
결정 기록에 남기고 관련 검사를 다시 한다. 이 패키지는 현재 설치된 것이 아니다.

DB는 `app_local_data_dir` 아래에 둔다. 최소 테이블:

| 테이블 | 핵심 필드 |
|---|---|
| projects | id, canonical_root, root_identity, display_root |
| runs | id, task_id, project_id, workflow_version, spec_json, spec_hash, projection_json, seq |
| attempts | id, run_id, node_id, attempt_no, iteration, policy_json, binding_json, execution_state, dispatch_state |
| events | run_id, seq, operation_id, kind, payload_json, payload_hash |
| artifacts | id, run_id, attempt_id, kind, content_hash, storage_ref, trust |
| receipts | id, run_id, attempt_id, check_id, subject_hash, outcome, payload_json |
| research_bundles | id, run_id, revision, content_hash, bundle_json |
| learning_artifacts | id, version, kind, status, project_id, content_hash, payload_json |
| approvals | id, run_id, attempt_id, scope_json, state, base_hash, decided_at |

`(run_id,seq)`, `operation_id`, `(learning id,version)`에 유일성을 둔다.
동일 operation ID와 동일 payload는 기존 결과를 반환한다. 다른 payload는
충돌로 거부한다. event와 projection/attempt/receipt 변경은 한 transaction이다.
네트워크·모델·프로세스 대기 중 transaction을 열어 두지 않는다.

공개 Rust 명령은 `workflow_create`, `workflow_transition`, `workflow_load`,
`workflow_list`, `workflow_export`로 시작한다. 요청 스키마·expected seq·호출
권한·run ownership을 검증한다. 임의 SQL·임의 저장 경로·클라이언트 작성
`passed` 상태를 받지 않는다.

artifact는 임시 파일→완료 파일의 atomic rename 후 hash를 확인하고 참조한다.
DB와 파일시스템이 하나의 transaction이라고 주장하지 않는다. 재시작 때
missing/hash mismatch는 unavailable/unknown으로 표시하고 성공 판정에 쓰지 않는다.

schema version과 workflow behavior version을 분리한다. migration checksum을
보존하고 알 수 없는 미래 schema에서는 실행·자동 downgrade를 거부한다.
실행 정의와 입력 revision을 새 기본값으로 덮어쓰지 않는다.
WAL·FULL 동기화와 backup API를 사용하고 실제 `sqlite_version()`을 기록한다.
라이브 `.db`만 복사하거나 네트워크 공유 DB를 사용하지 않는다.

### 근거와 검사

```ts
interface SourceSnapshot {
  id: string;
  requestedUrl: string;
  finalUrl: string | null;
  fetchedAt: string;
  status: "captured" | "blocked" | "failed";
  httpStatus: number | null;
  rawHash: string | null;
  textHash: string | null;
  extractorVersion: string;
  truncated: boolean;
  artifactId: string | null;
}
interface Citation {
  snapshotId: string;
  startByte: number;
  endByte: number;
  quote: string;
  relation: "supports" | "contradicts" | "context";
}
interface ResearchClaim {
  id: string;
  text: string;
  kind: "observation" | "inference" | "proposal";
  scope: string;
  asOf: string | null;
  citations: Citation[];
  premiseIds: string[];
  semanticState: SemanticState;
}
interface CheckReceipt {
  id: string;
  runId: string;
  attemptId: string;
  checkId: string;
  subjectHash: string;
  trust: ObservationTrust;
  outcome: "pass" | "fail" | "unknown";
  artifactIds: string[];
}
```

schema 정본은 `src/domain/workflow.ts`, runtime 검증은 경계에서 한 번 한다.
TypeScript와 Rust 간 전송 DTO는 기계가 검증하는 fixture를 공유한다.
하나의 정본에서 생성하거나, 생성이 과하면 동일 JSON fixture로 왕복 계약을
검증한다. 둘을 손으로 변경한 뒤 prose 비교로 통과시키지 않는다.

인용 범위는 LF 정규화 UTF-8 텍스트의 `[startByte,endByte)`다. 비문자 경계,
범위 초과, 잘못된 snapshot/run ID, quote 불일치, truncated 본문을 거부한다.
구간 일치와 의미의 참을 같은 판정으로 취급하지 않는다.

호스트 검사 정의는 사용자가 승인한 실행 파일·argv·cwd·대상 hash다.
모델은 check ID만 요청하며 exit code와 receipt를 만들 수 없다.
임의 shell 문자열을 실행하지 않는다. 프로젝트 스크립트도 신뢰 승인이 필요하다.
실제 host 실행의 stdout/stderr/exit/signal과 timeout을 보존한다.
존재하지 않거나 다른 attempt·산출물의 receipt를 성공 판정에 쓸 수 없다.

외부 URL fetch는 http/https와 승인된 public 목적지만 허용하고 redirect마다
검증한다. 내부망·loopback·metadata·credential URL은 기본 차단한다.
DNS 재해석도 검증하고 비밀 헤더를 전달하지 않는다. 로컬 출처는 별도 명시적
허용 기능으로 나눈다. 원문은 escaped text로 표시하고 privileged WebView로
직접 로드하지 않는다.

### 학습과 연구에서 제작으로

bundle은 claims/sources/citations/leads/decisions/unknowns를 포함한 immutable
revision이다. 구현 시작은 `{bundleId,revision,hash,scope,approvalId}`를 고정한다.
미확인은 삭제하지 않고 구현 가정으로 표시한다.

학습 artifact는 `preference | procedure | environmentFact`,
`proposed | evaluated | approved | active | stale | rejected | revoked`다.
source/run/attempt/최종 subject hash/receipt IDs/승인/이전 version을 가진다.
수정으로 subject hash가 바뀌면 기존 후보는 stale이다. 최초 reflect를
그대로 재사용하지 않는다. 최종 검사 뒤 재추출하거나 사용자가 근거를 새로
확인한 후보만 승인한다.

`approve(id,expectedVersion,expectedBaseHash)`와 감사 이벤트·이전 버전 보존을
한 transaction으로 처리한다. 철회는 그 artifact의 보상 revision이며
사용자 파일이나 저장소 전체를 되돌리지 않는다. 승인된 선호·스킬 revision을
run 시작에 고정한다. 자동 archive/delete/background learning은 없다.

## 패키지 DAG

**아래 표가 선행 관계의 유일한 정본이다.** 본문의 패키지 설명은 이 표를
따라야 한다. `mode`는 WP-09 평가 manifest에서 명시적으로 선택한다.

| 패키지 | 필수 선행 | 외부 게이트 |
|---|---|---|
| WP-00 | 없음 | 새로운 구현 지시 |
| WP-01 | WP-00 | 없음 |
| WP-02 | WP-01 | 없음 |
| WP-03 오프라인 | WP-02 | 없음 |
| WP-03 live | WP-03 오프라인 | 사용자 검증 승인, 자격·범위·비용 계약 |
| WP-04 | WP-01 | 없음 |
| WP-05 | WP-02, WP-04 | 없음 |
| WP-06 | WP-05 | 없음; 실제 추론은 WP-03 live 필요 |
| WP-07 | WP-05 | 없음; 실제 추론은 WP-03 live 필요 |
| WP-08 | WP-06, WP-07 | 두 패키지의 DTO·상태 계약이 고정돼 있어야 함 |
| WP-09 mode=offline | WP-06, WP-07, WP-08 | 없음; WP-03에 의존하지 않음 |
| WP-09 mode=live | WP-06, WP-07, WP-08, WP-03 live | 실제 구독 실행 승인 |
| WP-10 | WP-09 mode=live | 공개 배포 지시·서명·제공자 허용 범위 |

`WP-06/07/08`은 같은 domain/store 계약에 의존하므로 그 계약이 먼저 안정돼야 한다.
서로 다른 UI/domain/Rust 파일을 동시에 수정하는 무제한 fan-out은 하지 않는다.
구현 위임은 서로 겹치지 않는 경로만 병렬화하고 `lib.rs`, domain, migrations의
합류는 리드가 직렬 처리한다. 하위 모델 고정이 검증되지 않으면 직접 실행한다.

## WP-00: 기준 상태와 사용자 과제

- 선행: 구현에 대한 새 사용자 지시.
- 읽기: 위 baseline 파일, `docs/evidence/2026-10-31/QA.md`, 현재 CI, lockfiles.
- 수정 경계: 신규 `scripts/qa/baseline.mjs`,
  `scripts/qa/fixtures/golden-research/`, `.github/workflows/qa.yml`;
  기존 `scripts/qa/workflow.mjs`.
- 작업:
  - 현재 Git diff·파일 hash·설치 runtime과 모델 경로를 기록한다.
  - `pnpm build`, `bun scripts/qa/workflow.mjs`,
    `cargo test --manifest-path src-tauri/Cargo.toml`을 baseline 실행한다.
  - 기존 실패는 분리 기록하고 테스트 기대값을 green 목적으로 바꾸지 않는다.
  - 고정 golden project를 만든다: SQLite/DuckDB 로컬 연구 비교 fixture에서
    근거를 확인하고 간단한 문서 검색 모듈을 제작·검사하는 과제.
    입력 문서, 기대 검색 결과, malformed/empty/boundary 조건을 고정한다.
    실제 모델 답변 문구는 assertion으로 고정하지 않는다.
  - 새로운 상태·권한·수명·영수증 반례를 먼저 실패시키는 테스트를 추가한다.
- 수용: baseline 결과와 원래 실패를 분리할 수 있고, V-PROOF/V-STALE에 대한
  미래 acceptance는 현재 코드에서 실패한다.
- 증거: baseline manifest, 실행 stdout/exit, golden fixture hash.

## WP-01: 역할 권한과 끝나는 수명

- 선행: WP-00.
- 수정: `src/views/chat.ts`, `src/acp/client.ts`, `src/acp/pool.ts`,
  `src-tauri/src/acp.rs`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `scripts/qa/desktop.ts`.
  신규 `scripts/qa/acp-lifecycle.mjs`, `src-tauri/tests/acp_lifecycle.rs`,
  `src-tauri/src/bin/acp_fixture.rs`.
  helper는 `qa-fixtures` 전용 feature를 요구하고 release 기본 빌드에는 포함하지 않는다.
- 작업:
  - 자식 정책·signal·session correlation을 권한 handler에 전달한다.
  - 부모 bypass와 연구 권한을 분리하고 scope 상승은 자동 승인하지 않는다.
  - RPC에 operation deadline·AbortSignal·pending 제거를 추가한다.
  - workflow 전용 transport 소유권을 만들고 공유 채팅을 강제 종료하지 않는다.
  - new/config/prompt/close 각각의 취소·timeout·late-event 경로를 처리한다.
  - renderer 채널 단절과 정상 EOF를 구분하고 소유 프로세스 트리를 회수한 뒤
    registry에서 제거한다. 회수 여부를 확인하지 못하면 unknown이다.
- 수용 시나리오:
  - 부모 bypass + 자식 strict research + edit/mode-upgrade 요청은 자동 허용되지 않는다.
  - 같은 tool ID를 쓰는 두 세션의 응답이 섞이지 않는다.
  - 각 lifecycle 요청을 보류한 뒤 취소하면 bounded 종료, pending/승인 누수 없음.
  - 한 형제 실패 + 다른 형제 승인 대기, 취소 후 늦은 요청도 정리된다.
  - 실제 Rust stdio helper의 renderer 단절·EOF·kill에서 소유 PID와 자식이 종료된다.
  - 기존 다른 채팅은 계속 사용 가능하다.
- 검증: `bun scripts/qa/workflow.mjs`, 신규 `bun scripts/qa/acp-lifecycle.mjs`,
  `cargo test --manifest-path src-tauri/Cargo.toml`, native QA.
  새 helper는 추론 없이 stdin 사건과 명시적 gate로만 동작한다.

## WP-02: provider 계약과 비용 경계

- 선행: WP-01.
- 신규: `src/providers/types.ts`, `src/providers/acp.ts`.
  수정: `src/acp/client.ts`, `src/views/chat.ts`, `src-tauri/src/launch.rs`.
  신규 검사: `scripts/qa/provider-contract.mjs`, `scripts/qa/fixtures/providers/`.
- 작업:
  - TurnHandle·정규 event/outcome/cancel union을 정의하고 ACP를 감싼다.
  - legacy observer/외부 plan event와 앱 소유 scheduler event를 구분한다.
  - 모델 설정 응답의 effective 값·auth kind·capability를 확인한다.
  - 자식 환경은 provider별 allowlist로 구성한다. API-key 환경, feature model,
    압축·이미지·embedding·평가의 우회 경로와 provider fallback을 금지한다.
  - unknown usage를 0원·무제한·entitled로 표시하지 않는다.
- 수용: 설정 요청과 응답이 다른 peer, missing capability, API-key env,
  partial EOF, provider error가 실행 전 거절되거나 정직한 실패가 된다.
- 검증: `bun scripts/qa/provider-contract.mjs`와 기존 빌드/QA.
  모든 호출은 local peer; 실제 모델 비용은 발생하지 않는다.

## WP-03: 구독 adapter 실험

- 선행: WP-02. 오프라인 구현과 live 자격 게이트를 분리한다.
- 신규: `src/providers/codex.ts`, `src-tauri/src/codex.rs`,
  필요한 경우 `src-tauri/src/siwc.rs`; 등록은 `lib.rs`.
  schema 출력은 신규 `src/providers/codex-generated/`,
  검사·고정 transcript는 `scripts/qa/codex-contract.mjs`,
  `scripts/qa/fixtures/codex/`. manifest 변경은 `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, 등록은 `src-tauri/src/lib.rs`만이다.
- 기본 선택: 로컬 stdio app-server, 버전 고정 생성 schema, 실험 UI 표시.
  문서/바이너리 production 지원이 닫히기 전 기본 엔진·공개 지원으로 승격하지 않는다.
- 작업:
  - 정확한 runtime에서 `generate-ts` 또는 `generate-json-schema` 결과를 고정한다.
  - initialize/initialized, thread/start, turn/start, interrupt, terminal event,
    resume/pagination, command/file approval을 adapter에 연결한다.
  - 최초 spike는 공식 Codex 관리형 로컬 인증과 SIWC를 혼합하지 않는다.
    기존 로컬/OSS 경로의 허용 범위를 다시 확인한다.
  - SIWC가 선택되면 시스템 브라우저·PKCE/state/nonce, 발급 client ID,
    scope·ID token 검증과 직렬 refresh·프로세스 재시작을 별도 구현한다.
    내부용 chatgptAuthTokens나 비공개 backend endpoint를 사용하지 않는다.
  - 토큰은 Rust/OS keychain에 두고 frontend·로그·argv·export에 넣지 않는다.
    상속 환경으로 다른 프로세스에 전파하지 않는다.
- 오프라인 수용: transcript fixture의 승인 거절·취소·갱신·EOF·resume·중복
  이벤트와 실효 모델 불일치를 정확히 처리한다.
- live GO 조건: 사용자의 해당 검증 승인, 실제 계정 자격·scope, 비용 경로,
  runtime support 및 한도/철회/refresh/취소/재연결의 실제 영수증.
  allowance-only를 요구하는데 credits 제외를 확인할 계약이 없으면 NO-GO.
- 검증: `bun scripts/qa/codex-contract.mjs`, version/schema receipt,
  별도 승인된 native live 시나리오. 미실행이면 live gate는 계속 미통과다.

## WP-04: Rust 저장과 수동 복구

- 선행: WP-01. WP-02와 병렬 가능하나 `lib.rs` 합류는 직렬.
- 신규: `src/domain/workflow.ts`, `src-tauri/src/workflow_store.rs`,
  `src-tauri/migrations/`; 수정: Cargo manifest/lock, `lib.rs`, `workflow.ts`.
  위 수정 경로의 정식 이름은 `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`,
  `src-tauri/src/lib.rs`, `src/workflow.ts`다.
  신규 검사: `src-tauri/tests/workflow_recovery.rs`,
  `scripts/qa/workflow-recovery.mjs`.
- 작업:
  - 앞의 schema·상태·typed commands와 single-writer transaction을 구현한다.
  - project 정체성을 Rust가 등록한다. 슬래시·drive/UNC·symlink·끝 구분자
    변형과 OS 대소문자 정책을 검사하고 실제 다른 경로를 임의 소문자화해
    합치지 않는다. 실행 폴더를 다시 확인할 수 없으면 쓰기 실행을 거부한다.
  - dispatch intent를 commit한 뒤 외부 호출한다. 수신 결과·그래프 correction·
    최종 판정과 projection도 각각 원자적으로 commit한다.
  - 재시작 때 terminal 기록을 복원하고 미완료 attempt는 interrupted/unknown.
    사용자 승인 없는 새 inference나 외부 효과 replay는 없다.
  - migration·backup·future-schema·artifact 누락·저장 실패를 처리한다.
    저장 실패 뒤 신규 dispatch는 중단한다.
- 수용: admission 전후, dispatch 경계, 외부 효과 후 receipt 전, commit 후 UI
  통지 전의 crash cutpoint에서 중복 효과를 내지 않는다. 이미 저장한 성공
  형제 결과를 다시 실행하지 않는다. uncertain 효과는 unknown으로 남는다.
- 검증: `cargo test --manifest-path src-tauri/Cargo.toml --test workflow_recovery`,
  `bun scripts/qa/workflow-recovery.mjs`, 실제 native reload.
  별도 fake effect service가 효과를 영속화하고 테스트 본체가 종료 사건을
  구독한 뒤 child를 죽인다. sleep으로 crash timing을 맞추지 않는다.

## WP-05: 호스트 receipt와 연구 묶음

- 선행: WP-02, WP-04.
- 신규: `src/research/types.ts`, `src/research/validate.ts`,
  `src-tauri/src/research.rs`, `src-tauri/src/checks.rs`.
- 수정: `src/domain/workflow.ts`, `src-tauri/src/workflow_store.rs`,
  `src/workflow.ts`, `src-tauri/src/lib.rs`.
  신규 검사: `scripts/qa/research-integrity.mjs`,
  `src-tauri/tests/check_receipts.rs`, `scripts/qa/fixtures/research/`.
- 작업:
  - source snapshot·citation·claim·lead·debate·bundle schema를 정의한다.
  - 원문/raw/text hash, 변환기 버전, 최종 URL, blocked/truncated를 보존한다.
  - lookup/span/hash 검사는 deterministic, entailment는 별도 semantic review다.
  - 승인된 check 정의를 Rust가 실행해 receipt를 발급한다.
  - 모델 verdict에서 직접 run accepted로 가는 경로를 없앤다.
- 수용:
  - 위조·미등록·타 run/attempt·오래된 subject receipt를 거부한다.
  - 존재하지 않는 출처·범위·다른 quote, 차단 페이지의 성공 판정을 거부한다.
  - 올바른 인용과 반대 의미의 claim은 `integrityState="passed"`,
    `semanticState="contested"`, `acceptanceState="needs-review"`로 각각 남는다.
  - 외부 문서의 키 전송·파일 쓰기 지시가 승인·실행 정책으로 승격되지 않는다.
  - 저장 snapshot만으로 무결성 검사를 오프라인 재현한다.
- 검증: `bun scripts/qa/research-integrity.mjs`, Rust host-check tests.

## WP-06: 제한된 팀과 연구→제작

- 선행: WP-02, WP-04, WP-05. live backend는 WP-03 게이트 별도.
- 수정: `src/workflow.ts`, `src/views/chat.ts`, `src/domain/workflow.ts`,
  `src/research/types.ts`. 신규 검사: `scripts/qa/research-workflow.mjs`.
- 작업:
  - 기존 research/team/build/taste 명령과 역할 구성을 보존한다.
  - typed worker 결과에는 claim/lead/debate/unknown과 필요한 evidence ID만
    전달한다. 조상 원문 전체를 무제한 중첩하지 않는다.
  - 필요한 추가 조회·반례를 bounded lead queue로 처리한다.
    lead는 resolved/irrelevant/inaccessible/budget-exhausted로 닫고 뒤 두
    상태는 미확인을 유지한다.
  - 연구 종료 뒤 bundle revision·scope 승인 없이는 구현 노드를 시작하지 않는다.
  - 수정은 새 attempt이며 예산·기존 성공·실패 기록을 보존한다.
    실행 성공, integrity, semantic review, acceptance를 합치지 않는다.
- 수용: 한 핵심 조사 역할 실패·미해결 반증·예산 소진을 전체 성공으로 숨기지
  않는다. bundle 변경 뒤 기존 구현 승인은 재검토가 필요하다.
- 검증: `bun scripts/qa/research-workflow.mjs`; 동일 고정 자료의 single/team
  비교는 WP-09에서 수행한다.

## WP-07: revision 기반 개인화

- 선행: WP-04, WP-05. WP-06과 공유 domain 변경은 리드가 합류.
- 신규: `src/personalization.ts`, `src-tauri/src/personalization.rs`.
- 수정: `src/ui/execution.ts`, `src/domain/workflow.ts`,
  `src-tauri/src/workflow_store.rs`, `src-tauri/src/lib.rs`, `src/store.ts`.
  신규 검사: `scripts/qa/personalization.mjs`,
  `src-tauri/tests/personalization.rs`.
- 작업:
  - 기존 로컬 선호 문자열은 read-only preview 후 명시적 migration한다.
    형식 불량·storage 예외는 typed 결과로 처리하고 사용자 데이터는 보존한다.
  - 후보별 근거·scope·diff·충돌·승인·철회 UI와 version transaction을 구현한다.
  - 최종 subject revision과 맞지 않는 reflection은 stale 처리한다.
  - `SKILL.md` 가져오기는 경로 traversal/symlink/license/script를 검사하고
    실행 스크립트는 비활성화·격리한다. metadata로 권한을 늘리지 않는다.
  - 실행 시작에 승인된 artifact 목록을 고정한다. background 모델 호출 없음.
- 수용: correction 후 v1 lesson이 적용되지 않고, 승인 전 취향은 안 바뀐다.
  중복 승인·동시 편집·타 프로젝트·범위/도구 불일치·선택적 rollback을 검사한다.
- 검증: `bun scripts/qa/personalization.mjs`; 품질 향상 주장은 WP-09 전 금지.

## WP-08: 결과 중심 작업대

- 선행: 정본 DAG의 WP-06, WP-07. WP-04/05는 전이 의존성이다.
  두 패키지 DTO·상태 계약 고정 후 surface를 통합한다.
- 수정: `src/ui/execution.ts`, `src/ui/dag.ts`, `src/ui/diff.ts`,
  `src/views/chat.ts`, `src/styles.css`, `src/main.ts`,
  `scripts/qa/desktop.ts`, `scripts/qa/desktop.html`, `scripts/qa/native.ps1`.
  신규 QA action log·capture 결과는 `docs/evidence/research-platform/ui/`.
- 작업:
  - 결과·근거·활동·변경·관계 탭과 source/claim/artifact inspector를 제공한다.
  - 실행 DAG는 explicit dependsOn, 근거 graph는 typed relation만 사용한다.
    단어 겹침이나 시간 인접성을 확정 관계로 표시하지 않는다.
  - 승인 inbox에 run/attempt/session·cwd·명령/diff·provider 선택지를 표시한다.
  - 변경은 저장소 전체와 run 귀속을 구분한다. revert 전 현재 hash가
    다르면 conflict로 중단하며 사용자 변경을 덮어쓰지 않는다.
  - keyed render/focus 복원, 탭 연결, 상태 텍스트, 표만으로 전체 접근을 구현한다.
- 수용: 두 동시 승인 섞임 없음, reload selection revision 일치, pending review와
  적용 전을 구분, 키보드·확대·좁은 창에서 승인·중지 접근 가능.
- 검증: 실제 Tauri WebView의 desktop/narrow, light/dark, 한글 IME, 키보드,
  200% 확대, 중지·재연결 캡처. DOM 덤프만으로 native QA를 대체하지 않는다.

## WP-09: 같은 사용자 과제에서 평가

- 선행: 정본 DAG의 mode=offline 또는 mode=live 행. offline에는 WP-03이 없다.
- 신규 경계: `scripts/qa/evaluate-workflow.mjs`,
  `scripts/qa/fixtures/evaluation/cases.json`, `docs/research/evaluation-protocol.md`.
  결과는 `docs/evidence/research-platform/evaluations/`의 고유 run ID 폴더에 둔다.
  기존 golden fixture는 `scripts/qa/fixtures/golden-research/`.
  제품 결함 수정은 해당 패키지로 되돌려 검증한다.
- 작업:
  - WP-00 golden project의 조사→근거 승인→제작→실제 검사→학습 후보를 완주한다.
  - fixed source corpus·repo revision·모델·budget·검사 정의를 동일하게 두고
    단일 조사자 대 팀, 개인화 없음 대 승인 후보를 paired 비교한다.
  - 요구 충족, 회귀, 인용 오류, unknown 누락, 실행량·사용량·시간·사람 수정량을
    기록한다. usage 미보고는 unknown이다.
  - 작은 pilot을 통계적 일반화나 개선율 주장으로 쓰지 않는다.
- 수용: 결과물이 실제 테스트를 통과하고 모든 중요한 claim이 근거/미확인과
  연결된다. 위조 verdict, stale lesson, 취소 후 후속 실행이 재발하지 않는다.
  live 미실행이면 실제 모델 품질 게이트는 미통과로 남긴다.
- 검증: 관련 전체 QA + `pnpm build` + `cargo test --manifest-path src-tauri/Cargo.toml`,
  실제 프로그램 사용 증거와 native 캡처. 검사 환경·명령·exit·cleanup 보존.

## WP-10: 공개 배포 게이트

- 선행: WP-09 mode=live; 사용자 배포 지시·서명 자격 증명·제공자 허용 범위.
- 기존 수정: `src-tauri/src/updates.rs`, `src-tauri/src/setup.rs`,
  `src-tauri/src/lib.rs`, `src-tauri/build.rs`, `src-tauri/Cargo.toml`,
  `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`,
  `src-tauri/capabilities/`, `.github/workflows/build-macos.yml`, `README.md`.
  신규: `src-tauri/permissions/`, `.github/workflows/release-verified.yml`,
  `docs/RELEASE.md`, `THIRD_PARTY_NOTICES.md`, `artifacts/sbom/`.
  root `LICENSE`는 앱 자체 라이선스를 바꾸지 않고 타사 고지와 분리한다.
- 작업:
  - dev source-rebuild 경로와 release signed updater를 분리한다.
  - HTTPS manifest, 고정 public key, artifact signature 검증과 변조 거부를 구현한다.
  - Windows 서명/timestamp, WebView2 정책, macOS Developer ID/notarization/
    stapling과 포함 실행 파일을 검증한다.
  - CLI 재배포 허가 없이는 bundle하지 않는다. runtime·digest·publisher
    검증과 full-SHA CI dependency를 고정한다.
  - custom Rust command의 caller·범위를 명시하고 비신뢰 webview에 bridge를 주지 않는다.
- 수용: clean OS 설치/upgrade/uninstall, 잘못된 서명/architecture/중단,
  이전 DB 보존·복구를 실제 대상 OS에서 확인한다.
- 미확인 자격 증명이나 OS가 없으면 공개 출시 blocked로 남기고 local MVP와
  구분한다. 서명만으로 OS 경고가 없어진다고 보장하지 않는다.

## 공통 검증과 실패 처리

공유 경로 `src/domain/workflow.ts`, `src-tauri/src/workflow_store.rs`,
`src-tauri/src/lib.rs`, Cargo manifest/lock의 통합 소유자는 리드다.
WP-06/07의 domain 변경은 리드가 직렬 반영한다. WP-08은 두 패키지 완료 뒤
시작하므로 WP-07과 `src/ui/execution.ts`를 동시에 편집하지 않는다.
각 worker는 정해진 패키지 밖에서 발견한 문제를 기록하고 임의 수정하지 않는다.

새 시나리오마다 **트리거 전에 exact event/state 구독**을 등록한다.
bounded timeout은 실패 안전장치이며 고정 sleep·폴링 성공 판정은 없다.
무추론 JS QA는 한 번의 aggregate run에서 성공해야 하고 실패를 skip하거나
문구 기대값을 느슨하게 바꿔 숨기지 않는다.

| 범위 | 필요한 증거 |
|---|---|
| 소스 변경 | 기존 관련 검사 + 회귀를 잡는 최소 행동 검사 |
| RPC | 요청/응답/원시 correlation, cancelled/timeout/late-event |
| Rust bridge | 실제 자식 프로세스·stdio·EOF·종료·정리 |
| 저장 | crash cutpoint·idempotence·migration/backup·replay 결정 |
| 연구 | 저장 source/span과 claim, 반박·미확인, host checks |
| UI | 실제 Tauri action log + screenshots, desktop/narrow와 양 테마 |
| 제공자 | 실효 auth/model/usage-route, 실제 승인·취소·갱신·resume |
| 프로그램 | 실제 사용 경로, 테스트 exit와 최종 산출물 hash |

외부 상태가 바뀌는 중에는 monitor를 걸고 대기한다. 생성한 process/profile/
port/temp/cache는 소유권을 기록하고 제거 후 PID·port·파일 부재를 확인한다.
공유 cache·사용자 profile·계정은 삭제하거나 복제하지 않는다.

## 완료와 중단

패키지 완료는 해당 acceptance와 증거가 모두 있을 때만 표시한다.
외부 자격·정책·native OS가 없는 게이트는 명시적으로 blocked이며 다른
기반 작업은 계속할 수 있다. 실패하면 마지막 정상 schema/transaction
경계를 보존하고 임의 데이터 초기화로 해결하지 않는다.

**MVP 종료:** WP-00/01/02/04/05/06/07/08의 수용 조건과 golden offline flow가
통과하고, live 지원·품질 여부를 정직하게 분리해 보고했을 때다.
**구독 지원 종료:** WP-03의 실제 자격·범위·동작 게이트와 해당 golden live
flow가 통과했을 때만이다.
**공개 배포 종료:** WP-10 대상 OS·서명·라이선스 게이트까지 통과했을 때다.
서로 다른 완료 수준을 같은 “완료” 배지로 합치지 않는다.

## 후속 에이전트 실행 프롬프트

```text
이 저장소의 .omo/plans/commandcode-research-platform.md를 실행하라.
먼저 현재 사용자 지시와 지침/기억/작업 트리를 확인하고 WP-00부터 시작한다.
기존 미커밋 변경과 사용자 파일을 보존한다. 별도 지시 없는 commit/push/release는 하지 않는다.
유료 추론을 쓰는 검증은 최소 범위로 하고 쓴 모델과 대략의 비용을 기록한다.
파일 경계와 선행 게이트를 지키며 각 패키지의 실패 재현, 최소 수정, 실제 surface QA를 수행한다.
오프라인 peer, Rust stdio, 실제 모델, 대상 OS 증거를 서로 대체하지 않는다.
외부 자격이 없는 게이트는 blocked로 남기고 가능한 기반 작업을 계속한다.
각 완료마다 증거와 cleanup receipt를 기록하고 명시된 종료 조건에서 멈춘다.
```

## 근거와 변경 관리

선택·기각의 상세는 `../../docs/research/commandcode-expansion-2026-10-31.md`.
실행 관측·출처 색인·반박은
`../ulw-research/20261031-commandcode-expansion/`에 있다.
전체 원문 cache와 session 로그는 로컬 전용이다. 원문이 필요하면 공개
URL·고정 commit에서 새로 수집하고 새로운 관측으로 기록한다.
후속 실행 때 공식 지원 상태와 runtime/schema를 다시 확인한다.
문서 변경이 필요한 경우 어떤 acceptance·외부 계약이 바뀌었는지 기록하고
이 계획을 수정한다. 근거 없이 scope를 늘리거나 이미 승인된 결정을
조용히 바꾸지 않는다.
