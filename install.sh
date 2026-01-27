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
echo ""

# Create temporary directory
TMP_DIR=$(mktemp -d)
cd "$TMP_DIR"

echo "📦 Downloading oauth-preset-manager..."

# Download the package
REPO_URL="https://github.com/kmss1258/oauth-preset-manager"
ARCHIVE_URL="$REPO_URL/archive/refs/heads/main.tar.gz"

if command -v curl &> /dev/null; then
    curl -sSL "$ARCHIVE_URL" -o oauth-preset-manager.tar.gz
elif command -v wget &> /dev/null; then
    wget -q "$ARCHIVE_URL" -O oauth-preset-manager.tar.gz
else
    echo "❌ Error: Neither curl nor wget found"
    exit 1
fi

echo "✓ Downloaded package"

# Extract
tar -xzf oauth-preset-manager.tar.gz
cd oauth-preset-manager-main

echo ""
echo "📦 Installing package..."

# Install
python3 -m pip install --user -q .

echo "✓ Package installed"
echo ""

# Cleanup
cd /
rm -rf "$TMP_DIR"

# Check installation
if command -v opm &> /dev/null; then
    echo "✅ Successfully installed OAuth Preset Manager!"
    echo ""
    echo "Usage:"
    echo "  opm              # Interactive mode"
    echo "  opm save <name>  # Save current auth as preset"
    echo "  opm switch <name> # Switch to preset"
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
