#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
COMPOSE_FILE="$ROOT/docker-compose.yml"
ENV_FILE="$ROOT/.env"
API_ENV_FILE="$ROOT/../backend/.env"

fail(){ printf '\n[ERROR] %s\n' "$*" >&2; exit 1; }
info(){ printf '[INFO] %s\n' "$*"; }
ok(){ printf '[  OK] %s\n' "$*"; }
warn(){ printf '[WARN] %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Engine/Desktop first."
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable or current user lacks permission."
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE=(docker-compose)
else fail "Docker Compose plugin or docker-compose binary is required."; fi

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null || openssl rand -hex 32)"
  cat >"$ENV_FILE" <<EOF
VNC_PASSWORD=$secret
WEBSOCKIFY_PORT=6080
DESKTOP_RESOLUTION=1440x900
EOF
  chmod 600 "$ENV_FILE"
  warn "Created orchestration/.env with a random VNC password. Keep it private."
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${VNC_PASSWORD:?VNC_PASSWORD is required in orchestration/.env}"
PORT="${WEBSOCKIFY_PORT:-6080}"

port_available(){
  python3 - "$1" <<'PY'
import socket, sys
port=int(sys.argv[1])
s=socket.socket()
try:
    s.bind(("127.0.0.1",port))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
PY
}
if ! port_available "$PORT"; then
  # Existing Compose stack may already own the port; allow it if this project is running.
  if ! docker ps --format '{{.Names}}' | grep -qx 'execution-hub-websockify'; then
    fail "TCP port $PORT is occupied. Change WEBSOCKIFY_PORT in orchestration/.env."
  fi
fi

info "Starting isolated Linux/Xvfb/Fluxbox/Wine/VNC environment..."
"${COMPOSE[@]}" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build
ok "Compose services requested."

wait_http(){
  local url="$1" attempts="${2:-20}"
  for _ in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}
if wait_http "http://127.0.0.1:${PORT}/" 30; then
  ok "websockify HTTP endpoint responds at http://127.0.0.1:${PORT}/"
else
  warn "websockify did not respond yet; inspect logs with docker compose logs -f."
fi

printf '\n========== EXECUTION HUB STATUS ==========\n'
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps
printf '\nLinux desktop: '
if docker inspect --format '{{.State.Health.Status}}' execution-hub-linux 2>/dev/null | grep -qx healthy; then ok "healthy"; else warn "starting or unhealthy"; fi
printf 'WebSocket proxy: '
if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then ok "reachable on localhost:${PORT}"; else warn "not responding"; fi

# Remote endpoints are probed only when configured. No passwords are accepted on
# command line, no reverse tunnel is created implicitly, and no remote command
# is executed by this script. Use key-based SSH and an approved private network.
if [[ -n "${WINDOWS_HOST:-}" ]]; then
  printf 'Windows host %s: ' "$WINDOWS_HOST"
  if command -v nc >/dev/null 2>&1 && nc -z -w 3 "$WINDOWS_HOST" "${WINDOWS_RDP_PORT:-3389}" 2>/dev/null; then ok "TCP RDP port reachable (not an authentication test)"; else warn "RDP TCP probe failed"; fi
else
  printf 'Windows host: '; warn "not configured (set WINDOWS_HOST in orchestration/.env)"
fi

if [[ -n "${MAC_HOST:-}" ]]; then
  printf 'macOS host %s: ' "$MAC_HOST"
  if command -v ssh >/dev/null 2>&1 && [[ -n "${MAC_SSH_KEY:-}" ]] && [[ -r "${MAC_SSH_KEY/#\~/$HOME}" ]]; then
    key="${MAC_SSH_KEY/#\~/$HOME}"
    if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -i "$key" "${MAC_SSH_USER:-runner}@${MAC_HOST}" 'command -v xcrun >/dev/null && xcrun simctl list devices booted >/dev/null' >/dev/null 2>&1; then
      ok "SSH and xcrun simctl probe succeeded"
    else warn "SSH/simulator probe failed; check key, known_hosts, permissions, and Xcode"; fi
  else warn "MAC_SSH_KEY must reference a readable key and ssh must be installed"; fi
else
  printf 'macOS host: '; warn "not configured (set MAC_HOST and MAC_SSH_KEY)"
fi

cat <<EOF

Dashboard:
  Local API:      http://127.0.0.1:${API_PORT:-8080}
  noVNC landing:  http://127.0.0.1:${PORT}/
  WebSocket path: ws://127.0.0.1:${PORT}/websockify

Important:
  - The script does not publish raw VNC/RDP to the internet.
  - The API needs backend/.env and a secure reverse proxy for remote use.
  - GitHub Pages cannot reach localhost on your machine; deploy the API and
    WSS proxy on a reachable HTTPS/WSS host and configure the frontend API URL.
  - Uploads are staged only. Review packages and execute them manually in the
    isolated desktop; do not run untrusted binaries.
  - Stop with: docker compose -f "$COMPOSE_FILE" down
==========================================
EOF
