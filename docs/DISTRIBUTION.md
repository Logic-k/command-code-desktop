# 배포 · 업데이트 체크리스트

설치 파일(NSIS/DMG) → 서명된 업데이트 아티팩트 → `latest.json` → GitHub Release.

## 1. 키

업데이트 서명은 Tauri의 minisign 키로 합니다(코드 사이닝 인증서와 별개).

- 개인키: `~/.tauri/cmdc-gui.key` (**저장소에 커밋하지 않습니다**, 분실 시 업데이트 체인 단절)
- 공개키: `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` (이미 박혀 있음)
- 빌드 환경변수: `TAURI_SIGNING_PRIVATE_KEY`(키 문자열 또는 경로), 선택 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- CI(GitHub Actions): `TAURI_SIGNING_PRIVATE_KEY`를 repo secret으로 등록하면 빌드 시 `.sig`가 함께 생성됩니다.

## 2. 릴리스 절차

1. `src-tauri/tauri.conf.json`, `Cargo.toml`, `package.json`의 version을 올립니다.
2. 태그 푸시 (`v0.6.0`) → `Build` 워크플로가 Windows NSIS + macOS DMG를 만들어 draft 릴리스에 붙입니다.
3. 각 플랫폼의 업데이트 아티팩트(로컬 `pnpm tauri build`는 `bundle/`에 생성):
   - Windows: `*-setup.exe` + `.sig` (NSIS 인스톨러 자체가 업데이트 아티팩트; CI의 `.nsis.zip`도 동등하게 사용 가능)
   - macOS: `*.app.tar.gz` + `*.app.tar.gz.sig`
4. `latest.json`을 만들어 릴리스에 올립니다:

   ```json
   {
     "version": "0.6.0",
     "notes": "변경 요약",
     "pub_date": "2026-11-03T00:00:00Z",
     "platforms": {
       "windows-x86_64": { "signature": "<nsis.zip.sig 내용>", "url": "https://github.com/Logic-k/command-code-desktop/releases/download/v0.6.0/Command.Code.Desktop_0.6.0_x64-setup.nsis.zip" },
       "darwin-aarch64": { "signature": "<app.tar.gz.sig 내용>", "url": "…/app.tar.gz" },
       "darwin-x86_64":  { "signature": "<app.tar.gz.sig 내용>", "url": "…/app.tar.gz" }
     }
   }
   ```

   앱은 `releases/latest/download/latest.json`을 조회합니다(이미 config에 설정됨). 즉 `latest` 태그의 릴리스를 매번 갱신하거나, 최신 릴리스에 `latest.json`을 올리면 됩니다.

   **주의(0.6.0 릴리스에서 확인)**: `gh release upload`는 자산명의 공백을 `.`로 치환합니다(`Command Code Desktop_…` → `Command.Code.Desktop_…`). `latest.json`의 `url`은 **업로드 후 실제 자산명**과 일치해야 합니다 — 스페이스를 `%20`으로 쓰면 404. 업로드 후 `gh release view <tag> --json assets --jq '.assets[].name'`로 확인하세요. 또 `releases/latest/download/` 경로는 CDN 캐시로 수 분간 이전 내용을 서빙할 수 있습니다.

## 3. SmartScreen/게이트키퍼

- NSIS는 코드 사이닝이 없으면 SmartScreen 경고가 뜹니다. 해소 순서:
  1. 지금: minisign 서명(완료) — 다운로드는 되지만 SmartScreen은 남습니다.
  2. 다음 단계: Azure Trusted Signing(계정당 월 ~$9.99) 또는 OV 코드 사이닝 인증서로 `signtool sign` — SmartScreen 평판이 쌓입니다.
  3. macOS: ad-hoc 서명 유지 시 첫 실행에 확인 필요(현재 상태). 공증은 Apple Developer Program($99/년) 필요.
- 업데이트 설치 시 NSIS는 passive 모드로 실행됩니다(`tauri.conf.json` 설정).

## 4. 업데이트 동작 확인

- 설정 → "업데이트 확인…" → **배포본 (설치 파일)** 블록에서 확인.
- `check()`는 서명 검증에 실패하면 다운로드를 폐기합니다 — 서명 키 불일치 = 업데이트 없음과 동일한 실패로 보입니다.
