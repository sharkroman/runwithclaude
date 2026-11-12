// Cloudflare Pages Function: one shared password (HTTP Basic Auth) in front of the whole site,
// including runs/*.json. Ignored by GitHub Pages; active only when the repo is deployed on Cloudflare Pages.
// Set the Pages secret SITE_PASSWORD (ASCII only); optional SITE_USER (default "run").
export async function onRequest({ request, env, next }) {
  if (!env.SITE_PASSWORD) return new Response("Site password not configured.", { status: 503 });
  const expected = "Basic " + btoa(`${env.SITE_USER || "run"}:${env.SITE_PASSWORD}`);
  const got = request.headers.get("Authorization") || "";
  if (await same(got, expected)) return next();
  return new Response("Password required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Run With Claude", charset="UTF-8"', "Cache-Control": "no-store" }
  });
}

// Constant-time comparison via hashing, so response timing doesn't leak the password.
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
