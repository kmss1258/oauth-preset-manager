#!/bin/bash
set -e

echo "🚀 Installing OAuth Preset Manager..."
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: Python 3 is required but not found"
    echo "Please install Python 3.7 or higher"
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
echo "✓ Found Python $PYTHON_VERSION"

# Check pip
if ! python3 -m pip --version &> /dev/null; then
    echo "❌ Error: pip is required but not found"
    echo "Please install pip for Python 3"
    exit 1
fi

echo "✓ Found pip"

# Check git
if ! command -v git &> /dev/null; then
    echo "❌ Error: git is required but not found"
    echo "Please install git"
    exit 1
fi

echo "✓ Found git"
echo ""

# Create temporary directory
TEMP_DIR=$(mktemp -d)
echo "📥 Cloning repository to $TEMP_DIR..."

# Clone the repository
git clone -q https://github.com/kmss1258/oauth-preset-manager.git "$TEMP_DIR"

echo "✓ Repository cloned"
echo ""

echo "📦 Installing package..."

# Install (or upgrade if already installed)
python3 -m pip install --user --upgrade -q "$TEMP_DIR"

# Clean up
rm -rf "$TEMP_DIR"

echo "✓ Package installed"
echo ""

# Check installation
if command -v opm &> /dev/null; then
    echo "✅ Successfully installed OAuth Preset Manager!"
    echo ""
    echo "Usage:"
    echo "  opm              # Interactive mode"
    echo "  opm save <name>  # Save current auth as preset"
    echo "  opm switch <name> # Switch to preset"
    echo "  opm quota         # Show quota for all presets"
    echo ""
    echo "Run 'opm' to get started!"
else
    echo "⚠️  Installation complete, but 'opm' not found in PATH"
    echo ""
    echo "Please add the following to your PATH:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Add this line to your ~/.bashrc or ~/.zshrc and restart your shell"
fi
