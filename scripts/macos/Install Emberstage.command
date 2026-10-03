#!/bin/bash
set -eu

# Keep Terminal open on success AND failure without masking the exit status.
finish() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    printf '\nInstallation stopped (exit %s). Review the error above.\n' "$status" >&2
  fi
  if [ -t 0 ]; then
    printf '\nPress Enter to close this installer... '
    read -r ignored || true
  fi
  exit "$status"
}
trap finish EXIT

printf '%s\n' 'Emberstage macOS unsigned preview' \
  'Close OBS yourself before applying. This installer never starts/stops OBS' \
  'or streaming. Apply enables authenticated OBS WebSocket for native cameras.' \
  'No downloads, sudo, firewall changes, or background services.' ''

SCRIPT_DIR="$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALLER="$SCRIPT_DIR/payload/scripts/install-media-deck.sh"
if [ ! -f "$INSTALLER" ] || [ ! -f "$SCRIPT_DIR/payload/scripts/install-media-deck.py" ]; then
  printf '%s\n' 'Error: payload is missing. Keep this command beside the payload folder on the mounted DMG.' >&2
  exit 1
fi

python_help() {
  printf '%s\n' 'Python 3 is required but is missing or cannot run.' \
    'Install Python 3 yourself from https://www.python.org/downloads/macos/,' \
    'then reopen this installer. If you already use Homebrew: brew install python' \
    'Nothing will be downloaded or installed automatically.' >&2
}
if ! command -v python3 >/dev/null 2>&1; then
  python_help
  exit 1
fi
# Do not invoke the Apple developer-tools stub when Command Line Tools are absent.
if [ "$(command -v python3)" = /usr/bin/python3 ] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  python_help
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info.major == 3 else 1)'; then
  python_help
  exit 1
fi

printf '%s\n' 'Previewing changes (dry-run):'
/bin/bash "$INSTALLER"
printf '\nType exactly yes to apply the plan with backups; anything else cancels: '
CONFIRM=''
read -r CONFIRM || CONFIRM=''
if [ "$CONFIRM" != yes ]; then
  printf '%s\n' 'Cancelled. No changes were made.'
  exit 0
fi

# Do not forward caller arguments: only an explicit confirmation permits --apply.
/bin/bash "$INSTALLER" --apply
printf '\n%s\n' 'Installation complete. You may eject this disk and start OBS yourself.'
