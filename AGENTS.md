# AGENTS.md

This repository contains **OAuth Preset Manager (OPM)**: a small **Node.js CLI** for **OpenCode** users who juggle multiple OAuth-backed accounts (OpenAI, Google/"Antigravity") and want fast switching plus quota visibility.

## Project Purpose

- Switch the active OpenCode `auth.json` between named presets.
- Keep a lightweight local registry (metadata + current selection).
- Show quota usage for:
  - OpenAI OAuth tokens found in presets and/or the currently active `auth.json`.
  - Google quota for Antigravity accounts (from OpenCode's `antigravity-accounts.json`).
  - Provide a lightweight OpenAI-only quota kickoff action that sends one `gpt-5.6-luna` request per OpenAI OAuth target from the interactive menu.

## Directory Structure

Source-of-truth code lives under `src/`.

```
.
├── src/
│   ├── cli.js              # Main CLI entry point and interactive menus
│   ├── core.js             # Preset storage, quota collection, kickoff logic
│   └── i18n.js             # Minimal translations
├── tests/                  # Node test suite
├── install.sh              # Installer used by README one-liner
├── package.json            # Package metadata + bin entry (`opm`)
├── package-lock.json       # npm lockfile
├── README.md               # English README
└── README.ko.md            # Korean README
```

## Key Features

- Presets:
  - Save the current OpenCode auth as a named preset.
  - Switch to a preset, with optional selective switching by service.
  - Detect whether the current `auth.json` matches the last-selected preset.

- Quota:
  - OpenAI quota fetch via `https://chatgpt.com/backend-api/wham/usage`.
  - Google quota fetch via the Antigravity endpoint used by OpenCode.
  - OpenAI kickoff batch via `https://chatgpt.com/backend-api/codex/responses` using `gpt-5.6-luna`.
  - OpenAI results are deduped by token/refresh token, not only by account id.

- UI:
  - `opm` opens the interactive preset/menu flow.
  - `opm q` / `opm quota` shows quota and supports refresh via both `r` and `ㄱ`.
  - Quota layout is spacing-sensitive; preserve the existing visible layout when changing key handling.

- I18n:
  - Simple key/value translations via `src/i18n.js`.
  - Language selection via `OPM_LANG=ko|en`, otherwise system locale.

## Runtime Data Locations

OPM primarily manages files in the user's home directory.

- OpenCode auth file candidates:
  - `~/.local/share/opencode/auth.json`
  - `~/.config/opencode/auth.json`
- OPM config directory: `~/.config/oauth-preset-manager/`
  - Presets: `~/.config/oauth-preset-manager/presets/*.json`
  - Backups: `~/.config/oauth-preset-manager/backups/*.json`
  - Config: `~/.config/oauth-preset-manager/config.json`
- Antigravity account file candidates:
  - `~/.config/opencode/antigravity-accounts.json`
  - `~/.local/share/opencode/antigravity-accounts.json`

## Implementation Details (Code Map)

### Core Logic: `src/core.js`

- `PresetManager`
  - Initializes config/presets/backups directories under `~/.config/oauth-preset-manager/`.
  - Tracks `auth_path` and `current_preset` in `config.json`.
  - Saves presets by copying the current OpenCode auth JSON.
  - Switches presets with backup creation and service-level diffing.
  - Supports selective switching by service.
  - Detects the active preset by comparing on-disk auth JSON against saved presets.

- Quota collection
  - OpenAI quota collection reads OAuth entries from the active auth and saved presets.
  - Google quota collection reads Antigravity account data from OpenCode files.
  - OpenAI kickoff batching only targets OpenAI/Codex OAuth entries.

### CLI: `src/cli.js`

- Entry point: `src/cli.js`.
- Commands:
  - `opm` : interactive preset/menu flow
  - `opm save <name>` : save preset
  - `opm switch <name>` : switch preset
  - `opm quota` / `opm q` : show quota
- The interactive menu includes the OpenAI quota kickoff action.

### I18n: `src/i18n.js`

- `t(key, **kwargs)`-style lookup for translated UI strings.
- Keep Korean and English keys aligned when changing user-facing text.

## Installer Behavior

`install.sh` supports two distinct flows:

1. **Remote/global install**
   - Used by the README one-liner: `curl -sSL .../install.sh | bash`
   - Clones the repo into `~/.oauth-preset-manager`
   - Creates a launcher (`opm`) in the first writable PATH directory, or `~/.local/bin`
   - Launcher points to `~/.oauth-preset-manager/src/cli.js`

2. **Local/global install**
   - Used by running `bash /path/to/repo/install.sh`
   - Resolves the repo root from the installer script location, not caller `pwd`
   - Creates a launcher in the same PATH-based way
   - Launcher points to the local repo's `src/cli.js`

Important:
- The installer stores the launcher directory in `~/.config/oauth-preset-manager/install-launcher-path`.
- When touching `install.sh`, verify both outside-repo flows:
  - remote `curl | bash`
  - local `bash /path/to/repo/install.sh`
- Do not validate remote install by running `curl | bash` from inside the repo; that can produce misleading results.

## Working With This Repo

- Local run: `node src/cli.js` or `npm start`
- Tests: `npm test`
- Package version lives in both `package.json` and `package-lock.json`
- Current release line after the installer fix is `v1.0.3`

## Common Pitfalls

- Presets are not stored in this repo; they are created in the user's home directory.
- OpenAI business accounts can share the same visible account id while still having different quota because quota is token/member-context dependent.
- Quota endpoints are network-dependent and may change.
- If you change user-facing strings, update `src/i18n.js` and keep both languages aligned.
- If you change installer behavior, verify launcher contents and actual `opm q` execution, not just script text.
