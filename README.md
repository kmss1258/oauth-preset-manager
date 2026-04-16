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
- **Quota Table**: View quota usage in a Rich table for OpenAI & Google (Antigravity) accounts.
  - Supports detailed breakdown for Antigravity models (Flash, Pro, Claude).
  - Visual progress bars and reset timers.
  - Press `r` or `ㄱ` in `opm q` to refresh without changing the current quota layout.
- **Auto-Detection**: Alerts you if the current auth doesn't match the selected preset.
- **Interactive CLI**: Beautiful interactive prompts with arrow key navigation.
  - Includes an OpenAI-only interactive menu action that sends one `gpt-5.4-mini` request across saved OpenAI OAuth targets to kick quota back into motion after reset.
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
- Run the OpenAI quota kickoff action when you want to send one lightweight `gpt-5.4-mini` request to each OpenAI OAuth target.
- Save current configuration as a new preset.

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
> Shows usage for all presets + currently active Antigravity session.
> Renders a Rich table with provider, quota, reset, account, preset, and error columns.
> Press `r` or `ㄱ` to refresh the quota screen.

**Save Current Auth:**
```bash
opm save <new_preset_name>
```

## 🛠 Configuration

Presets are stored in `~/.config/oauth-preset-manager/presets/`.
The tool automatically detects your OpenCode `auth.json` location.
OpenCode uses XDG-style paths on both Linux and macOS, and honors `XDG_DATA_HOME` / `XDG_CONFIG_HOME` if you set them.

### Environment Variables
- `OPM_LANG`: Set language (`ko` or `en`)
- `OPM_ANTIGRAVITY_CLIENT_ID`: Required for Google/Antigravity quota refresh
- `OPM_ANTIGRAVITY_CLIENT_SECRET`: Required for Google/Antigravity quota refresh

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
