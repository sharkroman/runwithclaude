// Single source of truth for race/route roadbooks (races/<slug>/). Used by the dashboard
// (race card + roadbook dropdown) and by every roadbook page's switcher.
window.RWC_ROADBOOKS = [
  { slug: "mogan-20k-2027", date: "2027-04-10", // date TBC: 2026 edition was Apr 10–12
    name: { en: "Mogan 20K · UTMB", zh: "莫干山 20K · UTMB" },
    place: { en: "Deqing, Zhejiang · spring 2027 (date TBC)", zh: "浙江德清 · 2027 春季（日期待定）" } },
  { slug: "goleta-courtyard-8k", date: "2026-11-21",
    name: { en: "Courtyard 8K", zh: "Courtyard 8K" },
    place: { en: "Goleta, Santa Barbara · Nov 21", zh: "圣巴巴拉 Goleta · 11月21日" } },
  { slug: "catalina-10k-2026-11-14", date: "2026-11-14",
    name: { en: "Catalina 10K", zh: "Catalina 10K" },
    place: { en: "Avalon, Catalina Island · Nov 14", zh: "加州 Catalina 岛 Avalon · 11月14日" } }
];
window.RWC_mountRoadbookSwitcher = function (nav, current, getLang) {
  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Roadbooks / 路书");
  sel.style.cssText = "max-width:210px;padding:5px 8px;border:1px solid var(--line);border-radius:4px;background:var(--panel,#fff);color:var(--ink,#1a1a1a);font:inherit;font-size:11px;min-height:32px;cursor:pointer";
  const render = () => {
    const zh = getLang() === "zh";
    sel.innerHTML = [...window.RWC_ROADBOOKS].sort((a, b) => b.date.localeCompare(a.date))
      .map(r => `<option value="${r.slug}"${r.slug === current ? " selected" : ""}>${r.date} · ${r.name[zh ? "zh" : "en"]}</option>`).join("");
  };
  sel.onchange = () => { location.href = "../" + sel.value + "/"; };
  render();
  nav.insertBefore(sel, nav.querySelector(".language-switch"));
  ["langEn", "langZh"].forEach(id => document.getElementById(id)?.addEventListener("click", () => setTimeout(render, 0)));
};
