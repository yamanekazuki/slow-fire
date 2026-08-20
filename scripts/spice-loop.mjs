#!/usr/bin/env node
/**
 * spice-loop — BBQスパイス特設（spice.html）週次記事ループ
 *
 * 週1回（木 5:35 launchd・Mac mini）、claude CLI ヘッドレス（定額枠）で
 * スパイス記事を1本生成 → 品質ゲート（機械検査＋自己検査、最大4回改善・見送り禁止）→
 * spice/*.html・spice/posts.json・sitemap.xml を更新 → git commit & push
 * （GitHub Pages = https://yoron-bbq.com が自動デプロイ）
 *
 * テーマ選定（検索需要ドリブン・LLM前の機械収集）:
 *  ① GSC: yoron-bbq.com の検索クエリからスパイス系を抽出（表示は多いがクリックが少ない=伸びしろ）
 *  ② Googleサジェスト: 「バーベキュー スパイス」等のシード語の関連検索（無認証API・LLM不使用）
 *  ③ 台帳 backlog: スパイス講座由来のテーマ在庫（尽きたらClaudeが①②から立案）
 *
 * 事実素材の正本 = scripts/SPICE-SOURCE.md（スパイス講座20万字のエッセンス）。素材外の配合捏造は禁止。
 *
 * 使い方:
 *   node scripts/spice-loop.mjs            通常実行
 *   node scripts/spice-loop.mjs --dry-run  書き出し・pushなし
 *   node scripts/spice-loop.mjs --no-push  書くがpushしない
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";

const HOME = os.homedir();
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const SPICE_DIR = path.join(ROOT, "spice");
const POSTS_JSON = path.join(SPICE_DIR, "posts.json");
const SITEMAP = path.join(ROOT, "sitemap.xml");
const LEDGER = path.join(SCRIPTS, "spice-ledger.json");
const LOG = path.join(SCRIPTS, "spice-run.log");
const SOURCE_MD = path.join(SCRIPTS, "SPICE-SOURCE.md");
const SITE = "https://yoron-bbq.com";
const SC_SITE = "https://yoron-bbq.com/";

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push") || DRY_RUN;
const MAX_FIX = 4;
const PASS_SCORE = 80;

// ---------- ログ ----------
const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  if (DRY_RUN) return;
  fs.appendFileSync(LOG, logLines.join("\n") + "\n");
}
async function notifyCrash(text) {
  try {
    const { notifyYamane } = await import("../../../tools/lib/notify-yamane.mjs");
    await notifyYamane(`spice-loop クラッシュ: ${text}`.slice(0, 1500));
  } catch (e) { console.error("notify失敗:", e.message); }
}

// ---------- claude ヘッドレス ----------
function claudeBin() {
  for (const p of [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}
function askClaude(prompt, { timeout = 900000 } = {}) {
  return execFileSync(claudeBin(), ["-p", prompt, "--model", "claude-opus-4-8"], {
    encoding: "utf8", timeout, cwd: HOME, maxBuffer: 16 * 1024 * 1024,
  });
}
function parseJSON(out, what) {
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`${what}: JSONが見つからない`);
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- 検索需要の機械収集（LLM不使用） ----------
const SPICE_WORDS = ["スパイス", "ラブ", "rub", "調味", "シーズニング", "胡椒", "こしょう", "ハーブ",
  "ガーリック", "パプリカ", "クミン", "コリアンダー", "シナモン", "クローブ", "カルダモン", "マリネ", "下味"];

/** GSC: yoron-bbq.com 直近28日の検索クエリからスパイス系を抽出 */
async function fetchGscSpiceQueries() {
  try {
    const token = await gcpAccessToken("https://www.googleapis.com/auth/webmasters.readonly");
    const end = new Date(), start = new Date(end.getTime() - 28 * 86400000);
    const d = x => x.toISOString().slice(0, 10);
    const res = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC_SITE)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ startDate: d(start), endDate: d(end), dimensions: ["query"], rowLimit: 250 }),
      });
    if (!res.ok) throw new Error(`SC ${res.status}`);
    const rows = (await res.json()).rows || [];
    const spice = rows.filter(r => SPICE_WORDS.some(w => r.keys[0].toLowerCase().includes(w.toLowerCase())));
    return spice.slice(0, 40).map(r =>
      `- 「${r.keys[0]}」 表示${Math.round(r.impressions)}回/クリック${Math.round(r.clicks)}回/平均掲載順位${r.position.toFixed(1)}`);
  } catch (e) {
    log(`GSC取得スキップ（${e.message}）`);
    return [];
  }
}

