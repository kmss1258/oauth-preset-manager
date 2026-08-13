#!/bin/bash
set -e

REPO_URL="https://github.com/kmss1258/oauth-preset-manager.git"
INSTALL_DIR="$HOME/.oauth-preset-manager"
STATE_DIR="$HOME/.config/oauth-preset-manager"
STATE_FILE="$STATE_DIR/install-launcher-path"
NODE_VERSION_MIN=18
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_SOURCE="${BASH_SOURCE[0]}"

echo "🚀 OPM (OAuth Preset Manager) - Node.js Edition Installer"
echo ""

check_node() {
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js is not installed. Please install Node.js ${NODE_VERSION_MIN}+ first."
        echo "   Visit: https://nodejs.org/"
        exit 1
    fi

    if ! command -v npm &> /dev/null; then
        echo "❌ npm is not installed. Please install Node.js with npm first."
        exit 1
    fi

    if ! command -v git &> /dev/null; then
        echo "❌ git is not installed. Please install git first."
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt "$NODE_VERSION_MIN" ]; then
        echo "❌ Node.js version ${NODE_VERSION_MIN}+ required. Current: $(node -v)"
        exit 1
    fi
    
    echo "✅ Node.js $(node -v) found"
}

find_launcher_dir() {
    if [ -f "$STATE_FILE" ]; then
        saved_dir="$(cat "$STATE_FILE" 2>/dev/null || true)"
        if [ -n "$saved_dir" ] && [ -d "$saved_dir" ] && [ -w "$saved_dir" ]; then
            printf '%s\n' "$saved_dir"
            return 0
        fi
    fi

    existing_opm="$(command -v opm 2>/dev/null || true)"
    if [ -n "$existing_opm" ]; then
        existing_dir="$(dirname "$existing_opm")"
        if [ -d "$existing_dir" ] && [ -w "$existing_dir" ]; then
            printf '%s\n' "$existing_dir"
            return 0
        fi
    fi

    IFS=':' read -r -a path_dirs <<< "$PATH"

    for dir in "${path_dirs[@]}"; do
        if [ -n "$dir" ] && [ "$dir" != "." ] && [ -d "$dir" ] && [ -w "$dir" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done

    mkdir -p "$HOME/.local/bin"
    printf '%s\n' "$HOME/.local/bin"
}

install_launcher() {
    local launcher_dir="$1"
    local install_root="$2"
    local launcher_path="$launcher_dir/opm"

    mkdir -p "$launcher_dir"
    mkdir -p "$STATE_DIR"
    cat > "$launcher_path" <<EOF
#!/bin/sh
exec node "$install_root/src/cli.js" "\$@"
EOF
    chmod +x "$launcher_path"
    printf '%s\n' "$launcher_dir" > "$STATE_FILE"

    echo "🔗 Installed launcher: $launcher_path"

    case ":$PATH:" in
        *":$launcher_dir:"*) ;;
        *)
            echo "⚠️  '$launcher_dir' is not on your PATH yet."
            echo "   Add it to PATH to run 'opm' from any terminal."
            ;;
    esac
}

install_local() {
    case "$SCRIPT_SOURCE" in
        /dev/fd/*|/proc/*) return 1 ;;
    esac

    if [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/src" ]; then
        echo "📦 Installing from local directory..."
        (
            cd "$SCRIPT_DIR"
            npm install
        )
        install_launcher "$(find_launcher_dir)" "$SCRIPT_DIR"
        return 0
    fi
    return 1
}

install_from_git() {
    echo "📦 Installing from GitHub..."
    
    if [ -d "$INSTALL_DIR/.git" ]; then
        echo "🔄 Updating existing installation..."
        git -C "$INSTALL_DIR" fetch --depth 1 origin main
        git -C "$INSTALL_DIR" reset --hard origin/main
    else
        if [ -d "$INSTALL_DIR" ]; then
            echo "🧹 Cleaning up old installation..."
            rm -rf "$INSTALL_DIR"
        fi

        echo "⬇️  Cloning repository..."
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
            echo "❌ Failed to clone repository"
            exit 1
        }
    fi
    
    cd "$INSTALL_DIR"
    
    echo "📦 Installing dependencies..."
    npm install

    install_launcher "$(find_launcher_dir)" "$INSTALL_DIR"
}

main() {
    check_node
    
    if install_local; then
        echo ""
        echo "✅ OPM installed successfully from local directory!"
    else
        install_from_git
        echo ""
        echo "✅ OPM installed successfully!"
    fi
    
    echo ""
    echo "🎉 Installation complete!"
    echo ""
    echo "Usage:"
    echo "  opm              # Interactive mode"
    echo "  opm save <name>  # Save current auth as preset"
    echo "  opm switch <name> # Switch to preset"
    echo "  opm quota        # Show OAuth quota (or: opm q)"
    echo ""
    echo "Run 'opm' to get started!"
}

main "$@"
