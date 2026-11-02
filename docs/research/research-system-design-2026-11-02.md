# 리서치 시스템 설계: 공식 앱 기능 + 리서치 우선 개발 흐름

작성 2026-11-02 · 대상 저장소 CommandCode_Desktop v0.5.0 · 성격: 설계 제안 (구현 전)

판정 구분은 기존 리서치 문서와 같다. **관측**은 코드·문서에서 읽은 사실,
**제안**은 이번 설계 선택, **미확인**은 구현 전에 확인할 것이다.

## 0. 전제: 공식 앱은 개조하지 않고 기능을 가져온다

- 공식 Command Code Desktop(v0.1.60, 2026-10-28)은 Electron 앱이며 소스 비공개다.
  약관이 역공학·파생물을 금지하므로 **개조 대상이 아니라 기능 참고 대상**이다. (관측)
- `cmd acp`는 외부 클라이언트용으로 공식 제공되므로 현재 Tauri 앱 구조는 그대로 유지한다. (관측, `docs/REVIEW-2026-10-31.md`)

### 공식 앱 기능 대비 현재 앱 (관측, 공식 문서 `commandcode.ai/docs/desktop` 기준)

| 공식 앱 기능 | 현재 앱 | 비고 |
|---|---|---|
| 채팅, `@` 파일 첨부, 이미지 입력 | 있음 | README 35행 |
| 큐에 넣는 후속 메시지, 에이전트 질문 답변 | 부분 | 권한 카드는 있음, 메시지 큐는 미확인 |
| 권한 모드 4종(승인·자동편집·계획·전체) | 있음 | 채팅 권한 모드 |
| 터미널 | 있음 | ConPTY 탭 |
| Changes(diff, 브랜치, 커밋/푸시) | 없음 | `src/ui/diff.ts`는 메시지 내 diff 렌더만 |
| Files(편집·미리보기) | 없음 | `@` 자동완성만 |
| Plan 뷰 | 없음 | 할 일 패널은 CLI `todos` 모드 의존 |
| Browser 미리보기 + Design 모드 | 없음 | |
| 슬래시 `/design /goal /plan /mode /mcp /taste /compact /fork` | 부분 | ACP가 노출하는 명령만 |
| 설정: 스킬·MCP·BYOK·원격 제어·사용량 | 부분 | 계정·사용량·업데이트는 있음, 스킬·MCP UI 없음 |
| 백그라운드 자동 업데이트 | 부분 | 새 설치 파일 안내 |
| **없음** | 실행 탭(리서치·팀·구현·Taste DAG), 다중 계정, ULW 그래프 관찰 | 현재 앱의 차별점 |

리서치 시스템은 위 표의 "현재 앱 차별점"을 확장하는 방향이다. 공식 기능 보강(Changes, Files, Browser)은 별도 작업으로 두고, 이 문서는 리서치에 집중한다.

## 1. 현재 리서치 워크플로의 경계 (관측)

`src/workflow.ts`의 역할 그래프:

- `research`: 공식 자료 조사 → 근거 상호 검토 → 종합 → 독립 검증
- `team`: 공식 자료 · 대안/오픈소스 · 반례/위험 (병렬) → 상호 검토 → 종합 → 검증
- `build`: team 뒤에 설계·구현 → 회고 → 검증·수정 루프
- 검증은 JSON 판정 + 앱이 직접 본 도구 호출 영수증을 요구한다.

부족한 것:

1. **리서치 종류가 하나**다. 목표가 "대안 비교"든 "약관 확인"이든 같은 세 역할을 쓴다.
2. **입력이 한 줄 목표**다. 결정 질문, 제약, 이미 아는 것, 완료 기준이 프롬프트에 섞여 들어간다.
3. **출력이 자유 마크다운**이다. 주장·출처 표를 쓰라고 지시하지만 구조가 강제되지 않아 다음 단계(설계)가 기계적으로 읽을 수 없다.
4. **저장이 수동 내보내기**다. 리서치 결과가 프로젝트 폴더에 남지 않아 다음 대화·다음 리서치가 참조할 수 없다.
5. **반복이 검증 실패 수리만**이다. "아직 모르는 것"에서 다음 질문을 뽑아 다시 조사하는 루프가 없다.

