// HMI backend for the tire curing press on Industrial Edge.
// Subscribes to the SIMATIC v1 topics of one connector on the IE Databus, decodes them with the connector's
// metadata and streams named values to browsers over server-sent events. Operator commands come back as
// POST /api/write and leave as SIMATIC v1 write payloads on the data point's pubTopic, like any IE app would write.
import { readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import mqtt from "mqtt";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = (name, fallback) => (process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name]);
const CONFIG = {
  port: Number(env("PORT", 8080)),
  databusUrl: env("DATABUS_URL", "mqtt://ie-databus:1883"),
  databusUser: env("DATABUS_USER", undefined),
  databusPassword: env("DATABUS_PASSWORD", undefined),
  connector: env("CONNECTOR", "tirepress1"),
  connection: env("CONNECTION", "factory"),
  publicDir: env("PUBLIC_DIR", join(ROOT, "public")),
  writesEnabled: env("WRITES_ENABLED", "true") !== "false",
};
const TOPICS = {
  metadata: `ie/m/j/simatic/v1/${CONFIG.connector}/dp`,
  data: `ie/d/j/simatic/v1/${CONFIG.connector}/dp/r/${CONFIG.connection}/+`,
};
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ---- databus state -------------------------------------------------------------------------
const tags = new Map(); // id -> { id, name, dataType, access, chunk, pubTopic }
const byName = new Map();
const raw = new Map(); // chunk -> last payload, kept until metadata can decode it
const values = {}; // name -> value
const status = { connected: false, metadata: false, lastDataMs: 0, lastError: "", hashVersion: null };
let writeSeq = 0;

function onMetadata(payload) {
  const connection = (payload.connections || []).find((c) => c.name === CONFIG.connection);
  if (!connection) { status.lastError = `metadata has no connection "${CONFIG.connection}"`; return broadcastStatus(); }
  tags.clear(); byName.clear();
  for (const point of connection.dataPoints || []) {
    for (const def of point.dataPointDefinitions || []) {
      const tag = { id: String(def.id), name: def.name, dataType: def.dataType, access: def.accessMode || "r", chunk: point.name, pubTopic: point.pubTopic || "" };
      tags.set(tag.id, tag); byName.set(tag.name, tag);
    }
  }
  status.metadata = true; status.hashVersion = payload.hashVersion ?? null; status.lastError = "";
  log(`metadata: ${tags.size} tags in ${connection.dataPoints.length} data points`);
  broadcast("meta", catalog());
  for (const [chunk, data] of raw) onData(chunk, data);
  raw.clear();
  broadcastStatus();
}
function onData(chunk, payload) {
  status.lastDataMs = Date.now();
  if (!status.metadata) { raw.set(chunk, payload); return; }
  const changed = {};
  let ts = "";
  for (const v of payload.vals || []) {
    const tag = tags.get(String(v.id));
    if (!tag) continue;
    if (values[tag.name] !== v.val) { values[tag.name] = v.val; changed[tag.name] = v.val; }
    if (v.ts > ts) ts = v.ts;
  }
  broadcast("data", { chunk, ts, values: changed });
}
const catalog = () => [...tags.values()].map(({ name, dataType, access, chunk }) => ({ name, dataType, access, chunk }));

const client = mqtt.connect(CONFIG.databusUrl, {
  username: CONFIG.databusUser, password: CONFIG.databusPassword,
  clientId: `${CONFIG.connector}-hmi-${Math.random().toString(16).slice(2, 10)}`,
  reconnectPeriod: 3000, connectTimeout: 10000, clean: true,
});
client.on("connect", () => {
  status.connected = true; status.lastError = "";
  log(`databus connected: ${CONFIG.databusUrl}`);
  client.subscribe([TOPICS.metadata, TOPICS.data], { qos: 0 }, (error) => { if (error) { status.lastError = `subscribe failed: ${error.message}`; log(status.lastError); } });
  broadcastStatus();
});
client.on("close", () => { if (status.connected) log("databus disconnected"); status.connected = false; broadcastStatus(); });
client.on("error", (error) => { status.lastError = error.message; log(`databus error: ${error.message}`); broadcastStatus(); });
client.on("message", (topic, buffer) => {
  let payload;
  try { payload = JSON.parse(buffer.toString("utf8")); } catch { return; }
  if (topic === TOPICS.metadata) onMetadata(payload);
  else onData(topic.slice(topic.lastIndexOf("/") + 1), payload);
});

