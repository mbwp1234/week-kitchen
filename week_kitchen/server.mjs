// Week Kitchen server: serves the page and a tiny JSON-file API over a data folder.
// No dependencies. Everything personal lives in DATA_DIR, never in this repo:
//   DATA_DIR/settings.json      { title, accent, tagline, kid, scoop }
//   DATA_DIR/week.json          the current week plan
//   DATA_DIR/shop.json          the shared shopping list state for that week
//   DATA_DIR/timers.json        running kitchen timers (so they outlive a reload)
//   DATA_DIR/recipes/<id>.json  one recipe per file
import http from "node:http";
import fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const SHOP = path.join(DATA_DIR, "shop.json");
const TIMERS = path.join(DATA_DIR, "timers.json");
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_BODY = 256 * 1024;

// Home Assistant API (homeassistant_api: true gives the app SUPERVISOR_TOKEN). Optional:
// without it timers still ring on the page, there is just no push and no sensor.
// The base image's s6 /init can start CMD without the container environment, so the token
// is also read from where s6 keeps it.
function supervisorToken() {
  if (process.env.SUPERVISOR_TOKEN) return process.env.SUPERVISOR_TOKEN;
  try { return readFileSync("/run/s6/container_environment/SUPERVISOR_TOKEN", "utf8").trim(); } catch { return ""; }
}
const SUP_TOKEN = process.env.HA_API ? "" : supervisorToken();
const HA_API = process.env.HA_API || (SUP_TOKEN ? "http://supervisor/core/api" : "");
const HA_TOKEN = process.env.HA_TOKEN || SUP_TOKEN;
// timer_notify entries: "notify_service" (always) or "who=notify_service" (only timers that
// person started; who is matched against the HA user's login name, display name or id).
const TIMER_NOTIFY = (process.env.TIMER_NOTIFY ? process.env.TIMER_NOTIFY.split(",") : OPT.timer_notify || [])
  .map(s => String(s).trim()).filter(Boolean)
  .map(s => { const i = s.indexOf("="); return i < 0 ? { who: null, svc: s } : { who: s.slice(0, i).trim().toLowerCase(), svc: s.slice(i + 1).trim() }; })
  .map(e => ({ ...e, svc: e.svc.replace(/^notify\./, "") }))
  .filter(e => /^[a-z0-9_]+$/.test(e.svc));
const TONIGHT_SENSOR = OPT.tonight_sensor === false || process.env.TONIGHT_SENSOR === "0" ? null : "sensor.week_kitchen_tonight";

const PAGE = readFileSync(path.join(HERE, "www", "index.html"));

async function readJSON(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
// Write to a temp file beside the target, then rename: a reader never sees half a file.
async function writeJSON(file, obj) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + "\n");
  await fs.rename(tmp, file);
}
// One writer at a time. Two phones ticking the list in the same second must both land.
let chain = Promise.resolve();
const serial = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

async function tag(f) { try { const s = await fs.stat(f); return s.mtimeMs + ":" + s.size; } catch { return "-"; } }

