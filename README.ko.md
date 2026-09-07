# 🔐 OAuth Preset Manager

OpenCode OAuth 인증 프리셋을 쉽게 관리하고 전환할 수 있는 도구입니다.

---

## ⚡ 빠른 설치

```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash
```

> **참고:** `~/.local/bin`을 PATH에 추가해야 할 수 있습니다. 설치 프로그램이 안내해드립니다.

> 설치 프로그램은 PATH에서 쓰기 가능한 첫 디렉터리(없으면 `~/.local/bin`)에 `opm` 실행기를 만듭니다.

## 🚀 빠른 시작

그냥 실행하세요:
```bash
opm
```

끝! 🎉 화살표 키로 프리셋을 선택하고 전환하세요.

이미 설치되어 있어도 아래 설치 명령을 다시 실행하면 기존 설치를 업데이트합니다.

OpenCode는 Linux와 macOS에서 모두 XDG 스타일 경로를 사용하며, `XDG_DATA_HOME` / `XDG_CONFIG_HOME`가 있으면 이를 따릅니다.

일반적인 인증 파일 위치:
- OpenCode: `~/.local/share/opencode/auth.json` 또는 `~/.config/opencode/auth.json`
- Codex CLI: `~/.codex/auth.json`
- Command Code: `~/.commandcode/auth.json` (OPM은 `~/.commandcode/oauth.json`도 확인합니다)
- Claude Code: `~/.claude/.credentials.json`

---

## ✨ 주요 기능

- 🔄 **빠른 전환**: 여러 OAuth 계정 간 즉시 전환
- 💾 **프리셋 관리**: 여러 인증 상태를 저장하고 정리
- 📊 **쿼터 조회**: `opm q` / `opm quota`로 Rich 표 형식으로 확인하며, 대화형 화면은 60초마다 자동 갱신되고 표 위에 다음 갱신 카운트다운을 표시
- 📱 **모바일 터미널**: 좁은 창에서는 계정별 짧은 막대와 잔여율을 표시하고, 100열 이상에서는 전체 표를 표시합니다. 창 크기 변경은 추가 API 호출 없이 즉시 반영합니다.
- 화면 높이가 부족하면 `j`/`k`, 아래/위 화살표, Page Down/Page Up으로 페이지를 이동합니다. 카운트다운은 고정됩니다. `g`는 Google 상세 표시, `q`·Esc·Enter·Ctrl-C는 종료이며 이전 터미널 화면을 복원합니다.
- Claude OAuth의 5시간·주간·모델별 쿼터도 지원합니다. 아래 인증 조건을 확인하세요.
- 피크 시간은 고정된 평일(월–금) UTC 01:00–04:00 / KST 10:00–13:00, UTC 06:00–10:00 / KST 15:00–19:00이며 주말은 쉽니다. 시작 1시간 전부터 `HH:MM:SS` 카운트다운을 표시하고, 피크 중에는 TTY 화면의 테두리가 파스텔 무지개색으로 회전합니다. 서머타임은 적용하지 않습니다.
- 인증 배포에서는 먼저 정확한 top-level 인증 항목을 선택하고, 다음 대상 프리셋을 선택합니다(대상은 기본적으로 모두 선택). 선택한 키만 덮어쓰며 선택하지 않은 OAuth/API 항목은 모두 유지됩니다. OpenAI kickoff에는 `gpt-5.6-luna`를 사용합니다.
- OpenCode Go API 인증(`opencode-go:api`)과 브라우저/사용량 세션(`OpenCode Go OAuth session`)은 별개입니다. 세션은 `auth.json`에 넣지 않고 `~/.config/oauth-preset-manager/preset-sidecars/opencode-go/` 사이드카에 저장합니다.
- 🔒 **자동 백업**: 전환 전 자동 백업으로 안전하게
- ⚡ **간단한 명령어**: `save`와 `switch` 두 개면 충분!

## 📖 사용법

### 🎯 인터랙티브 모드 (추천)

인자 없이 실행하면 인터랙티브 모드로 진입합니다:

```bash
opm
```