/** Googleサジェスト（無認証）: シード語の関連検索を収集 */
const SUGGEST_SEEDS = ["バーベキュー スパイス", "bbq スパイス", "ドライラブ", "bbq ラブ",
  "スペアリブ スパイス", "バーベキュー 下味", "スパイス 配合", "バーベキュー 味付け"];
async function fetchSuggests() {
  const out = new Set();
  for (const seed of SUGGEST_SEEDS) {
    try {
      const res = await fetch(
        `https://suggestqueries.google.com/complete/search?client=firefox&hl=ja&q=${encodeURIComponent(seed)}`,
        { headers: { "user-agent": "Mozilla/5.0" } });
      if (!res.ok) continue;
      const j = await res.json();
      for (const s of j[1] || []) out.add(s);
    } catch { /* 1シード失敗しても続行 */ }
  }
  return [...out].slice(0, 60);
}

// ---------- HTML ----------
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonld = o => JSON.stringify(o).replace(/</g, "\\u003c");
const ALLOWED_TAGS = ["p", "h2", "h3", "strong", "em", "blockquote", "ul", "ol", "li", "a", "br"];

function checkBodyHtml(html) {
  const issues = [];
  const tags = [...html.matchAll(/<\/?([a-zA-Z0-9]+)[^>]*>/g)].map(m => m[1].toLowerCase());
  const bad = [...new Set(tags.filter(t => !ALLOWED_TAGS.includes(t)))];
  if (bad.length) issues.push(`許可されていないタグ: ${bad.join(", ")}`);
  const stack = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    const t = name.toLowerCase();
    if (t === "br" || self) continue;
    if (close) { if (stack.pop() !== t) { issues.push(`タグの対応が壊れています（${t}）`); break; } }
    else stack.push(t);
  }
  if (stack.length) issues.push(`閉じられていないタグ: ${stack.join(", ")}`);
  const text = html.replace(/<[^>]+>/g, "");
  if (text.length < 2800) issues.push(`本文が短すぎます（${text.length}字。2800字以上・目安3500〜4500字）`);
  if (!/<h2[ >]/.test(html)) issues.push("h2見出しがありません");
  const h2n = (html.match(/<h2[ >]/g) || []).length;
  if (h2n < 4) issues.push(`h2見出しが少なすぎます（${h2n}本。4〜6本）`);
  if (/```/.test(html)) issues.push("コードフェンス（```）が混入しています");
  if (/[（(]?(?:AI|Claude)(?:が|により)?生成/.test(text)) issues.push("生成に言及する文が含まれています");
  const NG_INTERNAL = [/粗利/, /利益率/, /原価/, /仕入れ値/, /売上目標/, /赤字/, /黒字/, /客単価/,
    /議事録/, /ミーティングで/, /定例で/, /社内/, /取引先/, /請求/, /経費/];
  for (const re of NG_INTERNAL) {
    if (re.test(text)) issues.push(`公開読者ガードレール違反の疑い（内部話題）: ${re.source}`);
  }
  const NG_MEDICAL = [/(?:効く|治る|治療|予防できる)/];
  for (const re of NG_MEDICAL) {
    if (re.test(text)) issues.push(`医療効能の断定の疑い: ${re.source} — 「〜とされる」等の伝承・一般知識の紹介にとどめること`);
  }
  return { ok: issues.length === 0, issues, textLen: text.length };
}

function buildArticleHtml(a, dateStr) {
  const url = `${SITE}/spice/${a.file}`;
  const jpDate = `${dateStr.slice(0, 4)}年${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日`;
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(a.title)}｜BBQスパイス大全 | YORON BBQ COMMUNITY</title>
  <meta name="description" content="${esc(a.description)}">
  <meta name="keywords" content="${esc(["バーベキュー スパイス", "BBQ ラブ", ...a.tags].join(","))}">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="YORON BBQ COMMUNITY">
  <meta property="og:title" content="${esc(a.title)}">
  <meta property="og:description" content="${esc(a.excerpt)}">
  <meta property="og:url" content="${url}">
  <meta property="og:locale" content="ja_JP">
  <meta property="article:published_time" content="${dateStr}">
  <meta name="twitter:card" content="summary">
  <meta name="theme-color" content="#f6f1e4">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d95f3b'/%3E%3Ctext x='16' y='23' font-family='sans-serif' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3EY%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../community.css">
  <script type="application/ld+json">${jsonld({
    "@context": "https://schema.org", "@type": "Article",
    headline: a.title, description: a.description,
    datePublished: dateStr, dateModified: dateStr, inLanguage: "ja-JP",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: { "@type": "Organization", name: "YORON BBQ COMMUNITY", url: `${SITE}/` },
    publisher: { "@type": "Organization", name: "YORON BBQ COMMUNITY", url: `${SITE}/` },
    keywords: a.tags.join(", "),
  })}</script>
  <script type="application/ld+json">${jsonld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "YORON BBQ COMMUNITY", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "BBQスパイス大全", item: `${SITE}/spice.html` },
      { "@type": "ListItem", position: 3, name: a.title, item: url },
    ],
  })}</script>
  <!-- Google Analytics (GA4) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-S66C9TDVT2"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-S66C9TDVT2');
  </script>
  <style>
    .sp-article { max-width: 760px; margin: 0 auto; padding: 8.5rem 1.4rem 4rem; }
    .sp-crumb { font-size: .8rem; color: var(--smoke); margin-bottom: 1.2rem; }
    .sp-crumb a { color: var(--ember-deep); text-decoration: none; }
    .sp-article h1 { font-size: clamp(1.5rem, 3.6vw, 2.2rem); font-weight: 900; line-height: 1.55; margin-bottom: .8rem; }
    .sp-meta { font-size: .82rem; color: var(--smoke); margin-bottom: 2.2rem; }
    .sp-body { font-size: .98rem; line-height: 2.05; color: var(--ink); }
    .sp-body h2 { font-size: 1.28rem; font-weight: 900; margin: 2.6rem 0 .9rem; line-height: 1.6; }
    .sp-body h3 { font-size: 1.08rem; font-weight: 900; margin: 2rem 0 .7rem; }
    .sp-body p { margin: 0 0 1.2rem; color: var(--ink-soft); }
    .sp-body ul, .sp-body ol { margin: 0 0 1.2rem; padding-left: 1.4em; color: var(--ink-soft); }
    .sp-body li { margin: .35rem 0; }
    .sp-body blockquote { margin: 1.4rem 0; padding: 1rem 1.3rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; color: var(--ink-soft); }
    .sp-body a { color: var(--ember-deep); }
    .sp-tags { margin-top: 2rem; display: flex; flex-wrap: wrap; gap: .45rem; }
    .sp-tags span { font-size: .78rem; background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: .3rem .8rem; color: var(--ink-soft); }
    .sp-cta { margin-top: 3rem; padding: 1.8rem 1.6rem; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); text-align: center; }
    .sp-cta p { font-weight: 700; margin-bottom: 1rem; }
    .sp-cta .btn { margin: .25rem; }
  </style>
