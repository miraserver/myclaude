#!/bin/bash
set -e

if [ -z "${SKIP_WARNING:-}" ]; then
  echo "⚠️  WARNING: install.sh is LEGACY and will be removed in future versions."
  echo "Please use the new installation method:"
  echo "  npx github:miraserver/myclaude"
  echo ""
  echo "Set SKIP_WARNING=1 to bypass this message"
  echo "Continuing with legacy installation in 5 seconds..."
  sleep 5
fi

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
    mingw*|msys*|cygwin*) OS="windows" ;;
esac

# Normalize architecture names
case "$ARCH" in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Build download URL
REPO="miraserver/myclaude"
VERSION="${CODEAGENT_WRAPPER_VERSION:-latest}"
BINARY_NAME="codeagent-wrapper-${OS}-${ARCH}"
if [ "$OS" = "windows" ]; then BINARY_NAME="${BINARY_NAME}.exe"; fi
if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/${REPO}/releases/latest/download/${BINARY_NAME}"
else
    URL="https://github.com/${REPO}/releases/download/${VERSION}/${BINARY_NAME}"
fi

echo "Downloading codeagent-wrapper from ${URL}..."
DOWNLOAD_FILE=$(mktemp)
CHECKSUM_FILE=$(mktemp)
trap 'rm -f "$DOWNLOAD_FILE" "$CHECKSUM_FILE"' EXIT
if ! curl -fsSL "$URL" -o "$DOWNLOAD_FILE"; then
    echo "ERROR: failed to download binary" >&2
    exit 1
fi

# A missing manifest is supported for releases published before SHA256SUMS.
CHECKSUM_STATUS=$(curl -sSL -w '%{http_code}' "${URL%/*}/SHA256SUMS" -o "$CHECKSUM_FILE") || {
    echo "ERROR: failed to download SHA256SUMS" >&2; exit 1;
}
if [ "$CHECKSUM_STATUS" = "404" ]; then
    echo "WARNING: SHA256SUMS absent; continuing without checksum verification." >&2
elif [ "$CHECKSUM_STATUS" != "200" ]; then
    echo "ERROR: SHA256SUMS download returned HTTP $CHECKSUM_STATUS" >&2; exit 1
else
    EXPECTED=$(awk -v asset="$BINARY_NAME" '$2 == asset {print $1}' "$CHECKSUM_FILE")
    if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL=$(sha256sum "$DOWNLOAD_FILE" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        ACTUAL=$(shasum -a 256 "$DOWNLOAD_FILE" | awk '{print $1}')
    else
        echo "ERROR: sha256sum or shasum is required for verification" >&2; exit 1
    fi
    if [[ ! "$EXPECTED" =~ ^[[:xdigit:]]{64}$ ]] || [ "$(echo "$EXPECTED" | tr 'A-F' 'a-f')" != "$ACTUAL" ]; then
        echo "ERROR: SHA256 checksum mismatch for $BINARY_NAME" >&2; exit 1
    fi
fi

INSTALL_DIR="${INSTALL_DIR:-$HOME/.claude}"
BIN_DIR="${INSTALL_DIR}/bin"
mkdir -p "$BIN_DIR"

WRAPPER_PATH="${BIN_DIR}/codeagent-wrapper"
if [ "$OS" = "windows" ]; then WRAPPER_PATH="${WRAPPER_PATH}.exe"; fi
if [ -e "$WRAPPER_PATH" ]; then
    mv -f "$WRAPPER_PATH" "$WRAPPER_PATH.old"
fi
if ! mv "$DOWNLOAD_FILE" "$WRAPPER_PATH" || ! chmod +x "$WRAPPER_PATH"; then
    echo "ERROR: unable to install binary" >&2
    rm -f "$WRAPPER_PATH"
    if [ -e "$WRAPPER_PATH.old" ]; then mv -f "$WRAPPER_PATH.old" "$WRAPPER_PATH"; fi
    exit 1
fi

if "$WRAPPER_PATH" --version >/dev/null 2>&1; then
    rm -f "$WRAPPER_PATH.old"
    echo "codeagent-wrapper installed successfully to ${WRAPPER_PATH}"
else
    echo "ERROR: installation verification failed" >&2
    rm -f "$WRAPPER_PATH"
    if [ -e "$WRAPPER_PATH.old" ]; then mv -f "$WRAPPER_PATH.old" "$WRAPPER_PATH"; fi
    exit 1
fi

# Auto-add to shell config files with idempotency
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    echo ""
    echo "WARNING: ${BIN_DIR} is not in your PATH"

    # Detect user's default shell (from $SHELL, not current script executor)
    USER_SHELL=$(basename "$SHELL")
    case "$USER_SHELL" in
        zsh)
            RC_FILE="$HOME/.zshrc"
            PROFILE_FILE="$HOME/.zprofile"
            ;;
        *)
            RC_FILE="$HOME/.bashrc"
            PROFILE_FILE="$HOME/.profile"
            ;;
    esac

    # Idempotent add: check if complete export statement already exists
    EXPORT_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
    FILES_TO_UPDATE=("$RC_FILE" "$PROFILE_FILE")

    for FILE in "${FILES_TO_UPDATE[@]}"; do
        if [ -f "$FILE" ] && grep -qF "${EXPORT_LINE}" "$FILE" 2>/dev/null; then
            echo "  ${BIN_DIR} already in ${FILE}, skipping."
        else
            echo "  Adding to ${FILE}..."
            echo "" >> "$FILE"
            echo "# Added by myclaude installer" >> "$FILE"
            echo "${EXPORT_LINE}" >> "$FILE"
        fi
    done

    echo "  Done. Restart your shell or run:"
    echo "    source ${PROFILE_FILE}"
    echo "    source ${RC_FILE}"
    echo ""
fi
