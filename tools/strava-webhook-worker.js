// Cloudflare Worker: Strava webhook -> GitHub repository_dispatch (new_strava_run).
// Paste into a Worker (module syntax). Secrets/vars to set on the Worker:
//   PATH_SECRET   random string; the callback URL is https://<worker>.workers.dev/<PATH_SECRET>
//   VERIFY_TOKEN  random string; also passed to Strava when creating the subscription
//   ATHLETE_ID    your Strava athlete id (number in strava.com/athletes/<id>); other athletes are ignored
//   GITHUB_TOKEN  fine-grained PAT, only this repo, "Contents: Read and write" (needed for repository_dispatch)
//   GITHUB_REPO   e.g. sharkroman/runwithclaude (plain variable)
// Strava does not sign webhook calls, so the secret path + athlete check keep strangers out;
// the worst a forged call can do is make the workflow re-process one of your own activities.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.PATH_SECRET || url.pathname !== `/${env.PATH_SECRET}`) {
      return new Response("Not found", { status: 404 });
    }

    // Strava validates the callback once, when the subscription is created.
    if (request.method === "GET") {
      const p = url.searchParams;
      if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === env.VERIFY_TOKEN && p.get("hub.challenge")) {
        return Response.json({ "hub.challenge": p.get("hub.challenge") });
      }
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      let ev;
      try { ev = await request.json(); } catch { return new Response("Bad request", { status: 400 }); }
      const wanted = ev.object_type === "activity" && ev.aspect_type === "create" &&
        String(ev.owner_id) === String(env.ATHLETE_ID) && /^\d+$/.test(String(ev.object_id));
      if (wanted) ctx.waitUntil(dispatch(env, String(ev.object_id)));
      // Strava needs a 200 within 2 seconds, so the GitHub call runs after responding.
      return new Response("ok");
    }
    return new Response("Method not allowed", { status: 405 });
  }
};

async function dispatch(env, activityId) {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "runwithclaude-strava-relay"
    },
    body: JSON.stringify({ event_type: "new_strava_run", client_payload: { activity_id: activityId } })
  });
  console.log(`dispatch ${activityId}: GitHub ${res.status}`);
  if (!res.ok) console.log(await res.text());
}
