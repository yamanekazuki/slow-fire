// =============================================================================
// コミュニティサイト（yoron-bbq.com）の自動で直す係 — 書き換えの安全弁（純関数・テスト対象）
// -----------------------------------------------------------------------------
// 2026-11-09 運営者の指示「提案だけでなく自動実装する仕組みに。承認なしでよい」。
// 承認待ちにはしないが、名簿・申込が届かなくなる事故だけは機械的に止める：
//   - 公開ページの .html だけ（運営用ページ・運営用・関数・スクリプトは不可）
//   - find がファイル内で「ちょうど1回」一致する時だけ置換（0回・複数回は不可）
//   - <script> の中・<form> の中は書き換えない／replace に script・form・入力欄・onclick等を入れない
//   - 開き/閉じタグの数の差が find と replace で同じ（レイアウトを壊さない）
//   - サイト全体の一括置換は href="..." の属性だけ
// =============================================================================

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BLOCKED_DIRS = ["functions", "scripts", "node_modules", "report-ops", "report-members", "finance", "plan", "print", "data", ".github"];
const BLOCKED_FILE = /^(admin.*|google[0-9a-f]+|venue-kiba-host)\.html$/;

/** 公開ページの html かどうか（相対パス） */
export function isAllowedFile(rel) {
  if (!rel || rel.includes("..") || rel.startsWith("/")) return false;
  if (!/\.html$/.test(rel)) return false;
  const parts = rel.split("/");
  if (BLOCKED_DIRS.includes(parts[0])) return false;
  if (BLOCKED_FILE.test(parts[parts.length - 1])) return false;
  return true;
}

