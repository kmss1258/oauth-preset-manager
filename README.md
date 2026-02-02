# OAuth Preset Manager (OPM) - Node.js Edition

**Manage your OAuth tokens like a pro.** Switch between multiple OpenAI/Google accounts instantly in OpenCode, check detailed quota usage, and keep your development flow uninterrupted.

Now rewritten in **Node.js** for better performance and cross-platform compatibility!

---

## ⚡ Quick Start

Install and run in one line:

```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash && opm
```

Or if already installed, just run:

```bash
opm
```

---

## 🔥 Features

- **Instant Switching**: Swap `auth.json` configurations with a single command.
- **Quota Dashboard**: View real-time quota usage for OpenAI & Google (Antigravity) accounts.
  - Supports detailed breakdown for Antigravity models (Flash, Pro, Claude).
  - Visual progress bars and reset timers.
- **Auto-Detection**: Alerts you if the current auth doesn't match the selected preset.
- **Interactive CLI**: Beautiful interactive prompts with arrow key navigation.
- **Multi-language**: English & Korean support (auto-detected).

## 🚀 Installation

### Requirements
- Node.js 18+
- Git

### Quick Install
```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash
```

### Manual Install
```bash
git clone https://github.com/kmss1258/oauth-preset-manager.git
cd oauth-preset-manager
npm install
npm link
```

## 📖 Usage

### Interactive Mode (Recommended)
Just run `opm` to open the interactive menu:
```bash
opm
```
- Select a preset to switch.
- View detailed quotas.
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

**Save Current Auth:**
```bash
opm save <new_preset_name>
```

## 🛠 Configuration

Presets are stored in `~/.config/oauth-preset-manager/presets/`.
The tool automatically detects your OpenCode `auth.json` location.

### Environment Variables
- `OPM_LANG`: Set language (`ko` or `en`)

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
