#!/usr/bin/env node
// Prints a Markdown coach report for one saved run: `node tools/report.js <activityId>`.
// Used by the workflow to open a GitHub issue (which notifies the owner) after a new run.
const fs = require("fs");
const path = require("path");

const SITE = "https://sharkroman.github.io/runwithclaude/";
const id = process.argv[2];
if (!/^\d+$/.test(id || "")) {
  console.error("Usage: node tools/report.js <activityId>");
  process.exit(1);
}
const run = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "runs", `${id}.json`), "utf8"));
const meta = run.meta || {};
const dist = run.streams?.dist || [];
const kmAt = idx => (typeof dist[idx] === "number" ? (dist[idx] / 1000).toFixed(1) : "?");
const icon = { critical: "🔴", warning: "🟠", target: "🟢", neutral: "🔵" };

const stats = [
  `**${run.distance_km} km**`,
  run.moving && `${run.moving} moving`,
  run.pace && `${run.pace} /km`,
  run.elev_gain_m != null && `+${run.elev_gain_m} m`,
  run.avg_hr && `HR ${run.avg_hr} avg / ${run.max_hr} max`
].filter(Boolean).join(" · ");

const lines = [
  `${stats}`,
  "",
  `[Open on the dashboard](${SITE}?id=${id})`,
  ""
];
if (meta.ai_generation?.mode !== "llm") {
  lines.push("> ⚠️ The AI coach was unavailable, so these are template notes" +
    (meta.ai_generation?.fallback_reason ? ` (${meta.ai_generation.fallback_reason}).` : "."), "");
}
for (const w of meta.waypoints || []) {
  lines.push(`### ${icon[w.type] || "•"} ${w.title?.en || ""} · km ${kmAt(w.idx)}`);
  if (w.tip?.en) lines.push(w.tip.en);
  if (w.tip?.zh) lines.push("", `> ${w.tip.zh}`);
  lines.push("");
}
if (meta.ai_generation?.model) lines.push(`<sub>Coach model: ${meta.ai_generation.model}</sub>`);
if (process.env.REPORT_MENTION) lines.push("", `cc @${process.env.REPORT_MENTION}`);
process.stdout.write(lines.join("\n") + "\n");
