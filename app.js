const $ = (selector) => document.querySelector(selector);
const API_BASE = (new URLSearchParams(location.search).get("api") || window.EXECUTION_HUB_API || "").replace(/\/$/, "");
let rfb = null;
let sessionToken = "";

function log(message, bad = false) {
  const p = document.createElement("p");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  p.append(time, document.createTextNode(message));
  if (bad) p.className = "bad";
  $("#activity-log").prepend(p);
}
function apiUrl(path) {
  if (!API_BASE) throw new Error("API base URL is not configured. Set window.EXECUTION_HUB_API or use ?api=https://your-api.example.");
  return `${API_BASE}${path}`;
}
async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (sessionToken) headers.set("Authorization", `Bearer ${sessionToken}`);
  const response = await fetch(apiUrl(path), { ...options, headers, credentials: "omit" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `API request failed (${response.status})`);
  return data;
}
function setStatus(id, value) {
  const el = document.getElementById(id);
  el.textContent = value ? "Online" : "Offline";
  el.className = `state ${value ? "online" : "offline"}`;
}
async function refreshStatus() {
  if (!API_BASE) {
    $("#api-indicator").textContent = "API: not configured";
    $("#api-indicator").className = "pill offline";
    $("#overall-state").textContent = "API URL required";
    ["linux-state", "windows-state", "mac-state"].forEach(id => {
      document.getElementById(id).textContent = "Not configured";
      document.getElementById(id).className = "state";
    });
    return;
  }
  try {
    const data = await apiFetch("/api/health");
    $("#api-indicator").textContent = "API: online";
    $("#api-indicator").className = "pill online";
    setStatus("linux-state", Boolean(data.environments?.linux?.available));
    setStatus("windows-state", Boolean(data.environments?.windows?.configured));
    setStatus("mac-state", Boolean(data.environments?.mac?.configured));
    $("#overall-state").textContent = data.ok ? "API operational" : "Some services unavailable";
    log("Health status refreshed.");
  } catch (error) {
    $("#api-indicator").textContent = "API: offline";
    $("#api-indicator").className = "pill offline";
    $("#overall-state").textContent = "API unreachable";
    log(error.message, true);
  }
}
function viewerMessage(title, detail) {
  disconnectViewer();
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-empty";
  const h = document.createElement("h3"); h.textContent = title;
  const p = document.createElement("p"); p.textContent = detail;
  wrapper.append(h, p);
  $("#viewer").replaceChildren(wrapper);
}
function disconnectViewer() {
  if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
  $("#viewer-state").textContent = "Not connected";
}
async function connectViewer(os = $("#viewer-os").value) {
  disconnectViewer();
  if (os !== "linux") {
    viewerMessage("Remote viewer not configured", "This environment requires a separately deployed, authenticated browser gateway. Do not expose raw RDP or VNC ports publicly.");
    log(`${os} viewer requires a separately configured gateway.`);
    return;
  }
  try {
    const info = await apiFetch("/api/viewer");
    if (!info.enabled || !info.websocketUrl) throw new Error("Linux viewer WebSocket is not configured.");
    if (location.protocol === "https:" && info.websocketUrl.startsWith("ws://")) throw new Error("HTTPS pages require a secure wss:// viewer endpoint.");
    const { default: RFB } = await import("https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/core/rfb.js");
    $("#viewer").replaceChildren();
    rfb = new RFB($("#viewer"), info.websocketUrl, { credentials: {} });
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener("connect", () => { $("#viewer-state").textContent = "Connected"; log("Linux desktop connected."); });
    rfb.addEventListener("disconnect", e => { $("#viewer-state").textContent = "Disconnected"; if (e.detail?.clean === false) log("Viewer disconnected unexpectedly.", true); });
    $("#viewer-state").textContent = "Connecting…";
    log("Opening Linux VNC WebSocket.");
  } catch (error) {
    viewerMessage("Could not connect", error.message);
    $("#viewer-state").textContent = "Connection failed";
    log(error.message, true);
  }
}
$("#refresh-btn").addEventListener("click", refreshStatus);
$("#viewer-connect").addEventListener("click", () => connectViewer("linux"));
$("#disconnect-btn").addEventListener("click", () => { disconnectViewer(); viewerMessage("Workspace disconnected", "Choose an environment and connect when ready."); });
$("#viewer-os").addEventListener("change", () => viewerMessage("Environment selected", "Click Connect to open a configured viewer."));
document.querySelectorAll(".connect-btn").forEach(button => button.addEventListener("click", () => {
  $("#viewer-os").value = button.dataset.os;
  connectViewer(button.dataset.os);
}));
$("#package-file").addEventListener("change", event => {
  $("#file-label").textContent = event.target.files?.[0]?.name || "Choose an .exe or .ipa package";
  const target = $("#target-os");
  if (event.target.files?.[0]?.name.toLowerCase().endsWith(".ipa")) target.value = "mac-simulator";
  else if (event.target.files?.[0]) target.value = "linux-wine";
});
$("#upload-form").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("#package-file").files?.[0];
  if (!file) return;
  const target = $("#target-os").value;
  const extension = file.name.toLowerCase().split(".").pop();
  if ((target === "linux-wine" && extension !== "exe") || (target === "mac-simulator" && extension !== "ipa")) {
    $("#upload-result").textContent = "File extension does not match the selected target.";
    return;
  }
  const button = event.submitter;
  button.disabled = true; button.textContent = "Uploading…";
  try {
    const form = new FormData();
    form.append("package", file, file.name);
    form.append("target", target);
    const result = await apiFetch("/api/uploads", { method: "POST", body: form });
    $("#upload-result").textContent = `Staged successfully\nID: ${result.id}\nName: ${result.filename}\nTarget: ${result.target}\nStatus: ${result.status}\n\nStaging never auto-executes packages. Use the authenticated host-side workflow to review and run them.`;
    log(`Package staged: ${result.filename} (${result.target}).`);
  } catch (error) {
    $("#upload-result").textContent = `Upload failed: ${error.message}`;
    log(error.message, true);
  } finally { button.disabled = false; button.textContent = "Upload and stage package"; }
});
$("#clear-log").addEventListener("click", () => $("#activity-log").replaceChildren());
refreshStatus();
