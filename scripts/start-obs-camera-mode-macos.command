#!/bin/zsh
set -eu

OBS_APP="/Applications/OBS.app"

if [[ ! -x "$OBS_APP/Contents/MacOS/OBS" ]]; then
  echo "OBS was not found at $OBS_APP"
  exit 1
fi

if pgrep -x OBS >/dev/null 2>&1; then
  echo "OBS is already running. Fully quit it, then run this launcher again."
  exit 2
fi

open -a "$OBS_APP" --args --enable-media-stream
