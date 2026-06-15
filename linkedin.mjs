#!/usr/bin/env node
// linkedin - prosty CLI do postowania na WLASNY profil LinkedIn.
// Zero zaleznosci. Node 18+ (global fetch). Tylko scope w_member_social.
// Endpoint i flow zweryfikowane z https://learn.microsoft.com/en-us/linkedin/

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";

const CONFIG_DIR = join(homedir(), ".config", "linkedin-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const QUEUE_PATH = join(CONFIG_DIR, "queue.jsonl");

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POST_URL = "https://api.linkedin.com/v2/ugcPosts"; // legacy, ale dziala 2026; flat /rest/posts to alternatywa
const SCOPE = "openid profile w_member_social";

// ---------- helpers ----------
function die(msg) { console.error("✗ " + msg); process.exit(1); }
function ok(msg) { console.log("✓ " + msg); }

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}
function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}

async function resolveUrn(token) {
  // OpenID Connect userinfo -> sub = member id -> urn:li:person:{sub}
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const j = await r.json();
  return j.sub ? `urn:li:person:${j.sub}` : null;
}

function tokenAlive(cfg) {
  return cfg.access_token && cfg.expires_at && Date.now() < cfg.expires_at;
}

// parsuje "YYYY-MM-DD HH:MM" jako czas LOKALNY (albo dowolny format ktory zrozumie Date)
function parseWhen(s) {
  if (!s || typeof s !== "string") return null;
  let v = s.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) v = v.replace(" ", "T");
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function readQueue() {
  if (!existsSync(QUEUE_PATH)) return [];
  return readFileSync(QUEUE_PATH, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
}
function writeQueue(items) {
  mkdirSync(dirname(QUEUE_PATH), { recursive: true });
  writeFileSync(QUEUE_PATH, items.map(i => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""), { mode: 0o600 });
}

// publikuje tekst -> {ok, id, error}
async function publishPost(cfg, text, visibility) {
  const payload = {
    author: cfg.author_urn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC" },
  };
  const r = await fetch(POST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.access_token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(payload),
  });
  if (r.status === 201) {
    return { ok: true, id: r.headers.get("x-restli-id") || r.headers.get("x-linkedin-id") };
  }
  return { ok: false, error: `${r.status}: ${await r.text()}` };
}

// ---------- commands ----------
async function cmdAuthToken(args) {
  const token = typeof args.token === "string" ? args.token.trim() : null;
  if (!token) die("podaj token: linkedin auth --token \"AQ...\"  (z Developer Portal > Token Generator)");
  let urn = typeof args.urn === "string" ? `urn:li:person:${args.urn.replace(/^urn:li:person:/, "")}` : null;
  if (!urn) {
    urn = await resolveUrn(token);
    if (!urn) die("nie udalo sie pobrac URN z /userinfo. Dodaj w token generatorze scope `openid` + `profile`, albo podaj recznie --urn <id>.");
  }
  const cfg = loadConfig();
  cfg.access_token = token;
  cfg.author_urn = urn;
  // token generator daje 60-dniowy token; zapisujemy bezpieczne 59 dni
  cfg.expires_at = args.expires ? Date.now() + Number(args.expires) * 1000 : Date.now() + 59 * 24 * 3600 * 1000;
  saveConfig(cfg);
  ok(`zalogowano. URN: ${urn}`);
  ok(`token wazny do ~${new Date(cfg.expires_at).toISOString().slice(0, 10)}`);
}

