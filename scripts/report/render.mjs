// BBQレポート専用のページ書き出し（2026-09-27 山根さんFBで page-kit から切り替え）
//   なぜ: page-kit はビジネス資料の型（要点3つ・章地図・注意書き・実施すること）で、BBQの「やりました」レポートには重い。
//         「空白がもったいない」「写真が大きい」「持ち帰る要点はいらない」を受けて、yoron-bbq.com の世界観で1枚に組み直す。
//   形: 冒頭（タイトル・リード・今日の人）→ 今日の数字＋メニュー（写真つきカード）→ 章（PCは本文｜写真＋吹き出しの2段組み・スマホは縦積み）→ フッター
//   入力: report-loop が作る page.json（prompt.md の形）。写真は img/photos/<番号>.jpg（切り抜き済み）、キャラは img/bbq/*.svg
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = "https://yoron-bbq.com";
export const LABEL_TO_CHAR = { ANCHAN: "anchan", YAMACHAN: "yama", UETAKU: "uetaku", YOSSY: "yossy", YUTA: "yuta" };
export const NAME_TO_CHAR = { "あんちゃん": "anchan", "やまちゃん": "yama", "うえたく": "uetaku", "ヨッシー": "yossy", "裕太さん": "yuta" };

export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** **太字** だけ許す（それ以外はエスケープ） */
export const md = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d95f3b'/%3E%3Ctext x='16' y='23' font-family='sans-serif' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3EY%3C/text%3E%3C/svg%3E`;

