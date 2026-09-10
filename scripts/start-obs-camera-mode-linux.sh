#!/bin/bash
set -eu

# Refuse if OBS is already running
if pgrep -x obs >/dev/null 2>&1 || pgrep -x obs-studio >/dev/null 2>&1 || pgrep -f "com.obsproject.Studio" >/dev/null 2>&1; then
  echo "OBS is already running. Fully quit it, then run this launcher again."
  exit 2
fi

# Try running Flatpak first if com.obsproject.Studio is installed, else try native obs
if command -v flatpak >/dev/null 2>&1 && flatpak list --columns=application | grep -q "com.obsproject.Studio"; then
  echo "Launching OBS Studio via Flatpak..."
  exec flatpak run com.obsproject.Studio --enable-media-stream
elif command -v obs >/dev/null 2>&1; then
  echo "Launching native OBS Studio..."
  exec obs --enable-media-stream
elif command -v obs-studio >/dev/null 2>&1; then
  echo "Launching native OBS Studio..."
  exec obs-studio --enable-media-stream
else
  echo "OBS Studio was not found on your system (neither Flatpak nor native 'obs'/'obs-studio' command)."
  exit 1
fi