</head>
<body>
  <div class="bg-field" aria-hidden="true"><div class="bg-blob b1"></div><div class="bg-blob b2"></div><div class="bg-blob b3"></div></div>
  <div class="bg-grain" aria-hidden="true"></div>
  <nav id="nav">
    <div class="nav-inner">
      <a href="../index.html" class="nav-logo">YORON BBQ <small>COMMUNITY</small></a>
      <ul class="nav-links">
        <li><a href="../spice.html">スパイス大全</a></li>
        <li><a href="../academy.html">学ぶ</a></li>
        <li><a href="../event.html">月1BBQ</a></li>
        <li><a href="../blog.html">読みもの</a></li>
        <li><a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP ↗</a></li>
        <li><a href="../index.html#join" class="nav-cta">仲間に入る</a></li>
      </ul>
      <button class="nav-hamburger" aria-label="メニュー" aria-expanded="false" aria-controls="mobileMenu"><span></span><span></span><span></span></button>
    </div>
  </nav>
  <div class="mobile-menu" id="mobileMenu" aria-hidden="true">
    <a href="../spice.html">スパイス大全</a>
    <a href="../academy.html">学ぶ</a>
    <a href="../event.html">月1BBQ</a>
    <a href="../blog.html">読みもの</a>
    <a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP ↗</a>
    <a href="../index.html#join" class="mm-cta">仲間に入る</a>
  </div>
  <main>
    <article class="sp-article">
      <nav class="sp-crumb" aria-label="パンくず"><a href="../spice.html">BBQスパイス大全</a> / ${esc(a.category)}</nav>
      <h1>${esc(a.title)}</h1>
      <p class="sp-meta"><time datetime="${dateStr}">${jpDate}</time> ・ YORON BBQ COMMUNITY</p>
      <div class="sp-body">