// yoron-bbq.com の community.css の色・フォントを写したもの。黒ベタ背景は使わない（フッターもクリーム）
const CSS = `
:root{--bg:#f6f1e4;--soft:#efe8d6;--card:#fffdf6;--ink:#2d251c;--ink2:#5b5044;--muted:#8a8177;--ember:#d95f3b;--ember2:#b74a2c;--amber:#e89b3f;--line:rgba(45,37,28,.12);--r:18px}
*{box-sizing:border-box;margin:0;padding:0}
html{overflow-x:clip}
body{font-family:'Zen Maru Gothic','Noto Sans JP',sans-serif;background:var(--bg);background-image:radial-gradient(circle at 12% 6%,rgba(232,155,63,.10),transparent 36%),radial-gradient(circle at 90% 28%,rgba(217,95,59,.06),transparent 40%);color:var(--ink);line-height:1.85;font-weight:500;overflow-x:hidden}
img{max-width:100%;display:block}
a{color:inherit}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
.nav{position:sticky;top:0;z-index:20;background:rgba(246,241,228,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.nav .wrap{display:flex;align-items:center;gap:14px;height:58px}
.logo{font-weight:900;font-size:1.05rem;letter-spacing:.06em;text-decoration:none;white-space:nowrap}
.logo small{font-size:.58rem;font-weight:700;letter-spacing:.22em;color:var(--ember);margin-left:.45rem}
.nav .sp{flex:1}
.nav a.l{font-size:.8rem;font-weight:700;color:var(--ink2);text-decoration:none;white-space:nowrap}
.nav a.cta{background:var(--ember);color:#fff;padding:.42rem 1rem;border-radius:100px;font-size:.8rem;font-weight:700;text-decoration:none;white-space:nowrap}
.hero{padding:34px 0 8px}
.eyebrow{font-size:.68rem;letter-spacing:.3em;color:var(--ember);font-weight:900}
.kind{display:inline-block;margin-top:8px;font-size:.78rem;font-weight:900;color:var(--ember2);background:rgba(217,95,59,.08);border-radius:999px;padding:3px 12px}
h1{font-size:clamp(1.5rem,3.6vw,2.2rem);font-weight:900;line-height:1.4;margin-top:10px;letter-spacing:.01em}
.lead{margin-top:10px;font-size:1rem;color:var(--ink2);max-width:760px}
.lead b{color:var(--ink)}
.cast{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:18px}
.cast .p{display:flex;align-items:center;gap:8px}
.cast .av{width:44px;height:44px;border-radius:14px;background:#fbf1e2;overflow:hidden;flex:none;display:grid;place-items:center;font-weight:900;color:var(--ember2)}
.cast .av img{width:44px;height:44px;object-fit:contain}
.cast .n{font-weight:900;font-size:.9rem;line-height:1.2}
.cast .r{font-size:.72rem;color:var(--muted);font-weight:700;line-height:1.3}
.voice{display:flex;align-items:flex-end;gap:8px;margin:14px 0}
.voice img{width:62px;height:auto;flex:none}
.voice .sb{position:relative;background:#fff;border:2px solid var(--ink);border-radius:16px;padding:10px 13px 8px;font-size:.84rem;font-weight:700;line-height:1.7;box-shadow:0 4px 12px rgba(45,37,28,.08)}
.voice .sb b{color:var(--ember2)}
.voice .sb::before{content:"";position:absolute;left:-8px;bottom:18px;width:12px;height:12px;background:#fff;border-left:2px solid var(--ink);border-bottom:2px solid var(--ink);transform:rotate(45deg)}
.voice .lb{display:block;font-size:.62rem;letter-spacing:.12em;color:var(--muted);font-weight:900;margin-top:4px}
.hero .voice{max-width:760px}
.sec{background:var(--card);border-radius:var(--r);box-shadow:0 4px 22px rgba(45,37,28,.06);padding:22px 24px;margin:18px 0}
.sec h2{font-size:1.18rem;font-weight:900;line-height:1.45;display:flex;gap:10px;align-items:flex-start}
.sec h2 .no{flex:none;width:30px;height:30px;border-radius:9px;background:var(--ember);color:#fff;font-size:.85rem;display:grid;place-items:center;margin-top:1px}
.sec .cl{margin-top:6px;font-weight:700;color:var(--ink)}
.cols{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:22px;margin-top:10px;align-items:start}
.body p{font-size:.93rem;color:var(--ink2);margin-top:8px}
.body p:first-child{margin-top:0}
.side .voice{margin-top:12px}
.body .voice{margin-top:14px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
.stat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:8px 16px;min-width:120px}
.stat .v{font-size:1.6rem;font-weight:900;color:var(--ember);line-height:1.2}
.stat .v small{font-size:.8rem;margin-left:2px}
.stat .l{font-size:.74rem;font-weight:700;color:var(--ink2)}
.menu{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;margin-top:14px}
.dish{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;padding:8px}
/* メニューの写真は少し大きめ（2026-09-27 山根さん「もう少しだけ大きく」） */
.dish img{width:96px;height:96px;object-fit:cover;border-radius:12px;flex:none;cursor:zoom-in}
.dish .ph{width:96px;height:96px;border-radius:10px;background:var(--soft);flex:none;display:grid;place-items:center;font-size:.62rem;color:var(--muted);font-weight:900}
.dish b{display:block;font-size:.86rem;line-height:1.4}
.dish span{display:block;font-size:.72rem;color:var(--ink2);line-height:1.5}
.dish i{font-style:normal;font-size:.66rem;font-weight:900;color:var(--ember2)}
/* 写真: 右の列いっぱいの幅で縦に並べる（2026-09-27 山根さん「110pxは小さすぎ・3倍くらいでいい」） */
.yphs{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.yph{margin:0}
.yphs.row{grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin-top:14px}
.yphs.row .yph img{height:220px;max-height:none}
.cols.one{grid-template-columns:minmax(0,1fr)}
.yph img{width:100%;height:auto;max-height:300px;object-fit:cover;border-radius:12px;cursor:zoom-in}
.yph figcaption{font-size:.72rem;font-weight:700;color:var(--muted);margin-top:4px;line-height:1.45}
.fig{margin-top:14px}
.fig .cap{font-size:.74rem;font-weight:900;color:var(--ember2);margin-bottom:6px}
.fig .note{font-size:.72rem;color:var(--muted);margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:.82rem;background:#fff;border-radius:12px;overflow:hidden}
th{background:var(--soft);text-align:left;font-weight:900;padding:7px 10px;white-space:nowrap}
td{padding:7px 10px;border-top:1px solid var(--line);color:var(--ink2);vertical-align:top;overflow-wrap:anywhere}
td b{color:var(--ink)}
.vs{display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:stretch}
.vs .bx{background:#fff;border:1px solid var(--line);border-radius:12px;padding:9px 12px}
.vs .bx.main{background:rgba(217,95,59,.07);border-color:rgba(217,95,59,.35)}
.vs .lbl{font-size:.66rem;color:var(--muted);font-weight:900}
.vs .t{font-weight:900;font-size:.92rem}
.vs .d{font-size:.76rem;color:var(--ink2);line-height:1.6}
.vs .mid{align-self:center;color:var(--muted);font-weight:900}
.flow{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch}
.flow .st{flex:1 1 150px;background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 11px}
.flow .st.hi{background:rgba(217,95,59,.07);border-color:rgba(217,95,59,.35)}
.flow .st b{display:block;font-size:.86rem}
.flow .st span{font-size:.74rem;color:var(--ink2)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.grid .it{background:#fff;border:1px solid var(--line);border-radius:12px;padding:8px 11px}
.grid .it.hi{background:rgba(217,95,59,.07);border-color:rgba(217,95,59,.35)}
.grid .it b{display:block;font-size:.86rem}
.grid .it span{display:block;font-size:.74rem;color:var(--ink2);line-height:1.55}
.grid .it i{font-style:normal;font-size:.64rem;font-weight:900;color:var(--ember2)}
.foot{background:var(--soft);margin-top:34px;padding:26px 0 30px;border-radius:32px 32px 0 0;font-size:.78rem;color:var(--ink2)}
.foot .row{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between;align-items:center}
.foot nav{display:flex;flex-wrap:wrap;gap:6px 16px}
.foot nav a{text-decoration:none;font-weight:700}
.foot .src{margin-top:10px;font-size:.72rem;color:var(--muted)}
.ylb{position:fixed;inset:0;z-index:100;background:rgba(45,37,28,.82);display:none;align-items:center;justify-content:center;padding:20px;cursor:zoom-out}
.ylb.on{display:flex}
.ylb img{max-width:min(900px,100%);max-height:88vh;border-radius:12px;object-fit:contain}
@media (max-width:760px){
  .nav a.l{display:none}
  .cols{grid-template-columns:minmax(0,1fr);gap:12px}
  .sec{padding:18px 16px}
  .yph img{max-height:260px}
  .yphs.row{grid-template-columns:repeat(2,minmax(0,1fr))}
  .yphs.row .yph img{height:140px}
  .menu{grid-template-columns:minmax(0,1fr)}
  .vs{grid-template-columns:minmax(0,1fr)}
  .vs .mid{justify-self:center}
  /* 表はスマホでは1行ずつのカードに（1列目が1文字ずつ折り返されないように） */
  table,tbody,tr,td{display:block;width:100%}
  thead{display:none}
  tr{border-top:1px solid var(--line);padding:8px 10px}
  tr:first-child{border-top:0}
  td{border:0;padding:2px 0}
  td:first-child{font-weight:900;color:var(--ink)}
  td:not(:first-child)::before{content:attr(data-h) "：";font-weight:900;color:var(--muted);font-size:.72rem}
}
`;

