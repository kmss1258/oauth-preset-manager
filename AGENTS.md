# AGENTS.md

This repository contains **OAuth Preset Manager (OPM)**: a small Python CLI/TUI for **OpenCode** users who juggle multiple OAuth-backed accounts (OpenAI, Google/"Antigravity") and want fast switching plus quota visibility.

## Project Purpose

- Switch the active OpenCode `auth.json` between named presets.
- Keep a lightweight local registry (metadata + current selection).
- Show quota usage for:
  - OpenAI OAuth tokens found in presets and/or the currently active `auth.json`.
  - Google quota for "Antigravity" accounts (from OpenCode's `antigravity-accounts.json`).

## Directory Structure

Source-of-truth code lives under `opm/`.

```
.
├── opm/                    # Python package
│   ├── cli.py              # Entry point, interactive menus, CLI commands
│   ├── core.py             # Preset storage + switch logic + quota collectors
│   ├── i18n.py              # Minimal translations + language detection
│   └── tui.py              # Optional Textual quota dashboard
├── install.sh              # Installer used by README one-liner
├── pyproject.toml          # Packaging + entry point: `opm = opm.cli:main`
├── README.md               # English README
├── README.ko.md            # Korean README
├── profile_quota.py        # Local profiling helper (dev script)
├── test_quota_simple.py    # Local quota smoke script
├── test_quota_final.py     # Local quota smoke script
├── tests/                  # (Currently empty)
├── build/                  # Build artifacts (generated)
└── oauth_preset_manager.egg-info/  # Packaging metadata (generated)
```

Notes:
- `build/` and `oauth_preset_manager.egg-info/` are typical packaging artifacts; treat them as generated unless this repo intentionally tracks them.

## Key Features

- Presets:
  - Save the current OpenCode auth as a named preset.
  - Switch to a preset (with auto-backup and a service-level diff).
  - Detect whether the current `auth.json` matches the last-selected preset.

- Quota:
  - OpenAI quota fetch via `https://chatgpt.com/backend-api/wham/usage`.
  - Google/"Antigravity" quota fetch via a Google internal endpoint used by Antigravity.
  - Consolidates tokens across presets (deduping by token/refresh token) to avoid repeated calls.

- UI:
  - Interactive menu UX (Questionary + Rich).
  - Optional TUI quota dashboard (Textual) when available.

- I18n:
  - Simple key/value translations via `opm/i18n.py`.
  - Language selection via `OPM_LANG=ko|en`, otherwise system locale.

## Runtime Data Locations

OPM primarily manages files in the user's home directory.

- OpenCode auth file (default): `~/.local/share/opencode/auth.json`
- OPM config directory: `~/.config/oauth-preset-manager/`
  - Presets: `~/.config/oauth-preset-manager/presets/*.json`
  - Backups: `~/.config/oauth-preset-manager/backups/*.json`
  - Config: `~/.config/oauth-preset-manager/config.json`
- Antigravity accounts (checked in order):
  - `~/.config/opencode/antigravity-accounts.json`
  - `~/.local/share/opencode/antigravity-accounts.json`

## Implementation Details (Code Map)

### Core Logic: `opm/core.py`

- `PresetManager`
  - Initializes the config/presets/backups directories under `~/.config/oauth-preset-manager/`.
  - Tracks `auth_path` and `current_preset` in `config.json`.
  - `save_preset(name, description="", watched_services=None)` copies the current `auth.json` into `presets/<name>.json` and records metadata.
  - `switch_preset(name, auto_backup=True)`:
    - Reads current + preset JSON, computes a service-level diff (`added/removed/modified`).
    - Creates a backup of the current auth file.
    - Replaces the active OpenCode `auth.json` with the preset.
  - `switch_preset_selective(name, selected_services=None, auto_backup=True)` supports partial service updates by merging JSON.
  - `detect_current_preset()` compares the on-disk `auth.json` against preset files for an exact match.

- Quota collection
  - `collect_openai_quota()` dedupes OAuth tokens found in presets and calls `_fetch_openai_quota_for_token`.
  - `collect_active_quota()` also checks:
    - The currently active `auth.json` ("(Current Active)").
    - Antigravity accounts from `antigravity-accounts.json`.
  - Time formatting lives in `time_until_reset()`.

Security note:
- `opm/core.py` currently contains hard-coded Antigravity OAuth client credentials used for token refresh. Treat this as sensitive and avoid logging or copying it into new places.

### CLI + Interactive Menus: `opm/cli.py`

- Entry point: `main()` (wired via `pyproject.toml`).
- Commands:
  - `opm` (no args): interactive preset picker.
  - `opm save <name>`: save preset.
  - `opm switch <name>`: switch preset.
  - `opm quota` / `opm q`: show quota.
- Quota rendering:
  - Prefers the Textual app from `opm/tui.py`.
  - Falls back to a Rich table if Textual is unavailable.

### TUI: `opm/tui.py`

- Textual `App` that groups quota results by preset and shows a tree view.
- Designed to run quota fetch in a background worker and render a loading view.

### I18n: `opm/i18n.py`

- `t(key, **kwargs)` provides translations for UI strings.
- `OPM_LANG` can override automatic language detection.

## Working With This Repo

- Local run: `python -m opm.cli` or install and use `opm`.
- Packaging entry point: `opm = opm.cli:main` in `pyproject.toml`.
- Optional dependency: Textual (quota TUI). If absent, quota falls back to Rich.

## Common Pitfalls

- Presets are not stored in this repo; they are created in the user's home directory.
- Quota endpoints are network-dependent and may change; quota scripts under the repo root are intended for local smoke/profiling.
- If you change any user-facing strings, update `opm/i18n.py` keys and their translations.
