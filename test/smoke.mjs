// node test/smoke.mjs : boots the server on a throwaway data folder and exercises the API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "week_kitchen");
let pass = 0, fail = 0;
// check() takes a BOOLEAN. Passing a function is a bug (it is always truthy), so refuse it.
function check(label, cond) {
  if (typeof cond === "function") throw new Error("check() given a function: " + label);
  if (cond) pass++; else { fail++; console.error("FAIL", label); }
}

const page = fs.readFileSync(path.join(APP, "www/index.html"), "utf8");
check("page wires the file API", page.includes("DB=KitchenDB();"));
check("page no longer asks for window.claude", !page.includes("window.claude"));
check("page fetches relative URLs (ingress prefix)", !/fetch\("\//.test(page));
// Backticks in raw <style> text would end the surrounding template literals in the script.
check("no backtick in style blocks", [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].every(m => !m[1].includes("`")));
check("week save sends the week's own base revision", page.includes('"x-base-week":WEEKREV'));
check("shopping list no longer kept in localStorage", !page.includes("store.get(shopKey") && page.includes('fetch("api/shop"'));
check("timers are server-held", page.includes('timerCall("POST","api/timers"') && !/let timers=\[\]/.test(page));
check("wake lock is not behind a toggle", !page.includes("wantWake") && page.includes("releaseWake()"));
check("a pull applies the week before the recipes (else a refused plan rebuilds from itself)", page.indexOf("subs.week.forEach(s=>s[0](snapW(st)))") >= 0 && page.indexOf("subs.week.forEach(s=>s[0](snapW(st)))") < page.indexOf("subs.recipes.forEach(s=>s[0](snapR(st)))"));
check("oven hints name no particular food (they show on every recipe)", !/hint:"[^"]*(tots|sausage|eggs)/.test(page));
check("a step's own hint wins over the heat level's", page.includes("s.hint||(h?h.hint"));
check("recipe page can mark a recipe made", page.includes("madeBtn(r.id)") && page.includes("data-made"));
// The shopping-list parser, run for real on lines like the ones that went wrong.
{ const a = page.indexOf("const FR="), b = page.indexOf("\nlet SHOPDOC");
  const P = new Function(page.slice(a, b) + "\nreturn {buildList,sectionOf,parseIng};")();
  const LIBT = { m: { short: "M", ing: ["½ red bell pepper, diced", "1 cup full-fat oat milk", "4 large eggs", "Black pepper"] },
                 n: { short: "N", ing: ["⅓ cup plain oat milk", "1 large egg", "Pepper", "1 can (28 oz) diced tomatoes"] } };
  const L = new Function("LIB", page.slice(a, b) + "\nreturn buildList;")(LIBT)(["m", "n"]);
  const by = n => L.find(i => i.name.toLowerCase() === n.toLowerCase());
  check("red bell pepper is produce, not pantry", by("red bell pepper") && by("red bell pepper").sec === "Produce");
  check("plain pepper is still pantry", by("pepper") && by("pepper").sec === "Check the pantry");
  check("black pepper is still pantry", by("black pepper") && by("black pepper").sec === "Check the pantry");
  check("full-fat and plain oat milk merge into one line", L.filter(i => /oat milk/i.test(i.name)).length === 1 && by("oat milk") != null);
  check("5 eggs read as plural", by("large eggs") && by("large eggs").amt[""] === 5);
  void P; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wk-"));
fs.mkdirSync(path.join(dir, "recipes"));
const recipe = { name: "Test Soup", short: "Soup", serves: 2, time: "10 min", gear: "Pot", ing: ["1 cup water"], steps: [{ h: "Boil", x: "Boil it.", heat: "H" }] };
fs.writeFileSync(path.join(dir, "recipes/soup.json"), JSON.stringify(recipe));
fs.writeFileSync(path.join(dir, "recipes/broken.json"), "{ not json");
fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ title: "Test", kid: "Kiddo" }));

const PORT = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [path.join(APP, "server.mjs")], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), INGRESS_ONLY: "0" }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise(ok => srv.stdout.once("data", ok));
const u = p => `http://127.0.0.1:${PORT}${p}`;
const J = async (p, o) => { const r = await fetch(u(p), o); return { status: r.status, body: await r.json() }; };
const send = (method, p, data, rev) => J(p, { method, headers: { "content-type": "application/json", "x-base-rev": rev || "" }, body: JSON.stringify(data) });

