// Cloudflare Pages Function: stores AI-coach conversations so they follow you across devices.
// Protected by functions/_middleware.js (site password). Data lives in Cloudflare KV, never in the repo.
// Setup: Workers & Pages -> KV -> create namespace "coach-memory"; then the Pages project ->
// Settings -> Bindings -> Add -> KV namespace, variable name COACH_KV -> that namespace; redeploy.
// Without the binding this returns 501 and the chat falls back to saving in the browser only.
//   GET  -> [conversation, ...] newest first
//   PUT  -> body: one conversation {id, updated, ...} (or {id, deleted:true, updated}); upserted by id
const KEY = "chats";
const KEEP = 60;
const MAX_BYTES = 400_000;   // one conversation

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

export async function onRequest({ request, env }) {
  if (!env.COACH_KV) return new Response("COACH_KV binding not configured.", { status: 501 });
  const list = (await env.COACH_KV.get(KEY, "json")) || [];

  if (request.method === "GET") return json(list.filter(c => !c.deleted));

  if (request.method === "PUT") {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: "too large" }, 413);
    let c;
    try { c = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
    if (!c || typeof c.id !== "string" || !/^[a-z0-9]{4,40}$/.test(c.id) || typeof c.updated !== "string") {
      return json({ error: "bad conversation" }, 400);
    }
    const old = list.find(x => x.id === c.id);
    if (old && String(old.updated) > c.updated) return json({ ok: true, stale: true });
    // Deletions are kept as small tombstones so other devices drop their copy too.
    const entry = c.deleted ? { id: c.id, deleted: true, updated: c.updated } : c;
    const next = [entry, ...list.filter(x => x.id !== c.id)]
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    const live = next.filter(x => !x.deleted).slice(0, KEEP);
    const tombs = next.filter(x => x.deleted).slice(0, 200);
    await env.COACH_KV.put(KEY, JSON.stringify([...live, ...tombs]));
    return json({ ok: true });
  }

  return new Response("Method not allowed", { status: 405 });
}