## 2. 프로그램 설계 전 리서치의 종류 (분류)

하나의 설계 리서치는 보통 아래 유형 중 2~5개의 조합이다. 유형마다 핵심 질문, 1차 출처, 산출물이 다르므로 템플릿도 달라야 한다.

| # | 유형 | 핵심 질문 | 1차 출처 | 산출물 |
|---|---|---|---|---|
| R1 | 문제·요구 정의 | 누가 어떤 상황에서 무엇을 못 하는가, 성공 기준은 | 사용자 기록, 이슈, 기존 노트(제2의 두뇌) | 문제 진술, 완료 기준, 비범위 |
| R2 | 지형·경쟁 조사 | 같은 문제를 푸는 제품·프로젝트는 무엇이고 어디까지 하나 | 공식 사이트, 릴리스, 문서, 저장소 | 비교표, 격차표, 차별점 |
| R3 | 기술 타당성 | 핵심 가정이 실제로 동작하는가 | 공식 API 문서, 재현 스파이크 실행 | 가정별 확인/반증, 스파이크 로그 |
| R4 | 라이브러리·의존성 평가 | 무엇을 빌리고 무엇을 직접 만드나 | 저장소, 릴리스 주기, 이슈, 라이선스 파일 | 후보 매트릭스(기능·유지보수·라이선스·크기) |
| R5 | 플랫폼 제약 | OS·스토어·런타임·API 한도가 허용하는가 | 플랫폼 공식 문서, 변경 로그 | 제약 목록, 우회 불가 항목 |
| R6 | 법·약관·라이선스 | 써도 되는가, 배포해도 되는가 | 약관 원문, 라이선스 원문 | 조항 인용 + 해석 + 미확인 |
| R7 | 보안·개인정보 | 어디서 비밀값·개인정보가 흐르나 | 위협 모델, 공식 보안 지침 | 자산·위협·완화 표 |
| R8 | 비용·요금 | 운영 비용과 한도는 | 공식 요금 페이지 | 시나리오별 비용 추정 |
| R9 | 선행 사례·실패 사례 | 누가 이미 시도했고 왜 실패했나 | 포스트모템, 이슈, 포럼 | 실패 패턴, 피할 설계 |
| R10 | 학술·원리 | 알고리즘·모델의 근거는 | 논문, 공식 벤치마크 | 원리 요약, 적용 조건 |
| R11 | 설계 대안 결정 | 후보 설계 중 무엇을 택하나 | 위 결과 전부 | ADR(결정·대안·결과) |
| R12 | 운영·배포 | 설치·업데이트·서명·배포 채널은 | 플랫폼 문서, 자체 릴리스 경험 | 점검표 |

이 저장소에서 이미 실행된 예: `docs/REVIEW-2026-10-31.md`는 R6+R5, `docs/research/commandcode-expansion-2026-10-31.md`는 R2+R4+R11, 이번 대화의 공식 앱 확인은 R2+R6다. 제2의 두뇌에는 R3 스파이크(공공임대 0단계), R2(Colab GPU)가 있다.

## 3. 시스템화 설계 (제안)

핵심 원칙 세 가지.

1. **리서치는 파일이다.** 결과는 프로젝트 폴더 `.research/<campaign>/`에 남고, 다음 단계는 그 파일을 읽는다. 채팅 기록이 아니라 파일이 진실이다.
2. **입력·출력에 스키마가 있다.** 브리프(입력)와 주장 장부(출력)는 JSON 스키마를 가진다. 자유 보고서는 장부에서 렌더링한다.
3. **유형별 프리셋이 역할 그래프를 만든다.** 사용자는 "유형 체크"만 하고, 앱이 역할·지시·검증 기준을 조립한다.

### 3.1 디렉터리 구조