${a.body_html}
      </div>
      <div class="sp-tags">${a.tags.map(t => `<span>#${esc(t)}</span>`).join("")}</div>
      <aside class="sp-cta">
        <p>配合を覚えたら、あとは焼くだけ。</p>
        <a class="btn btn-primary" href="../event.html">月1BBQに参加する</a>
        <a class="btn btn-ghost" href="../spice.html">スパイス大全にもどる</a>
      </aside>
    </article>
  </main>
  <footer>
    <div class="footer-inner">
      <div class="footer-top">
        <div class="footer-brand">
          <div class="footer-logo">YORON BBQ <small>COMMUNITY</small></div>
          <p class="footer-tagline">「今週末、BBQしよう」が合言葉になる日本へ。</p>
        </div>
        <nav class="footer-nav" aria-label="フッターナビゲーション">
          <a href="../spice.html">スパイス大全</a>
          <a href="../academy.html">学ぶ</a>
          <a href="../event.html">月1BBQ</a>
          <a href="../sourcing.html">食材仕入れガイド</a>
          <a href="../blog.html">読みもの</a>
          <a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP（BBQラブ通販）↗</a>
        </nav>
      </div>
      <div class="footer-bottom">
        <p>© 2026 YORON BBQ COMMUNITY. All rights reserved.</p>
        <p>Weber Grill Academy 受講チーム — Low n Slow Basics 日本正規取扱</p>
      </div>
    </div>
  </footer>
  <script src="../community.js"></script>
</body>
</html>
`;
}

function addToSitemap(file, dateStr) {
  let xml = fs.readFileSync(SITEMAP, "utf8");
  const loc = `${SITE}/spice/${file}`;
  if (xml.includes(loc)) return xml;
  const entry = `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStr}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  xml = xml.replace(/<\/urlset>/, entry + "</urlset>");
  xml = xml.replace(/(<loc>https:\/\/yoron-bbq\.com\/spice\.html<\/loc>\s*<lastmod>)[\d-]+(<\/lastmod>)/, `$1${dateStr}$2`);
  return xml;
}