async function cmdAuthBrowser(args) {
  const cfg = loadConfig();
  const clientId = args["client-id"] || process.env.LINKEDIN_CLIENT_ID || cfg.client_id;
  const clientSecret = args["client-secret"] || process.env.LINKEDIN_CLIENT_SECRET || cfg.client_secret;
  if (!clientId || !clientSecret) die("brak client_id/secret. Uzyj --client-id i --client-secret (albo env LINKEDIN_CLIENT_ID/SECRET).");
  const port = Number(args.port || 8765);
  const redirectUri = `http://localhost:${port}/callback`;
  const state = Math.random().toString(36).slice(2);

  const authUrl = `${AUTH_URL}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${encodeURIComponent(SCOPE)}`;

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      const c = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const err = u.searchParams.get("error_description") || u.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>${c ? "Gotowe ✓ wracaj do terminala" : "Blad: " + (err || "brak code")}</h2></body></html>`);
      server.close();
      if (err) reject(new Error(err));
      else if (st !== state) reject(new Error("state mismatch (mozliwy CSRF)"));
      else resolve(c);
    });
    server.listen(port, () => {
      console.log("Otwieram przegladarke do autoryzacji LinkedIn...");
      console.log("Jak sie nie otworzy, wejdz recznie:\n" + authUrl);
      openBrowser(authUrl);
    });
    setTimeout(() => { server.close(); reject(new Error("timeout 180s")); }, 180000);
  });

  const body = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: clientId,
    client_secret: clientSecret, redirect_uri: redirectUri,
  });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json();
  if (!r.ok || !j.access_token) die("wymiana code->token nieudana: " + JSON.stringify(j));

  const urn = await resolveUrn(j.access_token);
  if (!urn) die("token OK ale nie pobralem URN (dodaj produkt 'Sign In with LinkedIn using OpenID Connect').");

  cfg.client_id = clientId; cfg.client_secret = clientSecret;
  cfg.access_token = j.access_token;
  if (j.refresh_token) cfg.refresh_token = j.refresh_token;
  cfg.author_urn = urn;
  cfg.expires_at = Date.now() + (j.expires_in || 5184000) * 1000;
  saveConfig(cfg);
  ok(`zalogowano przez przegladarke. URN: ${urn}`);
  ok(`token wazny do ~${new Date(cfg.expires_at).toISOString().slice(0, 10)}`);
}

async function cmdPost(args) {
  const cfg = loadConfig();
  // tryb remote: publikuj z VPS (token tam), tresc przez stdin
  if (cfg.remote && !args["dry-run"]) {
    let text = args._[0];
    if (args.file && typeof args.file === "string") text = readFileSync(args.file, "utf8");
    if (!text) text = readStdinSafe();
    if (!text || !text.trim()) die("brak tresci.");
    let a = "post";
    if (typeof args.visibility === "string" && args.visibility.toLowerCase() === "connections") a += " --visibility connections";
    const r = sshRun(cfg, a, text);
    process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
    process.exit(r.status || 0);
  }
  if (!cfg.access_token || !cfg.author_urn) die("brak logowania. Najpierw: linkedin auth --token \"AQ...\"");
  if (!tokenAlive(cfg)) die("token wygasl (60 dni). Wygeneruj nowy w Developer Portal > Token Generator i: linkedin auth --token \"...\"");

  // tresc: pozycyjny arg | -f plik | stdin
  let text = args._[0];
  if (args.file && typeof args.file === "string") text = readFileSync(args.file, "utf8");
  if (!text && !process.stdin.isTTY) text = readFileSync(0, "utf8");
  if (!text || !text.trim()) die("brak tresci. Uzyj: linkedin post \"tekst\"  |  --file post.txt  |  echo tekst | linkedin post");
  text = text.replace(/\s+$/, "");

  const visibility = (typeof args.visibility === "string" && args.visibility.toLowerCase() === "connections")
    ? "CONNECTIONS" : "PUBLIC";

  const payload = {
    author: cfg.author_urn,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": visibility },
  };

  if (args["dry-run"]) {
    console.log(JSON.stringify(payload, null, 2));
    ok("dry-run - nic nie wyslano");
    return;
  }

  const res = await publishPost(cfg, text, visibility);
  if (res.ok) {
    ok("opublikowano na LinkedIn");
    if (res.id) console.log("  URN: " + res.id + "\n  Link: https://www.linkedin.com/feed/update/" + res.id + "/");
  } else {
    die("blad " + res.error);
  }
}

// ---- tryb remote (kolejka + publikacja na VPS, sterowanie z lokalnego CLI) ----
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
// deleguje komende na VPS po SSH; stdinText idzie na zdalny stdin (bezpiecznie dla dowolnej tresci)
function sshRun(cfg, cliArgs, stdinText) {
  const remoteCmd = (cfg.remote_cmd || "linkedin") + " " + cliArgs;
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", cfg.remote, remoteCmd],
    { input: stdinText ?? "", encoding: "utf8" });
  if (r.error) die("ssh: " + r.error.message);
  return r;
}

function readStdinSafe() {
  if (process.stdin.isTTY) return null;
  try { const s = readFileSync(0, "utf8"); return s && s.trim() ? s : null; }
  catch { return null; }
}

async function cmdSchedule(args) {
  const cfg = loadConfig();
  // date: z flagi --at, albo pierwszy pozycyjny. Parsujemy LOKALNIE (Twoja strefa).
  const when = parseWhen(args.at || args._[0]);
  if (!when) die("podaj date: linkedin schedule --at \"2026-06-16 09:00\" \"tresc\"  (czas lokalny)");
  // tekst: --file > pozycyjny (drugi gdy date byla pozycyjna, pierwszy gdy date z --at) > stdin
  const positionals = args._.slice();
  if (!args.at && positionals.length) positionals.shift(); // pierwszy pozycyjny byl data
  let text = (args.file && typeof args.file === "string") ? readFileSync(args.file, "utf8")
    : (positionals[0] || readStdinSafe());
  if (!text || !text.trim()) die("brak tresci. schedule --at \"...\" \"tekst\"  |  --file plik.txt  |  stdin");
  text = text.replace(/\s+$/, "");
  const visibility = (typeof args.visibility === "string" && args.visibility.toLowerCase() === "connections") ? "CONNECTIONS" : "PUBLIC";

  // tryb remote: wyslij na kolejke VPS. Czas jako absolutny UTC instant (VPS jest w UTC) -> zero przesuniecia.
  if (cfg.remote) {
    let a = `schedule --at ${shq(when.toISOString())}`;
    if (visibility === "CONNECTIONS") a += " --visibility connections";
    const r = sshRun(cfg, a, text);
    process.stdout.write((r.stdout || "").replace(/\d+\/\d+\/\d+.*(AM|PM)/, when.toLocaleString())); // pokaz czas lokalny
    process.stderr.write(r.stderr || "");
    process.exit(r.status || 0);
  }

  if (!cfg.author_urn) die("najpierw zaloguj: linkedin auth --token \"AQ...\"");
  const q = readQueue();
  const item = { id: Date.now().toString(36), when: when.toISOString(), text, visibility, status: "pending", created: new Date().toISOString() };
  q.push(item);
  writeQueue(q);
  ok(`zaplanowano #${item.id} na ${when.toLocaleString()}`);
  console.log("  " + text.split("\n")[0].slice(0, 70) + (text.length > 70 ? "..." : ""));
}

