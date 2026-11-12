#!/usr/bin/env node
// Adds a place name and Strava photos to saved runs, then rebuilds runs/index.json.
//   node tools/enrich.js            runs missing a place/photo check, plus photo re-checks for the last 7 days
//   node tools/enrich.js photos     re-check photos for every run (rate-limited, may need several runs)
// Place: reverse-geocodes the start point with OpenStreetMap Nominatim (max 1 request/second, cached in the run file).
// Photos: Strava GET /activities/{id}/photos; stores CloudFront image URLs (hotlinked, not copied into the repo).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "runs");
const TOKEN_FILE = path.join(ROOT, ".strava-refresh-token");
const MAX_STRAVA_CALLS = 70;          // Strava allows 100 requests / 15 min; backfill may have used some
const MAX_GEOCODES = 150;
const RECHECK_DAYS = 7;               // photos are often added after the run
const UA = "personal-run-dashboard/1.0 (static site generator)";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadEnv() {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function stravaToken() {
  const { STRAVA_CLIENT_ID: id, STRAVA_CLIENT_SECRET: secret } = process.env;
  // backfill.js may have rotated the token earlier in this job; use the newest one.
  const refresh = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : process.env.STRAVA_REFRESH_TOKEN;
  if (!id || !secret || !refresh) return null;
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" })
  });
  if (!res.ok) { console.warn(`enrich: Strava token refresh failed ${res.status}; skipping photos`); return null; }
  const j = await res.json();
  if (j.refresh_token && j.refresh_token !== refresh) fs.writeFileSync(TOKEN_FILE, j.refresh_token);
  return j.access_token;
}

async function photosFor(id, token) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${id}/photos?size=1600&photo_sources=true`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new Error("rate limited");
  if (!res.ok) { console.warn(`enrich: photos ${id} -> ${res.status}`); return null; }
  const list = await res.json();
  return (Array.isArray(list) ? list : []).map(p => {
    const urls = p.urls || {};
    const key = Object.keys(urls).sort((a, b) => +b - +a)[0];
    const size = (p.sizes && p.sizes[key]) || [];
    return urls[key] ? { url: urls[key], w: size[0] || null, h: size[1] || null, caption: p.caption || "" } : null;
  }).filter(Boolean);
}

function placeLabel(a) {
  if (!a) return "";
  const local = a.suburb || a.neighbourhood || a.quarter || a.village || a.hamlet || a.town || a.city_district || a.island || a.park || "";
  const wide = a.city || a.town || a.county || a.state || "";
  // Nominatim sometimes returns several name variants joined by ";" (e.g. simplified;traditional).
  const parts = [local, wide].map(v => String(v).split(";")[0].trim()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i);
  if (!parts.length && a.country) parts.push(a.country);
  return parts.join(", ");
}

async function geocode(lat, lng, lang) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${lat}&lon=${lng}&accept-language=${lang}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const j = await res.json();
  return { label: placeLabel(j.address), country: j.address?.country_code || "" };
}

async function main() {
  loadEnv();
  const allPhotos = process.argv[2] === "photos";
  const files = fs.readdirSync(DIR).filter(f => /^\d+\.json$/.test(f));
  const runs = files.map(f => ({ f, r: JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) }))
    .sort((a, b) => String(b.r.date).localeCompare(String(a.r.date)));
  const now = Date.now();
  let token, stravaCalls = 0, geocodes = 0, changed = 0;

  for (const item of runs) {
    const r = item.r;
    let dirty = false;

    const start = r.streams?.location?.[0];
    if (!r.place && start && geocodes < MAX_GEOCODES) {
      try {
        const en = await geocode(start[0], start[1], "en"); await sleep(1100);
        const zh = await geocode(start[0], start[1], "zh-CN"); await sleep(1100);
        geocodes++;
        if (en.label) { r.place = { en: en.label, zh: zh.label || en.label, country: en.country }; dirty = true; }
      } catch (e) { console.warn(`enrich: place ${r.id}: ${e.message}`); geocodes = MAX_GEOCODES; }
    }

    const ageDays = (now - new Date(String(r.date).replace(" ", "T"))) / 864e5;
    const wantPhotos = allPhotos || !r.photos_checked || ageDays <= RECHECK_DAYS;
    if (wantPhotos && stravaCalls < MAX_STRAVA_CALLS) {
      if (token === undefined) token = await stravaToken();
      if (token) {
        try {
          stravaCalls++;
          const photos = await photosFor(r.id, token);
          if (photos && (JSON.stringify(photos) !== JSON.stringify(r.photos || []) || !r.photos_checked)) {
            if (photos.length) r.photos = photos; else delete r.photos;
            r.photos_checked = new Date().toISOString().slice(0, 10);
            dirty = true;
          }
        } catch (e) { console.warn(`enrich: ${e.message}; stopping photo checks`); stravaCalls = MAX_STRAVA_CALLS; }
      }
    }

    if (dirty) { fs.writeFileSync(path.join(DIR, item.f), JSON.stringify(r)); changed++; }
  }

  const index = runs.map(({ r }) => ({
    id: r.id, name: r.name, date: r.date, distance_km: r.distance_km,
    ...(r.place ? { place: r.place } : {}), ...(r.photos?.length ? { photos: r.photos.length } : {})
  }));
  fs.writeFileSync(path.join(DIR, "index.json"), JSON.stringify(index, null, 2));
  const pending = runs.filter(({ r }) => !r.photos_checked).length;
  console.log(`enrich: ${changed} runs updated, ${geocodes} geocoded, ${stravaCalls} photo checks, ${pending} runs still unchecked`);
}

main().catch(e => { console.error(e); process.exit(1); });
