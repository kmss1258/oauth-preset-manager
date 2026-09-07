# OAuth Preset Manager (OPM) - Node.js Edition

**Manage your OAuth tokens like a pro.** Switch between multiple OpenAI/Google accounts instantly in OpenCode, check detailed quota usage, and keep your development flow uninterrupted.

Now rewritten in **Node.js** for better performance and cross-platform compatibility!

---

## ⚡ Quick Start

Install and run in one line:

```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash && opm
```

Re-run that same command later to update an existing install in place.

Or if already installed, just run:

```bash
opm
```

---

## 🔥 Features

- **Instant Switching**: Swap `auth.json` configurations with a single command.
- **Quota View**: View quota usage for OpenAI, Claude OAuth, Google (Antigravity), OpenCode Go, and Command Code.
  - Supports detailed breakdown for Antigravity models (Flash, Pro, Claude).
  - Visual progress bars and reset timers.
  - Mobile/narrow terminals use compact account rows with adaptive bars. At 100+ columns, the full table is shown. Window resizing updates the layout without fetching again.
  - Short screens are paginated: `j`/`k`, down/up arrows, or Page Down/Page Up. The countdown stays fixed; `g` toggles Google details, and `q`, Esc, Enter, or Ctrl-C exits. Interactive mode restores the previous terminal screen on exit.
  - `opm q` refreshes automatically every 60 seconds and shows the next-refresh countdown above the table.
  - Press `r` or `ㄱ` in `opm q` to refresh immediately without changing the current quota layout.
  - Shows fixed UTC peak periods Monday-Friday only (01:00–04:00 and 06:00–10:00 UTC; 10:00–13:00 and 15:00–19:00 KST), with a `HH:MM:SS` countdown one hour before and throughout each peak window. Weekends are off. Active peaks use a rotating pastel border in interactive terminals.
- **Auto-Detection**: Alerts you if the current auth doesn't match the selected preset.
- **Interactive CLI**: Beautiful interactive prompts with arrow key navigation.
- Includes an OpenAI-only interactive menu action that sends one `gpt-5.6-luna` request across saved OpenAI OAuth targets to kick quota back into motion after reset.
- Includes a credential distribution action: choose exact top-level auth entries first, then destination presets (all destinations are selected by default). Only selected keys are replaced; every other OAuth/API entry is preserved.
- OpenCode Go API credentials (`opencode-go:api`) are separate from the optional browser/usage session (`OpenCode Go OAuth session`). Sessions are stored as normalized sidecars in `~/.config/oauth-preset-manager/preset-sidecars/opencode-go/`, never inside `auth.json`.
- **Multi-language**: English & Korean support (auto-detected).

## 🚀 Installation

### Requirements
- Node.js 18+
- Git

### Quick Install
```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash
```
> The installer writes an `opm` launcher into the first writable directory on your PATH (or `~/.local/bin` as a fallback).

### Manual Install
```bash
git clone https://github.com/kmss1258/oauth-preset-manager.git
cd oauth-preset-manager
npm install
./install.sh
```

## 📖 Usage

### Interactive Mode (Recommended)
Just run `opm` to open the interactive menu:
```bash
opm
```
- Select a preset to switch.
- View detailed quotas.
- Run the OpenAI quota kickoff action when you want to send one lightweight `gpt-5.6-luna` request to each OpenAI OAuth target.
- Save current configuration as a new preset.
- Distribute selected credentials to selected presets. Legacy presets without a Go sidecar remain auth-only.

### CLI Commands

**Switch Preset:**
```bash
opm switch <preset_name>
```

**Check Quotas:**
```bash
opm quota
# or
opm q
```
> Shows usage for supported preset credentials and detected local provider sessions.
> Shows a full table on wide terminals, or compact progress bars on mobile/narrow terminals. Very small heights show only status/exit controls until enlarged. Piped output is a single, unpaginated snapshot without cursor controls.
> The interactive quota screen refreshes automatically every 60 seconds and shows the next refresh above the table. Press `r` or `ㄱ` to refresh immediately.
> Peak periods are fixed Monday-Friday schedules: 01:00–04:00 UTC / 10:00–13:00 KST and 06:00–10:00 UTC / 15:00–19:00 KST. Weekends are off. The peak countdown starts one hour before each period and uses `HH:MM:SS`; the pastel border is only shown during active peaks in TTY mode.

**Save Current Auth:**
```bash
opm save <new_preset_name>
```

## 🛠 Configuration

Presets are stored in `~/.config/oauth-preset-manager/presets/`.
The tool automatically detects your OpenCode `auth.json` location.
OpenCode uses XDG-style paths on both Linux and macOS, and honors `XDG_DATA_HOME` / `XDG_CONFIG_HOME` if you set them.

