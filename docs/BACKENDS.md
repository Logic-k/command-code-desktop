# 에이전트 백엔드 (ACP 레지스트리)

탭은 어떤 ACP 에이전트와도 대화할 수 있습니다. 설정 → **에이전트 백엔드**에서 명령을 등록하고, 탭 상단의 백엔드 드롭다운으로 전환합니다.

## 동작 방식

- 등록된 명령은 **사용자 PATH를 상속**받아 실행됩니다(`npx`, `uvx` 같은 런처가 동작). Command Code 전용 환경변수(`COMMAND_CODE_API_KEY`, 프로필)는 넘기지 않습니다.
- Windows에서는 명령이 `cmd.exe /c …`로 감싸져 `.cmd` shim(npx 등)도 실행됩니다.
- 에이전트별로 프로세스 풀이 분리됩니다(프로젝트·계정·백엔드 조합).
- 세션 기록, 전사 리플레이, 계정, 요금 게이지, 리서치 워크플로는 **Command Code 전용**입니다. 커스텀 백엔드의 탭은 새 대화로 시작합니다.

## 프리셋: Codex (ChatGPT 구독)

설정의 "+ Codex (ChatGPT 구독) 프리셋" 버튼이 등록하는 명령:

```
npx -y @agentclientprotocol/codex-acp
```

- `@agentclientprotocol/codex-acp`는 공식 ACP 어댑터로, **ChatGPT 구독 인증을 내장**합니다(API 키 불필요). 첫 실행 시 로그인 흐름이 열립니다.
- **라이브 검증됨(2026-11-03)**: codex-acp@2.5.0이 ACP v2로 응답하고 `authMethods`에 `api-key`/`chat-gpt`/`chat-gpt-device-code`를 노출합니다. `session.delete`·`session.fork`·`additionalDirectories` capability도 확인.
- 필요: Node의 `npx`. 앱-private Node는 이 경로에 쓰이지 않으므로 시스템 Node가 있어야 합니다.
- 에이전트가 `authMethods`를 알리면 ACP `auth/login`이 트리거될 수 있고, 인증 링크는 `elicitation`(URL 모드) 카드로 사용자 동의 후 열립니다.

## 다른 에이전트 예시

| 이름 | 명령 |
| --- | --- |
| Codex | `npx -y @agentclientprotocol/codex-acp` |
| 임의 ACP 에이전트 | `my-agent acp` 또는 `uvx my-agent-acp` |

## 한계

- 에이전트가 `session/list`를 지원하지 않으면 사이드바 목록은 비어 보입니다(Command Code만 목록을 채움).
- `dont-ask` 같은 권한 모드가 없으면 무인 워크플로 역할이 실패할 수 있습니다 — 워크플로는 Command Code에서만 보장됩니다.
- 프로토콜 버전 협상: 앱은 v2를 제안하고, 에이전트가 v1만 알면 v1 이름 그대로 동작합니다. v2는 initialize 필드명이 다릅니다(`capabilities`/`info`) — 클라이언트가 두 형태를 함께 보내 양쪽 모두 호환됩니다(실측: cmd 1.88.2는 v1로 다운 협상, codex-acp 2.5.0은 v2 응답).
- Windows 주의: `npx command-code …`는 패키지의 `cmd` 바이너리가 `cmd.exe`와 충돌합니다. 커스텀 백엔드로 Command Code를 npx 경유로 등록할 때는 `npx -y -p command-code commandcode acp`(또는 `cmdc`)를 쓰세요. 전역 설치 `cmd acp`는 영향 없습니다.
