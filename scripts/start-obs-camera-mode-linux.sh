#!/bin/bash
set -eu

# Refuse if OBS is already running
if pgrep -x obs >/dev/null 2>&1 || pgrep -x obs-studio >/dev/null 2>&1 || pgrep -f "com.obsproject.Studio" >/dev/null 2>&1; then
  echo "OBS is already running. Fully quit it, then run this launcher again."
  exit 2
fi

if [ $# -lt 1 ]; then
  echo "Error: Ambiguous mode. Please specify --native or --flatpak." >&2
  exit 1
fi

mode="$1"
if [ "$mode" = "--flatpak" ]; then
  if ! command -v flatpak >/dev/null 2>&1; then
    echo "Error: Flatpak is not installed or available." >&2
    exit 1
  fi
  echo "Launching OBS Studio via Flatpak..."
  exec flatpak run com.obsproject.Studio --enable-media-stream
elif [ "$mode" = "--native" ]; then
  if command -v obs >/dev/null 2>&1; then
    echo "Launching native OBS Studio..."
    exec obs --enable-media-stream
  elif command -v obs-studio >/dev/null 2>&1; then
    echo "Launching native OBS Studio..."
    exec obs-studio --enable-media-stream
  else
    echo "Error: Native OBS Studio ('obs' or 'obs-studio') was not found on your system." >&2
    exit 1
  fi
else
  echo "Error: Invalid argument '$mode'. Supported arguments: --native, --flatpak" >&2
  exit 1
fi
