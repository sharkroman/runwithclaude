const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "runs");
const TOKEN_FILE = path.join(__dirname, "..", ".strava-refresh-token");
const clientId = process.env.STRAVA_CLIENT_ID || "266235";
const clientSecret = process.env.STRAVA_CLIENT_SECRET || "41af975bc552294a9b213d3d6d944d8d9607da07";
const fallbackRefreshToken = "df3c27549862d8ad028df413b84ae987011a9305";
const storedToken = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, "utf8").trim() : null;
const refreshToken = process.env.STRAVA_REFRESH_TOKEN || storedToken || fallbackRefreshToken;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const openRouterModel = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";

async function getAccessToken() {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const j = await res.json();
  if (j.refresh_token && j.refresh_token !== refreshToken) {
    fs.writeFileSync(TOKEN_FILE, j.refresh_token);
    console.log("Strava refresh token rotated; new token saved.");
  }
  return j.access_token;
}

async function stravaGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    if(res.status === 404) return null; 
    throw new Error(`Strava GET ${url} failed: ${res.status}`);
  }
  return res.json();
}

function pick(streams, key) {
  if (!streams) return null;
  if (Array.isArray(streams)) {
    const s = streams.find((x) => x.type === key);
    return s ? s.data : null;
  }
  const s = streams[key];
  return s && s.data ? s.data : null;
}

