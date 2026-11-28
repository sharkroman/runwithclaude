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
  `assets/roadbooks.js` (`RWC_ROADBOOKS`) is the single roadbook list: it drives the dashboard race card (shown until 7 days after race day), the dashboard roadbook dropdown, and the switcher in each roadbook's topbar (each page loads it and calls `RWC_mountRoadbookSwitcher`).
  Catalina is an archived MapMyRun route, not the confirmed course: keep that disclaimer.
  `tools/roadbook_data.py <gpx> <out.json> --name ...` builds the routeData JSON (route/profile/DEM splits, Terrarium
  hillshade + contours) for a new roadbook; `goleta-courtyard-8k/` is a training-route roadbook built that way.
- `tools/backfill.js`: fetches Strava activities and streams, builds run JSON, and generates
  waypoints through the first configured provider: Amazon Bedrock (`BEDROCK_API_KEY`, Anthropic Messages format), the Anthropic API (`ANTHROPIC_API_KEY`), then OpenRouter (falls back to `emergencyFallbackWaypoints` with no key or on errors).
- `tools/enrich.js`: adds `place{en,zh,country}` (OSM Nominatim reverse geocode of the start point, 1 req/s) and
  `photos[{url,w,h,caption}]` (Strava activity photos, hotlinked CloudFront URLs; `photos_checked` date) to run files,
  re-checks photos for runs from the last 7 days, and rebuilds `runs/index.json` (adds `place`, `photos` count).
  `node tools/enrich.js photos` re-checks every run. Runs in the workflow after backfill.
- `tools/summary.js`: rebuilds `runs/summary.json` (one compact row per run incl. descent/uphill stats) after each
  workflow run; the browser chat (`assets/coach-chat.js` `trainingLog`) sends it as the athlete's full history.
- `tools/report.js <id>`: prints a Markdown coach report for one saved run
  (dispatch the workflow with `report:<id>` to resend one).
- `tools/video/runhud.py`: burns the running dashboard HUD (route map, distance/elevation/time, pace dial, terrain
  climb/descent + grade graph, HR vs roadbook target, elevation profile, GitHub link) onto run footage, synced from
  `runs/<id>.json` streams. `--offset` = race elapsed seconds at the clip's first frame (find it from a landmark).
  Per-race presets live in `races/<slug>/video.json` (run, title, HR `targets` by km, clips with offset/crop):
  `python3 tools/video/runhud.py --config races/<slug>/video.json`. Footage lives in `~/Movies/runwithclaude/<YYYY-MM-DD>_<Race>/`
  (`raw/`, `full/` HUD renders, `30s/`, `90s/`, `posts/`); clip `file`/`out` paths in video.json are relative to it (raw files not
  found there fall back to `~/Downloads/Airdrop`, where Taildrops land). Phones stream that folder over Tailscale. Needs pillow, numpy, ffmpeg; macOS fonts.
- `tools/video/runedit.py`: cuts 30s / 90s highlight edits from a full runhud render: picks moments from the run data
  (start, steepest climb, summit, fastest descent, stairs, end) plus fillers, slides each to the least-sky stretch nearby,
  cuts on the music's beats (own beat tracker), v5 captions under the HUD, music + quiet live sound, loudnorm -15:
  `python3 tools/video/runedit.py --hud full/<x>_hud.mp4 --run <run.json> --offset <s> --music <song> --length 30|90 --out ...`
  (`--captions` JSON overrides the automatic captions by moment name).
- `tools/video/runfun.py plan.json out.mp4`: playful hand-planned edit from the RAW clip with the live HUD re-drawn on top:
  per-shot `fx` cut / zoom (punch-in) / lapse (fast-forward + xN badge) / snap (shutter flash -> polaroid freeze, `crop_y`),
  beat-cut, v5 captions. Plan format in the docstring; scan the clip at 4 s intervals first to find landmarks.
- `.github/workflows/process-run.yml`: runs `backfill.js` every 30 min (`schedule`), on `repository_dispatch`
  (`new_strava_run`, payload `activity_id`) or a manual `workflow_dispatch`, commits `runs/`,
  opens a "Coach report" GitHub issue for each newly saved run (`backfill.js` lists them in `.new-runs`),
  and syncs the rotated Strava refresh token back to the repo secret through `GH_PAT`.

## Private hosting (planned)
`functions/_middleware.js` is a Cloudflare Pages Function that puts one shared password (password-only login page,
secret `SITE_PASSWORD`, 1-year HttpOnly cookie, `/__logout`) in front of the whole site. Inert on GitHub Pages. When moving: deploy the repo
on Cloudflare Pages (no build, output `/`), make the GitHub repo private, update `SITE` in `tools/report.js`, and
reduce the cron (private repos have 2,000 free Actions minutes/month).

## Coach chat memory
`assets/coach-chat.js` saves every conversation automatically (localStorage `rwc_coach_chats`, last 60) and, on the
Cloudflare site, syncs it through `functions/api/coach-memory.js` to Cloudflare KV (binding `COACH_KV`; 501 without it,
then browser-only). New chats get earlier conversations (~30k chars, newest first) appended to the system prompt.
History / New chat buttons in the chat header. Conversations never go into the repo.

## Instant updates (Strava webhook)
`tools/strava-webhook-worker.js` runs as a Cloudflare Worker: Strava POSTs each new activity to it and it fires
`repository_dispatch` `new_strava_run` with the activity id. Strava allows one subscription per API app
(`GET/POST/DELETE https://www.strava.com/api/v3/push_subscriptions`). The 30-min schedule stays as a backstop.
Deployed as Worker `strava-relay` (callback `https://strava-relay.<subdomain>.workers.dev/<PATH_SECRET>`). Manage the subscription with
`node tools/strava-webhook.js status | create <callback_url> <verify_token> | delete` (needs Strava client id/secret in `.env`).

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
