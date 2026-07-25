#!/usr/bin/env node
/**
 * column-loop — YORON BBQ コミュニティサイト「読みもの」自動コラムループ
 *
 * 週1回（金 5:30 launchd）、claude CLI ヘッドレス（定額枠／従量API不使用）で
 * コラムを1本生成 → 品質ゲート（自己検査＋最大4回改善、見送り禁止）→
 * blog/*.html・posts.json・blog.html・sitemap.xml を更新 → git commit & push
 * （公開先は GitHub Pages = https://yoron-bbq.com。push がそのままデプロイ）
 *
 * 使い方:
 *   node scripts/column-loop.mjs            通常実行（生成→検査→公開→push）
 *   node scripts/column-loop.mjs --dry-run  ファイル書き出し・pushなし（stdoutのみ）
 *   node scripts/column-loop.mjs --no-push  ファイルは書くがcommit/pushしない
 *
 * 設計の要点:
 *  - ネタ元 = ①YORON BBQ/SLOW FIRE思想 ②あんちゃんたちとのBBQ実施エピソード
 *             ③月1BBQ・ACADEMYの活動 ④memo-sync RECENT.md の「BBQ文脈だけ」抽出
 *    ※④はプライベート全般NG。BBQキーワードを含む段落のみを機械抽出して渡す。
 *  - 判断がつかない点（固有名詞の扱い等）はコラム本文に書かせず uncertainties[] に出させ、
 *    run.log へ「要確認」として残す。
 *  - 台帳 column-ledger.json で既出テーマ・slugを渡し重複を回避。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const BLOG_DIR = path.join(ROOT, "blog");
const POSTS_JSON = path.join(BLOG_DIR, "posts.json");
const BLOG_HTML = path.join(ROOT, "blog.html");
const SITEMAP = path.join(ROOT, "sitemap.xml");
const LEDGER = path.join(SCRIPTS, "column-ledger.json");
const LOG = path.join(SCRIPTS, "column-run.log");
const SITE = "https://yoron-bbq.com";

const DRY_RUN = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push") || DRY_RUN;
const MAX_FIX = 4;          // 品質ゲートの改善ループ上限（超えても「見送り」はしない）
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
  // ```json フェンス／前後の地の文を許容して最外の { } を取る
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`${what}: JSONが見つからない`);
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- ネタ元の収集 ----------
function readIf(p, limit = 12000) {
  try { return fs.readFileSync(p, "utf8").slice(0, limit); } catch { return ""; }
}

/** memo-sync RECENT.md から「BBQ文脈の段落」だけを抽出（プライベート全般は渡さない） */
const BBQ_WORDS = ["BBQ", "ＢＢＱ", "バーベキュー", "与論", "ヨロン", "あんちゃん", "うえたく", "YORON", "SLOW FIRE",
  "グリル", "スモーク", "ラブ", "ソムリエ", "焼き手", "Weber", "ウェーバー", "アンバサダー"];
/** BBQ文脈でも本文に出さない語（採用/PII寄り）。段落ごと除外する */
const EXCLUDE_WORDS = ["人材紹介", "PORTERS", "ポーターズ", "スカウト", "年収", "面談", "面接", "求人", "内定", "候補者",
  "商談", "受注", "売上目標", "パスワード", "@gmail", "@potentialight"];
function extractBbqMemo() {
  const src = readIf(path.join(HOME, "dev/tools/memo-sync/RECENT.md"), 400000);
  if (!src) return "";
  const paras = src.split(/\n{2,}/);
  const hits = paras.filter(p => {
    const t = p.trim();
    if (t.length < 60 || t.length > 4000) return false;
    if (!BBQ_WORDS.some(w => t.includes(w))) return false;
    if (EXCLUDE_WORDS.some(w => t.includes(w))) return false;
    return true;
  });
  // 直近側（ファイル後方）を優先しつつ総量を抑える
  const picked = [];
  let total = 0;
  for (const p of hits.reverse()) {
    if (total + p.length > 18000) break;
    picked.push(p.trim()); total += p.length;
  }
  return picked.join("\n\n");
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { entries: [] }; }
}

