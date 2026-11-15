// node test/smoke.mjs : boots the server on a throwaway data folder and exercises the API.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  check("love saved", r.status === 200 && r.body.stale === false);
  check("love persisted to file, rest kept", (() => { const d = JSON.parse(fs.readFileSync(path.join(dir, "recipes/soup.json"))); return d.loved === true && d.name === "Test Soup"; })());
  check("revision moved", r.body.rev !== rev0);

  r = await send("PATCH", "/api/recipes/soup", { name: "Hacked" }, r.body.rev);
  check("page cannot rewrite recipe content", r.status === 400);
  r = await send("PATCH", "/api/recipes/..%2Fsettings", { loved: true });
  check("path traversal refused", r.status === 400);
  r = await send("PATCH", "/api/recipes/nope", { loved: true });
  check("unknown recipe 404", r.status === 404);

  const cur = (await J("/api/rev")).body.rev;
  // Someone edits a file behind the page's back...
  await new Promise(ok => setTimeout(ok, 20));
  fs.writeFileSync(path.join(dir, "recipes/soup.json"), JSON.stringify({ ...recipe, loved: true, time: "12 min" }));
  r = await send("PUT", "/api/week", { label: "W", start: "2026-01-04", nights: [{ recipe: "soup", day: "Sun", date: "Jan 4", iso: "2026-01-04" }] }, cur);
  check("week saved", r.status === 200);
  check("write after an outside edit is flagged stale", r.body.stale === true);
  check("week persisted", JSON.parse(fs.readFileSync(path.join(dir, "week.json"))).nights[0].recipe === "soup");
  r = await send("PUT", "/api/week", { nope: 1 });
  check("malformed week refused", r.status === 400);

  const srv2 = spawn(process.execPath, [path.join(APP, "server.mjs")], { env: { ...process.env, DATA_DIR: dir + "-missing", PORT: String(PORT + 1), INGRESS_ONLY: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise(ok => srv2.stdout.once("data", ok));
  const m = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/state`)).json();
  check("missing data folder is an error, not an empty box", m.ok === false && m.error === "data_dir_missing");
  srv2.kill();

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
