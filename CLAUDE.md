# runwithclaude: running coach

Static GitHub Pages site (`index.html`) showing trail runs from Strava, with AI coaching
pins per run and a browser-side AI coach chat. Data is produced by a Node script run in
GitHub Actions and committed to `runs/`.

## Layout
- `index.html`: the whole dashboard (single file, EN/ZH via `data-i18n` + `setLang`).
  Loads `runs/index.json`, then `runs/<id>.json` (`?id=`, default newest). Reads pins from `D.meta.waypoints`.
- `races/<slug>/`: race roadbooks (`index.html` single file with embedded `routeData` JSON incl. a base64
  terrain image, plus the course `.gpx`). Never print the whole file; the data line is >1 MB. Uses the
  dashboard palette/fonts and the shared `localStorage` key `lang`; links back with `../../`.
  The dashboard's `RACES` list drives the race card (shown until 7 days after race day).
  Catalina is an archived MapMyRun route, not the confirmed course: keep that disclaimer.
- `tools/backfill.js`: fetches Strava activities and streams, builds run JSON, and generates
  waypoints through the first configured provider: Amazon Bedrock (`BEDROCK_API_KEY`, Anthropic Messages format), the Anthropic API (`ANTHROPIC_API_KEY`), then OpenRouter (falls back to `emergencyFallbackWaypoints` with no key or on errors).
- `tools/summary.js`: rebuilds `runs/summary.json` (one compact row per run incl. descent/uphill stats) after each
  workflow run; the browser chat (`assets/coach-chat.js` `trainingLog`) sends it as the athlete's full history.
- `tools/report.js <id>`: prints a Markdown coach report for one saved run
  (dispatch the workflow with `report:<id>` to resend one).
- `.github/workflows/process-run.yml`: runs `backfill.js` every 30 min (`schedule`), on `repository_dispatch`
  (`new_strava_run`, payload `activity_id`) or a manual `workflow_dispatch`, commits `runs/`,
  opens a "Coach report" GitHub issue for each newly saved run (`backfill.js` lists them in `.new-runs`),
  and syncs the rotated Strava refresh token back to the repo secret through `GH_PAT`.

## Re-authorising Strava (activity list returns 401)
The refresh token needs `activity:read_all`. Open
`https://www.strava.com/oauth/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read,activity:read_all`,
approve, copy `code=` from the (unloadable) localhost redirect URL, then dispatch the workflow with
`strava_code:<code>` (codes are single-use). It saves the new refresh token to the secret and fetches runs.

## Run JSON schema (`runs/<id>.json`)
`id, name, sport, date ("YYYY-MM-DD HH:MM" local), distance_km, elev_gain_m, moving, pace,
avg_hr, max_hr, calories, streams{location[[lat,lng]], hr, alt, dist(m), vel(m/s), grade(%), time(s)}`
(all streams the same length), plus `meta{waypoints[{idx, type, title{en,zh}, subText{en,zh},
tip{en,zh}, metrics{hr,pace}}], ai_tips, ai_generation{mode, model?, fallback_reason?, history_count}}`.
`runs/index.json` is `[{id, name, date, distance_km}]`, newest first.

## Commands
No package.json; Node 20 built-ins only.
- `node tools/backfill.js`: fetch the 10 most recent activities and skip IDs already saved.
- `node tools/backfill.js <activityId>`: (re)process one activity.
- `node tools/backfill.js tips` / `tips:<id>`: regenerate waypoints for every saved run, or for one.
  This calls the LLM API and rewrites run files, so ask before running it.
- Preview: `python3 -m http.server`, then open http://localhost:8000.

## Secrets / env
Read from env only (see `.env.example`; a local `.env` is auto-loaded and gitignored).
Repo secrets: `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`,
`BEDROCK_API_KEY` (preferred), `ANTHROPIC_API_KEY` (optional), `OPENROUTER_API_KEY`, `GH_PAT` (fine-grained, this repo, Secrets read/write).
Never hardcode credentials. The dashboard chat uses an OpenRouter key the user types; it is kept only in sessionStorage, never localStorage.

## Conventions
- Workflow files: LF, no BOM. Pass event inputs through `env:`, never `${{ }}` inside `run:`.
- Run files are large single-line JSON; never print them whole.
- User-facing text is bilingual `{en, zh}`.
