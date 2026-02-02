#!/bin/bash
set -e

REPO_URL="https://github.com/kmss1258/oauth-preset-manager.git"
INSTALL_DIR="$HOME/.oauth-preset-manager"
NODE_VERSION_MIN=18

echo "🚀 OPM (OAuth Preset Manager) - Node.js Edition Installer"
echo ""

check_node() {
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js is not installed. Please install Node.js ${NODE_VERSION_MIN}+ first."
        echo "   Visit: https://nodejs.org/"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt "$NODE_VERSION_MIN" ]; then
        echo "❌ Node.js version ${NODE_VERSION_MIN}+ required. Current: $(node -v)"
        exit 1
    fi
    
    echo "✅ Node.js $(node -v) found"
}

install_local() {
    if [ -f "package.json" ] && [ -d "src" ]; then
        echo "📦 Installing from local directory..."
        npm install
        npm link
        return 0
    fi
    return 1
}

install_from_git() {
    echo "📦 Installing from GitHub..."
    
    if [ -d "$INSTALL_DIR" ]; then
        echo "🧹 Cleaning up old installation..."
        rm -rf "$INSTALL_DIR"
    fi
    
    echo "⬇️  Cloning repository..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null || {
        echo "❌ Failed to clone repository"
        exit 1
    }
    
    cd "$INSTALL_DIR"
    
    echo "📦 Installing dependencies..."
    npm install
    
    npm link
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
