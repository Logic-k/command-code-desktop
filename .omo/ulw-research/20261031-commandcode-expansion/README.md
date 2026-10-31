# 공유용 리서치 원장

보고서와 실행계획의 검토·재개에 필요한 부분만 공유한다.
실제 제품 구현은 루트 `HANDOFF.md`와 실행계획의 선행 게이트를 따른다.

- `claim-graph.md`, `claims.v1.json`: 결론과 조건.
- `observations.md`, `source-relationships.md`: 관측 방식·독립성·한계.
- `sources-ledger.md`, `source-index.json`: 원문 출처·조회 시점·원래 snapshot hash.
- `debate-ledger.md`, `expansion-log.md`: 반박·추가 조사와 닫은 lead.
- `verify-claims.mjs`, `verify-evidence.md`: 무추론 실행 반례.
- `sources/S1/`: 자체 probe의 stdout·명령 영수증.
- `sources/S29/license-summary.json`: 설치 CLI의 라이선스 관련 선택 필드.
- `review-verdict.md`: 독립 문서 검토와 수정 확인.

제3자 전체 본문·raw cache는 배포하지 않는다. 색인의 hash는 당시 관측의
식별자이며, 동적 페이지를 나중에 다시 조회해 같은 hash가 나온다는 보장이 아니다.
S1 command receipt의 cwd는 원래 조사 환경을 기록한 것으로, 새 환경의
실행 경로가 아니다. 새 환경에서는 이 폴더의 상대 경로 probe 명령을 사용한다.

로컬 전용 `brief.md`, `journal.md`, `outcome.json`, 시각 캡처와 전체 원문 cache는
원래 환경에 보존되지만 이 저장소의 실행 의존성이 아니다.
