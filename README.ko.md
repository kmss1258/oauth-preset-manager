# 🔐 OAuth Preset Manager

OpenCode OAuth 인증 프리셋을 쉽게 관리하고 전환할 수 있는 도구입니다.

---

## ⚡ 빠른 설치

```bash
curl -sSL https://raw.githubusercontent.com/yourusername/oauth-preset-manager/main/install.sh | bash
```

> **참고:** `~/.local/bin`을 PATH에 추가해야 할 수 있습니다. 설치 프로그램이 안내해드립니다.

## 🚀 빠른 시작

그냥 실행하세요:
```bash
opm
```

끝! 🎉 화살표 키로 프리셋을 선택하고 전환하세요.

---

## ✨ 주요 기능

- 🔄 **빠른 전환**: 여러 OAuth 계정 간 즉시 전환
- 💾 **프리셋 관리**: 여러 인증 상태를 저장하고 정리
- 🎨 **인터랙티브 UI**: 아름다운 터미널 인터페이스와 메뉴 선택
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

다른 위치에 있다면 경로를 입력하라는 메시지가 표시됩니다.

## 📁 데이터 저장 위치

- **프리셋**: `~/.config/oauth-preset-manager/presets/`
- **백업**: `~/.config/oauth-preset-manager/backups/`
- **설정**: `~/.config/oauth-preset-manager/config.json`

## 📋 요구사항

- Python 3.7+
- pip

## 📄 라이선스

MIT

## 🤝 기여하기

기여를 환영합니다! Pull Request를 자유롭게 제출해주세요.