const charImg = (key) => (key ? `img/bbq/${key}.svg` : "img/bbq/yama.svg");
const labelKey = (label) => LABEL_TO_CHAR[String(label || "").split(/\s/)[0]];

export function voiceHtml(v) {
  if (!v || !v.text) return "";
  return `<div class="voice"><img src="${charImg(labelKey(v.label))}" alt=""><div class="sb">${md(v.text)}${v.label ? `<span class="lb">${esc(v.label)}</span>` : ""}</div></div>`;
}

const photoName = (f) => (String(f.url || "").match(/^img\/photos\/([\w.-]+\.jpg)$/) || [])[1];
function photosHtml(figs, { row = false } = {}) {
  const ph = figs.filter((f) => f.kind === "image" && photoName(f));
  if (!ph.length) return "";
  return `<div class="yphs${row ? " row" : ""}">${ph.map((f) => `<figure class="yph"><img src="img/photos/${photoName(f)}" alt="${esc(f.alt || f.cap || "")}"><figcaption>${esc(f.cap || "")}</figcaption></figure>`).join("")}</div>`;
}

export function figureHtml(f) {
  const cap = f.cap ? `<div class="cap">${esc(f.cap)}</div>` : "";
  const note = f.note ? `<div class="note">${md(f.note)}</div>` : "";
  let inner = "";
  switch (f.kind) {
    case "table":
      inner = `<table><thead><tr>${(f.head || []).map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${(f.rows || []).map((r) => `<tr>${r.map((c, j) => `<td data-h="${esc((f.head || [])[j] || "")}">${md(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      break;
    case "vs": {
      const bx = (o, main) => `<div class="bx${main ? " main" : ""}"><div class="lbl">${esc(o?.lb || "")}</div><div class="t">${esc(o?.t || "")}</div><div class="d">${esc(o?.d || "")}</div></div>`;
      inner = `<div class="vs">${bx(f.left, f.left?.main)}<div class="mid">${esc(f.mid || "→")}</div>${bx(f.right, f.right?.main !== false)}</div>`;
      break;
    }
    case "flow":
    case "timeline":
      inner = `<div class="flow">${(f.items || []).map((it) => `<div class="st${it.hi ? " hi" : ""}"><b>${esc(it.t || it.l || "")}${f.kind === "timeline" && it.l ? `　${esc(it.l)}` : ""}</b><span>${esc(it.d || "")}</span></div>`).join("")}</div>`;
      break;
    case "grid":
      inner = `<div class="grid">${(f.items || []).map((it) => `<div class="it${it.hi ? " hi" : ""}"><b>${esc(it.t)}</b><span>${esc(it.d || "")}</span>${it.q ? `<i>${esc(it.q)}</i>` : ""}</div>`).join("")}</div>`;
      break;
    default:
      return "";
  }
  return `<div class="fig">${cap}${inner}${note}</div>`;
}

/** 料理一覧（今日のメニュー）: table の各行を、写真つきのカードにする。写真は「料理名に一致する画像の cap」から引く */
export function menuHtml(table, photosByCap) {
  if (!table) return "";
  const rows = table.rows || [];
  const find = (name) => {
    const n = String(name).replace(/\s/g, "");
    for (const [cap, file] of photosByCap) { const c = cap.replace(/\s/g, ""); if (c.includes(n) || n.includes(c.replace(/[（(].*$/, ""))) return file; }
    return "";
  };
  return `<div class="menu">${rows.map((r) => {
    const file = /^[\w.-]+\.jpg$/.test(String(r[3] || "")) ? r[3] : find(r[0]);
    const who = r[2] && r[2] !== "—" ? `<i>${esc(r[2])}</i>` : "";
    return `<div class="dish">${file ? `<img src="img/photos/${file}" alt="${esc(r[0])}">` : `<div class="ph">写真なし</div>`}<div><b>${esc(r[0])}</b><span>${esc(r[1] || "")}</span>${who}</div></div>`;
  }).join("")}</div>`;
}

export function renderReportHtml(page) {
  const allImages = [];
  const walk = (o) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === "object") { if (o.kind === "image" && photoName(o)) allImages.push(o); Object.values(o).forEach(walk); } };
  walk(page.chapters || []);
  const photosByCap = allImages.map((f) => [String(f.cap || f.alt || ""), photoName(f)]);

  const figs = page.figures || [];
  const stat = figs.find((f) => f.kind === "stat");
  const menuTable = figs.find((f) => f.kind === "table");
  const cast = (page.speakers || []).map((s) => {
    const key = NAME_TO_CHAR[s.name];
    return `<div class="p"><span class="av">${key ? `<img src="img/bbq/${key}-face.svg" alt="">` : esc(String(s.name || "").slice(0, 1))}</span><div><div class="n">${esc(s.name)}</div><div class="r">${esc(s.role || "")}</div></div></div>`;
  }).join("");

  const chapters = (page.chapters || []).map((c, i) => {
    const imgs = [...(c.figuresTop || []), ...(c.figures || [])];
    const others = imgs.filter((f) => f.kind !== "image");
    const body = (c.body || []).map((p) => `<p>${md(p)}</p>`).join("");
    // 写真1枚なら右の列に吹き出しと一緒に。2枚以上なら右は吹き出しだけにして、写真は本文の下に横並び（左に空白を作らない）
    const nPhotos = imgs.filter((f) => f.kind === "image" && photoName(f)).length;
    //   写真1枚: 左=本文＋吹き出し／右=写真（左右の高さがそろいやすい）
    const left = nPhotos === 1 ? `${body}${voiceHtml(c.voice)}` : body;
    const side = nPhotos === 1 ? photosHtml(imgs) : voiceHtml(c.voice);
    return `<section class="sec" id="c${i + 1}">
  <h2><span class="no">${i + 1}</span><span>${esc(c.title)}</span></h2>
  ${c.lead ? `<p class="cl">${md(c.lead)}</p>` : ""}
  <div class="cols${side ? "" : " one"}"><div class="body">${left}</div>${side ? `<div class="side">${side}</div>` : ""}</div>
  ${nPhotos > 1 ? photosHtml(imgs, { row: true }) : ""}
  ${others.map(figureHtml).join("")}
</section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(page.title)} | YORON BBQ レポート</title>
<meta name="description" content="${esc(String(page.lead || "").replace(/\*\*/g, "").slice(0, 120))}">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head><body>
<header class="nav"><div class="wrap"><a class="logo" href="${SITE}/">YORON BBQ<small>COMMUNITY</small></a><span class="sp"></span><a class="l" href="${SITE}/report/">BBQレポート</a><a class="l" href="${SITE}/event.html">バーベキューイベント</a><a class="cta" href="${SITE}/index.html#join">仲間に入る</a></div></header>
<main class="wrap">
<div class="hero">
  <div class="eyebrow">YORON BBQ REPORT</div>
  ${page.kind ? `<span class="kind">${esc(page.kind)}</span>` : ""}
  <h1>${esc(page.title)}</h1>
  <p class="lead">${md(page.lead || "")}</p>
  ${cast ? `<div class="cast">${cast}</div>` : ""}
  ${voiceHtml(page.voice)}
</div>
${stat || menuTable ? `<section class="sec" id="menu">
  <h2><span>${esc(menuTable?.cap || "今日のメニュー")}</span></h2>
  ${stat ? `<div class="stats">${(stat.items || []).slice(0, 3).map((s) => `<div class="stat"><div class="v">${esc(s.v)}<small>${esc(s.u || "")}</small></div><div class="l">${esc(s.l || "")}</div></div>`).join("")}</div>` : ""}
  ${menuHtml(menuTable, photosByCap)}
</section>` : ""}
${chapters}
</main>
<footer class="foot"><div class="wrap">
  <div class="row"><a class="logo" href="${SITE}/">YORON BBQ<small>COMMUNITY</small></a>
  <nav><a href="${SITE}/report/">BBQレポート</a><a href="${SITE}/event.html">バーベキューイベント</a><a href="${SITE}/cookbook.html">料理ガイド</a><a href="${SITE}/team.html">チーム</a><a href="${SITE}/contact.html">お問い合わせ</a></nav></div>
  <p class="src">${esc(page.footer || "当日の写真と振り返りからまとめたレポートです。")}</p>
</div></footer>
<div class="ylb" id="ylb" role="dialog" aria-label="写真の拡大"><img alt=""></div>
<script>(function(){var lb=document.getElementById('ylb'),im=lb.querySelector('img');document.querySelectorAll('.yph img,.dish img').forEach(function(i){i.addEventListener('click',function(){im.src=i.src;im.alt=i.alt;lb.classList.add('on');});});lb.addEventListener('click',function(){lb.classList.remove('on');});document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on');});})();</script>
</body></html>
`;
}

/** 出力フォルダを作る: index.html ＋ img/photos（切り抜き済み）＋ img/bbq（キャラ） */
export function buildSite(page, outDir, photosDir) {
  fs.mkdirSync(path.join(outDir, "img/photos"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "img/bbq"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "chars"))) fs.copyFileSync(path.join(ROOT, "chars", f), path.join(outDir, "img/bbq", f));
  if (photosDir) for (const f of fs.readdirSync(photosDir)) fs.copyFileSync(path.join(photosDir, f), path.join(outDir, "img/photos", f));
  fs.writeFileSync(path.join(outDir, "index.html"), renderReportHtml(page));
}
