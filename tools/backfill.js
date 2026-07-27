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
function buildCompressedRunContext(runData) {
  const { dist = [], alt = [], hr = [], vel = [], grade = [], time = [], location = [] } = runData.streams || {};
  const n = dist.length;
  if (!n) return null;
  const targetSegments = Math.max(36, Math.min(120, Math.round(runData.distance_km * 10)));
  const step = Math.max(1, Math.floor(n / targetSegments));
  const segments = [];
  for (let start = 0; start < n; start += step) {
    const end = Math.min(n - 1, start + step);
    const idxs = [];
    for (let i = start; i <= end; i++) idxs.push(i);
    const segHr = idxs.map(i => hr[i]).filter(v => v > 30);
    const segVel = idxs.map(i => vel[i]).filter(v => v > 0.3);
    const segGrade = idxs.map(i => grade[i]).filter(v => typeof v === "number");
    const segAlt = idxs.map(i => alt[i]).filter(v => typeof v === "number");
    const segTimeStart = time[start] || 0;
    const segTimeEnd = time[end] || segTimeStart;
    const mid = Math.floor((start + end) / 2);
    segments.push({
      idx_start: start,
      idx_mid: mid,
      idx_end: end,
      km_start: round1((dist[start] || 0) / 1000),
      km_end: round1((dist[end] || 0) / 1000),
      seconds_start: segTimeStart,
      seconds_end: segTimeEnd,
      avg_pace: segVel.length ? paceStr(mean(segVel)) : null,
      avg_hr: segHr.length ? Math.round(mean(segHr)) : null,
      avg_grade: segGrade.length ? round1(mean(segGrade)) : null,
      elev_delta_m: segAlt.length ? round1(segAlt[segAlt.length - 1] - segAlt[0]) : null,
      min_alt_m: segAlt.length ? round1(Math.min(...segAlt)) : null,
      max_alt_m: segAlt.length ? round1(Math.max(...segAlt)) : null,
      gps_start: location[start] || null,
      gps_mid: location[mid] || null,
      gps_end: location[end] || null
    });
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
    segments
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
    used.add(idx);
    const title = typeof w.title === "object" ? localText(w.title.en || "", w.title.zh || "") : localText(String(w.title || `Moment ${index + 1}`), String(w.title || `时刻 ${index + 1}`));
    const tip = typeof w.tip === "object" ? localText(w.tip.en || "", w.tip.zh || "") : localText(String(w.tip || ""), String(w.tip || ""));
    return {
      idx,
      type: ["neutral", "warning", "target", "critical"].includes(w.type) ? w.type : inferWaypointType({ idx, title, tip }, runData),
      title,
      tip
    };
  }).sort((a, b) => a.idx - b.idx);
  if (normalized.length !== 7) return null;
  return normalized;
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
function heuristicWaypoints(runData, recentRuns) {
  const { dist = [], alt = [], hr = [], vel = [], grade = [] } = runData.streams || {};
  const n = dist.length;
  if (!n) return null;
  const rand = seededRandom(runData.id || n);
  const history = buildRecentHistory(recentRuns);
  const hasHR = hr.some(v => v > 30);
  const paceNow = paceSeconds(runData.pace);
  const histPace = paceSeconds(history.avg_pace);
  const chooseTitle = (optionsEn, optionsZh) => localText(optionsEn[Math.floor(rand() * optionsEn.length)], optionsZh[Math.floor(rand() * optionsZh.length)]);

  let summitIdx = 0;
  let climbIdx = 0;
  let dropIdx = 0;
  let fastIdx = 0;
  let hrIdx = 0;
  let slowIdx = Math.floor(n * 0.7);
  for (let i = 1; i < n; i++) {
    if ((alt[i] || 0) > (alt[summitIdx] || 0)) summitIdx = i;
    if ((grade[i] || 0) > (grade[climbIdx] || 0)) climbIdx = i;
    if ((grade[i] || 0) < (grade[dropIdx] || 0)) dropIdx = i;
    if ((vel[i] || 0) > (vel[fastIdx] || 0)) fastIdx = i;
    if ((hr[i] || 0) > (hr[hrIdx] || 0)) hrIdx = i;
    if ((vel[i] || Infinity) < (vel[slowIdx] || Infinity) && i > Math.floor(n * 0.3)) slowIdx = i;
  }
  const candidatePool = [
    { idx: 0, type: "neutral", title: chooseTitle(["Opening Read", "First Impression", "Settling In"], ["开场读秒", "第一印象", "进入状态"]), tip: localText(
      history.avg_distance_km ? `The run opens at ${Math.round(alt[0] || 0)}m. Today is ${runData.distance_km}km versus your recent ${history.avg_distance_km}km average, so the workload profile is already different.` : `The run opens at ${Math.round(alt[0] || 0)}m with fresh legs and plenty of room for the route to define itself.`,
      history.avg_distance_km ? `这次从 ${Math.round(alt[0] || 0)} 米起步。今天是 ${runData.distance_km} 公里，而你最近平均约 ${history.avg_distance_km} 公里，训练负荷从一开始就不同。` : `这次从 ${Math.round(alt[0] || 0)} 米起步，双腿还新鲜，路线会很快显露今天的风格。`
    ) },
    { idx: climbIdx, type: "warning", title: chooseTitle(["Torque Check", "Power Patch", "Climb Bite"], ["扭矩检查", "力量区间", "爬坡咬点"]), tip: localText(
      `This is the steepest uphill patch at ${round1((dist[climbIdx] || 0) / 1000)}km. Grade hits ${round1(grade[climbIdx] || 0)}%, and the run asks for force rather than rhythm here.`,
      `这里是最陡的上坡段，位于 ${round1((dist[climbIdx] || 0) / 1000)} 公里处。坡度达到 ${round1(grade[climbIdx] || 0)}%，这里更考验力量，而不是节奏。`
    ) },
    { idx: summitIdx, type: "target", title: chooseTitle(["Route Pivot", "High Point", "Turn Of The Run"], ["路线转折", "全程高点", "节奏拐点"]), tip: localText(
      `The route crests here at ${Math.round(alt[summitIdx] || 0)}m. This is less about “the summit” and more about where the whole run changes character.`,
      `路线在这里来到 ${Math.round(alt[summitIdx] || 0)} 米的高点。它不只是“最高点”，更是整次跑步性格发生变化的位置。`
    ) },
    { idx: dropIdx, type: "critical", title: chooseTitle(["Free Speed", "Gravity Test", "Downhill Choice"], ["免费速度", "重力测试", "下坡选择"]), tip: localText(
      `The steepest descent arrives here at ${round1(grade[dropIdx] || 0)}%. This section rewards confidence and punishes braking.`,
      `最陡下坡出现在这里，坡度 ${round1(grade[dropIdx] || 0)}%。这段会奖励顺势而下，也会惩罚用力刹车。`
    ) },
    { idx: fastIdx, type: "target", title: chooseTitle(["Release Point", "Stride Opens", "Fast Window"], ["释放点", "步幅打开", "极速窗口"]), tip: localText(
      `Your quickest section appears here at about ${paceStr(vel[fastIdx])}/km. The route finally gives you permission to move.`,
      `你最快的区间出现在这里，约 ${paceStr(vel[fastIdx])}/公里。路线终于允许你把速度放出来。`
    ) },
    { idx: hasHR ? hrIdx : slowIdx, type: "warning", title: chooseTitle(["Stress Marker", "Cost Of The Run", "Pressure Point"], ["压力标记", "代价时刻", "受压点"]), tip: localText(
      hasHR ? `Heart rate tops out at ${hr[hrIdx]} here, which is the physiological price tag of this run.` : `This is the slowest late-run patch, a good proxy for where the cost of the run starts showing up in the legs.`,
      hasHR ? `这里的心率来到峰值 ${hr[hrIdx]}，可以理解为这次跑步付出的生理代价。` : `这里是后程最慢的一段，可以把它理解为疲劳真正开始落到双腿上的位置。`
    ) },
    { idx: n - 1, type: "neutral", title: chooseTitle(["Finish Read", "Exit Signal", "Closing Note"], ["收尾读数", "结束信号", "结尾注脚"]), tip: localText(
      histPace && paceNow ? `You close at ${runData.pace}/km overall, ${paceNow < histPace ? "quicker" : paceNow > histPace ? "easier" : "almost identical"} than your recent ${history.avg_pace}/km baseline.` : `The run closes with enough information to tell a story, even without forcing it into fixed milestones.`,
      histPace && paceNow ? `最终均配 ${runData.pace}/公里，和你最近 ${history.avg_pace}/公里 的基线相比，今天${paceNow < histPace ? "更快" : paceNow > histPace ? "更轻松" : "几乎一致"}。` : `这次结束时已经留下足够多的信息，没必要再硬套固定里程碑。`
    ) }
  ];
  return finalizeWaypoints(candidatePool, runData);
}
async function generateLLMWaypoints(runData, recentRuns) {
  if (!openRouterKey) return null;
  const context = {
    current_run: buildCompressedRunContext(runData),
    recent_history: buildRecentHistory(recentRuns),
    instructions: {
      choose_exactly: 7,
      rule: "Choose 7 diverse moments from the whole run. They do NOT need to include start, finish, summit, fastest, or max heart rate unless those are genuinely interesting.",
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
    "Use the full run context and recent history provided.",
    "Choose exactly 7 interesting moments anywhere in the run.",
    "Do not force generic categories like start/summit/max HR unless they are truly the most interesting points.",
    "Make each title and note specific to this run, not a template.",
    "Return JSON only."
  ].join(" ");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openRouterKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: openRouterModel,
          temperature: 0.7,
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
        const text = data?.choices?.[0]?.message?.content || "";
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
  const fallback = heuristicWaypoints(runData, recentRuns);
  if (!fallback) return null;
  return {
    waypoints: fallback,
    ai_tips: fallback.map(w => w.tip),
    ai_generation: {
      mode: "heuristic_fallback",
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
