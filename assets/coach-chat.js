// Shared AI-coach chat (OpenRouter, called from the browser with a key the user types).
// Used by the run dashboard and the race roadbooks:
//   const chat = CoachChat.mount(containerEl, { lang: () => "en"|"zh", context: async () => "system prompt",
//                                               intro: {en, zh}, placeholder: {en, zh} });
//   chat.setLang();  // re-render labels after a language switch
// The key lives only in sessionStorage (this tab). localStorage is readable by every page on
// sharkroman.github.io, so any key an older version saved there is removed.
(function () {
  const MODELS = [
    ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5"],
    ["anthropic/claude-opus-5.5", "Claude Opus 5.5"],
    ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5"],
    ["openai/gpt-4o", "GPT-4o"],
    ["google/gemini-2.5-pro", "Gemini 2.5 Pro"],
    ["meta-llama/llama-4-maverick", "Llama 4 Maverick"],
    ["openrouter/auto", "OpenRouter Auto"]
  ];
  const L = {
    en: { title: "AI Coach", key: "OpenRouter API key", model: "Model", send: "Send", clear: "Clear",
          you: "You", coach: "Coach", sys: "Error", need_key: "Enter your OpenRouter API key first.",
          key_note: "Kept only in this browser tab; cleared when you close it.", thinking: "Thinking…",
          placeholder: "Ask the coach…", cut: "The reply hit the length limit. Ask \"continue\" to get the rest." },
    zh: { title: "AI 教练", key: "OpenRouter API 密钥", model: "模型", send: "发送", clear: "清空",
          you: "你", coach: "教练", sys: "错误", need_key: "请先输入 OpenRouter API 密钥。",
          key_note: "只保存在当前标签页，关闭后即清除。", thinking: "思考中…",
          placeholder: "问问教练…", cut: "回复达到长度上限被截断，发送“继续”获取剩余部分。" }
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

  function mount(root, opts) {
    injectCss();
    const lang = () => (opts.lang && opts.lang() === "en" ? "en" : "zh");
    const tx = k => L[lang()][k];
    root.classList.add("cc");
    root.innerHTML = `
      <div class="cc-head"><h2 class="cc-title"></h2><button class="cc-clear" type="button"></button></div>
      <p class="cc-intro"></p>
      <div class="cc-cfg">
        <label><span class="cc-l-key"></span><input type="password" autocomplete="off" placeholder="sk-or-v1-…"></label>
        <label><span class="cc-l-model"></span><select>${MODELS.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select></label>
      </div>
      <div class="cc-log" aria-live="polite"></div>
      <div class="cc-row"><textarea rows="1"></textarea><button type="button" class="cc-send"></button></div>`;
    const q = s => root.querySelector(s);
    const keyIn = q(".cc-cfg input"), modelSel = q(".cc-cfg select"), log = q(".cc-log"),
          input = q("textarea"), send = q(".cc-send");

    try { localStorage.removeItem("openrouter_key"); } catch {}
    try { keyIn.value = sessionStorage.getItem("openrouter_key") || ""; } catch {}
    keyIn.addEventListener("change", () => { try { sessionStorage.setItem("openrouter_key", keyIn.value.trim()); } catch {} });
    let savedModel = null;
    try { savedModel = localStorage.getItem("openrouter_model"); } catch {}
    modelSel.value = MODELS.some(m => m[0] === savedModel) ? savedModel : MODELS[0][0];
    modelSel.addEventListener("change", () => { try { localStorage.setItem("openrouter_model", modelSel.value); } catch {} });

    let convo = [];
    function add(kind, text) {
      const d = document.createElement("div");
      d.className = "cc-msg " + kind;
      if (kind === "coach") d.innerHTML = md(text); else d.textContent = text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
      return d;
    }
    function setLang() {
      const l = lang();
      q(".cc-title").textContent = (opts.title && opts.title[l]) || tx("title");
      q(".cc-intro").textContent = (opts.intro && opts.intro[l]) || "";
      q(".cc-intro").hidden = !(opts.intro && opts.intro[l]);
      q(".cc-l-key").textContent = tx("key");
      q(".cc-l-model").textContent = tx("model");
      q(".cc-clear").textContent = tx("clear");
      keyIn.title = tx("key_note");
      input.placeholder = (opts.placeholder && opts.placeholder[l]) || tx("placeholder");
      if (!send.disabled) send.textContent = tx("send");
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
      try {
        if (!convo.length) {
          const sys = await opts.context();
          convo.push({ role: "system", content: sys + `\n\nReply in ${lang() === "en" ? "English" : "Simplified Chinese"} unless the user writes in another language. Be concise and specific to the data. Today is ${new Date().toISOString().slice(0, 10)}. If the data above does not cover something, say so instead of guessing.` });
        }
        convo.push({ role: "user", content: text });
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
                     "HTTP-Referer": "https://sharkroman.github.io/runwithclaude", "X-Title": "Run With Claude" },
          body: JSON.stringify({ model: modelSel.value, messages: convo, max_tokens: 4000 })
        });
        if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        const choice = data?.choices?.[0] || {};
        const reply = choice.message?.content || "";
        convo.push({ role: "assistant", content: reply });
        pending.innerHTML = md(reply || "—");
        if (choice.finish_reason === "length") add("sys", tx("cut"));
      } catch (err) {
        convo = convo.filter((m, i) => !(i === convo.length - 1 && m.role === "user"));
        pending.remove();
        add("sys", err.message);
      } finally {
        send.disabled = false;
        send.textContent = tx("send");
      }
    }
    send.addEventListener("click", go);
    input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); } });
    q(".cc-clear").addEventListener("click", () => { convo = []; log.innerHTML = ""; });
    setLang();
    return { setLang, reset: () => { convo = []; } };
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
        const parts = [`${r.date.slice(0, 10)} "${r.name}"`, `${r.km} km`, `+${r.gain}/−${r.loss ?? "?"} m`,
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