/** 提案の「対象」に書かれたURL・パスを全部ファイルにする（「A（あわせて B）」のような書き方も拾う） */
export function resolveTargets(target, root = ".") {
  const str = String(target || "");
  const found = [...str.matchAll(/https?:\/\/[^\s（）()、，,]+|(?:^|[\s（(、,])(\/[A-Za-z0-9._\/-]*)/g)].map((m) => m[1] || m[0]);
  const out = [];
  for (const t of found.length ? found : [str]) {
    const f = resolveTarget(t, root);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** URL・パス1つ → リポジトリ内のファイル。見つからなければ null */
export function resolveTarget(target, root = ".") {
  let t = String(target || "").trim();
  const m = t.match(/https?:\/\/[^\s（）()、，,]+/);
  if (m) t = m[0];
  t = t.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "");
  if (!t.startsWith("/")) t = "/" + t;
  const cands = t === "/" ? ["index.html"] : t.endsWith("/") ? [t.slice(1) + "index.html"] : [t.slice(1), t.slice(1) + ".html", t.slice(1) + "/index.html"];
  for (const c of cands) {
    if (isAllowedFile(c) && existsSync(join(root, c))) return c;
  }
  return null;
}

const TAGS = ["div", "section", "a", "p", "ul", "ol", "li", "span", "nav", "header", "footer", "main", "article", "aside", "table", "tr", "td", "strong", "b", "em", "h1", "h2", "h3", "h4"];
/** タグごとの「開き−閉じ」の数 */
export function tagBalance(html) {
  const out = {};
  for (const t of TAGS) {
    const open = (html.match(new RegExp(`<${t}(\\s[^>]*)?>`, "gi")) || []).length;
    const close = (html.match(new RegExp(`</${t}\\s*>`, "gi")) || []).length;
    out[t] = open - close;
  }
  return out;
}

const FORBIDDEN_IN_REPLACE = [
  [/<script\b/i, "scriptを含む"],
  [/<\/?form\b/i, "formタグを含む"],
  [/<(input|select|textarea|button\s[^>]*type=["']?submit|iframe)\b/i, "入力欄・送信ボタン・iframeを含む"],
  [/\son[a-z]+\s*=/i, "onclick等の動きを含む"],
  [/javascript:/i, "javascript:を含む"],
  [/\saction\s*=/i, "フォームの送信先を含む"],
];

function insideBlock(src, idx, tag) {
  const before = src.slice(0, idx);
  const opens = (before.match(new RegExp(`<${tag}\\b`, "gi")) || []).length;
  const closes = (before.match(new RegExp(`</${tag}>`, "gi")) || []).length;
  return opens > closes;
}

/** 1ファイル分の置換を検査して適用後の文字列を返す（書き込みはしない） */
export function checkPatch(src, find, replace) {
  if (!find || typeof find !== "string") return { ok: false, reason: "置換前の文字列が空" };
  if (typeof replace !== "string") return { ok: false, reason: "置換後の文字列がない" };
  if (find === replace) return { ok: false, reason: "変化なし" };
  if (replace.length > 4000) return { ok: false, reason: "置換が長すぎる" };
  const count = src.split(find).length - 1;
  if (count !== 1) return { ok: false, reason: `ページ内で${count}回一致（1回だけの時に限る）` };
  const idx = src.indexOf(find);
  const end = idx + find.length;
  if (insideBlock(src, idx, "script") || insideBlock(src, end, "script") || /<\/?script\b/i.test(find)) return { ok: false, reason: "動きの部分（script）の中" };
  if (insideBlock(src, idx, "form") || insideBlock(src, end, "form") || /<\/?form\b/i.test(find)) return { ok: false, reason: "申込・入会フォームの中" };
  for (const [re, why] of FORBIDDEN_IN_REPLACE) if (re.test(replace)) return { ok: false, reason: `置換後が${why}` };
  const a = tagBalance(find), b = tagBalance(replace);
  const bad = TAGS.filter((t) => a[t] !== b[t]);
  if (bad.length) return { ok: false, reason: `タグの開閉がずれる（${bad.join(",")}）` };
  return { ok: true, out: src.slice(0, idx) + replace + src.slice(end) };
}

/** サイト全体の一括置換は href="..." 属性だけ許可 */
export function checkSiteWide(find, replace) {
  const re = /^href="[^"<>\s]*"$/;
  if (!re.test(find) || !re.test(replace)) return { ok: false, reason: "一括置換は href=\"...\" の属性だけ" };
  if (/javascript:/i.test(replace)) return { ok: false, reason: "javascript:を含む" };
  return { ok: true };
}

export function listSiteHtml(root = ".") {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      if (name.startsWith(".")) continue;
      const rel = dir ? `${dir}/${name}` : name;
      const st = statSync(join(root, rel));
      if (st.isDirectory()) { if (!BLOCKED_DIRS.includes(rel.split("/")[0])) walk(rel); }
      else if (isAllowedFile(rel)) out.push(rel);
    }
  };
  walk("");
  return out.sort();
}

/**
 * 提案1件分のパッチ群を適用する。1つでも不合格ならその提案は全部やめる（半端に直さない）。
 * patches: [{ file, find, replace }] / siteWide: [{ find, replace }]
 * 返り値: { ok, files:[...], reason }
 */
export function applyProposalPatches({ patches = [], siteWide = [] }, root = ".", { dryRun = false } = {}) {
  if (!patches.length && !siteWide.length) return { ok: false, files: [], reason: "直す箇所を特定できなかった" };
  const next = new Map(); // rel -> 新しい中身
  const skipped = [];
  const read = (rel) => (next.has(rel) ? next.get(rel) : readFileSync(join(root, rel), "utf8"));
  for (const p of patches) {
    const rel = String(p.file || "").replace(/^\/+/, "");
    if (!isAllowedFile(rel)) return { ok: false, files: [], reason: `対象外のファイル（${rel}）` };
    if (!existsSync(join(root, rel))) return { ok: false, files: [], reason: `ファイルがない（${rel}）` };
    const r = checkPatch(read(rel), p.find, p.replace);
    if (!r.ok) return { ok: false, files: [], reason: `${rel}：${r.reason}` };
    next.set(rel, r.out);
  }
  for (const s of siteWide) {
    const r = checkSiteWide(s.find, s.replace);
    if (!r.ok) return { ok: false, files: [], reason: r.reason };
    let hits = 0;
    for (const rel of listSiteHtml(root)) {
      const src = read(rel);
      if (!src.includes(s.find)) continue;
      hits++;
      next.set(rel, src.split(s.find).join(s.replace));
    }
    if (!hits) { skipped.push(`一括置換の対象なし（${s.find}）`); continue; }
    if (hits > 80) return { ok: false, files: [], reason: `一括置換の対象が多すぎる（${hits}ファイル）` };
  }
  if (!next.size) return { ok: false, files: [], reason: skipped.join("／") || "直す箇所を特定できなかった" };
  if (!dryRun) for (const [rel, body] of next) writeFileSync(join(root, rel), body);
  return { ok: true, files: [...next.keys()], skipped };
}
