# runwithclaude: running coach

Static GitHub Pages site (`index.html`) showing trail runs from Strava, with AI coaching
pins per run and a browser-side AI coach chat. Data is produced by a Node script run in
GitHub Actions and committed to `runs/`.

## Layout
- `index.html`: the whole dashboard (single file, EN/ZH via `data-i18n` + `setLang`).
  Loads `runs/index.json`, then `runs/<id>.json`. Reads pins from `D.meta.waypoints`.
- `tools/backfill.js`: fetches Strava activities and streams, builds run JSON, and generates
  waypoints through OpenRouter (falls back to `emergencyFallbackWaypoints` with no key or on errors).
- `.github/workflows/process-run.yml`: runs `backfill.js` on `repository_dispatch`
  (`new_strava_run`, payload `activity_id`) or a manual `workflow_dispatch`, commits `runs/`,
  and syncs the rotated Strava refresh token back to the repo secret through `GH_PAT`.

## Run JSON schema (`runs/<id>.json`)
`id, name, sport, date ("YYYY-MM-DD HH:MM" local), distance_km, elev_gain_m, moving, pace,
avg_hr, max_hr, calories, streams{location[[lat,lng]], hr, alt, dist(m), vel(m/s), grade(%), time(s)}`
(all streams the same length), plus `meta{waypoints[{idx, type, title{en,zh}, subText{en,zh},
tip{en,zh}, metrics{hr,pace}}], ai_tips, ai_generation{mode, model?, history_count}}`.
`runs/index.json` is `[{id, name, date, distance_km}]`, newest first.

## Commands
No package.json; Node 20 built-ins only.
- `node tools/backfill.js`: fetch the 10 most recent activities and skip IDs already saved.
- `node tools/backfill.js <activityId>`: (re)process one activity.
- `node tools/backfill.js tips` / `tips:<id>`: regenerate waypoints for every saved run, or for one.
  This calls OpenRouter and rewrites run files, so ask before running it.
- Preview: `python3 -m http.server`, then open http://localhost:8000.

## Secrets / env
Read from env only (see `.env.example`; a local `.env` is auto-loaded and gitignored).
Repo secrets: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`,
`OPENROUTER_API_KEY`, `GH_PAT` (fine-grained, this repo, Secrets read/write).
Never hardcode credentials. The dashboard chat uses an OpenRouter key the user types; never store it.

## Conventions
- Workflow files: LF, no BOM. Pass event inputs through `env:`, never `${{ }}` inside `run:`.
- Run files are large single-line JSON; never print them whole.
- User-facing text is bilingual `{en, zh}`.