// ---------- プロンプト ----------
function buildGeneratePrompt(ctx) {
  return `あなたは「YORON BBQ COMMUNITY」（https://yoron-bbq.com）のスパイス特設「BBQスパイス大全」の編集担当です。
検索から読者を連れてくるSEO記事を **1本** 書いてください。出力は後述のJSONのみ。

# このページ群の狙い
- 「バーベキュー スパイス」「ドライラブ 作り方」等で検索する人に、具体的で信頼できる答えを返し、
  そこからYORON BBQコミュニティ（月1BBQ・SHOP）への入口にする。
- 読者=BBQ初心者〜中級者。上から教えず、隣で話す温度で。です・ます基調のやわらかい語り口（常体禁止）。

# 検索需要データ（今週の機械収集。テーマ選定の一次根拠にすること）
## GSCの実クエリ（yoron-bbq.com 直近28日・スパイス系のみ）
${ctx.gsc.length ? ctx.gsc.join("\n") : "（今週は該当クエリなし）"}
## Googleサジェスト関連検索
${ctx.suggests.length ? ctx.suggests.map(s => `- ${s}`).join("\n") : "（取得なし）"}

# 今回書くテーマ（在庫から割り当て。原則これで書く。ただし上の検索データにより強い需要が見えるなら、素材の範囲内でそちらを優先してよい）
${ctx.backlogTheme ? `「${ctx.backlogTheme.title}」 — ${ctx.backlogTheme.angle}` : "（在庫切れ。検索データと素材から検索意図の強いテーマを1つ立ててください）"}

# 事実素材（この範囲の事実だけで書く。配合値・成分・歴史の捏造は絶対禁止）
${ctx.source}

# 公開読者ガードレール（違反したら不合格）
1. 内部数字（利益・売上・原価・仕入れ値・目標金額）を書かない。
2. メンバーの呼び名（あんちゃん／やまちゃん／うえたく）以外の人名・企業名・取引先名を出さない。
3. 健康・薬効は素材の禁忌情報の範囲で「〜とされる」と紹介するにとどめ、医療効能を断定しない（「効く」「治る」禁止）。
4. 商品の購入を煽らない。SHOPへの言及は自然な1回まで。
5. 「AIが」「本記事では」のような機械的な言い回しを使わない。

# SEOの型（厳守）
- タイトルは検索クエリの言葉を含む具体形（32字以内目安）。
- 冒頭150字で検索意図に即答する（結論先出し）。
- h2見出し4〜6本。見出しにも検索語彙を自然に入れる。
- 具体的な分量（グラム・比率・温度・時間）を素材から正確に引く。数字が信頼の源泉。
- サイト内リンクを ../spice.html（必須）と ../event.html または ../sourcing.html（1本）に自然に張る。

# 既出テーマ（重複禁止。切り口・タイトル・slugを必ず変えること）
${ctx.pastThemes || "（なし）"}

# 出力JSON（このスキーマ厳守）
{
  "title": "検索語を含む32字以内のタイトル",
  "slug": "英小文字とハイフンのみ。既出と重複しない",
  "category": "配合 / 使い方 / スパイス各論 / 基礎知識 のいずれか1つ",
  "description": "検索結果用。80〜120字。検索意図への答えを圧縮",
  "excerpt": "一覧カード用。40〜70字",
  "tags": ["3〜5個の日本語タグ"],
  "theme": "主題を15字程度で",
  "target_query": "この記事が狙う検索クエリ",
  "body_html": "本文HTML。許可タグは p / h2 / h3 / strong / em / blockquote / ul / ol / li / a / br のみ（class・style・画像・h1禁止）。プレーンテキスト3500〜4500字。",
  "uncertainties": ["判断がつかず本文に書かなかったこと。無ければ空配列"]
}`;
}

function buildGradePrompt(article) {
  return `あなたは「BBQスパイス大全」の編集長です。以下のSEO記事原稿を厳しく検査してください。出力はJSONのみ。

# 検査項目（100点満点・合格は${PASS_SCORE}点）
0. ガードレール（違反は即不合格）: 内部数字なし／固有名詞なし（メンバー呼び名は可）／医療効能の断定なし／機械的な言い回しなし。
1. 事実の正確性（35点）: 配合グラム・比率・温度・スパイスの特徴が素材（スパイス講座）と矛盾・捏造していないか。
   怪しい数字がひとつでもあれば必ず不合格にすること。
2. 検索意図への回答（25点）: target_queryで検索した人が冒頭150字で答えを得られるか。タイトル・見出しに検索語彙が自然に入っているか。
3. トーン（20点）: です・ます基調のやわらかい語り口か。広告臭・煽り・上から目線がないか。
4. 読み物としての完成度（20点）: 構成・具体性・重複のなさ・内部リンクの自然さ。
5. 分量（減点）: プレーンテキスト3500〜4500字か（2800字未満は不合格）。h2は4〜6本か。水増しがないか。

# 原稿
タイトル: ${article.title}
狙うクエリ: ${article.target_query}
本文HTML:
${article.body_html}

# 出力JSON
{ "score": 0-100の整数, "pass": true/false, "issues": ["具体的に"], "fix_hint": "改善指示。合格なら空文字" }`;
}

