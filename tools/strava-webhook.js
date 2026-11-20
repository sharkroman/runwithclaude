#!/usr/bin/env node
// Manage the Strava push subscription (one per API app) that feeds tools/strava-webhook-worker.js.
//   node tools/strava-webhook.js status
//   node tools/strava-webhook.js create <callback_url> <verify_token>   (replaces any existing subscription)
//   node tools/strava-webhook.js delete
// Needs STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET (env or the gitignored .env). The callback path is
// a secret, so status prints only its host.
const fs = require("fs");
const path = require("path");

const ENV_FILE = path.join(__dirname, "..", ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const id = process.env.STRAVA_CLIENT_ID, secret = process.env.STRAVA_CLIENT_SECRET;
if (!id || !secret) { console.error("Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env"); process.exit(1); }
const API = "https://www.strava.com/api/v3/push_subscriptions";

async function list() {
  const res = await fetch(`${API}?client_id=${id}&client_secret=${encodeURIComponent(secret)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`list ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
const host = (u) => { try { return new URL(u).host; } catch { return "?"; } };

async function del(sub) {
  const res = await fetch(`${API}/${sub.id}?client_id=${id}&client_secret=${encodeURIComponent(secret)}`, { method: "DELETE" });
  console.log(`deleted subscription ${sub.id} (${host(sub.callback_url)}): ${res.status}`);
}

(async () => {
  const [cmd, url, token] = process.argv.slice(2);
  const subs = await list();
  if (cmd === "status" || !cmd) {
    if (!subs.length) console.log("No subscription: Strava is not sending webhooks.");
    for (const s of subs) console.log(`subscription ${s.id} -> ${host(s.callback_url)} (created ${s.created_at})`);
  } else if (cmd === "delete") {
    for (const s of subs) await del(s);
  } else if (cmd === "create") {
    if (!url || !token) throw new Error("usage: create <callback_url> <verify_token>");
    for (const s of subs) await del(s);
    const form = new URLSearchParams({ client_id: id, client_secret: secret, callback_url: url, verify_token: token });
    const res = await fetch(API, { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`create ${res.status}: ${JSON.stringify(body)}`);
    console.log(`created subscription ${body.id} -> ${host(url)}`);
  } else throw new Error(`unknown command ${cmd}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
