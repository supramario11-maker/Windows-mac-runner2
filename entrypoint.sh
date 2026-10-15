#!/usr/bin/env bash
set -Eeuo pipefail
: "${VNC_PASSWORD:?VNC_PASSWORD is required}"
: "${RESOLUTION:=1440x900}"
case "$RESOLUTION" in *[!0-9x]*|x*|*x) echo "Invalid RESOLUTION" >&2; exit 2;; esac
mkdir -p "$HOME/.vnc" "$WINEPREFIX"
umask 077
x11vnc -storepasswd "$VNC_PASSWORD" "$HOME/.vnc/passwd" >/dev/null
Xvfb "$DISPLAY" -screen 0 "${RESOLUTION}x24" -nolisten tcp -ac &
XVFB_PID=$!
cleanup(){ kill "${VNC_PID:-}" "${WM_PID:-}" "${TERM_PID:-}" "$XVFB_PID" 2>/dev/null || true; }
trap cleanup EXIT TERM INT
for _ in $(seq 1 40); do
  [ -S /tmp/.X11-unix/X1 ] && break
  sleep .25
done
[ -S /tmp/.X11-unix/X1 ] || { echo "Xvfb failed to start" >&2; exit 1; }
fluxbox >/tmp/fluxbox.log 2>&1 &
WM_PID=$!
xterm -geometry 100x30+20+20 -title "Execution Hub - Wine Runtime" -e bash -lc 'echo "Linux/Wine desktop ready."; echo "Stage reviewed EXE files in /workspace."; echo "Run them manually with: wine /workspace/your-app.exe"; exec bash' >/tmp/xterm.log 2>&1 &
TERM_PID=$!
x11vnc -display "$DISPLAY" -rfbport 5900 -rfbauth "$HOME/.vnc/passwd" -forever -shared -localhost no -noxdamage -repeat &
VNC_PID=$!
wait "$XVFB_PID"