```
<project>/.research/
  <YYYYMMDD>-<slug>/
    brief.json          # 입력: 결정 질문, 유형, 제약, 이미 아는 것, 완료 기준
    cycle_001/
      sources.jsonl     # 출처 스냅샷: url, 조회일, 제목, 발행일, 등급, 발췌 해시
      claims.jsonl      # 주장 장부: 주장, 지지 출처[], 반박 출처[], 상태, 신뢰도
      alternatives.json # R4·R11용 후보 매트릭스
      open-questions.md # 미확인·다음 사이클 질문
      verify.json       # 독립 검증 판정 + 도구 영수증
    report.md           # 장부에서 생성한 사람용 보고서
    decision.md         # ADR: 결정, 이유, 버린 대안, 되돌릴 조건
    run.json            # 실행 DAG 기록 (기존 내보내기 형식)
```

`cycle_NNN` 번호 규칙과 "쓰기 직전 폴더 재확인"은 제2의 두뇌 교훈(리서치 사이클 에이전트)을 그대로 따른다.

### 3.2 브리프 템플릿 (입력)

실행 탭의 "목표 한 줄"을 아래 폼으로 바꾼다. 비우면 기존처럼 한 줄로 동작한다.

```json
{
  "decision": "무엇을 결정하려고 리서치하는가 (한 문장)",
  "types": ["R2", "R4", "R6"],
  "constraints": ["Tauri 유지", "GPL 금지", "오프라인 QA 가능"],
  "known": ["cmd acp가 공식 외부 클라이언트 경로다"],
  "doneWhen": ["후보 3개 이상 비교표", "약관 조항 원문 인용", "미확인 항목 분리"],
  "budget": { "maxCycles": 3, "maxSources": 40 },
  "sourcePolicy": { "primaryFirst": true, "minRecencyDays": 365, "allowForums": true }
}
```

### 3.3 유형별 프리셋 → 역할 그래프

프리셋은 `src/workflow.ts`의 `add()` 호출을 데이터로 바꾼 것이다. 유형을 여러 개 고르면 조사 역할이 병렬로 늘고, 검토·종합·검증은 공유한다.

| 유형 | 추가되는 조사 역할 | 역할별 완료 기준(검증자가 확인) |
|---|---|---|
| R2 | 지형 조사 | 후보마다 공식 URL·버전·확인일, 격차표 |
| R3 | 스파이크 실행(쓰기 허용, 임시 폴더) | 실행 명령·결과 로그, 가정별 확인/반증 |
| R4 | 의존성 평가 | 라이선스 파일 원문 링크, 최근 릴리스일, 열린 이슈 수 |
| R5/R6 | 제약·약관 조사 | 조항 **원문 인용** + 해석 분리 |
| R7 | 위협 모델 | 자산·흐름·위협·완화 표 |
| R9 | 실패 사례 | 사례마다 원인·우리 설계에서 피하는 방법 |
| 공통 | 반례 조사(red team) | 각 핵심 주장에 반박 시도 1회 이상 |
| 공통 | 근거 상호 검토 | 주장↔출처 대응 샘플 검사 |
| 공통 | 종합 + ADR 초안 | `claims.jsonl` 상태가 모두 confirmed/refuted/unknown 중 하나 |
| 공통 | 독립 검증 | 기존 JSON 판정 + 도구 영수증 |

### 3.4 출처 등급과 주장 상태 (스키마)

- 출처 등급: `P1` 공식 1차(문서·약관·저장소·릴리스) · `P2` 1차 재현(직접 실행 로그) · `S1` 신뢰 가능한 2차(유지보수자 블로그·논문) · `S2` 포럼·요약 사이트 · `X` 출처 불명.
- 규칙: 결정에 쓰이는 주장은 P1 또는 P2가 하나 이상 있어야 `confirmed`. S1·S2만 있으면 `reported`. 반박만 있으면 `refuted`. 없으면 `unknown`.
- 주장 레코드: `{ id, text, type, supports:[sourceId], refutes:[sourceId], status, checkedAt, note }`.
- 보고서의 `[S1]`식 각주는 `sources.jsonl`에서 생성한다. 손으로 쓰지 않는다.

