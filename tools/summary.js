#!/usr/bin/env node
// Writes runs/summary.json: one compact row per saved run (whole history), so the browser AI coach
// can see every run without downloading the large stream files. Run by the workflow after backfill.
//   node tools/summary.js
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "runs");
const HYST = 3;          // metres of reversal needed before a climb/descent counts as ended (GPS noise)
const STEEP = 4;         // |grade| % that counts as uphill / downhill running

const r1 = x => Math.round(x * 10) / 10;
const pace = (sec, m) => {
  if (!(m > 50) || !(sec > 0)) return null;
  const s = Math.round(sec / (m / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function summarise(run) {
  const st = run.streams || {};
  const alt = st.alt || [], dist = st.dist || [], time = st.time || [], vel = st.vel || [], grade = st.grade || [];
  const row = {
    id: run.id, date: run.date, name: run.name, sport: run.sport, place: run.place?.en, km: run.distance_km,
    gain: run.elev_gain_m, moving: run.moving, pace: run.pace, hr: run.avg_hr, hr_max: run.max_hr
  };
  if (alt.length < 2) return row;

  // Total descent and the biggest single continuous descent, with hysteresis against GPS jitter.
  let loss = 0, ref = alt[0], dir = 0;
  let peak = alt[0], peakD = dist[0] || 0, low = alt[0], lowD = dist[0] || 0, best = { drop: 0, km: 0 };
  for (let i = 1; i < alt.length; i++) {
    const a = alt[i], d = dist[i] ?? 0;
    if (a < ref - HYST || (dir < 0 && a < ref)) { loss += ref - a; ref = a; dir = -1; }
    else if (a > ref + HYST || (dir > 0 && a > ref)) { ref = a; dir = 1; }
    if (a > peak) { peak = a; peakD = d; low = a; lowD = d; }
    if (a < low) { low = a; lowD = d; }
    if (peak - low > best.drop) best = { drop: peak - low, km: (lowD - peakD) / 1000 };
    if (a > low + 10) { peak = a; peakD = d; low = a; lowD = d; }   // a real climb ends this descent
  }

  // Time and distance spent on uphill vs downhill grades (moving samples only).
  const up = { m: 0, s: 0 }, down = { m: 0, s: 0 };
  let steepestDown = 0;
  for (let i = 1; i < alt.length; i++) {
    const dm = (dist[i] ?? 0) - (dist[i - 1] ?? 0), dt = (time[i] ?? 0) - (time[i - 1] ?? 0);
    if (!(dm > 0) || !(dt > 0) || dt > 30 || (vel[i] ?? 1) < 0.5) continue;
    const g = grade[i];
    if (typeof g !== "number") continue;
    if (g >= STEEP) { up.m += dm; up.s += dt; }
    else if (g <= -STEEP) { down.m += dm; down.s += dt; }
  }
  // Steepest sustained downhill: worst average grade over any ~400 m window.
  for (let i = 0, j = 0; i < alt.length; i++) {
    while (j < alt.length - 1 && (dist[j] ?? 0) - (dist[i] ?? 0) < 400) j++;
    const span = (dist[j] ?? 0) - (dist[i] ?? 0);
    if (span >= 350) steepestDown = Math.min(steepestDown, (alt[j] - alt[i]) / span * 100);
  }

  Object.assign(row, {
    loss: Math.round(loss),
    alt_min: Math.round(Math.min(...alt)), alt_max: Math.round(Math.max(...alt)),
    longest_descent_m: Math.round(best.drop), longest_descent_km: r1(best.km),
    steepest_400m_down_pct: r1(steepestDown),
    downhill_km: r1(down.m / 1000), downhill_pace: pace(down.s, down.m),
    uphill_km: r1(up.m / 1000), uphill_pace: pace(up.s, up.m)
  });
  return row;
}

const rows = fs.readdirSync(DIR).filter(f => /^\d+\.json$/.test(f)).map(f => {
  try { return summarise(JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"))); }
  catch (e) { console.warn(`summary: skipped ${f}: ${e.message}`); return null; }
}).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));

const out = { note: `Downhill/uphill = samples with grade <= -${STEEP}% / >= ${STEEP}%. Descents use ${HYST} m hysteresis.`, runs: rows };
fs.writeFileSync(path.join(DIR, "summary.json"), JSON.stringify(out));
console.log(`summary: ${rows.length} runs -> runs/summary.json`);