메뉴에서 다음을 할 수 있습니다:
- ⬆️⬇️ 화살표 키로 프리셋 탐색 및 선택
- 👀 각 프리셋에 포함된 서비스 확인
- ⚡ 프리셋 즉시 전환
- 💾 새 프리셋 저장
- 🔗 인증 항목과 대상 프리셋을 순서대로 선택해 배포

### 💻 명령줄 모드

**현재 인증을 프리셋으로 저장:**
```bash
opm save work
opm save personal
```

**프리셋으로 전환:**
```bash
opm switch work
opm switch personal
```

**할당량 확인:**
```bash
opm quota
# 또는
opm q
```
> 피크 카운트다운은 다음 quota 자동 갱신 카운트와 같은 줄에 표시됩니다. `r` 또는 `ㄱ`은 기존처럼 즉시 갱신하고, 비대화형 출력에서는 ANSI 애니메이션을 사용하지 않습니다.
> 넓은 창은 표, 모바일·좁은 창은 작은 프로그레스바로 보여줍니다. 높이가 극도로 작으면 상태/종료 표시만 남기고, 창을 키우면 복원됩니다. 파이프 출력은 커서 제어·페이지 나눔 없이 한 번만 출력합니다.
> 대화형 쿼터 화면은 60초마다 자동 갱신됩니다. 표 바로 위의 다음 갱신 카운트다운을 확인하거나 `r` 또는 `ㄱ`으로 즉시 갱신할 수 있습니다.

## 🔧 작동 원리

OAuth Preset Manager는 OpenCode 인증 파일(`~/.local/share/opencode/auth.json`)을 다음과 같이 관리합니다:

1. **저장**: 현재 인증 상태의 스냅샷 생성
2. **전환**: 현재 인증을 저장된 프리셋으로 교체
3. **백업**: 전환 전 자동 백업

모든 프리셋은 `~/.config/oauth-preset-manager/presets/`에 저장됩니다.

## 📝 사용 예시

```bash
# 1. 현재 회사 계정을 저장
$ opm save work
✓ Saved preset: work
Services: anthropic, openai, google, zai-coding-plan

# 2. OpenCode에서 로그아웃하고 개인 계정으로 로그인
# ... (OpenCode에서 로그아웃/로그인)

# 3. 개인 계정을 저장
$ opm save personal
✓ Saved preset: personal
Services: anthropic, openai

# 4. 언제든지 회사 계정으로 전환
$ opm switch work
✓ Switched to preset: work
Services: anthropic, openai, google, zai-coding-plan

# 또는 인터랙티브 모드 사용
$ opm
# 화살표 키로 메뉴에서 선택
```

## ⚙️ 설정

첫 실행 시 `opm`은 자동으로 OpenCode 인증 파일을 감지합니다:
```
~/.local/share/opencode/auth.json
```

OpenCode는 Linux와 macOS에서 모두 XDG 스타일 경로를 사용하며, `XDG_DATA_HOME` / `XDG_CONFIG_HOME`가 있으면 이를 따릅니다.

다른 위치에 있다면 경로를 입력하라는 메시지가 표시됩니다.

### 환경 변수
- `OPM_LANG`: 언어 설정 (`ko` 또는 `en`)
- `OPM_ANTIGRAVITY_CLIENT_ID`: Google/Antigravity 할당량 갱신에 필요
- `OPM_ANTIGRAVITY_CLIENT_SECRET`: Google/Antigravity 할당량 갱신에 필요
- `OPENCODE_GO_WORKSPACE_ID`: OpenCode Go quota 조회용 workspace ID (`wrk_...`)
- `OPENCODE_GO_AUTH_COOKIE`: OpenCode Go quota 조회용 `opencode.ai`의 `auth` 쿠키
- `OPM_COMMAND_CODE_AUTH_PATH`: Command Code 인증 파일 경로 재정의
- `CLAUDE_CONFIG_DIR`: Claude Code 프로필 디렉터리 (기본 `~/.claude`)
- `OPM_CLAUDE_AUTH_PATH`: Claude Code `.credentials.json` 경로 재정의 (`CLAUDE_CONFIG_DIR`보다 우선)

### Claude OAuth 쿼터

