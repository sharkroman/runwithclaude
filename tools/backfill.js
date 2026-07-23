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

async function generateAITips(runData) {
  if (!openRouterKey) return null;
  
  const alt = runData.streams.alt;
  const grade = runData.streams.grade;
  const hr = runData.streams.hr;
  const dist = runData.streams.dist;
  const vel = runData.streams.vel;
  const n = alt.length;
  if (n === 0) return null;

  let sIdx = 0, sAlt = alt[0];
  for (let i = 0; i < n; i++) { if (alt[i] > sAlt) { sAlt = alt[i]; sIdx = i; } }
  const climbMid = Math.round(sIdx / 2);
  let steepIdx = sIdx, steepG = 0;
  for (let i = sIdx; i < n; i++) { if (grade[i] < steepG) { steepG = grade[i]; steepIdx = i; } }
  const q8 = Math.max(1, Math.round(n * 0.08));
  const fade = Math.round(sIdx + (n - 1 - sIdx) * 0.85);

  const waypoints = [
    { idx: 0, label: "START" },
    { idx: q8, label: "EFFORT BUILDS" },
    { idx: climbMid, label: "MID CLIMB" },
    { idx: sIdx, label: "SUMMIT" },
    { idx: steepIdx, label: "STEEP DROP" },
    { idx: fade, label: "LEGS FADING" },
    { idx: n - 1, label: "FINISH" }
  ];

  const wpData = waypoints.map(w => {
    return `${w.label} (Distance: ${(dist[w.idx]/1000).toFixed(2)}km): Altitude ${Math.round(alt[w.idx])}m, HR ${hr[w.idx]}bpm, Pace ${paceFromSpeed(vel[w.idx])}/km`;
  }).join("\n");

  const prompt = `You are an elite trail running coach. A runner just finished a run named "${runData.name}" (${runData.distance_km}km, +${runData.elev_gain_m}m).
Here are 7 key moments from their run:
${wpData}

Write exactly 7 short coaching observations (one for each moment). Each observation should be 1-2 sentences. Do NOT include bullet points, numbering, or labels. Separate each observation with the exact string "|||". Make it bilingual (English first, then Chinese translation in the same block). Provide ONLY the 7 blocks separated by "|||".`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error(`AI Tips HTTP ${res.status} (attempt ${attempt}): ${errBody.slice(0, 300)}`);
      } else {
        const j = await res.json();
        const reply = j.choices[0].message.content;
        const tips = reply.split("|||").map(s => s.trim()).filter(s => s.length > 0);
        if (tips.length === 7) return tips;
        console.error(`AI Tips bad block count ${tips.length} (attempt ${attempt}): ${String(reply).slice(0, 200)}`);
      }
    } catch(e) {
      console.error(`AI Tips fetch error (attempt ${attempt}):`, e && e.message ? e.message : e);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
  }
  return null;
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

async function regenTips(onlyId = null) {
  if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is required for tips mode");
  const files = fs.readdirSync(OUT_DIR).filter(f => /^\d+\.json$/.test(f));
  let updated = 0, skipped = 0;
  for (const f of files) {
    if (onlyId && f !== `${onlyId}.json`) continue;
    const p = path.join(OUT_DIR, f);
    const runData = JSON.parse(fs.readFileSync(p, "utf8"));
    if (runData.meta && runData.meta.ai_tips) { skipped++; continue; }
    if (!runData.streams || !runData.streams.alt || !runData.streams.alt.length) { skipped++; continue; }
    console.log(`Generating tips for ${runData.id} - ${runData.name}...`);
    const tips = await generateAITips(runData);
    if (tips) {
      runData.meta = runData.meta || {};
      runData.meta.ai_tips = tips;
      fs.writeFileSync(p, JSON.stringify(runData));
      updated++;
    } else {
      console.log(`  tips generation failed for ${runData.id}, skipped`);
    }
  }
  console.log(`AI tips updated for ${updated} runs (${skipped} skipped).`);
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

      // Add AI Tips
      const tips = await generateAITips(runData);
      if(tips) {
        runData.meta = runData.meta || {};
        runData.meta.ai_tips = tips;
        console.log(`Generated AI tips for ${id}`);
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