### 3.5 사이클 루프 (반복)

```
brief → 사이클 N: 조사(병렬) → 반례 → 상호 검토 → 종합
      → 검증 실패? → 수리(기존)
      → open-questions.md에 질문 남음 && N < maxCycles? → 사이클 N+1 (질문만 조사)
      → 종료: report.md + decision.md 생성 → 사용자 승인 → build 워크플로의 고정 입력
```

기존 `build` 워크플로는 `synthesis` 노드 출력 대신 승인된 `.research/<campaign>/` revision을 읽는다. 이는 10-31 문서의 "근거 묶음 승인 → 구현 고정" 제안과 같은 흐름이다.

### 3.6 앱 UI 변경 범위 (최소)

1. 실행 탭 설정 화면에 유형 체크박스와 브리프 폼 추가(`src/ui/execution.ts`).
2. `createWorkflow`에 프리셋 테이블 도입, 역할 지시문을 유형별 템플릿 문자열로 분리(`src/workflow.ts`).
3. 노드 출력에서 ```json 블록을 읽어 `claims.jsonl`/`sources.jsonl`로 저장하는 Rust 명령 1개(`.research/` 아래만 쓰기 허용).
4. 결과 화면에 "주장 장부" 탭: 상태별 필터, 출처 클릭, 미확인 목록. 그래프는 보조.
5. "이 리서치로 구현" 버튼: 승인 revision을 `build`에 고정.

재사용: 기존 검증 JSON 가드, 도구 영수증, 역할별 세션, Taste 저장소 패턴.

### 3.7 CLI·스킬과의 접점

- 앱 밖에서도 같은 구조를 쓰도록 `.research/` 레이아웃과 스키마는 앱 비의존으로 둔다. Claude Code·Codex 스킬이 같은 폴더에 쓰면 앱이 읽어 보여 준다.
- 외부 조사 도구(검색·페이지 읽기)는 CLI의 MCP·스킬로 붙이고 앱은 결과 파일만 다룬다. 앱이 직접 웹을 긁지 않는다.

## 4. 외부 리서치 에이전트·스킬 조사 (2026-11-02 조회)

별도 조사 에이전트가 공식 저장소·문서를 확인한 결과다. 라이선스는 저장소 표기 기준이며 재확인 전엔 "관측"으로 둔다.

### 4.1 오픈소스 딥 리서치 에이전트

| 이름 | 구조 패턴 | 라이선스 | 재사용 가치 |
|---|---|---|---|
| [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | Planner 서브질문 → 병렬 Executor 스크래핑·요약(소스 추적) → Publisher 인라인 인용 보고서. depth/breadth 트리 재귀. Claude 스킬로도 설치 가능 | Apache-2.0 | 서브쿼리 병렬 + 출처 추적 요약 구조 |
| [STORM / Co-STORM](https://github.com/stanford-oval/storm) | 유사 주제 문서에서 **관점** 추출 → 관점별 작가↔전문가 대화로 질문 생성 → 아웃라인 → 작성. Co-STORM은 공유 마인드맵 | MIT | 관점 유도 질문 생성 |
| [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research) | Scope(명확화 → **research brief** 압축) → Supervisor가 서브토픽 병렬 위임·압축 → 단일 작성. 섹션 병렬 작성은 폐기 | MIT | 브리프 1개를 모든 역할의 기준으로 |
| [HF open_deep_research](https://github.com/huggingface/smolagents/tree/main/examples/open_deep_research) | Manager CodeAgent + search agent, 텍스트 브라우저 도구(visit·page_up/down·find·archive·inspect) | Apache-2.0 | 최소 수집 도구셋 |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Coordinator → Planner → Research Team → Reporter(1.x). 2.0은 샌드박스·메모리·스킬 harness, 산출물 디렉터리 강제 | MIT | 산출물 폴더 강제 |
| [local-deep-research](https://github.com/LearningCircuit/local-deep-research) | LLM이 검색 엔진(arXiv·PubMed 등) 스스로 선택, 로컬 LLM 1급 지원 | MIT | 학술 유형(R10) 엔진 선택 |
| [Perplexica/Vane](https://github.com/ItzCrazyKns/Perplexica) | SearxNG 메타검색 → 리랭크 → 인용 답변, Speed/Balanced/Quality | MIT | 깊이 티어 |
| [OpenAI research_bot](https://github.com/openai/openai-agents-python/tree/main/examples/research_bot) | planner(검색어 + **이유**) → 병렬 search → writer | MIT | 계획 감사 가능성 |
| [Anthropic 멀티에이전트 리서치](https://www.anthropic.com/engineering/multi-agent-research-system) | Lead 계획 → 서브에이전트 병렬 → 종합 → **CitationAgent** 원문 재대조. 복잡도 비례 노력. LLM 심사 5축 루브릭 | 블로그 | 인용 후처리, 평가 루브릭 |

큐레이션: [Awesome-Deep-Research](https://github.com/DavidZWZ/Awesome-Deep-Research). 미확인: Onyx 내부 루프, Flowise 템플릿.

### 4.2 코딩 에이전트용 리서치 스킬

| 이름 | 단계·출력 | 참고 |
|---|---|---|
| Anthropic `deep-research` 스킬(이 세션에도 설치됨) | 후속 질문 → `research_notes/`·`reports/` 폴더 → MECE 서브토픽+관점 분해 → 병렬 서브에이전트 → 갭 보강 **1회** → 단일 작성자. 코디네이터는 조사·작성 금지 | 공개 저장소 경로 미확인 |
| [firecrawl-deep-research](https://github.com/firecrawl/firecrawl-workflows) | Quick/Thorough/Exhaustive 티어 → 각도 분해(개요·기술·시장·**반론**·1차 소스) → 검색·스크랩 → 종합. 보고서에 Contrarian Views & Risks, Open Questions, **Rerun Inputs** | skills.sh 최다 설치 |
| [do-your-research(-deep)](https://claudskills.com/skills/do-your-research-deep/) | 세션 내 주장을 유형별 인벤토리 → 1차 소스 대조 → verdict·source tier·consensus·recency 원장 | MIT, 검증 스킬 표준형 |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) (이 세션에도 설치됨) | 16+ 플랫폼 수집 CLI, 백엔드 폴백 라우팅, `doctor` 진단 | 수집 레이어, 약관 주의 |
| [strategy-red-team](https://skills.sh/phuryn/pm-skills/strategy-red-team) | 스틸맨 먼저 → 공격, 가장 싼 테스트로 가설 kill | 반례 역할 지시문 참고 |
| [GPT Researcher Claude skill](https://docs.gptr.dev/docs/gpt-researcher/gptr/claude-skill) | `SKILL.md` + `references/` 패키징 | 스킬 패키징 참고 |

Codex 공식 카탈로그에는 범용 웹 리서치 스킬이 확인되지 않았다.

### 4.3 구조화 방법론 (유형별 기본 산출물 템플릿의 출처)

- [MADR](https://adr.github.io/madr/): Context / Decision Drivers / Options / Outcome(+Consequences, Confirmation) / Pros & Cons → `decision.md`의 뼈대.
- [Rust RFC 템플릿](https://github.com/rust-lang/rfcs/blob/master/0000-template.md): **Prior art**, **Unresolved questions** 절 → R9와 `open-questions.md`.
- [Shape Up pitch](https://basecamp.com/shapeup/1.5-chapter-06): Appetite(예산), Rabbit holes, No-gos → 브리프의 `budget`·비범위.
- Agile Spike: 타임박스 조사, 산출은 결정·프로토타입 → R3 역할(쓰기 허용, 임시 폴더).
- [Technology Radar](https://www.thoughtworks.com/radar/faq-and-more): Adopt/Trial/Assess/Caution 링 → R4 후보 판정 값.
- Build-vs-Buy 가중 매트릭스: 기준 5~7 × 가중치 × 1~5점, 오버라이드는 기록 → `alternatives.json` 스키마.
- Google 디자인 독: Alternatives Considered, 교차 관심사(보안·프라이버시·롤아웃) → R7·R12 점검 축.
- Rapid Review(Cartaxo 등): 임박한 결정에 한정한 축약 체계적 리뷰 → `maxCycles` 작게 두는 근거.
- 출처 평가 CRAAP + 1차/2차/3차 구분 → 3.4의 P1/P2/S1/S2 등급. 공학용 표준 증거 위계는 없어 자체 정의가 맞다.
- Pre-mortem vs Red team → 반례 역할을 두 단계(스틸맨→공격→"이미 실패했다" 역추적)로.

리서치 유형 분류(2절)는 단일 공인 프레임워크가 없고, 타당성 연구 5종(기술·운영·경제·일정·법)과 기술 실사 체크리스트, Radar 사분면을 합쳐 정한 것이다.

### 4.4 우리 설계에 반영하는 패턴 (3절과의 대응)

| 패턴 | 출처 | 3절 반영 위치 |
|---|---|---|
| 브리프 1개로 압축 후 모든 역할이 참조 | LangChain | 3.2 `brief.json` |
| 조사만 병렬, 작성은 단일 역할 | LangChain, Anthropic 스킬 | 3.3 종합 역할 하나 |
| 관점 유도 질문 생성 | STORM | 3.3 R2 지형 조사 지시문에 "관점 3개 먼저" 추가 |
| 깊이 티어 → 소스 수 예산 | Firecrawl, Perplexica | 3.2 `budget.maxSources` |
| 검색어마다 이유 기록 | OpenAI research_bot | `sources.jsonl`에 `query`, `why` 필드 추가 |
| 인용 후처리 재대조 | Anthropic CitationAgent | 3.3 근거 상호 검토 = 주장↔출처 샘플 검사 |
| 주장 원장(verdict·tier·recency) | do-your-research | 3.4 `claims.jsonl` |
| Contrarian Views, Open Questions, Rerun Inputs 절 | Firecrawl | `report.md` 고정 절 + `brief.json` 자체가 Rerun Inputs |
| 갭 보강 횟수 상한 | Anthropic 스킬 | 3.5 `maxCycles` |
| 산출물 폴더 강제, 노트는 파일 | DeerFlow, Anthropic 스킬 | 3.1 `.research/` |
| 코디네이터는 조사·작성 금지 | Anthropic 스킬 | 앱이 코디네이터, 모델은 역할만 |
| 스틸맨→레드팀→프리모템 | pm-skills, HFES | 3.3 반례 역할 지시문 |
| 평가 루브릭 5축 | Anthropic | 독립 검증 JSON에 `scores` 선택 필드(사실·인용·완전성·소스 품질·도구 효율) |

빌리지 않는 것: GPT Researcher·DeerFlow 같은 프레임워크를 앱에 내장하는 것. 추론은 Command Code CLI 계정으로만 하므로(README 범위), 외부 프레임워크는 **구조만** 가져오고 실행은 ACP 역할 세션으로 한다. 수집 도구가 필요하면 CLI의 MCP·스킬(agent-reach, firecrawl 등)을 사용자가 설치하고 앱은 결과 파일을 읽는다(3.7).

## 5. 미확인·다음 단계

- 미확인: ACP 세션에서 모델이 `.research/` 아래 파일을 직접 쓰게 할지(권한 모드 의존), 앱이 노드 출력을 파싱해 쓸지. 읽기 전용 역할 원칙상 **앱이 쓰는 쪽**을 기본으로 둔다.
- 미확인: 사이클당 비용. 유형 3개 선택 시 역할 7~8개 × 사이클 2 = 세션 15개 안팎. 비용 게이지와 연동 필요.
- 다음 단계: WP-00 기준 검사 → WP-01 권한·수명 경계(기존 계획) 뒤에, 이 문서의 3.6 항목 1~3을 첫 작업 패키지로 한다.
