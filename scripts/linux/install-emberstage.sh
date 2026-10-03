#!/bin/sh
# Host-side installer: no sudo, network downloads or sandbox overrides.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v python3 >/dev/null 2>&1 || { printf '%s\n' 'Python 3 is required on the Linux host.' >&2; exit 1; }
case "${1:-}" in
  --flatpak)
    shift
    exec python3 "$HERE/../install-media-deck.py" --obs-config-path "$HOME/.var/app/com.obsproject.Studio/config/obs-studio" "$@"
    ;;
  --native)
    shift
    exec python3 "$HERE/../install-media-deck.py" --obs-config-path "${XDG_CONFIG_HOME:-$HOME/.config}/obs-studio" "$@"
    ;;
  *) exec python3 "$HERE/../install-media-deck.py" "$@" ;;
esac