Common auth file locations:
- OpenCode: `~/.local/share/opencode/auth.json` or `~/.config/opencode/auth.json`
- Codex CLI: `~/.codex/auth.json`
- Command Code: `~/.commandcode/auth.json` (OPM also checks `~/.commandcode/oauth.json`)
- Claude Code: `~/.claude/.credentials.json`

### Environment Variables
- `OPM_LANG`: Set language (`ko` or `en`)
- `OPM_ANTIGRAVITY_CLIENT_ID`: Required for Google/Antigravity quota refresh
- `OPM_ANTIGRAVITY_CLIENT_SECRET`: Required for Google/Antigravity quota refresh
- `OPENCODE_GO_WORKSPACE_ID`: OpenCode Go workspace ID (`wrk_...`) for `opm q` usage data
- `OPENCODE_GO_AUTH_COOKIE`: `auth` cookie from `opencode.ai` for OpenCode Go usage data
- `OPM_COMMAND_CODE_AUTH_PATH`: Optional Command Code credential path override
- `CLAUDE_CONFIG_DIR`: Claude Code profile directory (default `~/.claude`)
- `OPM_CLAUDE_AUTH_PATH`: Optional Claude Code `.credentials.json` path override; takes precedence over `CLAUDE_CONFIG_DIR`

### Claude OAuth quota

`opm q` detects `claudeAiOauth.accessToken` in the Claude Code credential file, plus `anthropic` entries with `type: "oauth"` in active OpenCode auth and saved presets. Identical access tokens share one request; API keys are ignored. No Claude credentials means no Claude row.

- Shows **remaining** 5-hour and weekly quota, plus model-specific weekly/extra-usage percentages when returned. The Claude table row labels its first window `5h` (not a calendar day).
- Reads the internal `https://api.anthropic.com/api/oauth/usage` endpoint with `anthropic-beta: oauth-2025-04-20`. Supports both legacy windows and newer `limits[]` responses. This is not a public stable Anthropic API.
- Requires usage/profile permission (`user:profile`); inference-only tokens may not work. Expired/unauthorized credentials show a re-login message. OPM **never refreshes, copies, or rewrites Claude credentials** as part of quota collection.
- Successful reads are cached in memory for 60 seconds. HTTP 429 honors `Retry-After` (five-minute fallback); manual refresh cannot bypass that cooldown. Credentials are re-read each collection, so a login/token rotation is picked up automatically.
- macOS Keychain-only credentials are **not read automatically**. Use an existing file-backed Claude profile or an OpenCode Anthropic OAuth entry. Keep credential files private (`chmod 600`); symlinked local Claude credential files are ignored.

References: [CodexBar OAuth fetcher/schema](https://github.com/steipete/CodexBar/blob/170a4d41c6d69e2bb25daac4fb088a92de2f9bc4/Sources/CodexBarCore/Providers/Claude/ClaudeOAuth/ClaudeOAuthUsageFetcher.swift), [Headroom client](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/subscription/client.py), [Claude Code authentication](https://code.claude.com/docs/en/authentication).

### OpenCode Go session

OpenCode Go usage is read from its workspace page and shows the 5-hour, weekly, and monthly windows. Its API key enables Go models, but the usage page currently requires the browser `auth` cookie as well.

You may store those two values in `~/.config/oauth-preset-manager/opencode-go.json` instead; environment variables take precedence. Keep this file private:

```json
{
  "workspaceId": "wrk_...",
  "authCookie": "Fe26.2**..."
}
```

```bash
chmod 600 ~/.config/oauth-preset-manager/opencode-go.json
```

The stored Go file is the only source used when saving or distributing a Go OAuth session. `OPENCODE_GO_WORKSPACE_ID` and `OPENCODE_GO_AUTH_COOKIE` are runtime quota overrides and are never persisted into presets or sidecars. Switching a preset with a sidecar restores its session; switching to a legacy preset leaves the current global Go session unchanged.

Go sidecars are stored outside the preset JSON files at `~/.config/oauth-preset-manager/preset-sidecars/opencode-go/<preset>.json` with restricted permissions.
If the stored global Go session is missing or malformed, saving/overwriting a preset leaves any existing sidecar unchanged; clearing a session is never inferred from absent data.

## 📝 Project Structure

```
.
├── src/
│   ├── cli.js          # Main CLI entry point
│   ├── core.js         # PresetManager and quota logic
│   └── i18n.js         # Translations (KO/EN)
├── package.json        # Node.js package config
├── install.sh          # Quick installer
└── README.md
```

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---
*Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-opencode)*