try {
  const html = await fetch(u("/"));
  check("page served", html.status === 200 && (await html.text()).includes("KitchenDB"));

  let s = (await J("/api/state")).body;
  check("state ok", s.ok === true);
  check("recipe loaded with id from filename", s.recipes.soup && s.recipes.soup.id === "soup" && s.recipes.soup.name === "Test Soup");
  check("broken file reported, not fatal", s.bad.includes("broken.json") && !s.recipes.broken);
  check("settings delivered", s.settings.kid === "Kiddo");
  check("no week yet reads null, not empty", s.week === null);

  const rev0 = s.rev;
  let r = await send("PATCH", "/api/recipes/soup", { loved: true }, rev0);
  check("love saved", r.status === 200);
  check("love persisted to file, rest kept", (() => { const d = JSON.parse(fs.readFileSync(path.join(dir, "recipes/soup.json"))); return d.loved === true && d.name === "Test Soup"; })());
  check("revision moved", r.body.rev !== rev0);

  r = await send("PATCH", "/api/recipes/soup", { name: "Hacked" }, r.body.rev);
  check("page cannot rewrite recipe content", r.status === 400);
  r = await send("PATCH", "/api/recipes/..%2Fsettings", { loved: true });
  check("path traversal refused", r.status === 400);
  r = await send("PATCH", "/api/recipes/nope", { loved: true });
  check("unknown recipe 404", r.status === 404);

  // ---- week: a stale write is REFUSED, never silently overwrites ----
  s = (await J("/api/state")).body;
  const W1 = { label: "W", start: "2026-01-04", nights: [{ recipe: "soup", day: "Sun", date: "Jan 4", iso: "2026-01-04" }] };
  const putWeek = (doc, base) => J("/api/week", { method: "PUT", headers: { "content-type": "application/json", ...(base != null ? { "x-base-week": base } : {}) }, body: JSON.stringify(doc) });
  check("no week yet has a revision of its own", s.weekRev === "-");
  r = await putWeek(W1, s.weekRev);
  check("first week saved", r.status === 200 && typeof r.body.weekRev === "string" && r.body.weekRev !== "-");
  const wr1 = r.body.weekRev;
  r = await putWeek({ ...W1, label: "W2" }, wr1);
  check("a save built on the current week lands", r.status === 200);
  const wr2 = r.body.weekRev;
  // ...the other phone (or Claude) still holds wr1:
  r = await putWeek({ ...W1, label: "OTHER" }, wr1);
  check("a save built on an older week is refused 409", r.status === 409 && r.body.weekRev === wr2);
  check("the refused save did not touch the file", JSON.parse(fs.readFileSync(path.join(dir, "week.json"))).label === "W2");
  r = await putWeek(W1);
  check("a save with no base revision is refused", r.status === 409);
  await new Promise(ok => setTimeout(ok, 20));
  fs.writeFileSync(path.join(dir, "week.json"), JSON.stringify({ ...W1, label: "hand-edited" }));
  r = await putWeek(W1, wr2);
  check("a hand edit to week.json makes the page's base stale", r.status === 409);
  r = await putWeek({ nope: 1 }, "-");
  check("malformed week refused", r.status === 400);
  const recipeOnly = (await J("/api/state")).body;
  await new Promise(ok => setTimeout(ok, 20));
  fs.writeFileSync(path.join(dir, "recipes/soup.json"), JSON.stringify({ ...recipe, time: "12 min" }));
  r = await putWeek(W1, recipeOnly.weekRev);
  check("a recipe edit does NOT make a week save stale (only the week counts)", r.status === 200);

  // ---- lastCooked from the page, and undo ----
  r = await send("PATCH", "/api/recipes/soup", { lastCooked: "2026-01-05" });
  check("made-it date saved", r.status === 200 && JSON.parse(fs.readFileSync(path.join(dir, "recipes/soup.json"))).lastCooked === "2026-01-05");
  r = await send("PATCH", "/api/recipes/soup", { lastCooked: null });
  check("undo to never-cooked removes the field", r.status === 200 && !("lastCooked" in JSON.parse(fs.readFileSync(path.join(dir, "recipes/soup.json")))));
  r = await send("PATCH", "/api/recipes/soup", { lastCooked: "yesterday" });
  check("a non-date lastCooked is refused", r.status === 400);

  // ---- shopping list: shared, applied as operations so concurrent taps both land ----
  const op = o => J("/api/shop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
  await Promise.all(["a", "b", "c", "d", "e"].map(k => op({ week: "2026-01-04", op: "check", key: k, on: true })));
  let sh = JSON.parse(fs.readFileSync(path.join(dir, "shop.json")));
  check("five simultaneous ticks all land", sh.checks.length === 5 && sh.week === "2026-01-04");
  r = await op({ week: "2026-01-04", op: "check", key: "c", on: false });
  check("untick removes only that item", r.body.shop.checks.length === 4 && !r.body.shop.checks.includes("c"));
  r = await op({ week: "2026-01-04", op: "pick", key: "any:soup", on: false });
  check("meal skip recorded", r.body.shop.pick["any:soup"] === false && r.body.shop.checks.length === 4);
  r = await op({ week: "2026-01-11", op: "check", key: "z", on: true });
  check("a new week starts a fresh list", r.body.shop.checks.join() === "z" && !("any:soup" in r.body.shop.pick));
  r = await op({ week: "2026-01-11", op: "clear" });
  check("uncheck all", r.body.shop.checks.length === 0);
  r = await op({ week: "2026-01-11", op: "explode" });
  check("unknown shop op refused", r.status === 400);
  check("state carries the shared list", (await J("/api/state")).body.shop.week === "2026-01-11");

  const srv2 = spawn(process.execPath, [path.join(APP, "server.mjs")], { env: { ...process.env, DATA_DIR: dir + "-missing", PORT: String(PORT + 1), INGRESS_ONLY: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise(ok => srv2.stdout.once("data", ok));
  const m = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/state`)).json();
  check("missing data folder is an error, not an empty box", m.ok === false && m.error === "data_dir_missing");
  srv2.kill();

  // ---- timers: server-held, pushed through HA to whoever started them ----
  const calls = [];
  const fake = http.createServer((q, res) => { let b = ""; q.on("data", c => b += c); q.on("end", () => { calls.push({ path: q.url, auth: q.headers.authorization, body: JSON.parse(b || "{}") }); res.end("[]"); }); });
  await new Promise(ok => fake.listen(0, ok));
  const today = (() => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
  fs.writeFileSync(path.join(dir, "week.json"), JSON.stringify({ label: "T", start: today, nights: [{ recipe: "soup", day: "X", date: "X", iso: today }] }));
  const P4 = PORT + 3, u4 = p => `http://127.0.0.1:${P4}${p}`;
  const boot4 = () => { const p = spawn(process.execPath, [path.join(APP, "server.mjs")], { env: { ...process.env, DATA_DIR: dir, PORT: String(P4), INGRESS_ONLY: "0",
      HA_API: `http://127.0.0.1:${fake.address().port}`, HA_TOKEN: "tok", TIMER_NOTIFY: "alice=notify.mobile_app_a,mobile_app_all,bob=mobile_app_b,bad service" }, stdio: ["ignore", "pipe", "inherit"] });
    return new Promise(ok => p.stdout.once("data", () => ok(p))); };
  let srv4 = await boot4();
  const T = async (method, p, data, hdr) => { const r = await fetch(u4(p), { method, headers: { "content-type": "application/json", ...(hdr || {}) }, body: data ? JSON.stringify(data) : undefined }); return { status: r.status, body: await r.json() }; };
  r = await T("POST", "/api/timers", { label: "Soup: Simmer", sec: 1, key: "soup:3" }, { "x-remote-user-name": "Alice" });
  check("timer created with an end on the server clock", r.status === 200 && r.body.timer.end > Date.now() && r.body.timer.key === "soup:3");
  const tid = r.body.timer.id;
  check("bad timer refused", (await T("POST", "/api/timers", { label: "x", sec: -5 })).status === 400);
  check("state says push is configured", (await T("GET", "/api/state")).body.push === true);
  await new Promise(ok => setTimeout(ok, 3600));
  const pushes = calls.filter(c => c.path.startsWith("/services/notify/") && c.body.message !== "clear_notification");
  const to = pushes.map(c => c.path.split("/").pop()).sort().join();
  check("timer pushed to its starter and to the everyone-target, not to bob", to === "mobile_app_a,mobile_app_all");
  check("push is time-sensitive and tagged", pushes.every(c => c.auth === "Bearer tok" && c.body.data.push["interruption-level"] === "time-sensitive" && c.body.data.tag === "wk-" + tid));
  check("push fires once, not every tick", pushes.length === 2);
  const sensor = calls.find(c => c.path === "/states/sensor.week_kitchen_tonight");
  check("tonight sensor posted with tonight's recipe", !!sensor && sensor.body.state === "Test Soup" && sensor.body.attributes.recipe === "soup");
  let st4 = (await T("GET", "/api/state")).body;
  check("rung timer reported as rung", st4.timers.length === 1 && st4.timers[0].rung > 0);
  srv4.kill(); srv4 = await boot4();
  st4 = (await T("GET", "/api/state")).body;
  check("timers survive a restart", st4.timers.length === 1 && st4.timers[0].id === tid);
  r = await T("POST", "/api/timers/" + tid, { add: 60 });
  check("+1 min re-arms a rung timer", r.status === 200 && r.body.timers[0].rung === 0 && r.body.timers[0].end > Date.now() + 50e3);
  r = await T("DELETE", "/api/timers/" + tid);
  check("timer dismissed", r.status === 200 && r.body.timers.length === 0);
  check("dismissing unknown timer is 404", (await T("DELETE", "/api/timers/0123456789")).status === 404);
  check("rung push cleared from the lock screen", calls.some(c => c.body.message === "clear_notification" && c.body.data.tag === "wk-" + tid));
  srv4.kill(); fake.close();

  const srv3 = spawn(process.execPath, [path.join(APP, "server.mjs")], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT + 2) }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise(ok => srv3.stdout.once("data", ok));
  check("non-ingress caller refused by default", (await fetch(`http://127.0.0.1:${PORT + 2}/api/state`)).status === 403);
  srv3.kill();
} finally {
  srv.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