function renderQueue(items, showAll) {
  if (!items.length) { console.log(showAll ? "kolejka pusta" : "brak zaplanowanych postow (--all pokazuje wyslane)"); return; }
  for (const i of items.sort((a, b) => a.when.localeCompare(b.when))) {
    const mark = i.status === "pending" ? "⏳" : i.status === "sent" ? "✓" : "✗";
    console.log(`${mark} #${i.id}  ${new Date(i.when).toLocaleString()}  ${i.status}`);
    console.log(`    ${i.text.split("\n")[0].slice(0, 70)}${i.text.length > 70 ? "..." : ""}`);
    if (i.status === "sent" && i.result) console.log(`    https://www.linkedin.com/feed/update/${i.result}/`);
    if (i.status === "error" && i.error) console.log(`    blad: ${i.error.slice(0, 120)}`);
  }
}

function cmdQueue(args) {
  const cfg = loadConfig();
  const showAll = !!args.all;
  // tryb remote: pobierz surowa kolejke z VPS, renderuj LOKALNIE (czas w Twojej strefie)
  if (cfg.remote && !args.json) {
    const r = sshRun(cfg, "queue --all --json");
    if (r.status) { process.stderr.write(r.stderr || ""); process.exit(r.status); }
    let items = [];
    try { items = JSON.parse(r.stdout || "[]"); } catch { die("zla odpowiedz z VPS: " + (r.stdout || "")); }
    renderQueue(showAll ? items : items.filter(i => i.status === "pending"), showAll);
    return;
  }
  const q = readQueue();
  if (args.json) { console.log(JSON.stringify(q)); return; }
  const items = showAll ? q : q.filter(i => i.status === "pending");
  renderQueue(items, showAll);
}

function cmdUnschedule(args) {
  const id = args._[0];
  if (!id) die("podaj id: linkedin unschedule <id>");
  const cfg = loadConfig();
  if (cfg.remote) {
    const r = sshRun(cfg, "unschedule " + shq(id));
    process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
    process.exit(r.status || 0);
  }
  const q = readQueue();
  const before = q.length;
  const next = q.filter(i => !(i.id === id && i.status === "pending"));
  if (next.length === before) die(`nie znaleziono pending #${id}`);
  writeQueue(next);
  ok(`usunieto #${id}`);
}

