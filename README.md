# 🔐 OAuth Preset Manager

Easily manage and switch between multiple OpenCode OAuth authentication presets.

---

## ⚡ Quick Install

```bash
curl -sSL https://raw.githubusercontent.com/kmss1258/oauth-preset-manager/main/install.sh | bash
```

> **Note:** You may need to add `~/.local/bin` to your PATH. The installer will guide you.

## 🚀 Quick Start

Just run:
```bash
opm
```

That's it! 🎉 Use arrow keys to select and switch between presets.

---

## ✨ Features

- 🔄 **Quick Switching**: Switch between different OAuth accounts instantly
- 💾 **Preset Management**: Save and organize multiple authentication states
- 🎨 **Interactive UI**: Beautiful terminal interface with menu selection
- 🔒 **Auto Backup**: Automatic backups before switching presets
- ⚡ **Simple Commands**: Just `save` and `switch` - that's it!

## 📖 Usage

### 🎯 Interactive Mode (Recommended)

Simply run without arguments to enter interactive mode:

```bash
opm
```

This will show you a menu where you can:
- ⬆️⬇️ Browse and select presets with arrow keys
- 👀 See which services each preset contains
- ⚡ Switch presets instantly
- 💾 Save new presets

### 💻 Command Line Mode

**Save current auth as a preset:**
```bash
opm save work
opm save personal
```

**Switch to a preset:**
```bash
opm switch work
opm switch personal
```

## 🔧 How It Works

OAuth Preset Manager manages your OpenCode authentication file (`~/.local/share/opencode/auth.json`) by:

1. **Saving**: Creates a snapshot of your current auth state
2. **Switching**: Replaces your current auth with a saved preset
3. **Backing up**: Automatically backs up before each switch

All presets are stored in `~/.config/oauth-preset-manager/presets/`

## 📝 Example Workflow

```bash
# 1. Save your current work account
$ opm save work
✓ Saved preset: work
Services: anthropic, openai, google, zai-coding-plan

# 2. Logout and login with personal account in OpenCode
# ... (logout/login in OpenCode)

# 3. Save your personal account
$ opm save personal
✓ Saved preset: personal
Services: anthropic, openai

# 4. Switch back to work account anytime
$ opm switch work
✓ Switched to preset: work
Services: anthropic, openai, google, zai-coding-plan

# Or use interactive mode
$ opm
# Select from menu with arrow keys
```

## ⚙️ Configuration

On first run, `opm` will automatically detect your OpenCode auth file at:
```
~/.local/share/opencode/auth.json
```

If it's in a different location, you'll be prompted to enter the path.

## 📁 Data Storage

- **Presets**: `~/.config/oauth-preset-manager/presets/`
- **Backups**: `~/.config/oauth-preset-manager/backups/`
- **Config**: `~/.config/oauth-preset-manager/config.json`

## 📋 Requirements

- Python 3.7+
- pip

## 📄 License

MIT

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