`opm q`는 Claude Code 인증 파일의 `claudeAiOauth.accessToken`, 활성 OpenCode auth와 저장된 프리셋의 `anthropic` OAuth 항목(`type: "oauth"`)을 조회합니다. 동일 access token은 한 번만 요청하며 API key는 제외합니다. Claude 인증이 없으면 해당 행은 표시하지 않습니다.

- **잔여율** 기준으로 5시간·주간 쿼터와, 응답에 있을 경우 모델별 주간·추가 사용량 비율을 표시합니다. Claude 행의 첫 구간은 하루가 아닌 `5h`입니다.
- 내부 API `https://api.anthropic.com/api/oauth/usage`와 `anthropic-beta: oauth-2025-04-20` 헤더를 사용합니다. 기존 응답과 최신 `limits[]` 형식을 모두 지원하지만, 공개 안정 API가 아니므로 변경될 수 있습니다.
- 사용량 조회에는 `user:profile` 권한이 필요합니다. 추론 전용 토큰은 실패할 수 있습니다. 만료·권한 오류는 재로그인 안내로 표시하며, 쿼터 수집 과정에서 **Claude 인증을 갱신·복사·덮어쓰지 않습니다**.
- 성공 응답은 메모리에 60초간 보관합니다. 429 응답의 `Retry-After`를 준수하고, 없으면 5분 대기합니다. 수동 갱신도 이 제한을 우회하지 않습니다. 인증 파일은 매번 다시 읽으므로 재로그인 후 변경된 토큰을 자동으로 감지합니다.
- macOS **Keychain 전용 인증은 자동으로 읽지 않습니다**. 기존 파일 기반 Claude 프로필이나 OpenCode의 Anthropic OAuth 항목을 사용하세요. 인증 파일은 `chmod 600`으로 보호하고, 로컬 Claude 인증 파일의 심볼릭 링크는 무시합니다.

참고 구현: [CodexBar](https://github.com/steipete/CodexBar/blob/170a4d41c6d69e2bb25daac4fb088a92de2f9bc4/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift), [Headroom](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/subscription/client.py), [Claude Code 인증 문서](https://code.claude.com/docs/en/authentication).

### OpenCode Go 세션

OpenCode Go API key는 모델 사용을 활성화합니다. `opm q`에서 5시간·주간·월간 사용량을 가져오려면 현재 OpenCode Go workspace 페이지가 브라우저 `auth` 쿠키도 요구하므로 위 두 환경 변수를 함께 설정해야 합니다.

환경 변수 대신 `~/.config/oauth-preset-manager/opencode-go.json`에 두 값을 저장할 수도 있으며, 환경 변수가 있으면 그것이 우선합니다. 이 파일은 비공개로 유지하세요.

```json
{
  "workspaceId": "wrk_...",
  "authCookie": "Fe26.2**..."
}
```

```bash
chmod 600 ~/.config/oauth-preset-manager/opencode-go.json
```

저장된 Go 파일만 Go OAuth 세션 저장·배포의 원본으로 사용합니다. `OPENCODE_GO_WORKSPACE_ID`와 `OPENCODE_GO_AUTH_COOKIE` 환경 변수는 quota 조회용 런타임 override이며 프리셋이나 사이드카에 저장하지 않습니다. 사이드카가 있는 프리셋으로 전환하면 해당 세션을 복원하고, 기존 프리셋처럼 사이드카가 없으면 현재 전역 Go 세션을 그대로 둡니다.

## 📁 데이터 저장 위치

- **프리셋**: `~/.config/oauth-preset-manager/presets/`
- **백업**: `~/.config/oauth-preset-manager/backups/`
- **설정**: `~/.config/oauth-preset-manager/config.json`
- **OpenCode Go 사이드카**: `~/.config/oauth-preset-manager/preset-sidecars/opencode-go/`

저장된 전역 Go 세션이 없거나 잘못된 경우에도 기존 사이드카를 삭제하거나 바꾸지 않습니다. 빈 데이터를 세션 삭제 의도로 추정하지 않으므로 데이터 손실 없이 유지합니다.

## 📋 요구사항

- Node.js 18+
- Git

## 📄 라이선스

MIT

## 🤝 기여하기

기여를 환영합니다! Pull Request를 자유롭게 제출해주세요.