// ---- writes --------------------------------------------------------------------------------
const INTEGER = new Set(["Int", "DInt", "UInt", "UDInt", "SInt", "USInt", "LInt", "ULInt", "Word", "DWord", "Byte"]);
function check(tag, value) {
  if (tag.dataType === "Bool") return typeof value === "boolean" ? "" : "expects true or false";
  if (tag.dataType === "String") return typeof value === "string" && value.length <= 254 ? "" : "expects a string of up to 254 characters";
  if (typeof value !== "number" || !Number.isFinite(value)) return "expects a number";
  if (INTEGER.has(tag.dataType) && !Number.isInteger(value)) return "expects an integer";
  return "";
}
function write(requested) {
  if (!CONFIG.writesEnabled) return { status: 403, body: { error: "writes are disabled on this HMI (WRITES_ENABLED=false)" } };
  if (!status.connected) return { status: 503, body: { error: "not connected to the databus" } };
  if (!status.metadata) return { status: 503, body: { error: `no metadata yet on ${TOPICS.metadata}` } };
  const refused = [], byTopic = new Map();
  for (const [name, value] of Object.entries(requested)) {
    const tag = byName.get(name);
    if (!tag) { refused.push(`${name}: unknown tag`); continue; }
    if (tag.access !== "rw" || !tag.pubTopic) { refused.push(`${name}: read-only`); continue; }
    const problem = check(tag, value);
    if (problem) { refused.push(`${name}: ${problem}`); continue; }
    if (!byTopic.has(tag.pubTopic)) byTopic.set(tag.pubTopic, []);
    byTopic.get(tag.pubTopic).push({ id: tag.id, val: value });
  }
  for (const [topic, vals] of byTopic) {
    writeSeq = writeSeq >= 4294967295 ? 1 : writeSeq + 1;
    client.publish(topic, JSON.stringify({ seq: writeSeq, vals }), { qos: 1 });
  }
  const written = [...byTopic.values()].reduce((n, vals) => n + vals.length, 0);
  if (written) log(`write: ${Object.keys(requested).filter((name) => !refused.some((r) => r.startsWith(name + ":"))).join(", ")}`);
  return { status: refused.length && !written ? 400 : 202, body: { written, refused } };
}

// ---- browsers ------------------------------------------------------------------------------
const clients = new Set();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function broadcast(event, data) { const text = frame(event, data); for (const res of clients) res.write(text); }
const statusBody = () => ({ ...status, connector: CONFIG.connector, connection: CONFIG.connection, broker: CONFIG.databusUrl, topics: TOPICS, writesEnabled: CONFIG.writesEnabled, tags: tags.size });
let statusKey = "";
function broadcastStatus() { const body = statusBody(), key = JSON.stringify({ ...body, lastDataMs: 0 }); if (key !== statusKey) { statusKey = key; broadcast("status", body); } }
setInterval(() => { for (const res of clients) res.write(frame("status", statusBody())); }, 5000).unref();

const page = (() => {
  try { const html = readFileSync(join(CONFIG.publicDir, "index.html")); return { html, gz: gzipSync(html) }; } catch (error) { log(`no page at ${CONFIG.publicDir}/index.html: ${error.message}`); return null; }
})();
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" };
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY }); res.end(JSON.stringify(body)); };

// Routes match on the path's end, so the app works behind the IE reverse proxy whether or not it strips its prefix.
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://hmi").pathname;
  if (path.endsWith("/favicon.ico")) { res.writeHead(204); return res.end(); }
  if (path.endsWith("/healthz")) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("ok\n"); }
  if (path.endsWith("/api/status") && req.method === "GET") return json(res, 200, statusBody());
  if (path.endsWith("/api/events") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY });
    res.write("retry: 3000\n\n");
    res.write(frame("status", statusBody()));
    if (status.metadata) { res.write(frame("meta", catalog())); res.write(frame("data", { chunk: "*", ts: "", values })); }
    clients.add(res);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15000);
    req.on("close", () => { clearInterval(beat); clients.delete(res); });
    return;
  }
  if (path.endsWith("/api/write")) {
    if (req.method !== "POST") return json(res, 405, { error: "use POST" });
    let body = "", size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size > 16384) { json(res, 413, { error: "body too large" }); req.destroy(); } else body += chunk; });
    req.on("end", () => {
      if (res.headersSent) return;
      let requested;
      try { requested = JSON.parse(body).values; } catch { return json(res, 400, { error: "expected JSON {\"values\": {\"<tag name>\": <value>}}" }); }
      if (!requested || typeof requested !== "object" || Array.isArray(requested)) return json(res, 400, { error: "expected JSON {\"values\": {\"<tag name>\": <value>}}" });
      const result = write(requested);
      json(res, result.status, result.body);
    });
    return;
  }
  if (req.method === "GET" && (path.endsWith("/") || path.endsWith("/index.html"))) {
    if (!page) { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("HMI page missing: run node build.mjs\n"); }
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", Vary: "Accept-Encoding", ...(gz ? { "Content-Encoding": "gzip" } : {}), ...SECURITY });
    return res.end(gz ? page.gz : page.html);
  }
  // /prefix without its trailing slash: send the browser to /prefix/ so relative api/ URLs resolve under the prefix
  const segment = path.slice(path.lastIndexOf("/") + 1);
  if (req.method === "GET" && segment && !segment.includes(".") && !path.includes("/api/")) { res.writeHead(302, { Location: `${segment}/` }); return res.end(); }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found\n");
});
server.listen(CONFIG.port, () => log(`HMI on :${CONFIG.port} · connector ${CONFIG.connector} · connection ${CONFIG.connection} · databus ${CONFIG.databusUrl}`));

const stop = () => { log("shutting down"); for (const res of clients) res.end(); server.close(); client.end(true, () => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
