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


const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const pad = n => String(n).padStart(2, "0");
function paceStr(v) {
  if (!v || v <= 0.3) return "walk";
  const spk = 1000 / v;
  return `${Math.floor(spk / 60)}:${pad(Math.round(spk % 60))}`;
}
function hv(arr, i) {
  for (let d = 0; d < arr.length; d++) {
    if (arr[i + d] != null && arr[i + d] > 30) return arr[i + d];
    if (arr[i - d] != null && arr[i - d] > 30) return arr[i - d];
  }
  return null;
}

function generateDynamicWaypoints(d, recentRuns) {
  const S = d.streams;
  const { dist, alt, hr, vel, grade } = S;
  if (!dist || !alt || !vel || !grade) return null;
  const n = alt.length;
  if (n < 10) return null;

  const hasHR = hr && hr.some(x => x != null && x > 30) && d.avg_hr != null;
  const h = i => (hasHR ? hv(hr, i) : null);
  const kmAt = i => (dist[i] / 1000).toFixed(2);

  // Historical context
  let histAvgPaceSec = null;
  let histAvgHr = null;
  let histMaxHr = null;
  let histAvgDist = null;
  if (recentRuns && recentRuns.length > 0) {
    const validPace = recentRuns.filter(r => r.pace).map(r => {
      const [m, s] = r.pace.split(':').map(Number);
      return m * 60 + s;
    });
    if (validPace.length) histAvgPaceSec = Math.round(avg(validPace));
    const validHr = recentRuns.filter(r => r.avg_hr).map(r => r.avg_hr);
    if (validHr.length) histAvgHr = Math.round(avg(validHr));
    const validMaxHr = recentRuns.filter(r => r.max_hr).map(r => r.max_hr);
    if (validMaxHr.length) histMaxHr = Math.max(...validMaxHr);
    histAvgDist = avg(recentRuns.map(r => r.distance_km));
  }

  // Find interesting indices
  let summitIdx = 0, sAlt = alt[0];
  for (let i = 0; i < n; i++) if (alt[i] > sAlt) { sAlt = alt[i]; summitIdx = i; }

  let steepClimbIdx = 0, maxG = 0;
  let steepDropIdx = 0, minG = 0;
  for (let i = 0; i < n; i++) {
    if (grade[i] > maxG) { maxG = grade[i]; steepClimbIdx = i; }
    if (grade[i] < minG) { minG = grade[i]; steepDropIdx = i; }
  }

  let maxHrIdx = 0, maxH = 0;
  if (hasHR) {
    for (let i = 0; i < n; i++) {
      if (hr[i] > maxH) { maxH = hr[i]; maxHrIdx = i; }
    }
  }

  let fastIdx = 0, maxV = 0;
  for (let i = Math.round(n * 0.05); i < n * 0.95; i++) {
    if (vel[i] > maxV) { maxV = vel[i]; fastIdx = i; }
  }

  const candidates = [
    { idx: 0, tag: "start" },
    { idx: summitIdx, tag: "summit" },
    { idx: steepClimbIdx, tag: "steep_climb" },
    { idx: steepDropIdx, tag: "steep_drop" },
    { idx: fastIdx, tag: "fastest" },
    { idx: n - 1, tag: "finish" }
  ];
  if (hasHR && maxH > 0) candidates.push({ idx: maxHrIdx, tag: "max_hr" });

  // Sort and deduplicate (must be at least 4% of run apart)
  candidates.sort((a, b) => a.idx - b.idx);
  const minSep = n * 0.04;
  const filtered = [];
  for (const c of candidates) {
    if (filtered.length === 0) {
      filtered.push(c);
    } else {
      const last = filtered[filtered.length - 1];
      if (c.idx - last.idx < minSep) {
        if (c.tag === 'summit' || c.tag === 'finish' || c.tag === 'max_hr') {
          filtered[filtered.length - 1] = c;
        }
      } else {
        filtered.push(c);
      }
    }
  }

  const waypoints = [];
  for (const c of filtered) {
    const i = c.idx;
    const pStr = paceStr(vel[i]);
    const hrVal = h(i);
    const hrNoteEN = hrVal ? `, HR ${hrVal}` : "";
    const hrNoteCN = hrVal ? `，心率${hrVal}` : "";
    
    let type = "neutral";
    let title = "";
    let subText = `${kmAt(i)} km`;
    let tip = "";

    if (c.tag === "start") {
      title = "Start / 起点";
      type = "neutral";
      subText = `${Math.round(alt[i])} m`;
      const distCmp = histAvgDist ? (d.distance_km > histAvgDist * 1.1 ? "longer than" : (d.distance_km < histAvgDist * 0.9 ? "shorter than" : "similar to")) : "";
      tip = `Starting out at ${Math.round(alt[i])}m. ${distCmp ? `Today's ${d.distance_km}km is ${distCmp} your recent average of ${histAvgDist.toFixed(1)}km. ` : ""}` +
            `从海拔${Math.round(alt[i])}米起步。${distCmp ? `今天的${d.distance_km}公里比你最近平均的${histAvgDist.toFixed(1)}公里${distCmp==='longer than'?'要长':distCmp==='shorter than'?'要短':'差不多'}。` : ""}`;
    } else if (c.tag === "summit") {
      title = "Summit / 最高点";
      type = "target";
      subText = `${kmAt(i)} km · ${Math.round(alt[i])} m`;
      tip = `High point of the route at ${Math.round(alt[i])}m${hrNoteEN}. ` +
            `全程最高点${Math.round(alt[i])}米${hrNoteCN}。`;
    } else if (c.tag === "steep_climb") {
      title = "Steepest Climb / 最陡爬坡";
      type = "warning";
      tip = `Hitting a ${grade[i]}% grade here. Pace slows to ${pStr}/km${hrNoteEN}, a strong power phase. ` +
            `遇到${grade[i]}%的陡坡。配速降至${pStr}/公里${hrNoteCN}，极好的力量训练阶段。`;
    } else if (c.tag === "steep_drop") {
      title = "Steepest Drop / 最陡下坡";
      type = "critical";
      tip = `Gravity takes over with a ${grade[i]}% descent. Pace ${pStr}/km. ` +
            `进入${grade[i]}%的陡下坡。配速${pStr}/公里。`;
    } else if (c.tag === "fastest") {
      title = "Peak Pace / 极速区间";
      type = "target";
      tip = `You opened up the stride here hitting ${pStr}/km. ` +
            `你在这里迈开步子，达到了${pStr}/公里的极速。`;
    } else if (c.tag === "max_hr") {
      title = "Peak Effort / 极值心率";
      type = "warning";
      const hrCmp = (histMaxHr && maxH > histMaxHr) ? ` This is higher than your recent max of ${histMaxHr}.` : "";
      const hrCmpCN = (histMaxHr && maxH > histMaxHr) ? ` 这比你近期的峰值${histMaxHr}还要高。` : "";
      tip = `Your heart rate peaked at ${maxH} bpm here.${hrCmp} ` +
            `心率在这里达到峰值${maxH}。${hrCmpCN}`;
    } else if (c.tag === "finish") {
      title = "Finish / 终点";
      type = "neutral";
      let paceCmp = "";
      let paceCmpCN = "";
      if (histAvgPaceSec && d.pace) {
        const [m, s] = d.pace.split(':').map(Number);
        const todaySec = m * 60 + s;
        if (todaySec < histAvgPaceSec - 5) { paceCmp = ` Faster than your recent average (${Math.floor(histAvgPaceSec/60)}:${pad(Math.round(histAvgPaceSec%60))}/km)!`; paceCmpCN = ` 比你最近的平均配速（${Math.floor(histAvgPaceSec/60)}:${pad(Math.round(histAvgPaceSec%60))}/公里）要快！`; }
        else if (todaySec > histAvgPaceSec + 5) { paceCmp = ` A bit more relaxed than your recent average (${Math.floor(histAvgPaceSec/60)}:${pad(Math.round(histAvgPaceSec%60))}/km).`; paceCmpCN = ` 比你最近的平均配速（${Math.floor(histAvgPaceSec/60)}:${pad(Math.round(histAvgPaceSec%60))}/公里）要轻松一些。`; }
      }
      tip = `Finished ${d.distance_km}km in ${d.moving} (avg ${d.pace}/km).${paceCmp} ` +
            `完成${d.distance_km}公里，用时${d.moving}（平均${d.pace}/公里）。${paceCmpCN}`;
    }

    waypoints.push({
      idx: i,
      type: type,
      title: title,
      subText: subText,
      tip: tip
    });
  }

  return waypoints;
}

async function regenTips(onlyId = null) {
  const indexFile = path.join(OUT_DIR, "index.json");
  let allRuns = [];
  if (fs.existsSync(indexFile)) {
    allRuns = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  }

  const files = fs.readdirSync(OUT_DIR).filter(f => /^\d+\.json$/.test(f));
  let updated = 0, skipped = 0;
  for (const f of files) {
    if (onlyId && f !== `${onlyId}.json`) continue;
    const p = path.join(OUT_DIR, f);
    const runData = JSON.parse(fs.readFileSync(p, "utf8"));
    
    // Find up to 5 runs before this one chronologically
    const runDate = new Date(runData.date);
    const recentRuns = allRuns.filter(r => new Date(r.date) < runDate).slice(0, 5);

    const waypoints = generateDynamicWaypoints(runData, recentRuns);
    if (waypoints) {
      runData.meta = runData.meta || {};
      runData.meta.waypoints = waypoints;
      runData.meta.ai_tips = waypoints.map(w => w.tip);
      fs.writeFileSync(p, JSON.stringify(runData));
      updated++;
    } else {
      skipped++;
    }
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