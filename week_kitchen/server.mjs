// Week Kitchen server: serves the page and a tiny JSON-file API over a data folder.
// No dependencies. Everything personal lives in DATA_DIR, never in this repo:
//   DATA_DIR/settings.json      { title, accent, tagline, kid, scoop }
//   DATA_DIR/week.json          the current week plan
//   DATA_DIR/recipes/<id>.json  one recipe per file
import http from "node:http";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function options() {
  try { return JSON.parse(readFileSync("/data/options.json", "utf8")); } catch { return {}; }
}
const OPT = options();
const DATA_DIR = process.env.DATA_DIR || OPT.data_dir || "/share/recipes";
const PORT = +(process.env.PORT || 8099);
// Ingress traffic always arrives from the Supervisor's proxy. Anything else is refused,
// so the app has no open port and no login of its own: HA's login is the login.
const INGRESS_ONLY = process.env.INGRESS_ONLY !== "0";
const INGRESS_IP = "172.30.32.2";
const RECIPES = path.join(DATA_DIR, "recipes");
const WEEK = path.join(DATA_DIR, "week.json");
const SETTINGS = path.join(DATA_DIR, "settings.json");
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY = 256 * 1024;

const PAGE = readFileSync(path.join(HERE, "www", "index.html"));

async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
// Write to a temp file beside the target, then rename: a reader never sees half a file.
async function writeJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await fs.rename(tmp, file);
}

// The revision is a fingerprint of every file's mtime+size. SMB mounts do not deliver
// inotify events for changes made by another machine, so the client polls this instead.
async function revision() {
  const parts = [];
  for (const f of [WEEK, SETTINGS]) {
    try { const s = await fs.stat(f); parts.push(f + s.mtimeMs + ":" + s.size); } catch { parts.push(f + "-"); }
  }
  try {
    for (const n of (await fs.readdir(RECIPES)).sort()) {
      if (!n.endsWith(".json")) continue;
      const s = await fs.stat(path.join(RECIPES, n)); parts.push(n + s.mtimeMs + ":" + s.size);
    }
  } catch { parts.push("recipes-"); }
  let h = 2166136261;
  for (const ch of parts.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

async function state() {
  if (!existsSync(DATA_DIR)) return { ok: false, error: "data_dir_missing", dataDir: DATA_DIR };
  const recipes = {}, bad = [];
  let names = [];
  try { names = await fs.readdir(RECIPES); } catch {}
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -5);
    if (!ID.test(id)) continue;
    try { recipes[id] = { ...(await readJSON(path.join(RECIPES, n))), id }; }
    catch { bad.push(n); }   // a half-edited file must not take the whole box down
  }
  return { ok: true, rev: await revision(), recipes, week: await readJSON(WEEK),
           settings: (await readJSON(SETTINGS).catch(() => null)) || {}, bad };
}

function send(res, code, body, type = "application/json") {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "content-length": buf.length });
  res.end(buf);
}
function body(req) {
  return new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY) { fail(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { ok(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { fail(new Error("bad_json")); } });
    req.on("error", fail);
  });
}
// The page sends the revision its view was built from. If the files moved since (Claude
// edited a recipe, another phone saved the plan), the reply says so and the page re-pulls
// instead of adopting the post-write revision and masking the other change.
async function isStale(req) {
  const base = req.headers["x-base-rev"];
  return !base || base !== await revision();
}
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

// Only these recipe fields may be changed from the page. Recipes themselves are
// authored as files; the page only records what happened in the kitchen.
const PAGE_FIELDS = new Set(["loved", "lastCooked"]);

async function handle(req, res) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (INGRESS_ONLY && ip !== INGRESS_IP) return send(res, 403, { error: "ingress_only" });
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && p === "/api/rev") return send(res, 200, { rev: existsSync(DATA_DIR) ? await revision() : null });
  if (req.method === "GET" && p === "/api/state") return send(res, 200, await state());

  if (req.method === "PUT" && p === "/api/week") {
    const doc = await body(req);
    if (!isObj(doc) || !Array.isArray(doc.nights)) return send(res, 400, { error: "bad_week" });
    if (!existsSync(DATA_DIR)) return send(res, 503, { error: "data_dir_missing" });
    const stale = await isStale(req);
    await writeJSON(WEEK, doc);
    return send(res, 200, { ok: true, stale, rev: await revision() });
  }

  const m = p.match(/^\/api\/recipes\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return send(res, 400, { error: "bad_id" });
    const patch = await body(req);
    if (!isObj(patch) || !Object.keys(patch).length || Object.keys(patch).some(k => !PAGE_FIELDS.has(k)))
      return send(res, 400, { error: "fields_not_allowed", allowed: [...PAGE_FIELDS] });
    const file = path.join(RECIPES, id + ".json");
    const cur = await readJSON(file);
    if (!cur) return send(res, 404, { error: "no_such_recipe" });
    const stale = await isStale(req);
    await writeJSON(file, { ...cur, ...patch });
    return send(res, 200, { ok: true, stale, rev: await revision() });
  }
  send(res, 404, { error: "not_found" });
}

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(new Date().toISOString(), req.method, req.url, e.message);
    if (!res.headersSent) send(res, e.message === "too_large" ? 413 : e.message === "bad_json" ? 400 : 500, { error: e.message });
  });
}).listen(PORT, () => console.log(`Week Kitchen on :${PORT}, data in ${DATA_DIR}${existsSync(DATA_DIR) ? "" : " (NOT FOUND - is the network share mounted?)"}`));