// The revision is a fingerprint of every file's mtime+size. SMB mounts do not deliver
// inotify events for changes made by another machine, so the client polls this instead.
async function revision() {
  const parts = [];
  for (const f of [WEEK, SETTINGS, SHOP, TIMERS]) parts.push(f + (await tag(f)));
  try {
    for (const n of (await fs.readdir(RECIPES)).sort()) {
      if (!n.endsWith(".json")) continue;
      parts.push(n + (await tag(path.join(RECIPES, n))));
    }
  } catch { parts.push("recipes-"); }
  let h = 2166136261;
  for (const ch of parts.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

async function loadRecipes() {
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
  return { recipes, bad };
}

async function state() {
  if (!existsSync(DATA_DIR)) return { ok: false, error: "data_dir_missing", dataDir: DATA_DIR };
  const { recipes, bad } = await loadRecipes();
  return { ok: true, rev: await revision(), weekRev: await tag(WEEK), now: Date.now(), recipes,
           week: await readJSON(WEEK), shop: await readJSON(SHOP).catch(() => null),
           timers: timers.list, push: TIMER_NOTIFY.length > 0 && !!HA_API,
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
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Only these recipe fields may be changed from the page. Recipes themselves are
// authored as files; the page only records what happened in the kitchen.
const PAGE_FIELDS = new Set(["loved", "lastCooked"]);

/* ---------- shopping list: shared by everyone, applied as operations ----------
   Each tap is sent as one small operation and applied to the current file, so two people
   ticking items at once both land; nothing is a whole-list overwrite. The file belongs to
   one week (week = the plan's start date); a tap for a different week starts it fresh. */
async function shopOp(op) {
  if (!isObj(op) || typeof op.week !== "string" || op.week.length > 20) throw Object.assign(new Error("bad_shop"), { code: 400 });
  return serial(async () => {
    let s = await readJSON(SHOP).catch(() => null);
    if (!isObj(s) || s.week !== op.week) s = { week: op.week, pick: {}, checks: [] };
    if (!isObj(s.pick)) s.pick = {};
    const checks = new Set(Array.isArray(s.checks) ? s.checks : []);
    const key = typeof op.key === "string" ? op.key.slice(0, 120) : null;
    if (op.op === "check" && key) op.on ? checks.add(key) : checks.delete(key);
    else if (op.op === "pick" && key) s.pick[key] = !!op.on;
    else if (op.op === "clear") checks.clear();
    else throw Object.assign(new Error("bad_shop"), { code: 400 });
    s.checks = [...checks];
    s.updated = new Date().toISOString();
    await writeJSON(SHOP, s);
    return s;
  });
}

/* ---------- timers: held by the server so they outlive a reload or a locked phone ---------- */
const timers = { list: [] };
async function loadTimers() {
  const t = await readJSON(TIMERS).catch(() => null);
  timers.list = isObj(t) && Array.isArray(t.list) ? t.list.filter(x => isObj(x) && x.id && Number.isFinite(x.end)) : [];
}
const saveTimers = () => writeJSON(TIMERS, { list: timers.list });
function who(req) {
  const h = k => { const v = req.headers[k]; return v ? String(v) : ""; };
  return { id: h("x-remote-user-id"), name: h("x-remote-user-name"), display: h("x-remote-user-display-name") };
}
async function ha(method, p, data) {
  if (!HA_API) return null;
  const r = await fetch(HA_API + p, { method, headers: { authorization: "Bearer " + HA_TOKEN, "content-type": "application/json" },
                                      body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HA ${method} ${p} -> ${r.status}`);
  return r;
}
function targetsFor(t) {
  const names = [t.by && t.by.id, t.by && t.by.name, t.by && t.by.display].filter(Boolean).map(s => s.toLowerCase());
  return [...new Set(TIMER_NOTIFY.filter(e => !e.who || names.includes(e.who)).map(e => e.svc))];
}
async function notifyTimer(t, clear) {
  for (const svc of targetsFor(t)) {
    const data = clear ? { message: "clear_notification", data: { tag: "wk-" + t.id } }
      : { title: "⏰ Timer done", message: t.label,
          data: { tag: "wk-" + t.id, push: { "interruption-level": "time-sensitive", sound: "default" }, ttl: 0, priority: "high" } };
    try { await ha("POST", "/services/notify/" + svc, data); }
    catch (e) { console.error(new Date().toISOString(), "notify", svc, e.message); }
  }
}
async function tick() {
  const now = Date.now(); let dirty = false;
  for (const t of timers.list) if (!t.rung && now >= t.end) { t.rung = now; dirty = true; notifyTimer(t, false); }
  const keep = timers.list.filter(t => !t.rung || now - t.rung < 3600e3);   // a forgotten ringing timer clears itself after an hour
  if (keep.length !== timers.list.length) { timers.list = keep; dirty = true; }
  if (dirty) await serial(saveTimers).catch(e => console.error("timers", e.message));
}

/* ---------- sensor.week_kitchen_tonight: tonight's dinner for dashboards and briefs ---------- */
function todayISO() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
let lastSensor = "", lastSensorAt = 0;
async function pushTonight() {
  if (!HA_API || !TONIGHT_SENSOR || !existsSync(DATA_DIR)) return;
  try {
    const week = await readJSON(WEEK).catch(() => null), today = todayISO();
    const night = week && Array.isArray(week.nights) ? week.nights.find(n => n.iso === today) : null;
    const r = night && ID.test(night.recipe) ? await readJSON(path.join(RECIPES, night.recipe + ".json")).catch(() => null) : null;
    const body = { state: r ? String(r.name || night.recipe).slice(0, 250) : "Nothing planned",
      attributes: { friendly_name: "Tonight's dinner", icon: "mdi:silverware-fork-knife", recipe: night ? night.recipe : null,
                    short: r ? r.short || null : null, time: r ? r.time || null : null, date: today,
                    week: week && week.label || null } };
    const sig = JSON.stringify(body);
    // Re-post every 10 minutes even if unchanged: HA forgets an API-set state on restart.
    if (sig === lastSensor && Date.now() - lastSensorAt < 600e3) return;
    await ha("POST", "/states/" + TONIGHT_SENSOR, body);
    lastSensor = sig; lastSensorAt = Date.now();
  } catch (e) { console.error(new Date().toISOString(), "sensor", e.message); }
}

async function handle(req, res) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if (INGRESS_ONLY && ip !== INGRESS_IP) return send(res, 403, { error: "ingress_only" });
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && p === "/api/rev") return send(res, 200, { rev: existsSync(DATA_DIR) ? await revision() : null, now: Date.now() });
  if (req.method === "GET" && p === "/api/state") return send(res, 200, await state());
  if (req.method !== "GET" && !existsSync(DATA_DIR)) return send(res, 503, { error: "data_dir_missing" });

  // The week is the one document two people can rewrite wholesale, so it is the one that
  // refuses a stale write: the page must send the week.json revision its plan was built
  // from, and if the file moved since (the other phone saved, Claude edited it) the save is
  // refused with 409 and the page reloads the plan instead of overwriting it.
  if (req.method === "PUT" && p === "/api/week") {
    const doc = await body(req);
    if (!isObj(doc) || !Array.isArray(doc.nights)) return send(res, 400, { error: "bad_week" });
    return serial(async () => {
      const cur = await tag(WEEK);
      if (req.headers["x-base-week"] !== cur) return send(res, 409, { error: "stale", weekRev: cur });
      await writeJSON(WEEK, doc);
      pushTonight();
      return send(res, 200, { ok: true, weekRev: await tag(WEEK), rev: await revision() });
    });
  }

  if (req.method === "POST" && p === "/api/shop") {
    const s = await shopOp(await body(req));
    return send(res, 200, { ok: true, shop: s, rev: await revision() });
  }

  if (req.method === "POST" && p === "/api/timers") {
    const b = await body(req);
    const sec = Math.round(+b.sec);
    if (!(sec > 0 && sec <= 24 * 3600) || typeof b.label !== "string") return send(res, 400, { error: "bad_timer" });
    const t = { id: crypto.randomBytes(5).toString("hex"), label: b.label.slice(0, 120), end: Date.now() + sec * 1000,
                key: typeof b.key === "string" ? b.key.slice(0, 120) : null, by: who(req), rung: 0 };
    await serial(async () => { timers.list.push(t); await saveTimers(); });
    return send(res, 200, { ok: true, timer: t, timers: timers.list, now: Date.now() });
  }
  const tm = p.match(/^\/api\/timers\/([a-f0-9]{10})$/);
  if (tm && (req.method === "POST" || req.method === "DELETE")) {
    const b = req.method === "POST" ? await body(req) : {};
    const t = timers.list.find(x => x.id === tm[1]);
    const wasRung = t && t.rung;
    if (!t) return send(res, 404, { error: "no_such_timer", timers: timers.list, now: Date.now() });
    await serial(async () => {
      if (req.method === "DELETE") timers.list = timers.list.filter(x => x !== t);
      else { const add = Math.round(+b.add); if (!(add > 0 && add <= 3600)) throw Object.assign(new Error("bad_timer"), { code: 400 });
             t.end = Math.max(t.end, Date.now()) + add * 1000; t.rung = 0; }
      await saveTimers();
    });
    if (wasRung) notifyTimer(t, true);   // take the push off the lock screen too
    return send(res, 200, { ok: true, timers: timers.list, now: Date.now() });
  }

  const m = p.match(/^\/api\/recipes\/([^/]+)$/);
  if (m && req.method === "PATCH") {
    const id = decodeURIComponent(m[1]);
    if (!ID.test(id)) return send(res, 400, { error: "bad_id" });
    const patch = await body(req);
    if (!isObj(patch) || !Object.keys(patch).length || Object.keys(patch).some(k => !PAGE_FIELDS.has(k)))
      return send(res, 400, { error: "fields_not_allowed", allowed: [...PAGE_FIELDS] });
    if ("lastCooked" in patch && patch.lastCooked !== null && !ISO.test(patch.lastCooked)) return send(res, 400, { error: "bad_date" });
    const file = path.join(RECIPES, id + ".json");
    // A field merge, so it is safe against a stale view: it only ever touches its own fields.
    const out = await serial(async () => {
      const cur = await readJSON(file);
      if (!cur) return null;
      const next = { ...cur, ...patch };
      if (next.lastCooked === null) delete next.lastCooked;
      await writeJSON(file, next);
      return next;
    });
    if (!out) return send(res, 404, { error: "no_such_recipe" });
    return send(res, 200, { ok: true, rev: await revision() });
  }
  send(res, 404, { error: "not_found" });
}

await loadTimers().catch(() => {});
setInterval(() => tick().catch(() => {}), 1000);
setInterval(pushTonight, 60e3); setTimeout(pushTonight, 3000);

http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(new Date().toISOString(), req.method, req.url, e.message);
    if (!res.headersSent) send(res, e.code === 400 ? 400 : e.message === "too_large" ? 413 : e.message === "bad_json" ? 400 : 500, { error: e.message });
  });
}).listen(PORT, () => console.log(`Week Kitchen on :${PORT}, data in ${DATA_DIR}${existsSync(DATA_DIR) ? "" : " (NOT FOUND - is the network share mounted?)"}`
  + `; push ${TIMER_NOTIFY.length && HA_API ? TIMER_NOTIFY.length + " target(s)" : "off"}; sensor ${HA_API && TONIGHT_SENSOR ? "on" : "off"}`));