// odpalane z cron/launchd: publikuje wszystko co dojrzalo
async function cmdRunDue(args) {
  const cfg = loadConfig();
  const q = readQueue();
  const now = Date.now();
  const due = q.filter(i => i.status === "pending" && new Date(i.when).getTime() <= now);
  if (!due.length) { if (args.verbose) console.log("nic do wyslania"); return; }
  if (!tokenAlive(cfg)) die("token wygasl - posty czekaja w kolejce. Odnow: linkedin auth --token \"...\"");
  for (const i of due) {
    const res = await publishPost(cfg, i.text, i.visibility);
    if (res.ok) { i.status = "sent"; i.result = res.id; i.sent_at = new Date().toISOString(); ok(`wyslano #${i.id} -> ${res.id}`); }
    else { i.status = "error"; i.error = res.error; console.error(`✗ #${i.id}: ${res.error}`); }
  }
  writeQueue(q);
}

function cmdRemote(args) {
  const cfg = loadConfig();
  if (args.off) { delete cfg.remote; delete cfg.remote_cmd; saveConfig(cfg); ok("tryb remote WYLACZONY (CLI dziala lokalnie)"); return; }
  const target = args._[0];
  if (!target) {
    console.log(cfg.remote ? `remote: ${cfg.remote}  (cmd: ${cfg.remote_cmd || "linkedin"})` : "remote: wylaczony (lokalny tryb)");
    return;
  }
  cfg.remote = target; // np. user@your-server.example.com
  if (typeof args.cmd === "string") cfg.remote_cmd = args.cmd;
  saveConfig(cfg);
  ok(`tryb remote WLACZONY -> ${target}`);
  console.log("  schedule/post/queue/unschedule ida teraz na VPS. run-due chodzi tam w cronie.");
}

function cmdWhoami() {
  const cfg = loadConfig();
  if (!cfg.author_urn) die("nie zalogowany.");
  console.log("URN:    " + cfg.author_urn);
  console.log("Token:  " + (tokenAlive(cfg) ? "wazny do ~" + new Date(cfg.expires_at).toISOString().slice(0, 10) : "WYGASL - zaloguj ponownie"));
  console.log("Config: " + CONFIG_PATH);
}

function usage() {
  console.log(`linkedin - prosty CLI do postowania na Twoj profil LinkedIn

UZYCIE:
  linkedin auth --token "AQ..."       zaloguj tokenem z Developer Portal (Token Generator)
  linkedin auth --browser             zaloguj przez przegladarke (wymaga client-id/secret)
  linkedin post "tresc posta"         opublikuj posta
  linkedin post --file post.txt       opublikuj tresc z pliku
  echo "tresc" | linkedin post        opublikuj ze stdin
  linkedin whoami                     pokaz kogo masz zalogowanego + waznosc tokenu

PLANOWANIE (kolejka + cron):
  linkedin schedule --at "2026-06-16 09:00" "tresc"   zaplanuj post (czas lokalny)
  linkedin schedule --at "..." --file post.txt        zaplanuj tresc z pliku
  linkedin queue                      pokaz zaplanowane (--all = tez wyslane)
  linkedin unschedule <id>            usun zaplanowany post
  linkedin run-due                    opublikuj wszystko co dojrzalo (to wola cron)

REMOTE (kolejka + publikacja na VPS, sterowanie z Maca):
  linkedin remote root@HOST           wlacz tryb remote (schedule/post/queue ida na VPS)
  linkedin remote --off               wroc do trybu lokalnego
  linkedin remote                     pokaz aktualny tryb

OPCJE post/schedule:
  --visibility public|connections     domyslnie public
  --dry-run                           (post) pokaz payload, nie wysylaj

Pierwsze uruchomienie: zobacz README.md (setup aplikacji + cron).`);
}

// ---------- router ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

(async () => {
  try {
    switch (cmd) {
      case "auth":
        if (args.browser) await cmdAuthBrowser(args);
        else await cmdAuthToken(args);
        break;
      case "post": await cmdPost(args); break;
      case "schedule": await cmdSchedule(args); break;
      case "queue": cmdQueue(args); break;
      case "unschedule": cmdUnschedule(args); break;
      case "run-due": await cmdRunDue(args); break;
      case "remote": cmdRemote(args); break;
      case "whoami": cmdWhoami(); break;
      case "-h": case "--help": case "help": case undefined: usage(); break;
      default: die(`nieznana komenda: ${cmd}. linkedin --help`);
    }
  } catch (e) {
    die(e.message || String(e));
  }
})();
