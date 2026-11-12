// Cloudflare Pages Function: one shared password in front of the whole site, including runs/*.json.
// Ignored by GitHub Pages; active only when the repo is deployed on Cloudflare Pages.
// Set the Pages secret SITE_PASSWORD. Logging in sets an HttpOnly cookie for a year;
// changing the password signs everyone out. /__logout clears the cookie on this device.
const COOKIE = "rwc_auth";
const YEAR = 60 * 60 * 24 * 365;

export async function onRequest({ request, env, next }) {
  if (!env.SITE_PASSWORD) return new Response("Site password not configured.", { status: 503 });
  const url = new URL(request.url);
  const token = await sha256hex(`rwc-session:${env.SITE_PASSWORD}`);

  if (url.pathname === "/__logout") {
    return redirect("/", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  }

  if (url.pathname === "/__login" && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const given = String(form?.get("password") || "");
    const back = safePath(String(form?.get("next") || "/"));
    if (await same(await sha256hex(`rwc-session:${given}`), token)) {
      return redirect(back, `${COOKIE}=${token}; Path=/; Max-Age=${YEAR}; HttpOnly; Secure; SameSite=Lax`);
    }
    return loginPage(back, true);
  }

  if (await same(readCookie(request, COOKIE), token)) return next();

  // Pages get the login form; data/asset requests just get 401.
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (request.method === "GET" && wantsHtml) return loginPage(url.pathname + url.search, false);
  return new Response("Password required.", { status: 401, headers: { "Cache-Control": "no-store" } });
}

function loginPage(next, failed) {
  const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Run With Claude</title>
<style>
:root{--bg:#F9F8F6;--panel:#fff;--ink:#1A1A1A;--dim:#6B6B6B;--line:#E5E1D8;--clay:#D97757}
@media (prefers-color-scheme:dark){:root{--bg:#1A1918;--panel:#242321;--ink:#EEE;--dim:#A8A49C;--line:#3A3835}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;padding:16px}
form{width:100%;max-width:320px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--dim);font-size:13px}
input[type=password]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--bg);color:inherit}
button{width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;background:var(--ink);color:var(--bg);font-size:15px;font-weight:600;cursor:pointer}
.err{color:var(--clay);font-size:13px;margin:10px 0 0}
</style></head><body>
<form method="post" action="/__login">
<h1>Run With Claude</h1><p>Password · 密码</p>
<input type="text" name="username" value="run" autocomplete="username" hidden>
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
<input type="hidden" name="next" value="${esc(next)}">
<button type="submit">Enter · 进入</button>
${failed ? '<p class="err">Wrong password · 密码错误</p>' : ""}
</form></body></html>`;
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

function redirect(location, cookie) {
  return new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}

// Only same-site paths, so the login form can't be used to bounce people elsewhere.
function safePath(p) {
  return p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/__") ? p : "/";
}

function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time comparison (both sides hashed first, so lengths always match).
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}
