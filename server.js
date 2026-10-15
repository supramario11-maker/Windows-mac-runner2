import express from "express";
import helmet from "helmet";
import cors from "cors";
import multer from "multer";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads"));
const API_TOKEN = process.env.API_TOKEN || "";
const MAX_UPLOAD_MB = Math.min(Math.max(Number(process.env.MAX_UPLOAD_MB || 200), 1), 2048);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:8080,http://127.0.0.1:8080").split(",").map(s => s.trim()).filter(Boolean);
const VNC_WS_URL = process.env.VNC_WS_URL || "";
const WINDOWS_GATEWAY_URL = process.env.WINDOWS_GATEWAY_URL || "";
const MAC_HOST = process.env.MAC_HOST || "";
const WINDOWS_HOST = process.env.WINDOWS_HOST || "";

await fs.mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
const appOrigin = (origin) => !origin || ALLOWED_ORIGINS.includes(origin);
app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS || 0));
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
app.use(cors({ origin(origin, cb) { cb(null, appOrigin(origin)); }, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"] }));
app.use(express.json({ limit: "32kb" }));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

function authenticate(req, res, next) {
  if (!API_TOKEN) return res.status(503).json({ error: "API_TOKEN is not configured; API is locked." });
  const supplied = req.get("authorization") || "";
  const expected = `Bearer ${API_TOKEN}`;
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });
  next();
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".exe", ".ipa"].includes(ext)) return cb(new Error("Only .exe and .ipa files are accepted."));
    cb(null, true);
  }
});

app.get("/api/health", async (_req, res) => {
  let dockerAvailable = false;
  try {
    const raw = await fs.readFile("/var/run/docker.sock");
    dockerAvailable = raw.length >= 0;
  } catch { /* Docker socket is deliberately not mounted into this API by default. */ }
  res.json({
    ok: true,
    service: "execution-hub-api",
    environments: {
      linux: { available: Boolean(VNC_WS_URL), viewerConfigured: Boolean(VNC_WS_URL), dockerSocketMounted: dockerAvailable },
      windows: { configured: Boolean(WINDOWS_HOST && WINDOWS_GATEWAY_URL) },
      mac: { configured: Boolean(MAC_HOST) }
    },
    note: "Configured means settings are present, not that a remote host has passed an authenticated health check."
  });
});
app.get("/api/viewer", authenticate, (_req, res) => {
  if (!VNC_WS_URL) return res.json({ enabled: false, websocketUrl: null });
  let parsed;
  try { parsed = new URL(VNC_WS_URL); } catch { return res.status(500).json({ error: "VNC_WS_URL is invalid." }); }
  if (!["ws:", "wss:"].includes(parsed.protocol)) return res.status(500).json({ error: "VNC_WS_URL must use ws:// or wss://." });
  res.json({ enabled: true, websocketUrl: parsed.toString() });
});
app.post("/api/uploads", authenticate, upload.single("package"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No package file uploaded." });
  const target = req.body.target;
  const ext = path.extname(req.file.originalname).toLowerCase();
  const validTarget = (ext === ".exe" && target === "linux-wine") || (ext === ".ipa" && target === "mac-simulator");
  if (!validTarget) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: "File extension does not match target." });
  }
  const id = path.basename(req.file.filename, ext);
  const record = {
    id, filename: path.basename(req.file.originalname).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 180),
    storedFilename: req.file.filename, size: req.file.size, target, status: "staged",
    uploadedAt: new Date().toISOString(), sha256: await hashFile(req.file.path)
  };
  await fs.writeFile(path.join(DATA_DIR, `${id}.json`), JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
  res.status(201).json({ id: record.id, filename: record.filename, target: record.target, status: record.status, sha256: record.sha256 });
});
async function hashFile(file) {
  const data = await fs.readFile(file);
  return crypto.createHash("sha256").update(data).digest("hex");
}
app.get("/api/uploads/:id", authenticate, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid upload ID." });
  try {
    const record = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${req.params.id}.json`), "utf8"));
    res.json({ id: record.id, filename: record.filename, size: record.size, target: record.target, status: record.status, uploadedAt: record.uploadedAt, sha256: record.sha256 });
  } catch { res.status(404).json({ error: "Staged package not found." }); }
});
app.get("/api/remote/windows", authenticate, (_req, res) => {
  if (!WINDOWS_HOST || !WINDOWS_GATEWAY_URL) return res.status(503).json({ error: "Windows gateway is not configured." });
  res.json({ configured: true, host: WINDOWS_HOST, gatewayUrl: WINDOWS_GATEWAY_URL });
});
app.get("/api/remote/mac", authenticate, (_req, res) => {
  if (!MAC_HOST) return res.status(503).json({ error: "macOS SSH host is not configured." });
  res.json({ configured: true, host: MAC_HOST, simulatorInstallSupported: false, note: "Configure a reviewed host-side SSH worker and verify simulator-compatible builds before enabling install operations." });
});
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `Upload exceeds ${MAX_UPLOAD_MB} MB limit.` : err.message });
  if (err) return res.status(400).json({ error: err.message || "Bad request" });
  res.status(500).json({ error: "Internal server error" });
});
app.listen(PORT, HOST, () => {
  console.log(`Execution Hub API listening on http://${HOST}:${PORT}`);
  if (!API_TOKEN) console.error("WARNING: API_TOKEN is unset; authenticated API routes are locked.");
  if (HOST !== "127.0.0.1" && HOST !== "::1" && !process.env.TLS_TERMINATED_UPSTREAM) console.error("WARNING: non-loopback bind without declared TLS termination; use a private network or TLS reverse proxy.");
});