// ---------- HTML 組み立て ----------
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const jsonld = o => JSON.stringify(o).replace(/</g, "\\u003c");

const ALLOWED_TAGS = ["p", "h2", "h3", "strong", "em", "blockquote", "ul", "ol", "li", "a", "br"];
/** 本文HTMLの機械検査。許可タグのみ・タグの対応・最低文字数 */
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
  if (text.length < 1600) issues.push(`本文が短すぎます（${text.length}字。1600字以上）`);
  if (!/<h2[ >]/.test(html)) issues.push("h2見出しがありません");
  if (/```/.test(html)) issues.push("コードフェンス（```）が混入しています");
  if (/[（(]?(?:AI|Claude)(?:が|により)?生成/.test(text)) issues.push("生成に言及する文が含まれています");
  return { ok: issues.length === 0, issues, textLen: text.length };
}

// index.html のナビに合わせる（変更時はここも更新）
const NAV_ITEMS = [
  ["../context.html", "はじめての方へ"],
  ["../academy.html", "学ぶ"],
  ["../event.html", "月1BBQ"],
  ["../blog.html", "読みもの"],
  ["../index.html#community", "コミュニティ"],
  ["../team.html", "チーム"],
  ["https://yamanekazuki.github.io/slow-fire-shop/", "SHOP ↗"],
];

function buildArticleHtml(a, dateStr) {
  const url = `${SITE}/blog/${a.file}`;
  const jpDate = `${dateStr.slice(0, 4)}年${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日`;
  const ext = h => (h.startsWith("http") ? ' target="_blank" rel="noopener"' : "");
  const navLis = NAV_ITEMS.map(([h, t]) => `        <li><a href="${h}"${ext(h)}>${t}</a></li>`).join("\n");
  const navMob = NAV_ITEMS.map(([h, t]) => `    <a href="${h}"${ext(h)}>${t}</a>`).join("\n");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(a.title)}｜YORON BBQ 読みもの</title>
  <meta name="description" content="${esc(a.description)}">
  <meta name="keywords" content="${esc(["YORON BBQ", "与論バーベキュー", ...a.tags].join(","))}">
  <meta name="author" content="YORON BBQ COMMUNITY">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="YORON BBQ COMMUNITY">
  <meta property="og:title" content="${esc(a.title)}">
  <meta property="og:description" content="${esc(a.excerpt)}">
  <meta property="og:url" content="${url}">
  <meta property="og:locale" content="ja_JP">
  <meta property="article:published_time" content="${dateStr}">
  <meta property="article:section" content="${esc(a.category)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(a.title)}">
  <meta name="twitter:description" content="${esc(a.excerpt)}">
  <meta name="theme-color" content="#f6f1e4">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d95f3b'/%3E%3Ctext x='16' y='23' font-family='sans-serif' font-size='18' font-weight='700' fill='%23fff' text-anchor='middle'%3Eあ%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Noto+Sans+JP:wght@300;400;500;700&family=Bebas+Neue&family=Cormorant+Garamond:ital,wght@1,300;1,400;1,600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="../blog.css">
  <link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../community-theme.css">
  <script type="application/ld+json">${jsonld({
    "@context": "https://schema.org", "@type": "BlogPosting",
    headline: a.title, description: a.description,
    datePublished: dateStr, dateModified: dateStr, inLanguage: "ja-JP",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: { "@type": "Organization", name: "YORON BBQ COMMUNITY", url: `${SITE}/` },
    publisher: { "@type": "Organization", name: "YORON BBQ COMMUNITY", url: `${SITE}/` },
    articleSection: a.category, keywords: a.tags.join(", "),
  })}</script>
  <script type="application/ld+json">${jsonld({
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "YORON BBQ COMMUNITY", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "読みもの", item: `${SITE}/blog.html` },
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
</head>
<body>
  <div class="grain-overlay" aria-hidden="true"></div>
  <nav id="nav">
    <div class="nav-inner">
      <a href="../index.html" class="nav-logo">YORON BBQ</a>
      <ul class="nav-links">
${navLis}
        <li><a href="../index.html#join" class="nav-cta">入会する</a></li>
      </ul>
      <button class="nav-hamburger" aria-label="メニュー" aria-expanded="false" aria-controls="mobileMenu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>

  <div class="mobile-menu" id="mobileMenu" aria-hidden="true">
${navMob}
    <a href="../index.html#join" class="mm-cta">入会する</a>
  </div>

  <main class="blog-article">
    <article>
      <header class="article-head">
        <nav class="article-crumb" aria-label="パンくず">
          <a href="../blog.html">読みもの</a> <span>/</span> <span>${esc(a.category)}</span>
        </nav>
        <h1 class="article-title">${esc(a.title)}</h1>
        <p class="article-meta"><time datetime="${dateStr}">${jpDate}</time> ・ YORON BBQ COMMUNITY</p>
      </header>
      <div class="article-body">
${a.body_html}
      </div>
      <div class="article-tags">
        ${a.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join("")}
      </div>
      <aside class="article-cta">
        <p>火を囲む時間を、あなたも。</p>
        <a class="btn-fire" href="../event.html">月1BBQに参加する</a>
        <a class="btn-ghost" href="../blog.html">ほかの読みものを見る</a>
      </aside>
    </article>
  </main>

  <footer>
    <div class="footer-inner">
      <div class="footer-top">
        <div class="footer-brand">
          <div class="footer-logo">YORON BBQ</div>
          <p class="footer-tagline">「今週末、BBQしよう」が合言葉になる日本へ。</p>
        </div>
        <nav class="footer-nav" aria-label="フッターナビゲーション">
          <a href="../context.html">はじめての方へ</a>
          <a href="../academy.html">学ぶ</a>
          <a href="../event.html">月1BBQ</a>
          <a href="../blog.html">読みもの</a>
          <a href="../cookbook.html">料理ガイド</a>
          <a href="../team.html">チーム</a>
          <a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP（BBQラブ通販）↗</a>
        </nav>
      </div>
      <div class="footer-bottom">
        <p class="footer-copy">© 2026 YORON BBQ COMMUNITY. All rights reserved.</p>
        <p class="footer-copy">Weber Grill Academy 受講チーム — Low n Slow Basics 日本正規取扱</p>
      </div>
    </div>
  </footer>
  <script src="../script.js"></script>
</body>
</html>
`;
}

/** blog.html の一覧グリッドと Blog JSON-LD を posts.json から作り直す */
function rebuildBlogIndex(posts) {
  let html = fs.readFileSync(BLOG_HTML, "utf8");
  const sorted = [...posts].sort((a, b) => (a.date < b.date ? 1 : -1));
  const cards = sorted.map(p => {
    const jp = `${p.date.slice(0, 4)}年${Number(p.date.slice(5, 7))}月${Number(p.date.slice(8, 10))}日`;
    return `      <a class="post-card" href="blog/${p.file}">
        <span class="post-card-cat">${esc(p.category)}</span>
        <h2 class="post-card-title">${esc(p.title)}</h2>
        <p class="post-card-excerpt">${esc(p.excerpt)}</p>
        <span class="post-card-date"><time datetime="${p.date}">${jp}</time></span>
      </a>`;
  }).join("\n");
  html = html.replace(/(<div class="post-grid">)[\s\S]*?(\n\s*<\/div>)/,
    (_m, open, close) => `${open}\n${cards}${close}`);
  const ld = jsonld({
    "@context": "https://schema.org", "@type": "Blog", name: "YORON BBQ 読みもの",
    url: `${SITE}/blog.html`, inLanguage: "ja-JP",
    publisher: { "@type": "Organization", name: "YORON BBQ COMMUNITY", url: `${SITE}/` },
    blogPost: sorted.map(p => ({
      "@type": "BlogPosting", headline: p.title, datePublished: p.date,
      url: `${SITE}/blog/${p.file}`,
    })),
  });
  html = html.replace(/<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"Blog"[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${ld}</script>`);
  return html;
}

function addToSitemap(file, dateStr) {
  let xml = fs.readFileSync(SITEMAP, "utf8");
  const loc = `${SITE}/blog/${file}`;
  if (xml.includes(loc)) return xml;
  const entry = `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${dateStr}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n`;
  xml = xml.replace(/<\/urlset>/, entry + "</urlset>");
  xml = xml.replace(/(<loc>https:\/\/yoron-bbq\.com\/blog\.html<\/loc>\s*<lastmod>)[\d-]+(<\/lastmod>)/, `$1${dateStr}$2`);
  return xml;
}

// ---------- プロンプト ----------
function buildGeneratePrompt(ctx) {
  return `あなたは「YORON BBQ COMMUNITY」の編集担当です。コミュニティサイト（https://yoron-bbq.com）の
「読みもの」に載せるコラムを **1本** 書いてください。出力は後述のJSONのみ（説明文・前置き・後書きは一切不要）。

# 判断軸（最優先）
- SLOW FIRE思想: BBQで届けたいのは「美味しい（Concrete）」ではなく、場の空気が変わる体験（Subtle / MetAware）。
- YORON BBQ: アメリカンBBQのロジック（蓋付きグリル・間接熱・ロー&スロー）は継承しつつ、
  ①5〜6時間で完結 ②熱々を出来立てで ③多品種（普通のスーパーの食材で）④創作の解放（ラブ/スパイス）
  ⑤最終使命=AI時代の人間関係の最強のハブ。
- 読者はコミュニティのメンバーとこれから入る人。上から教えるのではなく、隣で話す温度で。

# 文体（厳守）
- です・ます基調のやわらかい語り口。語尾をやわらげる（〜なんですよね／個人的には／〜といいですよ）。
- 常体（〜だ／〜である／体言止めの連発）は禁止。
- 冒頭は共感か問いかけから入り、要所はやさしく言い切る。数値は正確に。
- 「AIが」「本記事では」のような機械的な言い回しを使わない。

# 事実の扱い（最重要）
- 下の素材に書かれていないことを事実として書かない。数字・日付・人名・地名の捏造は絶対禁止。
- 迷ったら本文に書かず、JSONの uncertainties[] に「何が判断できなかったか」を日本語で書くこと。
  例: 実名を出してよいか判断できない／開催日が資料により異なる、など。
- 個人が特定できるプライベートな話題（BBQ以外の私生活・仕事の機密）は一切書かない。
- メンバーの呼び名は「あんちゃん」「やまちゃん」「うえたく」まで。フルネームや連絡先は書かない。

# 素材A: YORON BBQ思想（サイト内の正本）
${ctx.philosophy}

# 素材B: SLOW FIRE思想メモ
${ctx.slowfire}

# 素材C: 山根のBBQ関連メモ（音声メモ由来。BBQ文脈のみ抽出済み。生の口語なので引用せず要旨として使うこと）
${ctx.memo || "（今週は該当メモなし）"}

# 素材D: コミュニティの現在地
- 月1BBQ: 誰でも手ぶらで参加できるオープンな会。申込はサイトの event.html から。
- ACADEMY: Weber Grill Academy 初級/中級/上級の学びを8レッスンに体系化（academy.html）。
- 与論島での出店経験（第2回=BBQバーガー約170食が3時間半で完売）。
- 目標: 日本人の3人に1人がYORON BBQを知っている状態。

# 既出テーマ（重複禁止。切り口・タイトル・slugを必ず変えること）
${ctx.pastThemes || "（なし）"}

# 出力JSON（このスキーマ厳守）
{
  "title": "40字以内。読者が読みたくなる具体的なタイトル",
  "slug": "英小文字とハイフンのみ。既出slugと重複しないこと",
  "category": "哲学 / 技術 / レポート / コミュニティ のいずれか1つ",
  "description": "検索結果用。80〜120字",
  "excerpt": "一覧カード用の引き。40〜70字",
  "tags": ["3〜5個の日本語タグ"],
  "theme": "このコラムの主題を15字程度で（台帳の重複判定に使う）",
  "body_html": "本文HTML。使ってよいタグは p / h2 / h3 / strong / em / blockquote / ul / ol / li / a / br のみ。class属性・style属性・画像・見出しh1は禁止。h2見出しを3〜4本立て、全体でプレーンテキスト2000〜2800字。サイト内リンクは相対パス（../event.html ../academy.html ../cookbook.html ../team.html ../context.html）で1〜2本だけ自然に入れる。最後の段落は月1BBQかコミュニティへの静かな誘い。",
  "uncertainties": ["判断がつかず本文に書かなかったこと。無ければ空配列"]
}`;
}

function buildGradePrompt(article) {
  return `あなたは「YORON BBQ COMMUNITY」の編集長です。以下のコラム原稿を厳しく検査してください。
出力はJSONのみ（説明不要）。

# 検査項目（100点満点・合格は${PASS_SCORE}点）
1. 思想との整合（30点）: SLOW FIRE / YORON BBQ の思想（Concreteで終わらずSubtle/MetAwareに届く、
   5〜6時間で完結・熱々・多品種・創作の解放・人間関係のハブ）と矛盾していないか。
   ただの一般的なBBQハウツーで終わっていないか。
2. 事実の捏造がないこと（30点）: 素材にない数字・日付・人名・肩書・受賞歴・引用を作っていないか。
   断定できないことを断定していないか。1つでも捏造の疑いがあれば必ず不合格にすること。
3. コミュニティ向けのトーン（25点）: です・ます基調のやわらかい語り口か。常体・体言止めの連発、
   上から目線、広告臭、機械的な言い回しがないか。読者が「行ってみようかな」と思える温度か。
4. 読み物としての完成度（15点）: 構成・具体性・重複のなさ・締めの自然さ。

# 原稿
タイトル: ${article.title}
カテゴリ: ${article.category}
引き: ${article.excerpt}
本文HTML:
${article.body_html}

# 出力JSON
{ "score": 0-100の整数, "pass": true/false, "issues": ["落ちた項目と理由を具体的に"], "fix_hint": "書き直す人への具体的な指示。合格なら空文字" }`;
}

function buildFixPrompt(article, grade) {
  return `以下のコラム原稿を、編集長の指摘に沿って書き直してください。出力はJSONのみ。

# 編集長の指摘
${grade.issues.map(i => `- ${i}`).join("\n")}
改善指示: ${grade.fix_hint}

# 守ること
- 文体はです・ます基調のやわらかい語り口（常体禁止）。
- 素材にない事実を足さない。迷ったら本文から外し uncertainties[] に書く。
- body_html で使えるタグは p / h2 / h3 / strong / em / blockquote / ul / ol / li / a / br のみ（class・style禁止）。
- プレーンテキストで2000〜2800字、h2見出し3〜4本。

# 現在の原稿
${JSON.stringify(article, null, 1)}

# 出力JSON（同じスキーマ）
{ "title": "...", "slug": "...", "category": "...", "description": "...", "excerpt": "...", "tags": [...], "theme": "...", "body_html": "...", "uncertainties": [...] }`;
}

// ---------- メイン ----------
function normalize(a) {
  a.tags = Array.isArray(a.tags) ? a.tags.slice(0, 5) : [];
  a.uncertainties = Array.isArray(a.uncertainties) ? a.uncertainties : [];
  a.slug = String(a.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  a.body_html = String(a.body_html || "").trim().replace(/^```(?:html)?\n?|```$/g, "");
  return a;
}

async function main() {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  log(`=== column-loop 開始 (${dateStr})${DRY_RUN ? " [dry-run]" : ""}`);

  const ledger = loadLedger();
  const posts = JSON.parse(fs.readFileSync(POSTS_JSON, "utf8"));
  const pastThemes = [
    ...ledger.entries.map(e => `- ${e.date} 「${e.title}」 主題=${e.theme} slug=${e.slug}`),
    ...posts.filter(p => !ledger.entries.some(e => e.slug === p.slug)).map(p => `- ${p.date} 「${p.title}」 slug=${p.slug}`),
  ].join("\n");

  const ctx = {
    philosophy: readIf(path.join(ROOT, "AN-BBQ-PHILOSOPHY.md"), 9000),
    slowfire: readIf(path.join(HOME, ".claude/projects/-Users-yamanekazuki/memory/project_bbq_philosophy.md"), 6000),
    memo: extractBbqMemo(),
    pastThemes,
  };
  log(`素材: philosophy=${ctx.philosophy.length}字 slowfire=${ctx.slowfire.length}字 memo=${ctx.memo.length}字 既出=${ledger.entries.length + posts.length}本`);

  // 1) 生成
  let article = normalize(parseJSON(askClaude(buildGeneratePrompt(ctx)), "生成"));
  log(`生成: 「${article.title}」 slug=${article.slug}`);

  // 2) 品質ゲート（機械検査 + 自己検査）→ NGなら最大4回改善（見送りはしない）
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
      log(`⚠️ 要確認: ${MAX_FIX}回の改善でも合格点に届きませんでした（最高${bestScore}点）。見送りはせず最高得点版を公開します。`);
      break;
    }
    article = normalize(parseJSON(askClaude(buildFixPrompt(article, grade)), "改善"));
  }
  article = best;

  // 最終の機械検査（ここだけは通らないと壊れたHTMLを出すことになるので中止）
  const finalCheck = checkBodyHtml(article.body_html);
  if (!finalCheck.ok) {
    log(`⚠️ 要確認: 最終HTML検査に失敗したため公開を中止しました — ${finalCheck.issues.join(" / ")}`);
    flushLog();
    process.exitCode = 1;
    return;
  }

  for (const u of article.uncertainties) log(`⚠️ 要確認: ${u}`);

  // 3) 書き出し
  if (posts.some(p => p.slug === article.slug)) article.slug = `${article.slug}-${dateStr.slice(5).replace("-", "")}`;
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

  fs.writeFileSync(path.join(BLOG_DIR, file), pageHtml);
  const newPosts = [{
    title: article.title, category: article.category, description: article.description,
    excerpt: article.excerpt, tags: article.tags, date: dateStr, slug: article.slug, file,
  }, ...posts];
  fs.writeFileSync(POSTS_JSON, JSON.stringify(newPosts, null, 2) + "\n");
  fs.writeFileSync(BLOG_HTML, rebuildBlogIndex(newPosts));
  fs.writeFileSync(SITEMAP, addToSitemap(file, dateStr));

  ledger.entries = [{
    date: dateStr, title: article.title, slug: article.slug, theme: article.theme || "",
    category: article.category, score: bestScore, rounds,
    uncertainties: article.uncertainties,
  }, ...(ledger.entries || [])];
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  log(`公開ファイル: blog/${file}（${finalCheck.textLen}字 / ${bestScore}点 / 改善${rounds}回）`);

  // 4) commit & push（GitHub Pages が自動デプロイ）
  if (NO_PUSH) { log("push はスキップしました（--no-push）"); flushLog(); return; }
  try {
    const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
    git("add", `blog/${file}`, "blog/posts.json", "blog.html", "sitemap.xml", "scripts/column-ledger.json");
    git("commit", "-m", `読みもの: ${article.title}`);
    git("push");
    log(`push完了 → ${SITE}/blog/${file}`);
  } catch (e) {
    log(`⚠️ 要確認: git push に失敗しました — ${e.message}`);
    process.exitCode = 1;
  }
  flushLog();
}

main().catch(e => { log(`⚠️ 異常終了: ${e.stack || e.message}`); flushLog(); process.exit(1); });