function buildFixPrompt(article, grade, source) {
  return `以下のSEO記事原稿を、編集長の指摘に沿って書き直してください。出力はJSONのみ。

# 編集長の指摘
${grade.issues.map(i => `- ${i}`).join("\n")}
改善指示: ${grade.fix_hint}

# 守ること
- 事実は下の素材の範囲のみ。配合・数値の捏造禁止。
- です・ます基調。許可タグは p / h2 / h3 / strong / em / blockquote / ul / ol / li / a / br のみ。
- プレーンテキスト3500〜4500字・h2見出し4〜6本。
- ガードレール（内部数字なし／固有名詞なし／医療効能断定なし）を厳守。

# 事実素材
${source}

# 現在の原稿
${JSON.stringify(article, null, 1)}

# 出力JSON（同じスキーマ）
{ "title": "...", "slug": "...", "category": "...", "description": "...", "excerpt": "...", "tags": [...], "theme": "...", "target_query": "...", "body_html": "...", "uncertainties": [...] }`;
}

// ---------- メイン ----------
function normalize(a) {
  a.tags = Array.isArray(a.tags) ? a.tags.slice(0, 5) : [];
  a.uncertainties = Array.isArray(a.uncertainties) ? a.uncertainties : [];
  a.slug = String(a.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  a.body_html = String(a.body_html || "").trim().replace(/^```(?:html)?\n?|```$/g, "");
  return a;
}
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { entries: [], backlog: [] }; }
}