function mmss(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function paceFromSpeed(speed) {
  if (!speed || speed <= 0) return "";
  const spk = 1000 / speed;
  const m = Math.floor(spk / 60);
  const s = Math.round(spk % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}



function buildRun(activity, streams) {
  const loc = pick(streams, "latlng") || [];
  const hr = pick(streams, "heartrate") || [];
  const alt = pick(streams, "altitude") || [];
  const dist = pick(streams, "distance") || [];
  const vel = pick(streams, "velocity_smooth") || [];
  const grade = pick(streams, "grade_smooth") || dist.map(() => 0);
  const time = pick(streams, "time") || dist.map((_, i) => i);

  const n = loc.length;
  const safe = (arr, fill) => {
    if (arr && arr.length === n) return arr;
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = arr && arr[i] != null ? arr[i] : fill;
    return out;
  };

  const distanceKm = Math.round((activity.distance / 10)) / 100;

  return {
    id: activity.id,
    name: activity.name || "",
    sport: activity.sport_type || activity.type || "Run",
    date: activity.start_date_local ? activity.start_date_local.replace("T", " ").slice(0, 16) : "",
    distance_km: distanceKm,
    elev_gain_m: Math.round(activity.total_elevation_gain || 0),
    moving: mmss(activity.moving_time || 0),
    pace: paceFromSpeed(activity.average_speed),
    avg_hr: activity.average_heartrate != null ? Math.round(activity.average_heartrate) : null,
    max_hr: activity.max_heartrate != null ? Math.round(activity.max_heartrate) : null,
    calories: activity.calories != null ? Math.round(activity.calories) : null,
    streams: {
      location: loc,
      hr: safe(hr, 0),
      alt: safe(alt, 0),
      dist: safe(dist, 0),
      vel: safe(vel, 0),
      grade: safe(grade, 0),
      time: safe(time, 0),
    },
  };
}

const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const pad = n => String(n).padStart(2, "0");
function paceStr(v) {
  if (!v || v <= 0.3) return "walk";
  const spk = 1000 / v;
  return `${Math.floor(spk / 60)}:${pad(Math.round(spk % 60))}`;
}
function paceSeconds(pace) {
  if (!pace || typeof pace !== "string" || !pace.includes(":")) return null;
  const [m, s] = pace.split(":").map(Number);
  if (Number.isNaN(m) || Number.isNaN(s)) return null;
  return m * 60 + s;
}
function formatPace(sec) {
  if (!sec && sec !== 0) return "";
  return `${Math.floor(sec / 60)}:${pad(Math.round(sec % 60))}`;
}
function hv(arr, i) {
  for (let d = 0; d < arr.length; d++) {
    if (arr[i + d] != null && arr[i + d] > 30) return arr[i + d];
    if (arr[i - d] != null && arr[i - d] > 30) return arr[i - d];
  }
  return null;
}
function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
function mean(arr) {
  const vals = arr.filter(v => typeof v === "number" && !Number.isNaN(v));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
function round5(v) {
  return v == null ? null : Math.round(v * 100000) / 100000;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function tryParseDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function parseJsonBlock(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
function localText(en, zh) {
  return { en, zh };
}
function pickLocalized(v, lang = "en") {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return lang === "zh" ? (v.zh || v.en || "") : (v.en || v.zh || "");
  return String(v);
}
function buildRecentHistory(recentRuns) {
  const paceVals = recentRuns.map(r => paceSeconds(r.pace)).filter(v => v != null);
  const distVals = recentRuns.map(r => r.distance_km).filter(v => typeof v === "number");
  const elevVals = recentRuns.map(r => r.elev_gain_m).filter(v => typeof v === "number");
  const hrVals = recentRuns.map(r => r.avg_hr).filter(v => typeof v === "number");
  const maxHrVals = recentRuns.map(r => r.max_hr).filter(v => typeof v === "number");
  return {
    count: recentRuns.length,
    avg_distance_km: round1(mean(distVals)),
    avg_pace: paceVals.length ? formatPace(Math.round(mean(paceVals))) : null,
    avg_hr: hrVals.length ? Math.round(mean(hrVals)) : null,
    max_recent_hr: maxHrVals.length ? Math.max(...maxHrVals) : null,
    avg_elev_gain_m: elevVals.length ? Math.round(mean(elevVals)) : null,
    recent_runs: recentRuns.slice(0, 8).map(r => ({
      id: r.id,
      name: r.name,
      date: r.date,
      distance_km: r.distance_km,
      pace: r.pace,
      avg_hr: r.avg_hr,
      max_hr: r.max_hr,
      elev_gain_m: r.elev_gain_m
    }))
  };
}
function buildLLMRunContext(runData) {
  const { dist = [], alt = [], hr = [], vel = [], grade = [], time = [], location = [] } = runData.streams || {};
  const n = dist.length;
  if (!n) return null;
  const maxPoints = runData.distance_km <= 8 ? 900 : runData.distance_km <= 20 ? 1200 : 1600;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const telemetry_points = [];
  for (let i = 0; i < n; i += step) {
    const gps = location[i] || [];
    telemetry_points.push({
      idx: i,
      km: round1((dist[i] || 0) / 1000),
      seconds: time[i] || 0,
      altitude_m: round1(alt[i] || 0),
      hr: hr[i] > 30 ? Math.round(hr[i]) : null,
      pace: vel[i] > 0.3 ? paceStr(vel[i]) : null,
      grade_pct: typeof grade[i] === "number" ? round1(grade[i]) : null,
      lat: round5(gps[0]),
      lng: round5(gps[1])
    });
  }
  if (telemetry_points[telemetry_points.length - 1]?.idx !== n - 1) {
    const gps = location[n - 1] || [];
    telemetry_points.push({
      idx: n - 1,
      km: round1((dist[n - 1] || 0) / 1000),
      seconds: time[n - 1] || 0,
      altitude_m: round1(alt[n - 1] || 0),
      hr: hr[n - 1] > 30 ? Math.round(hr[n - 1]) : null,
      pace: vel[n - 1] > 0.3 ? paceStr(vel[n - 1]) : null,
      grade_pct: typeof grade[n - 1] === "number" ? round1(grade[n - 1]) : null,
      lat: round5(gps[0]),
      lng: round5(gps[1])
    });
  }
  let fastestIdx = 0;
  let steepestUpIdx = 0;
  let steepestDownIdx = 0;
  let highestIdx = 0;
  let maxHrIdx = 0;
  for (let i = 1; i < n; i++) {
    if ((vel[i] || 0) > (vel[fastestIdx] || 0)) fastestIdx = i;
    if ((grade[i] || 0) > (grade[steepestUpIdx] || 0)) steepestUpIdx = i;
    if ((grade[i] || 0) < (grade[steepestDownIdx] || 0)) steepestDownIdx = i;
    if ((alt[i] || 0) > (alt[highestIdx] || 0)) highestIdx = i;
    if ((hr[i] || 0) > (hr[maxHrIdx] || 0)) maxHrIdx = i;
  }
  return {
    run_summary: {
      id: runData.id,
      name: runData.name,
      date: runData.date,
      distance_km: runData.distance_km,
      elev_gain_m: runData.elev_gain_m,
      moving: runData.moving,
      pace: runData.pace,
      avg_hr: runData.avg_hr,
      max_hr: runData.max_hr,
      points: n
    },
    sample_policy: {
      source_points: n,
      sent_points: telemetry_points.length,
      sampling_step: step
    },
    telemetry_points,
    notable_extremes: {
      highest_point: { idx: highestIdx, km: round1((dist[highestIdx] || 0) / 1000), altitude_m: round1(alt[highestIdx] || 0) },
      steepest_uphill: { idx: steepestUpIdx, km: round1((dist[steepestUpIdx] || 0) / 1000), grade_pct: round1(grade[steepestUpIdx] || 0) },
      steepest_downhill: { idx: steepestDownIdx, km: round1((dist[steepestDownIdx] || 0) / 1000), grade_pct: round1(grade[steepestDownIdx] || 0) },
      fastest_split: { idx: fastestIdx, km: round1((dist[fastestIdx] || 0) / 1000), pace: vel[fastestIdx] > 0.3 ? paceStr(vel[fastestIdx]) : null },
      max_hr_point: hr[maxHrIdx] > 30 ? { idx: maxHrIdx, km: round1((dist[maxHrIdx] || 0) / 1000), hr: Math.round(hr[maxHrIdx]) } : null
    }
  };
}
function inferWaypointType(waypoint, runData) {
  const text = `${pickLocalized(waypoint.title, "en")} ${pickLocalized(waypoint.tip, "en")}`.toLowerCase();
  const idx = waypoint.idx || 0;
  const lastIdx = (runData.streams?.dist?.length || 1) - 1;
  const grade = runData.streams?.grade?.[idx] || 0;
  if (idx === 0 || idx === lastIdx) return "neutral";
  if (text.includes("drop") || text.includes("descent") || grade <= -8) return "critical";
  if (text.includes("summit") || text.includes("push") || text.includes("surge") || text.includes("fast")) return "target";
  if (text.includes("fatigue") || text.includes("fade") || text.includes("heart") || grade >= 8) return "warning";
  return "neutral";
}
function normalizeWaypoints(raw, runData) {
  if (!raw || !Array.isArray(raw.waypoints) || raw.waypoints.length < 7) return null;
  const maxIdx = (runData.streams?.dist?.length || 1) - 1;
  const used = new Set();
  const normalized = raw.waypoints.map((w, index) => {
    let idx = clamp(Math.round(Number(w.idx) || 0), 0, maxIdx);
    while (used.has(idx) && idx < maxIdx) idx += 1;
    while (used.has(idx) && idx > 0) idx -= 1;
    if (used.has(idx)) return null;
    used.add(idx);
    const title = typeof w.title === "object" ? localText(w.title.en || "", w.title.zh || "") : localText(String(w.title || `Moment ${index + 1}`), String(w.title || `时刻 ${index + 1}`));
    const tip = typeof w.tip === "object" ? localText(w.tip.en || "", w.tip.zh || "") : localText(String(w.tip || ""), String(w.tip || ""));
    return {
      idx,
      type: ["neutral", "warning", "target", "critical"].includes(w.type) ? w.type : inferWaypointType({ idx, title, tip }, runData),
      title,
      tip
    };
  }).filter(Boolean).sort((a, b) => a.idx - b.idx);
  if (normalized.length < 7) return null;
  return normalized.slice(0, 7);
}
function finalizeWaypoints(waypoints, runData) {
  const { dist = [], alt = [], hr = [], vel = [] } = runData.streams || {};
  return waypoints.map(w => {
    const i = clamp(w.idx, 0, dist.length - 1);
    const km = round1((dist[i] || 0) / 1000);
    const hrVal = hr[i] > 30 ? hr[i] : null;
    const meters = Math.round(alt[i] || 0);
    const pace = paceStr(vel[i]);
    let subEn = `${km} km`;
    let subZh = `${km} 公里`;
    if (meters && Math.abs(meters - Math.round(alt[0] || 0)) > 10) {
      subEn += ` · ${meters} m`;
      subZh += ` · ${meters} 米`;
    }
    return {
      idx: i,
      type: w.type || "neutral",
      title: {
        en: pickLocalized(w.title, "en"),
        zh: pickLocalized(w.title, "zh")
      },
      subText: {
        en: subEn,
        zh: subZh
      },
      tip: {
        en: pickLocalized(w.tip, "en"),
        zh: pickLocalized(w.tip, "zh")
      },
      metrics: {
        hr: hrVal,
        pace
      }
    };
  }).sort((a, b) => a.idx - b.idx);
}
function emergencyFallbackWaypoints(runData, recentRuns) {
  const { dist = [], alt = [], hr = [], vel = [], grade = [] } = runData.streams || {};
  const n = dist.length;
  if (!n) return null;
  const rand = seededRandom(runData.id || n);
  const history = buildRecentHistory(recentRuns);
  const hasHR = hr.some(v => v > 30);
  const paceNow = paceSeconds(runData.pace);
  const histPace = paceSeconds(history.avg_pace);
  const windows = 7;
  const candidatePool = [];
  for (let s = 0; s < windows; s++) {
    const start = Math.floor((s * n) / windows);
    const end = Math.max(start, Math.min(n - 1, Math.floor(((s + 1) * n) / windows) - 1));
    const span = Math.max(1, end - start);
    const idx = clamp(start + Math.floor(rand() * span), start, end);
    const km = round1((dist[idx] || 0) / 1000);
    const hrVal = hr[idx] > 30 ? Math.round(hr[idx]) : null;
    const pace = vel[idx] > 0.3 ? paceStr(vel[idx]) : "walk";
    const gradeVal = round1(grade[idx] || 0);
    const altVal = Math.round(alt[idx] || 0);
    const relativePace = histPace && paceNow
      ? (paceNow < histPace ? "quicker than recent baseline overall" : paceNow > histPace ? "easier than recent baseline overall" : "close to recent baseline overall")
      : null;
    let type = "neutral";
    if (gradeVal <= -8) type = "critical";
    else if (gradeVal >= 8 || (hrVal != null && runData.max_hr && hrVal >= runData.max_hr - 3)) type = "warning";
    else if (pace !== "walk" && vel[idx] >= Math.max(...vel)) type = "target";
    let en = `At ${km}km, the run is moving through ${altVal}m with ${pace}/km pace`;
    let zh = `在 ${km} 公里处，路线来到 ${altVal} 米，当前配速约 ${pace}/公里`;
    if (hrVal != null) {
      en += ` and HR ${hrVal}`;
      zh += `，心率 ${hrVal}`;
    }
    en += `.`;
    zh += `。`;
    if (gradeVal >= 8) {
      en += ` This stretch tilts up at ${gradeVal}%, so the effort is more about force than flow.`;
      zh += ` 这一段上扬到 ${gradeVal}% ，更考验力量而不是流畅节奏。`;
    } else if (gradeVal <= -8) {
      en += ` The downhill angle hits ${gradeVal}%, so control matters more than chasing free speed.`;
      zh += ` 这一段下坡来到 ${gradeVal}% ，控制重心比盲目追速度更重要。`;
    } else {
      en += ` This is a usable snapshot of how the run is evolving mid-route.`;
      zh += ` 这是观察整次跑步如何演变的一个有效切面。`;
    }
    if (relativePace) {
      en += ` The full run looks ${relativePace}.`;
      zh += ` 从全程看，这次与近期基线相比${paceNow < histPace ? "更快" : paceNow > histPace ? "更轻松" : "比较接近"}。`;
    }
    candidatePool.push({
      idx,
      type,
      title: localText(`Moment ${s + 1}`, `节点 ${s + 1}`),
      tip: localText(en, zh)
    });
  }
  return finalizeWaypoints(candidatePool, runData);
}
function extractMessageText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("\n");
  }
  return "";
}
async function generateLLMWaypoints(runData, recentRuns) {
  if (!openRouterKey) return null;
  const context = {
    current_run: buildLLMRunContext(runData),
    recent_history: buildRecentHistory(recentRuns),
    instructions: {
      choose_exactly: 7,
      rule: "Choose 7 diverse moments from the whole run telemetry. Do NOT default to start, finish, summit, max HR, fastest split, or steepest grade unless they are genuinely the most interesting moments in this specific run.",
      output_schema: {
        waypoints: [
          {
            idx: "integer index from the original run stream",
            type: "one of neutral|warning|target|critical",
            title: { en: "short English title", zh: "short Chinese title" },
            tip: { en: "1-2 sentence English coaching note", zh: "1-2 sentence Chinese coaching note" }
          }
        ]
      }
    }
  };
  const prompt = [
    "You are writing elite running-coach annotations for a single run.",
    "Use the run telemetry and recent history provided.",
    "Choose exactly 7 interesting moments anywhere in the run.",
    "Avoid repeated template titles such as First Impression, Stress Marker, Climb Bite, High Point, Gravity Test, Release Point, or Closing Note.",
    "Do not force generic categories like start, finish, summit, max HR, fastest split, or steepest grade unless they are truly the most interesting points in this specific run.",
    "Each title should sound bespoke to this run.",
    "Each note should reference what is happening around that point in the telemetry.",
    "Return valid JSON only."
  ].join(" ");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://sharkroman.github.io/runwithclaude",
          "X-Title": "Run With Claude"
        },
        body: JSON.stringify({
          model: openRouterModel,
          temperature: 1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: JSON.stringify(context) }
          ]
        })
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`LLM waypoint HTTP ${res.status} (attempt ${attempt}): ${err.slice(0, 300)}`);
      } else {
        const data = await res.json();
        const text = extractMessageText(data?.choices?.[0]?.message);
        const parsed = parseJsonBlock(text);
        const normalized = normalizeWaypoints(parsed, runData);
        if (normalized) return finalizeWaypoints(normalized, runData);
        console.error(`LLM waypoint parse failed (attempt ${attempt})`);
      }
    } catch (err) {
      console.error(`LLM waypoint fetch error (attempt ${attempt}): ${err.message}`);
    }
  }
  return null;
}
async function generateWaypointBundle(runData, recentRuns) {
  const llmWaypoints = await generateLLMWaypoints(runData, recentRuns);
  if (llmWaypoints) {
    return {
      waypoints: llmWaypoints,
      ai_tips: llmWaypoints.map(w => w.tip),
      ai_generation: {
        mode: "llm",
        model: openRouterModel,
        history_count: recentRuns.length
      }
    };
  }
  const fallback = emergencyFallbackWaypoints(runData, recentRuns);
  if (!fallback) return null;
  return {
    waypoints: fallback,
    ai_tips: fallback.map(w => w.tip),
    ai_generation: {
      mode: "emergency_fallback",
      history_count: recentRuns.length
    }
  };
}
function loadRunById(id) {
  const file = path.join(OUT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function loadRecentRuns(indexData, targetDate, currentId, limit = 8) {
  const date = tryParseDate(targetDate);
  if (!date) return [];
  return indexData
    .filter(r => r.id !== currentId && tryParseDate(r.date) && tryParseDate(r.date) < date)
    .sort((a, b) => tryParseDate(b.date) - tryParseDate(a.date))
    .slice(0, limit)
    .map(r => loadRunById(r.id))
    .filter(Boolean);
}
async function regenTips(onlyId = null) {
  const indexPath = path.join(OUT_DIR, "index.json");
  const indexData = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : [];
  const files = fs.readdirSync(OUT_DIR).filter(f => /^\d+\.json$/.test(f));
  let updated = 0, skipped = 0;
  for (const f of files) {
    if (onlyId && f !== `${onlyId}.json`) continue;
    const p = path.join(OUT_DIR, f);
    const runData = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!runData.streams || !runData.streams.location || !runData.streams.location.length) {
      skipped++;
      continue;
    }
    const recentRuns = loadRecentRuns(indexData, runData.date, runData.id, 8);
    const bundle = await generateWaypointBundle(runData, recentRuns);
    if (!bundle) {
      skipped++;
      continue;
    }
    runData.meta = runData.meta || {};
    runData.meta.waypoints = bundle.waypoints;
    runData.meta.ai_tips = bundle.ai_tips;
    runData.meta.ai_generation = bundle.ai_generation;
    fs.writeFileSync(p, JSON.stringify(runData));
    updated++;
    console.log(`AI bundle refreshed for ${runData.id} (${bundle.ai_generation.mode})`);
  }
  console.log(`regenTips: updated=${updated} skipped=${skipped}`);
}
async function main() {
  // Accept specific activity ID from command line, otherwise fetch recent
  const args = process.argv.slice(2);

  if (args[0] === "tips" || (args[0] || "").startsWith("tips:")) {
    const onlyId = args[0].includes(":") ? args[0].split(":")[1] : null;
    await regenTips(onlyId);
    return;
  }

  const token = await getAccessToken();
  console.log("Got access token");

  let activities = [];
  
  if (args.length > 0 && args[0] !== 'all') {
    const act = await stravaGet(`https://www.strava.com/api/v3/activities/${args[0]}`, token);
    if(act) activities.push(act);
  } else {
    activities = await stravaGet("https://www.strava.com/api/v3/athlete/activities?per_page=10", token);
  }
  
  const runs = activities.filter(a => a.type === "Run" || a.type === "TrailRun");
  console.log(`Found ${runs.length} runs to process`);
  
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  let indexData = [];
  const indexPath = path.join(OUT_DIR, "index.json");
  if(fs.existsSync(indexPath)) {
    indexData = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  }

  for (const act of runs) {
    const id = act.id;
    const outPath = path.join(OUT_DIR, `${id}.json`);
    
    // If it's a webhook trigger, we WANT to process it even if it exists.
    // If we're just syncing, we skip. But we will always fetch streams if we passed an explicit ID.
    if (fs.existsSync(outPath) && args.length === 0) {
      continue;
    }
    
    console.log(`Fetching run: ${id} - ${act.name}...`);
    
    try {
      const detail = await stravaGet(`https://www.strava.com/api/v3/activities/${id}`, token);
      const keys = "latlng,heartrate,altitude,distance,velocity_smooth,time,grade_smooth";
      const streams = await stravaGet(`https://www.strava.com/api/v3/activities/${id}/streams?keys=${keys}&key_by_type=false&resolution=high&series_type=distance`, token);
      
      if(!streams) {
        console.log(`No streams found for ${id}, skipping.`);
        continue;
      }
      
      const runData = buildRun(detail || act, streams);
      if(runData.streams.location.length === 0) continue;

      const recentRuns = loadRecentRuns(indexData, runData.date, runData.id, 8);
      const bundle = await generateWaypointBundle(runData, recentRuns);
      if (bundle) {
        runData.meta = runData.meta || {};
        runData.meta.waypoints = bundle.waypoints;
        runData.meta.ai_tips = bundle.ai_tips;
        runData.meta.ai_generation = bundle.ai_generation;
        console.log(`Generated AI waypoint bundle for ${id} (${bundle.ai_generation.mode})`);
      }
      
      fs.writeFileSync(outPath, JSON.stringify(runData));
      console.log(`Saved ${id}.json`);
      
      // Update index
      indexData = indexData.filter(x => x.id !== runData.id);
      indexData.push({
        id: runData.id,
        name: runData.name,
        date: runData.date,
        distance_km: runData.distance_km
      });
    } catch(err) {
      console.error(`Error processing ${id}:`, err.message);
    }
  }
  
  indexData.sort((a, b) => new Date(b.date) - new Date(a.date));
  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
  console.log(`Updated index.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
