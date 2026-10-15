# Cross-Platform Execution Hub

A GitHub-ready control dashboard and self-hosted orchestration starter for an isolated Linux/Wine desktop, browser VNC access, package staging, and optional authorized Windows/macOS endpoint checks.

> **Security model:** uploads are staged, not automatically executed. The public dashboard is not an execution environment. Keep the API private until TLS, authentication, origin restrictions, upload retention, monitoring, and host hardening are configured.

## Architecture

- `frontend/`: static HTML/CSS/JS dashboard; deployable to GitHub Pages.
- `backend/`: Node.js API with bearer-token authentication, upload limits, origin allowlist, rate limiting, SHA-256 package digests, and staging metadata.
- `orchestration/`: Docker Compose Linux desktop with Xvfb, Fluxbox, Wine, x11vnc, and websockify.
- `.github/workflows/deploy.yml`: deploys only the static dashboard to GitHub Pages.

GitHub Pages cannot host Node.js, Docker, binaries, SSH tunnels, or a backend. Run the backend and Compose stack on a computer/server you control. For a hosted Pages frontend, configure a publicly reachable HTTPS API and WSS viewer endpoint behind TLS. Do not expose raw VNC/RDP ports.

## Requirements

- Docker Engine or Docker Desktop with Compose v2.
- Bash, Python 3, `curl`, and (for optional remote checks) OpenSSH client. `openssl` is used only if Python cannot create a secret.
- Linux is recommended for the orchestrator. Docker Desktop can run the Linux containers on Windows/macOS, but shell/network behavior differs.
- Ports: `6080/tcp` by default, bound to `127.0.0.1` only. API defaults to `127.0.0.1:8080`. Change ports if occupied.
- For remote browser use: DNS name, valid TLS certificate, reverse proxy supporting WebSockets, and firewall rules allowing only intended clients.

## Quick start (local development)

From the repository root:

```bash
cd orchestration
cp .env.example .env
chmod 600 .env
# Edit .env and set a strong VNC_PASSWORD.
./start-all.sh
```

The script creates a random `.env` if you don't create one first. Keep `.env` private; it is ignored by Git.

Start the API in a second terminal:

```bash
cd backend
cp .env.example .env
# Generate a token and place it in backend/.env:
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
npm install
npm run check
npm start
```

The API binds to loopback by default. `API_TOKEN` must be set before authenticated routes work. Set `VNC_WS_URL=ws://127.0.0.1:6080/websockify` for local HTTP-only development. Set `ALLOWED_ORIGINS` to the exact origin serving the dashboard. The browser's upload/viewer calls use bearer auth; this starter does not persist a token in localStorage. For an authenticated deployment, integrate a proper login/OIDC flow or inject short-lived tokens through a secure application session. Do not put a long-lived API token into a public GitHub Pages JavaScript file.

### Local dashboard

Serve `frontend/` using any static web server, or use the API origin only if you configure a static server separately. Example:

```bash
python3 -m http.server 5173 --directory frontend
```

Open `http://127.0.0.1:5173`. The API must allow that origin in `ALLOWED_ORIGINS`. The sample UI does not embed an API token; therefore protected upload and viewer endpoints will return 401 until you connect a proper authentication/session layer. This is intentional—shipping a permanent bearer secret in static JavaScript would expose it to every visitor.

For a temporary local-only UI smoke test, you can use a local development proxy that adds the token server-side; do not use that pattern as a public authentication system.

## Configuration reference

### `orchestration/.env`

| Variable | Default | Purpose |
|---|---|---|
| `VNC_PASSWORD` | Generated if absent | Password for VNC authentication; keep private |
| `WEBSOCKIFY_PORT` | `6080` | Host loopback port for browser WebSocket proxy |
| `DESKTOP_RESOLUTION` | `1440x900` | Xvfb virtual screen size |
| `WINDOWS_HOST` | unset | Optional Windows endpoint for TCP reachability probe |
| `WINDOWS_RDP_PORT` | `3389` | Windows RDP port used only for a TCP probe |
| `MAC_HOST` | unset | Optional macOS host name/IP for SSH probe |
| `MAC_SSH_USER` | `runner` | Remote SSH account |
| `MAC_SSH_KEY` | unset | Path to private key on the orchestrator host |

### `backend/.env`

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | API bind address; loopback by default |
| `PORT` | `8080` | API port |
| `API_TOKEN` | empty/locked | Random bearer secret for protected routes |
| `DATA_DIR` | `./data` | Upload metadata storage |
| `UPLOAD_DIR` | `./data/uploads` | Staged packages |
| `MAX_UPLOAD_MB` | `200` | Maximum package size |
| `ALLOWED_ORIGINS` | local examples | Comma-separated exact browser origins |
| `VNC_WS_URL` | empty | Browser-facing `ws://` or `wss://` URL |
| `WINDOWS_HOST` | empty | Windows endpoint metadata |
| `WINDOWS_GATEWAY_URL` | empty | Authenticated browser RDP gateway URL metadata |
| `MAC_HOST` | empty | macOS SSH host metadata |
| `TRUST_PROXY_HOPS` | `0` | Set only when behind a known proxy |
| `TLS_TERMINATED_UPSTREAM` | `false` | Operator declaration that TLS is terminated upstream |