async function main() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  log(`=== spice-loop 開始 (${dateStr})${DRY_RUN ? " [dry-run]" : ""}`);

  const ledger = loadLedger();
  let posts = { posts: [] };
  try { posts = JSON.parse(fs.readFileSync(POSTS_JSON, "utf8")); } catch { /* 初回 */ }
  const pastThemes = [
    ...(ledger.entries || []).map(e => `- ${e.date} 「${e.title}」 主題=${e.theme} slug=${e.slug} クエリ=${e.target_query || ""}`),
  ].join("\n");

  const usedThemes = new Set((ledger.entries || []).map(e => e.backlogId).filter(Boolean));
  const backlogTheme = (ledger.backlog || []).find(b => !usedThemes.has(b.id)) || null;
  log(backlogTheme ? `テーマ在庫から割当: [${backlogTheme.id}] ${backlogTheme.title}`
                   : "テーマ在庫なし → 検索需要データからClaudeが立案");

  const [gsc, suggests] = await Promise.all([fetchGscSpiceQueries(), fetchSuggests()]);
  log(`検索需要データ: GSCクエリ${gsc.length}件 / サジェスト${suggests.length}件`);

  const source = fs.readFileSync(SOURCE_MD, "utf8");
  const ctx = { backlogTheme, gsc, suggests, source, pastThemes };

  // 1) 生成
  let article = normalize(parseJSON(askClaude(buildGeneratePrompt(ctx)), "生成"));
  log(`生成: 「${article.title}」 slug=${article.slug} クエリ=${article.target_query}`);

  // 2) 品質ゲート → NGなら最大4回改善（見送り禁止）
  let best = null, bestScore = -1, rounds = 0;
  for (let i = 0; i <= MAX_FIX; i++) {
    rounds = i;
    const mech = checkBodyHtml(article.body_html);
    let grade;
    if (!mech.ok) {
      grade = { score: 0, pass: false, issues: mech.issues, fix_hint: mech.issues.join(" / ") };
      log(`検査${i}: 機械検査NG — ${mech.issues.join(" / ")}`);
    } else {
      grade = parseJSON(askClaude(buildGradePrompt(article)), "検査");
      log(`検査${i}: score=${grade.score} pass=${grade.pass}${grade.issues?.length ? " — " + grade.issues.join(" / ") : ""}`);
    }
    const score = Number(grade.score) || 0;
    if (score > bestScore) { bestScore = score; best = { ...article }; }
    if (grade.pass === true && score >= PASS_SCORE && mech.ok) { best = { ...article }; bestScore = score; break; }
    if (i === MAX_FIX) {
      log(`⚠️ 要確認: ${MAX_FIX}回の改善でも合格点に届かず（最高${bestScore}点）。最高得点版を公開します。`);
      break;
    }
    article = normalize(parseJSON(askClaude(buildFixPrompt(article, grade, source)), "改善"));
  }
  article = best;

  const finalCheck = checkBodyHtml(article.body_html);
  if (!finalCheck.ok) {
    log(`⚠️ 要確認: 最終HTML検査に失敗したため公開を中止 — ${finalCheck.issues.join(" / ")}`);
    flushLog();
    await notifyCrash(`最終HTML検査NGで公開中止（${finalCheck.issues.join(" / ")}）`);
    process.exitCode = 1;
    return;
  }
  for (const u of article.uncertainties) log(`⚠️ 要確認: ${u}`);

  // 3) 書き出し
  if ((posts.posts || []).some(p => p.slug === article.slug)) article.slug = `${article.slug}-${dateStr.slice(5).replace("-", "")}`;
  const file = `${dateStr}-${article.slug}.html`;
  article.file = file;
  const pageHtml = buildArticleHtml(article, dateStr);

  if (DRY_RUN) {
    console.log("\n--- 生成結果（dry-run） ---");
    console.log(JSON.stringify({ ...article, body_html: `${article.body_html.slice(0, 400)}…` }, null, 2));
    console.log(`本文 ${finalCheck.textLen}字 / スコア ${bestScore} / 改善${rounds}回`);
    flushLog();
    return;
  }

  fs.mkdirSync(SPICE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SPICE_DIR, file), pageHtml);
  const newPosts = { posts: [{
    title: article.title, category: article.category, excerpt: article.excerpt,
    date: dateStr, slug: article.slug, file,
  }, ...(posts.posts || [])] };
  fs.writeFileSync(POSTS_JSON, JSON.stringify(newPosts, null, 2) + "\n");
  fs.writeFileSync(SITEMAP, addToSitemap(file, dateStr));

  ledger.entries = [{
    date: dateStr, title: article.title, slug: article.slug, theme: article.theme || "",
    target_query: article.target_query || "", backlogId: backlogTheme ? backlogTheme.id : null,
    category: article.category, score: bestScore, rounds, uncertainties: article.uncertainties,
  }, ...(ledger.entries || [])];
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  log(`公開ファイル: spice/${file}（${finalCheck.textLen}字 / ${bestScore}点 / 改善${rounds}回）`);

  // 4) commit & push
  if (NO_PUSH) { log("push はスキップしました（--no-push）"); flushLog(); return; }
  try {
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    git("pull", "--rebase");
    git("add", `spice/${file}`, "spice/posts.json", "sitemap.xml", "scripts/spice-ledger.json");
    git("commit", "-m", `スパイス大全: ${article.title}`);
    git("push");
    log(`push完了 → ${SITE}/spice/${file}`);
  } catch (e) {
    log(`⚠️ 要確認: git push に失敗 — ${e.message}`);
    await notifyCrash(`git push失敗（${e.message.slice(0, 300)}）`);
    process.exitCode = 1;
  }
  flushLog();
}

main().catch(async e => {
  log(`⚠️ 異常終了: ${e.stack || e.message}`);
  flushLog();
  await notifyCrash(e.message || String(e));
  process.exit(1);
});
