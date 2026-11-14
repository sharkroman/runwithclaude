// Shared AI-coach chat (OpenRouter, called from the browser with a key the user types).
// Used by the run dashboard and the race roadbooks:
//   const chat = CoachChat.mount(containerEl, { lang: () => "en"|"zh", context: async () => "system prompt",
//                                               intro: {en, zh}, placeholder: {en, zh} });
//   chat.setLang();  // re-render labels after a language switch
// Optional: base (path to site root, for the memory API), label: () => "name shown in History".
// The key lives only in sessionStorage (this tab). localStorage is readable by every page on
// sharkroman.github.io, so any key an older version saved there is removed.
(function () {
  // Value picks from openrouter.ai/models (checked 2026-11-13), at least one per major lab.
  // Price = US$ per million input / output tokens. One coach message (~8k tokens of context) costs well under 5 cents on any of these.
  const MODELS = [
    ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5 · $2/$10"],
    ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5 · $0.10/$0.50"],
    ["openai/gpt-6.1-terra", "OpenAI GPT-6.1 Terra · $1/$5"],
    ["google/gemini-4-hydrogen", "Google Gemini 4 Hydrogen · $1.50/$7.50"],
    ["x-ai/grok-4.3", "xAI Grok 4.3 · $1.25/$2.50"],
    ["deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash · $0.30/$1.20"],
    ["qwen/qwen3.8-flash", "Qwen 3.8 Flash · $0.15/$0.47"],
    ["moonshotai/kimi-k2.6", "Kimi K2.6 · $0.65/$3.41"],
    ["z-ai/glm-5.3", "Z.ai GLM 5.3 · $0.08/$3.60"],
    ["minimax/minimax-m3.1-flash", "MiniMax M3.1 Flash · $0.15/$0.60"],
    ["mistralai/mistral-large-4-0", "Mistral Large 4 · $0.70/$2.10"],
    ["meta-llama/llama-4-maverick", "Meta Llama 4 Maverick · $0.35/$1"],
    ["openrouter/auto", "OpenRouter Auto"]
  ];
  const L = {
    en: { title: "AI Coach", key: "OpenRouter API key", model: "Model", send: "Send", new_chat: "New chat", history: "History", delete: "Delete",
          confirm_delete: "Delete this saved conversation?", no_history: "No saved conversations yet.",
          saved_local: "Conversations save automatically in this browser and are remembered in new chats.",
          saved_sync: "Conversations save automatically, sync across your devices, and are remembered in new chats.",
          you: "You", coach: "Coach", sys: "Error", need_key: "Enter your OpenRouter API key first.",
          key_note: "Kept only in this browser tab; cleared when you close it.", thinking: "Thinking…",
          placeholder: "Ask the coach…", tos: "This provider refused the request (often a region/VPN restriction on that lab). Pick a model from another lab above and send again.", cut: "The reply hit the length limit. Ask \"continue\" to get the rest." },
    zh: { title: "AI 教练", key: "OpenRouter API 密钥", model: "模型", send: "发送", new_chat: "新对话", history: "历史", delete: "删除",
          confirm_delete: "删除这条保存的对话？", no_history: "还没有保存的对话。",
          saved_local: "对话自动保存在此浏览器，新对话会记得之前聊过的内容。",
          saved_sync: "对话自动保存并在你的设备间同步，新对话会记得之前聊过的内容。",
          you: "你", coach: "教练", sys: "错误", need_key: "请先输入 OpenRouter API 密钥。",
          key_note: "只保存在当前标签页，关闭后即清除。", thinking: "思考中…",
          placeholder: "问问教练…", tos: "该模型厂商拒绝了请求（常见原因是该厂商的地区/VPN 限制）。请在上方换一家厂商的模型再发送。", cut: "回复达到长度上限被截断，发送“继续”获取剩余部分。" }
  };
  const CSS = `
.cc{font-size:13px;color:var(--cc-ink,#1A1A1A)}
.cc-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}
.cc-intro{font-size:12px;color:var(--cc-dim,#666);margin:0 0 10px;line-height:1.5}
.cc-cfg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.cc-cfg label{display:block;font-size:11px;color:var(--cc-dim,#666)}
.cc-cfg input,.cc-cfg select{width:100%;margin-top:4px;padding:7px 8px;border:1px solid var(--cc-line,#E5E1D8);border-radius:6px;background:var(--cc-bg,#F9F8F6);color:inherit;font:inherit;font-size:12px}
.cc-log{display:flex;flex-direction:column;gap:8px;max-height:var(--cc-max,260px);overflow-y:auto;margin-bottom:10px}
.cc-log:empty{display:none}
.cc-msg{padding:8px 10px;border-radius:10px;line-height:1.5;overflow-wrap:anywhere}
.cc-msg.you{align-self:flex-end;background:var(--cc-ink,#1A1A1A);color:#fff;max-width:85%}
.cc-msg.coach{background:var(--cc-soft,#F3F1EC);border:1px solid var(--cc-line,#E5E1D8)}
.cc-msg.sys{background:#FBEAE5;color:#8a2a17;font-size:12px}
.cc-msg p{margin:0 0 6px}.cc-msg p:last-child{margin:0}.cc-msg ul{margin:4px 0 6px 18px;padding:0}
.cc-row{display:flex;gap:6px}
.cc-row textarea{flex:1;resize:vertical;min-height:38px;max-height:160px;padding:8px 10px;border:1px solid var(--cc-line,#E5E1D8);border-radius:8px;background:var(--cc-bg,#F9F8F6);color:inherit;font:inherit;font-size:13px}
.cc-row button{padding:8px 14px;border:0;border-radius:8px;background:var(--cc-ink,#1A1A1A);color:#fff;font-weight:600;cursor:pointer;font-size:13px}
.cc-row button:disabled{opacity:.5;cursor:default}
.cc-acts{font-size:11px;color:var(--cc-dim,#666);white-space:nowrap}
.cc-hist{border:1px solid var(--cc-line,#E5E1D8);border-radius:8px;margin-bottom:10px;max-height:220px;overflow-y:auto}
.cc-hrow{display:flex;border-bottom:1px solid var(--cc-line,#E5E1D8)}.cc-hrow:last-child{border-bottom:0}
.cc-hopen{flex:1;min-width:0;text-align:left;border:0;background:none;color:inherit;font:inherit;font-size:12px;padding:7px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cc-hopen:hover{background:var(--cc-soft,#F3F1EC)}
.cc-hdel{border:0;background:none;color:var(--cc-dim,#666);font-size:15px;padding:0 10px;cursor:pointer}
.cc-empty{margin:0;padding:8px 10px;font-size:12px;color:var(--cc-dim,#666)}
.cc-save{margin:6px 0 0;font-size:11px;color:var(--cc-dim,#666)}
.cc-clear{border:0;background:none;color:var(--cc-dim,#666);font-size:11px;cursor:pointer;text-decoration:underline;padding:0}
@media(max-width:520px){.cc-cfg{grid-template-columns:1fr}}`;

  function injectCss() {
    if (document.getElementById("cc-style")) return;
    const s = document.createElement("style");
    s.id = "cc-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const esc = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Minimal, escape-first Markdown: paragraphs, bullet lists, **bold**.
  function md(text) {
    const out = [];
    let list = null;
    for (const raw of esc(text).split(/\n/)) {
      const line = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
      if (m) { (list = list || []).push(`<li>${m[1]}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      if (line.trim()) out.push(`<p>${line.replace(/^#+\s*/, "")}</p>`);
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    return out.join("");
  }

  // ---- Saved conversations ("coach memory") ----
  // Every conversation is saved automatically: in this browser (localStorage) and, on the
  // password-protected Cloudflare site, in Cloudflare KV via functions/api/coach-memory.js so it
  // follows you across devices. Past conversations are added to the system prompt of new ones.
  const STORE = "rwc_coach_chats", KEEP = 60, MEM_CHARS = 30000;
  const loadLocal = () => { try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch { return []; } };
  const saveLocal = list => { try { localStorage.setItem(STORE, JSON.stringify(list.slice(0, KEEP))); } catch {} };
  const byNewest = (a, b) => String(b.updated).localeCompare(String(a.updated));
  function merge(a, b) {
    const m = new Map();
    for (const c of [...a, ...b]) if (c && c.id && (!m.has(c.id) || String(c.updated) > String(m.get(c.id).updated))) m.set(c.id, c);
    return [...m.values()].filter(c => !c.deleted).sort(byNewest).slice(0, KEEP);
  }
  function memoryText(list, excludeId) {
    const out = [];
    let used = 0;
    for (const c of list.filter(c => c.id !== excludeId && c.messages?.length).sort(byNewest)) {
      const lines = c.messages.map(m => {
        const t = String(m.content || "").trim();
        return m.role === "user" ? `Athlete: ${t}` : `Coach: ${t.length > 1500 ? t.slice(0, 1500) + " …" : t}`;
      });
      let block = `### ${String(c.started).slice(0, 10)} · ${c.label || c.page}\n${lines.join("\n")}`;
      if (used + block.length > MEM_CHARS) {
        // Out of room: keep just what the athlete said in older conversations.
        block = `### ${String(c.started).slice(0, 10)} · ${c.label || c.page} (athlete's messages only)\n` +
          c.messages.filter(m => m.role === "user").map(m => `Athlete: ${String(m.content).slice(0, 600)}`).join("\n");
        if (used + block.length > MEM_CHARS) break;
      }
      out.push(block); used += block.length;
    }
    return out.length ? `\n\nEarlier conversations with this athlete (newest first). Use them as memory: plans, preferences and corrections the athlete made there still apply unless the data above or the athlete now says otherwise.\n${out.join("\n\n")}` : "";
  }

  function mount(root, opts) {
    injectCss();
    const lang = () => (opts.lang && opts.lang() === "en" ? "en" : "zh");
    const tx = k => L[lang()][k];
    const api = (opts.base || "") + "api/coach-memory";
    const page = location.pathname.replace(/index\.html$/, "") + location.search;
    root.classList.add("cc");
    root.innerHTML = `
      <div class="cc-head"><h2 class="cc-title"></h2><span class="cc-acts"><button class="cc-clear cc-hbtn" type="button"></button> · <button class="cc-clear cc-new" type="button"></button></span></div>
      <p class="cc-intro"></p>
      <div class="cc-hist" hidden></div>
      <div class="cc-cfg">
        <label><span class="cc-l-key"></span><input type="password" autocomplete="off" placeholder="sk-or-v1-…"></label>
        <label><span class="cc-l-model"></span><select>${MODELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
      </div>
      <div class="cc-log" aria-live="polite"></div>
      <div class="cc-row"><textarea rows="1"></textarea><button type="button" class="cc-send"></button></div>
      <p class="cc-save"></p>`;
    const q = s => root.querySelector(s);
    const keyIn = q(".cc-cfg input"), modelSel = q(".cc-cfg select"), log = q(".cc-log"),
          input = q("textarea"), send = q(".cc-send"), hist = q(".cc-hist");

    try { localStorage.removeItem("openrouter_key"); } catch {}
    try { keyIn.value = sessionStorage.getItem("openrouter_key") || ""; } catch {}
    keyIn.addEventListener("change", () => { try { sessionStorage.setItem("openrouter_key", keyIn.value.trim()); } catch {} });
    let savedModel = null;
    try { savedModel = localStorage.getItem("openrouter_model"); } catch {}
    modelSel.value = MODELS.some(m => m[0] === savedModel) ? savedModel : MODELS[0][0];
    modelSel.addEventListener("change", () => { try { localStorage.setItem("openrouter_model", modelSel.value); } catch {} });

    let chats = loadLocal(), synced = false;
    let convo = [], current = null, sysPrompt = null;
    const newConv = () => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), page,
      label: "", started: new Date().toISOString(), updated: "", messages: [] });

    async function pull() {
      try {
        const r = await fetch(api, { cache: "no-store", credentials: "same-origin" });
        if (!r.ok || !(r.headers.get("Content-Type") || "").includes("json")) return;
        chats = merge(chats, await r.json()); synced = true; saveLocal(chats);
      } catch {}
      status(); renderHist();
    }
    async function push(c) {
      try {
        const r = await fetch(api, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
        if (r.ok && (r.headers.get("Content-Type") || "").includes("json")) synced = true;
      } catch {}
      status();
    }
    function persist() {
      if (!current || !convo.length) return;
      current.messages = convo.slice();
      current.updated = new Date().toISOString();
      try { current.label = (opts.label && opts.label()) || document.title; } catch { current.label = document.title; }
      chats = merge(chats.filter(c => c.id !== current.id), [current]);
      saveLocal(chats);
      push(current);
      renderHist();
    }
    function status() { q(".cc-save").textContent = tx(synced ? "saved_sync" : "saved_local"); }

    function add(kind, text) {
      const d = document.createElement("div");
      d.className = "cc-msg " + kind;
      if (kind === "coach") d.innerHTML = md(text); else d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }
    function open(c) {
      current = c ? JSON.parse(JSON.stringify(c)) : newConv();
      convo = current.messages.slice(); sysPrompt = null;
      log.innerHTML = "";
      for (const m of convo) add(m.role === "user" ? "you" : "coach", m.content);
      hist.hidden = true;
    }
    function renderHist() {
      q(".cc-hbtn").textContent = `${tx("history")} (${chats.length})`;
      if (hist.hidden) return;
      hist.innerHTML = chats.length ? "" : `<p class="cc-empty">${esc(tx("no_history"))}</p>`;
      for (const c of chats) {
        const row = document.createElement("div");
        row.className = "cc-hrow";
        const first = (c.messages.find(m => m.role === "user") || {}).content || "";
        const b = document.createElement("button");
        b.type = "button"; b.className = "cc-hopen";
        b.textContent = `${String(c.started).slice(5, 10)} · ${c.label || c.page} — ${first.slice(0, 60)}`;
        b.addEventListener("click", () => open(c));
        const x = document.createElement("button");
        x.type = "button"; x.className = "cc-hdel"; x.textContent = "×"; x.title = tx("delete");
        x.addEventListener("click", () => {
          if (!confirm(tx("confirm_delete"))) return;
          chats = chats.filter(k => k.id !== c.id); saveLocal(chats);
          push({ id: c.id, deleted: true, updated: new Date().toISOString() });
          if (current && current.id === c.id) open(null);
          renderHist();
        });
        row.append(b, x); hist.appendChild(row);
      }
    }
    q(".cc-hbtn").addEventListener("click", () => { hist.hidden = !hist.hidden; renderHist(); });
    q(".cc-new").addEventListener("click", () => open(null));

    function setLang() {
      const l = lang();
      q(".cc-title").textContent = (opts.title && opts.title[l]) || tx("title");
      q(".cc-intro").textContent = (opts.intro && opts.intro[l]) || "";
      q(".cc-intro").hidden = !(opts.intro && opts.intro[l]);
      q(".cc-l-key").textContent = tx("key");
      q(".cc-l-model").textContent = tx("model");
      q(".cc-new").textContent = tx("new_chat");
      keyIn.title = tx("key_note");
      input.placeholder = (opts.placeholder && opts.placeholder[l]) || tx("placeholder");
      if (!send.disabled) send.textContent = tx("send");
      status(); renderHist();
    }
    async function go() {
      const text = input.value.trim();
      if (!text) return;
      const key = keyIn.value.trim();
      if (!key) { add("sys", tx("need_key")); keyIn.focus(); return; }
      try { sessionStorage.setItem("openrouter_key", key); } catch {}
      add("you", text);
      input.value = "";
      send.disabled = true;
      send.textContent = "…";
      const pending = add("coach", tx("thinking"));
      convo.push({ role: "user", content: text });
      try {
        if (!sysPrompt) {
          const sys = await opts.context();
          sysPrompt = sys + `\n\nReply in ${lang() === "en" ? "English" : "Simplified Chinese"} unless the user writes in another language. Be concise and specific to the data. Today is ${new Date().toISOString().slice(0, 10)}. If the data above does not cover something, say so instead of guessing.` +
            memoryText(chats, current.id);
        }
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
                     "HTTP-Referer": "https://sharkroman.github.io/runwithclaude", "X-Title": "Run With Claude" },
          body: JSON.stringify({ model: modelSel.value, messages: [{ role: "system", content: sysPrompt }, ...convo], max_tokens: 4000 })
        });
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 403 && /Terms Of Service/i.test(body)) throw new Error(`${modelSel.selectedOptions[0].text.split(" · ")[0]}: ${tx("tos")}`);
          throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
        }
        const data = await res.json();
        const choice = data?.choices?.[0] || {};
        const reply = choice.message?.content || "";
        convo.push({ role: "assistant", content: reply });
        pending.innerHTML = md(reply || "—");
        if (choice.finish_reason === "length") add("sys", tx("cut"));
        persist();
      } catch (err) {
        if (convo.length && convo[convo.length - 1].role === "user") convo.pop();
        pending.remove();
        add("sys", err.message);
        input.value = input.value || text;   // keep the question so it can be resent
      } finally {
        send.disabled = false;
        send.textContent = tx("send");
      }
    }
    send.addEventListener("click", go);
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });

    // Reopen the latest conversation from this page if it is less than a day old; else start fresh.
    const last = chats.find(c => c.page === page);
    open(last && Date.now() - new Date(last.updated) < 864e5 ? last : null);
    setLang();
    pull();
    return { setLang, reset: () => open(null) };
  }

  // Compact summaries of the most recent runs (for race and training questions).
  async function recentRuns(base, n = 6) {
    try {
      const idx = await (await fetch(base + "runs/index.json", { cache: "no-cache" })).json();
      const runs = await Promise.all(idx.slice(0, n).map(r =>
        fetch(`${base}runs/${r.id}.json`).then(x => x.json()).catch(() => null)));
      return runs.filter(Boolean).map(r =>
        `- ${r.date} "${r.name}": ${r.distance_km} km, +${r.elev_gain_m} m, ${r.moving} moving, ${r.pace}/km, HR ${r.avg_hr} avg / ${r.max_hr} max`
      ).join("\n");
    } catch { return ""; }
  }

  // The athlete's whole saved history from runs/summary.json (built by tools/summary.js): monthly
  // volume plus one line per run with climb/descent detail. Falls back to the last few runs.
  async function trainingLog(base, fallbackN = 8) {
    try {
      const sum = await (await fetch(base + "runs/summary.json", { cache: "no-cache" })).json();
      const runs = (sum.runs || []).filter(r => /run/i.test(r.sport || "Run"));
      if (!runs.length) throw new Error("empty");
      const months = {};
      for (const r of runs) {
        const m = months[r.date.slice(0, 7)] ||= { n: 0, km: 0, gain: 0, loss: 0 };
        m.n++; m.km += +r.km || 0; m.gain += +r.gain || 0; m.loss += +r.loss || 0;
      }
      const monthLines = Object.entries(months).sort().map(([k, m]) =>
        `${k}: ${m.n} runs, ${m.km.toFixed(1)} km, +${Math.round(m.gain)}/−${Math.round(m.loss)} m`).join("\n");
      const runLines = runs.map(r => {
        const parts = [`${r.date.slice(0, 10)} "${r.name}"`, r.place && `in ${r.place}`, `${r.km} km`, `+${r.gain}/−${r.loss ?? "?"} m`,
          r.alt_max != null && `alt ${r.alt_min}–${r.alt_max} m`, `${r.moving} moving @ ${r.pace}/km`,
          r.hr && `HR ${r.hr}/${r.hr_max}`];
        if (r.longest_descent_m >= 15) parts.push(`longest descent ${r.longest_descent_m} m over ${r.longest_descent_km} km (steepest 400 m ${r.steepest_400m_down_pct}%)`);
        if (r.downhill_pace && r.downhill_km >= 0.2) parts.push(`downhill ${r.downhill_km} km @ ${r.downhill_pace}`);
        if (r.uphill_pace && r.uphill_km >= 0.2) parts.push(`uphill ${r.uphill_km} km @ ${r.uphill_pace}`);
        return "- " + parts.filter(Boolean).join(", ");
      }).join("\n");
      return `Complete saved training history: ${runs.length} runs, ${runs[runs.length - 1].date.slice(0, 10)} to ${runs[0].date.slice(0, 10)}.
Downhill/uphill = time on grades ≤ −4% / ≥ 4%; "longest descent" = biggest continuous drop.
Monthly volume:
${monthLines}
Every run, newest first:
${runLines}`;
    } catch {
      const recent = await recentRuns(base, fallbackN);
      return recent ? `Most recent ${fallbackN} runs only (full history unavailable):\n${recent}` : "";
    }
  }

  window.CoachChat = { mount, recentRuns, trainingLog };
})();