`/api/health` reports configuration presence, not proof of remote authentication or host health. The optional shell probes are separate and conservative.

## Remote Windows and macOS hosts

- Use a VPN/private network or a hardened bastion. Restrict firewall ingress to known clients.
- Use SSH keys, `BatchMode=yes`, host-key verification, and a dedicated low-privilege remote account. Provision host keys in `known_hosts` before running probes.
- The script probes the Windows RDP TCP port only. It does not log in or create a reverse tunnel. For browser RDP, deploy a separately authenticated gateway (for example, Apache Guacamole) and configure `WINDOWS_GATEWAY_URL`. Do not expose raw RDP to the public internet.
- The script runs a constrained `xcrun simctl` availability probe on macOS over SSH. It does not install arbitrary IPA files. Simulator-compatible builds are distinct from device builds; real-device installation requires appropriate signing, provisioning, pairing, and authorization.
- Do not place passwords, SSH private keys, certificates, or long-lived API tokens in Git, the frontend, command-line arguments, or issue reports.

## GitHub Pages deployment

1. Push the repository to a GitHub repository with the default branch set to `main`.
2. In **Settings → Pages**, choose **GitHub Actions** as the build/deployment source.
3. Push a change to `frontend/` or manually run the workflow from the Actions tab.
4. Configure your hosted API URL through the frontend's `?api=https://api.example.com` query parameter or by setting `window.EXECUTION_HUB_API` before `app.js` loads.
5. Set the API's `ALLOWED_ORIGINS` to the exact Pages origin, e.g. `https://OWNER.github.io`. If using a project Pages URL, the origin is still `https://OWNER.github.io` (the project path is not part of the origin).
6. Set `VNC_WS_URL` to a `wss://` URL accessible by the browser, routed through TLS and authentication. The provided Compose port binds to localhost and is intended for local testing only.

**Important authentication note:** this starter intentionally does not ship a browser-accessible permanent API token. Before exposing it publicly, implement OIDC/session login or a backend-for-frontend session that issues short-lived scoped tokens. The UI needs an authenticated session integration for protected operations. CORS is not authentication.

## Upload behavior and execution

- Only `.exe` and `.ipa` extensions are accepted. Extension checks are not malware detection.
- The API stores uploads under a UUID filename, records metadata and SHA-256, and marks them `staged`.
- It does not automatically run an executable or install an IPA. This avoids turning an upload endpoint into a remote code execution service.
- To test Wine, connect to the Linux desktop and manually run a reviewed file from `/workspace` after copying it into the mounted volume using an operator-controlled workflow. The API upload directory is intentionally separate from the desktop volume in this starter; do not mount uploads into the runtime until you design a review/approval boundary.
- Scan files, enforce quotas/retention, run the runtime as an unprivileged user, isolate network access, and take disposable snapshots before executing untrusted software.

## Operational commands

```bash
# Show services and health
cd orchestration
docker compose --env-file .env ps
docker compose --env-file .env logs -f

# Restart
docker compose --env-file .env restart

# Stop containers (persistent volume remains)
docker compose --env-file .env down

# Stop and delete the persistent workspace volume (DESTRUCTIVE)
docker compose --env-file .env down -v

# Check Node API syntax
cd ../backend
npm run check
```

## Production hardening checklist

- [ ] Put API behind HTTPS with a trusted certificate and restrictive firewall.
- [ ] Replace bearer-only prototype auth with OIDC/SSO and short-lived scoped sessions.
- [ ] Implement CSRF protections if using cookies, and audit authorization on every action.
- [ ] Deploy a WebSocket-aware reverse proxy; restrict viewer access and enforce authentication.
- [ ] Keep Docker socket out of the API container; never mount it merely to report health.
- [ ] Add malware scanning, quotas, cleanup/retention jobs, immutable audit events, and request IDs.
- [ ] Add observability, alerting, backups, vulnerability scanning, and dependency update automation.
- [ ] Pin container images and GitHub Actions to reviewed immutable digests/SHAs for a hardened release.
- [ ] Test restore, incident response, remote-host key rotation, and package deletion.

## Limitations

This repository is a secure-minded starter, not a turnkey cloud emulator. Wine does not provide Windows kernel compatibility; not every `.exe` works. An `.ipa` is not generally runnable in a Linux container, and simulator/device builds have different requirements. GitHub Pages is static hosting and cannot itself proxy to a user's localhost. Remote desktop and native macOS/Windows integration require separate, authorized services.
