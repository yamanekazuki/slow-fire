#!/usr/bin/env node
/**
 * report-loop — BBQレポート便（2026-09-27 山根さん依頼）
 *
 *   開催した日の夜に、アルバムの写真・振り返りメモ・運営LINEの会話から「BBQレポート」を自動で作る。
 *   ① 確認用URLに置く（Firebase Storage のトークン付きURL。画像込みの1ファイル。公開リポジトリには入れない）
 *   ② 山根さんへメール ＋ 運営LINEグループへ投稿（「やまちゃんです！」で名乗る）
 *   ③ やまちゃんがLINEで「レポートOK」と返したら、yoron-bbq.com/report/<日付>/ に公開し、特設一覧 /report/ と sitemap を更新
 *
 *   node scripts/report-loop.mjs                     通常実行（mini launchd 30分ごと）
 *   node scripts/report-loop.mjs --dry-run           生成・書き出しまで。アップロード・push・メール・LINE・公開なし
 *   node scripts/report-loop.mjs --event 2026-09-26 [--content <page.json>] [--no-line]
 *                                                    その回だけ作る（--content なら生成を飛ばして用意済みの原稿で）
 *   node scripts/report-loop.mjs --publish 2026-09-26  承認を待たずに公開（山根さんの指示があったときだけ）
 *
 * 設計判断:
 *   - 開催回の起点は「アルバム（Firestore albums）」。写真が無い回はレポートにしない（料理が主役のため）
 *   - 当日は21時(JST)以降に作る。翌日以降は3日以内なら取りこぼしを拾う。作り直しは「写真が10枚以上増えた／振り返りが後から書かれた」ときの1回まで
 *   - 承認は、やまちゃんのLINEユーザーID×運営グループID×短い承認文の完全一致だけ（表示名は本人が変えられるので使わない）。
 *     1回の承認は「最後に送った1件」にだけ効く。承認者IDは scripts/report-local.json（gitに入れない）。無ければ公開しない
 *   - 台帳 scripts/report-ledger.json は確認用URLを含むので gitに入れない（yoron-bbq.com は公開リポジトリで scripts/ も配信される）
 *   - claude は1回あたり1呼び出し（定額枠・Opus）。写真は番号付きの一覧画像にして渡す
 *   - 送信の途中で落ちた回（built）は、作り直さずに送信だけやり直す。生成失敗は3回まで（毎回Opusを呼び続けない）
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import { breaker, breakerOk, throttledNotify } from "../../../tools/lib/failsafe.mjs";
import { claudeBin, isWeeklyLimit } from "../../../tools/lib/claude-bin.mjs";
import { renderReport, sendReport, esc } from "../../../tools/lib/report-mail.mjs";
import { ymdJst } from "../../../tools/lib/jst.mjs";
import { BBQ_PARENT_PAGE_ID, listChildBlocks, pageText, linePush, calendarEvents } from "./lib/bbq-notion.mjs";
import { eventsToGenerate, findApproval, approvalCutoff, latestSent, sanitizePage, reportIndexItems, eventCandidates, missingAlbumAction, MAX_FAILURES, CATCHUP_DAYS, MIN_PHOTOS } from "./report/pipeline.mjs";
import { buildSite } from "./report/render.mjs";

const HOME = os.homedir();
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, "..");
const LEDGER = path.join(SCRIPTS, "report-ledger.json");
const LOCAL = path.join(SCRIPTS, "report-local.json");
const LOGF = path.join(SCRIPTS, "report-run.log");
const WORK = path.join(HOME, ".cache/bbq-report");
const SITE = "https://yoron-bbq.com";
const GCP = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP}/databases/(default)/documents`;
const BUCKET = `${GCP}.firebasestorage.app`;
const LAUNCHD_LABEL = "com.yamane.bbq-report";
const MAIL_TO = ["yamane@potentialight.com"];

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const NO_LINE = argv.includes("--no-line"); // 初回の確認など、LINEグループへはまだ出さないとき
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);

const logs = [];
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; logs.push(l); console.log(l); };
const flushLog = () => { try { fs.appendFileSync(LOGF, logs.join("\n") + "\n"); } catch {} };

// ---------- 台帳・ローカル設定 ----------
function loadLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return {}; } }
function saveLedger(l) { if (!DRY) fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n"); }
function loadLocal() { try { return JSON.parse(fs.readFileSync(LOCAL, "utf8")); } catch { return {}; } }

// ---------- Firestore / Storage ----------
let _tok;
const token = async () => (_tok ||= await gcpAccessToken());
async function fsGet(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
  if (!r.ok) throw new Error(`Firestore GET ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const val = (f) => (f ? Object.values(f)[0] : undefined);

async function listAlbums() {
  const j = await fsGet(`${FS_BASE}/albums?pageSize=100`);
  const out = [];
  for (const d of j.documents || []) {
    const f = d.fields || {};
    const albumId = d.name.split("/").pop();
    const eventId = String(val(f.eventId) || albumId.slice(0, 10));
    if (!/^\d{4}-\d{2}-\d{2}/.test(eventId)) continue;
    out.push({ albumId, eventId, label: val(f.label) || "", place: val(f.place) || "" });
  }
  return out;
}
async function listPhotos(album) {
  const j = await fsGet(`${FS_BASE}/albums/${album.albumId}/photos?pageSize=500`);
  return (j.documents || [])
    .map((d) => ({ path: val(d.fields?.path), at: val(d.fields?.createdAt) || d.createTime }))
    .filter((p) => p.path)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
async function downloadPhotos(photos, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // 番号→Storageのパスの対応表。アルバムで写真が消されて番号がずれたら取り直す（消した写真を載せない）
  const mf = path.join(dir, "manifest.json");
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(mf, "utf8")); } catch {}
  for (const f of fs.readdirSync(dir)) if (/^\d+\.jpg$/.test(f) && !photos[Number(f.slice(0, -4))]) fs.rmSync(path.join(dir, f), { force: true });
  const names = [];
  for (let i = 0; i < photos.length; i++) {
    const name = `${String(i).padStart(2, "0")}.jpg`;
    const dst = path.join(dir, name);
    if (!fs.existsSync(dst) || manifest[name] !== photos[i].path) {
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(photos[i].path)}?alt=media`, { headers: { Authorization: `Bearer ${await token()}` } });
      if (!r.ok) { log(`写真DL失敗 ${photos[i].path}: ${r.status}`); continue; }
      fs.writeFileSync(dst, Buffer.from(await r.arrayBuffer()));
      // 長辺1400pxに縮める（macOS標準の sips）。位置情報などのメタデータは公開用の切り抜き(cropPhotos)で落とす
      try { execFileSync("sips", ["-Z", "1400", dst], { stdio: "ignore" }); } catch (e) { log(`縮小失敗 ${name}: ${e.message}`); }
      manifest[name] = photos[i].path;
    }
    names.push(name);
  }
  fs.writeFileSync(mf, JSON.stringify(manifest, null, 1));
  return names;
}
/** Storage にトークン付きで置く（ルール上は非公開。トークンを知っている人だけ開ける） */
async function uploadPreview(objectName, html) {
  const tok = crypto.randomUUID();
  const boundary = `b${crypto.randomBytes(8).toString("hex")}`;
  const meta = { name: objectName, contentType: "text/html; charset=utf-8", cacheControl: "no-store", metadata: { firebaseStorageDownloadTokens: tok } };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n`),
    Buffer.from(html), Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=multipart`, {
    method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!r.ok) throw new Error(`確認用のアップロード失敗 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(objectName)}?alt=media&token=${tok}`;
}
async function deletePreview(objectName) {
  try { await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(objectName)}`, { method: "DELETE", headers: { Authorization: `Bearer ${await token()}` } }); } catch {}
}

async function lineLogs(fromIso, toIso) {
  const body = { structuredQuery: {
    from: [{ collectionId: "line_group_log" }],
    where: { compositeFilter: { op: "AND", filters: [
      { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: fromIso } } },
      { fieldFilter: { field: { fieldPath: "createdAt" }, op: "LESS_THAN", value: { stringValue: toIso } } },
    ] } },
    orderBy: [{ field: { fieldPath: "createdAt" } }], limit: 500,
  } };
  const r = await fetch(`${FS_BASE}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`line_group_log runQuery ${r.status}`);
  return (await r.json()).filter((x) => x.document).map((x) => {
    const f = x.document.fields;
    return { who: val(f.who) || "", userId: val(f.userId) || "", groupId: val(f.groupId) || "", text: val(f.text) || "", createdAt: val(f.createdAt) || "" };
  });
}

// ---------- 素材 ----------
function scheduleEntry(date) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "schedule-events.json"), "utf8"));
    return (j.events || []).find((e) => e.date === date) || null;
  } catch { return null; }
}
/** Notion「🐿️ バーベキュー」直下で、タイトルが開催日(YYYYMMDD)で始まる振り返り系ページ */
async function notesFor(date, { withText = true } = {}) {
  const ymd = date.replace(/-/g, "");
  const out = [];
  for (const b of await listChildBlocks(BBQ_PARENT_PAGE_ID)) {
    if (b.type !== "child_page") continue;
    const title = b.child_page?.title || "";
    if (!title.startsWith(ymd) || /アジェンダ|議事録|招待/.test(title)) continue;
    out.push({ id: b.id, title, edited: b.last_edited_time, text: withText ? await pageText(b.id) : "" });
  }
  return out;
}
/** 音声メモ（memo-sync の直近ログ）から開催日(JST)の段落だけ */
function memosFor(date) {
  const out = [];
  for (const f of ["AQUA-RECENT.md", "RECENT.md"]) {
    const p = path.join(HOME, "dev/tools/memo-sync", f);
    if (!fs.existsSync(p)) continue;
    for (const part of fs.readFileSync(p, "utf8").split(/\n(?=## \d{4}-\d{2}-\d{2}T)/)) {
      const m = part.match(/^## (\S+)/);
      if (!m || ymdJst(new Date(m[1])) !== date) continue;
      if (!/バーベキュー|BBQ|焼|鶏|グリル|燻製|料理|美味し/.test(part)) continue;
      out.push(part.slice(0, 1500));
    }
  }
  return out.slice(0, 30);
}
const jstStamp = (iso) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

// ---------- 写真の一覧画像（Claudeに渡す） ----------
async function loadPlaywright() {
  for (const c of ["dev/tools/ux-patrol", "dev/tools/content-bundle", "dev/note-persona"].map((d) => path.join(HOME, d, "node_modules/playwright/index.mjs"))) {
    if (fs.existsSync(c)) return import(pathToFileURL(c).href);
  }
  throw new Error("playwright が見つからない");
}
async function contactSheets(photoDir, names, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const { chromium } = await loadPlaywright();
  const b = await chromium.launch();
  const files = [];
  try {
    for (let s = 0; s < names.length; s += 12) {
      const cells = names.slice(s, s + 12).map((n) => `<div class="c"><img src="${pathToFileURL(path.join(photoDir, n)).href}"><b>${n.replace(".jpg", "")}</b></div>`).join("");
      const hp = path.join(outDir, `sheet${s / 12}.html`);
      fs.writeFileSync(hp, `<html><body style="margin:0;background:#fff"><style>.g{display:grid;grid-template-columns:repeat(4,300px);gap:6px;padding:6px}.c{position:relative;width:300px;height:300px;overflow:hidden;background:#eee}.c img{width:100%;height:100%;object-fit:contain}.c b{position:absolute;left:0;top:0;background:#000;color:#ff0;font:700 28px sans-serif;padding:2px 8px}</style><div class="g">${cells}</div></body></html>`);
      const p = await b.newPage({ viewport: { width: 1236, height: 930 } });
      await p.goto(pathToFileURL(hp).href, { waitUntil: "load" });
      const png = path.join(outDir, `sheet${s / 12}.png`);
      await p.screenshot({ path: png, fullPage: true });
      await p.close();
      files.push(png);
    }
  } finally { await b.close(); }
  return files;
}

// ---------- 生成 ----------
function generatePage({ album, sched, notes, memos, lines, sheets, photoCount, prevErrors }) {
  const bin = claudeBin();
  if (!bin) throw new Error("claude CLI が見つからない");
  const guide = fs.readFileSync(path.join(SCRIPTS, "report/prompt.md"), "utf8");
  // 見本＝山根さんと往復して仕上げた 9/26 のレポート（形・トーン・写真の選び方・切り抜き・吹き出しの配分をこれに合わせる）
  const example = fs.readFileSync(path.join(SCRIPTS, "report/examples/2026-09-26.page.json"), "utf8");
  const src = [
    `## 開催情報\n日付: ${album.eventId.slice(0, 10)}\nアルバム名: ${album.label}\n場所: ${album.place || sched?.place || "不明"}\n予定台帳: ${sched ? `${sched.title}（${sched.place || ""}）` : "なし"}\n写真: ${photoCount}枚`,
    sheets.length ? `## 写真の一覧画像（番号＝ファイル名。Readで全部見ること）\n${sheets.join("\n")}` : "## 写真\nこの回は写真がありません。image の図は使わず、今日のメニューの写真列は空文字にする",
    `## 振り返りメモ（Notion）\n${notes.map((n) => `### ${n.title}\n${n.text}`).join("\n\n") || "なし"}`,
    `## 音声メモ（当日）\n${memos.join("\n---\n") || "なし"}`,
    `## 運営LINEグループ（前後の会話・時刻は日本時間）\n${lines.map((l) => `${jstStamp(l.createdAt)} ${l.who}: ${l.text.replace(/\n/g, " / ")}`).join("\n") || "なし"}`,
    prevErrors ? `## 前回の出力の問題（直して出し直すこと）\n${prevErrors}` : "",
  ].filter(Boolean).join("\n\n");
  const prompt = `${guide}\n\n# 見本（9/26 のレポート。形・トーン・写真の使い方・吹き出しの配分をこれに合わせる。中身は写さない）\n${example}\n\n# ここから素材\n${src}\n\n以上を読んで、page.json を1つだけ出力してください。`;
  let out;
  try {
    const args = ["-p", prompt, "--model", "claude-opus-4-8"];
    if (sheets.length) args.push("--allowedTools", "Read", "--add-dir", path.dirname(sheets[0]));
    out = execFileSync(bin, args, {
      encoding: "utf8", timeout: 1200000, cwd: ROOT, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CLAUDECODE: "" },
    });
  } catch (e) {
    const t = `${e.stdout || ""}${e.stderr || ""}`;
    if (isWeeklyLimit(t)) { const err = new Error("claude 定額枠の上限（リセット後に自然回復）"); err.limit = true; throw err; }
    throw e;
  }
  if (isWeeklyLimit(out)) { const err = new Error("claude 定額枠の上限（リセット後に自然回復）"); err.limit = true; throw err; }
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`生成結果にJSONがない: ${out.slice(0, 200)}`);
  return JSON.parse(raw.slice(s, e + 1));
}

/** page.json → 仕上がったページ（キャッシュ内の site/ に書き出す。公開リポジトリには書かない） */
/**
 * 公開用の写真を作る: 料理のまわりだけ切り抜き（crop=[x,y,w,h] は向きを直した写真に対する0〜1の割合）、
 * 長辺800pxに縮め、描き直して保存する（EXIFの位置情報なども残らない）。2026-09-27 山根さん「蓋や上下の余白は切っていい」
 */
/** crop=[x,y,w,h]（0〜1の割合）を安全な範囲に丸める。指定なし・不正なら写真全体 */
export function normCrop(crop) {
  if (!Array.isArray(crop) || crop.length !== 4 || !crop.every((v) => Number.isFinite(Number(v)))) return [0, 0, 1, 1];
  const cl = (v) => Math.min(1, Math.max(0, Number(v)));
  const x = cl(crop[0]), y = cl(crop[1]);
  const w = Math.max(0.1, Math.min(1 - x, cl(crop[2]))), h = Math.max(0.1, Math.min(1 - y, cl(crop[3])));
  return [x, y, w, h].map((v) => Math.round(v * 1000) / 1000);
}
async function cropPhotos(jobs, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  if (!jobs.length) return;
  const { chromium } = await loadPlaywright();
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    for (const j of jobs) {
      // file:// の画像はcanvasから書き出せない（taint）ので、データURLで渡す
      const src = `data:image/jpeg;base64,${fs.readFileSync(j.src).toString("base64")}`;
      const data = await p.evaluate(async ({ src, crop, max }) => {
        const im = new Image();
        im.src = src;
        await im.decode();
        const w = im.naturalWidth, h = im.naturalHeight;
        const [x, y, cw, ch] = crop;
        const sx = Math.round(x * w), sy = Math.round(y * h), sw = Math.round(cw * w), sh = Math.round(ch * h);
        const k = Math.min(1, max / Math.max(sw, sh));
        const c = document.createElement("canvas");
        c.width = Math.round(sw * k); c.height = Math.round(sh * k);
        c.getContext("2d").drawImage(im, sx, sy, sw, sh, 0, 0, c.width, c.height);
        return c.toDataURL("image/jpeg", 0.85);
      }, { src, crop: j.frac, max: 800 });
      const buf = Buffer.from(String(data).split(",")[1] || "", "base64");
      if (buf.length < 1000) throw new Error(`写真の切り抜きに失敗: ${j.name}`);
      fs.writeFileSync(path.join(dstDir, j.name), buf);
    }
  } finally { await b.close(); }
}
/** page.json の写真ごとの切り抜き指定（同じ写真は最初の指定を使う） */
export function photoCrops(page) {
  const out = {};
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const m = o.kind === "image" && String(o.url || "").match(/^img\/photos\/([\w.-]+\.jpg)$/);
    if (m && !(m[1] in out)) out[m[1]] = normCrop(o.crop);
    for (const v of Object.values(o)) walk(v);
  };
  walk(page);
  return out;
}
/** 仕上がったページを自分で点検する（page-kit のビジネス資料向けゲートの代わり） */
export function checkReport(html) {
  const ng = [];
  if (!/<h1>[^<]{4,}<\/h1>/.test(html)) ng.push("見出し(h1)がない");
  if ((html.match(/<section class="sec" id="c\d+">/g) || []).length < 2) ng.push("章が2つ未満");
  for (const w of ["持ち帰る要点", "次にやること", "推奨しないこと", "Potentialight", "POTENTIALIGHT", "potentialight.com"]) if (html.includes(w)) ng.push(`載せない言葉: ${w}`);
  if (/[\u{1F000}-\u{1FAFF}\u2757\u203C]/u.test(html)) ng.push("絵文字");
  return ng;
}
async function renderPage(page, photoDir, buildDir, buildId) {
  // 版ごとに別フォルダ（作り直しが途中で失敗しても、送った版の仕上がりは上書きされない）
  fs.rmSync(buildDir, { recursive: true, force: true });
  const siteDir = path.join(buildDir, "site");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, "page.json"), JSON.stringify(page, null, 2));
  const crops = photoCrops(page);
  const sel = path.join(buildDir, "used-photos");
  await cropPhotos(Object.entries(crops).filter(([n]) => fs.existsSync(path.join(photoDir, n))).map(([name, frac]) => ({ name, frac, src: path.join(photoDir, name) })), sel);
  buildSite(page, siteDir, sel);
  // どの版かを本番で見分ける目印（waitLive 用）
  const idx = path.join(siteDir, "index.html");
  const html = fs.readFileSync(idx, "utf8").replace("<head>", `<head>\n<meta name="bbq-build" content="${buildId}">`);
  fs.writeFileSync(idx, html);
  const ng = checkReport(html);
  return { siteDir, pass: !ng.length, gate: ng.join("／") };
}
export const ROBOTS_RE = /\n?<meta name="robots"[^>]*>/g;
/** 確認用: 画像を埋め込んだ1ファイルのHTML（noindex） */
export function selfContained(siteDir, { shrink = true } = {}) {
  let html = fs.readFileSync(path.join(siteDir, "index.html"), "utf8").replace(ROBOTS_RE, "");
  html = html.replace("<head>", '<head>\n<meta name="robots" content="noindex,nofollow,noarchive">');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-inline-"));
  return html.replace(/src="(img\/[^"]+)"/g, (m, rel) => {
    const f = path.join(siteDir, rel);
    if (!fs.existsSync(f)) return m;
    if (f.endsWith(".svg")) return `src="data:image/svg+xml;base64,${fs.readFileSync(f).toString("base64")}"`;
    const small = path.join(tmp, path.basename(f));
    fs.copyFileSync(f, small);
    if (shrink) { try { execFileSync("sips", ["-Z", "900", small], { stdio: "ignore" }); } catch {} }
    return `src="data:image/jpeg;base64,${fs.readFileSync(small).toString("base64")}"`;
  });
}

// ---------- 公開（GitHub Pages = main に push） ----------
const git = (args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 180000 });
function pushPaths(paths, msg) {
  git(["add", "--", ...paths]);
  const staged = git(["diff", "--cached", "--name-only", "--", ...paths]).trim();
  if (staged) git(["commit", "-qm", `${msg}\n\nCo-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`, "--", ...paths]);
  else log("コミット対象なし（前回のコミットが未pushなら続けてpushする）");
  git(["pull", "-q", "--rebase", "--autostash"]); // 失敗したら例外で止める（push に進まない）
  const ahead = Number(git(["rev-list", "--count", "@{u}..HEAD"]).trim() || 0);
  if (ahead > 0) git(["push", "-q"]);
  return ahead > 0;
}
/** 本番URLで実測（pushした＝出た、と取り違えない）。marker は版ごとの目印 */
async function waitLive(url, marker, { tries = 24, waitMs = 15000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url.includes("?") ? url : `${url}?v=${Date.now()}`, { cache: "no-store" });
      if (r.ok && (!marker || (await r.text()).includes(marker))) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, waitMs));
  }
  return false;
}

export function indexHtml(items) {
  const cards = items.map((it) => `<a class="card" href="/${esc(it.path)}">${it.thumb ? `<img src="/${esc(it.path)}${esc(it.thumb)}" alt="" loading="lazy">` : ""}<div class="t"><small>${esc(it.date)}${it.place ? `・${esc(it.place)}` : ""}</small><b>${esc(it.title)}</b></div></a>`).join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>BBQレポート | YORON BBQ COMMUNITY</title><meta name="description" content="YORON BBQ のバーベキューの記録。その日に焼いた料理と、焼き方のポイントを写真でまとめています。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d95f3b'/%3E%3Ctext x='16' y='23' font-family='sans-serif' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3EY%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/community.css">
<style>.rp{max-width:980px;margin:0 auto;padding:6.4rem 1.2rem 4rem}.rp-h{text-align:center;margin-bottom:2rem}.rp-h small{display:block;font-size:.68rem;letter-spacing:.3em;color:var(--ember);font-weight:900;margin-bottom:.5rem}.rp-h h1{font-size:clamp(1.4rem,4.6vw,2rem);font-weight:900;margin:0 0 .4rem}.rp-h p{color:var(--ink-soft);font-size:.92rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}.card{background:var(--card);border-radius:18px;overflow:hidden;text-decoration:none;color:var(--ink);box-shadow:0 4px 24px rgba(45,37,28,.07)}.card img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}.card .t{padding:12px 14px 14px}.card small{display:block;color:var(--ember);font-weight:900;font-size:.72rem;letter-spacing:.06em}.card b{display:block;font-size:.98rem;line-height:1.5;margin-top:4px}</style>
</head><body><div class="bg-grain" aria-hidden="true"></div>
<nav id="nav"><div class="nav-inner"><a href="/index.html" class="nav-logo">YORON BBQ <small>COMMUNITY</small></a></div></nav>
<main class="rp"><header class="rp-h"><small>BBQ REPORT</small><h1>BBQレポート</h1><p>その日に焼いた料理と、焼き方のポイントを写真でまとめています。</p></header>
<div class="grid">
${cards || '<p style="text-align:center;color:var(--smoke)">まだレポートはありません。</p>'}
</div></main></body></html>
`;
}
function addToSitemap(url) {
  const p = path.join(ROOT, "sitemap.xml");
  let s = fs.readFileSync(p, "utf8");
  if (s.includes(`<loc>${url}</loc>`)) return;
  s = s.replace("</urlset>", `  <url>\n    <loc>${url}</loc>\n    <lastmod>${ymdJst()}</lastmod>\n  </url>\n</urlset>`);
  fs.writeFileSync(p, s);
}

// ---------- 通知 ----------
const mdLabel = (eventId) => { const [, m, d] = eventId.slice(0, 10).split("-"); return `${Number(m)}/${Number(d)}`; };
async function notifyPreview(e, eventId, { update = false } = {}) {
  const url = e.previewUrl;
  const md = mdLabel(eventId);
  const { html, text } = renderReport({
    title: `BBQレポート${update ? "（更新版）" : ""}：${md} ${e.place || e.label || ""}`,
    dateLabel: `${eventId.slice(0, 10)} 開催分・確認用（まだ公開していません）`,
    legend: ["確認用URLは、リンクを知っている人だけが開ける置き場所です（検索にも出ません）。", "LINEでやまちゃんが「レポートOK」と返すと、yoron-bbq.com/report/ に公開します。"],
    sections: [{ title: e.title || "BBQレポート", kind: "html", html: `<a href="${esc(url)}" style="text-decoration:none;color:inherit;display:block;background:#fffdf6;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.06)"><div style="padding:12px 14px"><div style="font-size:13px;color:#5b5044;line-height:1.7">${esc(e.lead || "")}</div><div style="margin-top:10px"><span style="display:inline-block;background:#d95f3b;color:#fff;font-weight:900;font-size:13px;border-radius:999px;padding:7px 16px">レポートを見る</span></div></div></a>` }],
    footer: "BBQレポート便（開催日の夜に自動で作ります）",
  });
  const mail = await sendReport({ subject: `【YORON BBQ レポート】${md} ${e.title || ""}`.slice(0, 120), html, text, to: MAIL_TO, fromName: "YORON BBQ レポート" });
  log(`メール: ${mail.ok ? `送信 ${mail.id}` : `失敗 ${mail.error}`}`);
  if (!mail.ok) throw new Error(`メール送信失敗: ${mail.error}`);
  let line = false;
  if (NO_LINE) log("LINE: 今回は送らない（--no-line）");
  else {
    line = await linePush(`${md}のBBQレポートを作ったよ！${update ? "（振り返りを反映した更新版）" : ""}\n「${e.title || ""}」\n${url}\n\nこれで良さそうなら、やまちゃんが「レポートOK」って返したらサイトに公開するね！直してほしいところがあったらここで教えて！`);
    log(`LINE: ${line ? "送信" : "失敗（送信箱へ退避・request-loopが再送）"}`);
  }
  return { mail: mail.id, line };
}

// ---------- 1回分 ----------
async function buildPreview(album, { contentPath } = {}) {
  const eventId = album.eventId;
  const date = eventId.slice(0, 10);
  const dir = path.join(WORK, eventId);
  const photoDir = path.join(dir, "photos");
  const names = album.albumId ? await downloadPhotos(await listPhotos(album), photoDir) : [];
  log(`${eventId}: 写真${names.length}枚`);

  let page;
  let notesEditedAt = "";
  if (contentPath) {
    const r = sanitizePage(JSON.parse(fs.readFileSync(contentPath, "utf8")), { photoNames: names });
    if (r.errors.length) throw new Error(`用意された page.json が要件を満たさない: ${r.errors.join("／")}`);
    page = r.page;
  } else {
    const notes = await notesFor(date);
    notesEditedAt = notes.map((n) => n.edited).sort().pop() || "";
    const memos = memosFor(date);
    const from = new Date(Date.parse(`${date}T00:00:00+09:00`) - 3 * 86400000).toISOString();
    const to = new Date(Date.parse(`${date}T00:00:00+09:00`) + 2 * 86400000).toISOString();
    const lines = await lineLogs(from, to);
    const sheets = names.length ? await contactSheets(photoDir, names, path.join(dir, "sheets")) : [];
    log(`素材: 振り返り${notes.length}件・音声メモ${memos.length}件・LINE${lines.length}件・一覧画像${sheets.length}枚`);
    let prevErrors = "";
    for (let attempt = 1; attempt <= 2 && !page; attempt++) {
      const r = sanitizePage(generatePage({ album, sched: scheduleEntry(date), notes, memos, lines, sheets, photoCount: names.length, prevErrors }), { photoNames: names });
      if (!r.errors.length) page = r.page;
      else { prevErrors = r.errors.join("／"); log(`生成${attempt}回目の問題: ${prevErrors}`); }
    }
    if (!page) throw Object.assign(new Error(`生成が2回とも要件を満たさなかった: ${prevErrors}`), { genFailed: true });
  }

  const buildId = `${eventId}-${Date.now().toString(36)}`;
  const r = await renderPage(page, photoDir, path.join(dir, "builds", buildId), buildId);
  log(`ページ: ${r.siteDir}（${r.pass ? "チェック通過" : `チェック差し戻し\n${r.gate}`}）`);
  if (!r.pass) throw Object.assign(new Error(`ページの点検で差し戻し: ${r.gate}`), { genFailed: true });
  const thumb = (JSON.stringify(page).match(/img\/photos\/[\w.-]+\.jpg/) || [""])[0];
  return { page, siteDir: r.siteDir, buildId, thumb, photos: names.length, notesEditedAt };
}

async function sendBuilt(eventId, e, ledger) {
  if (!e.previewUrl) throw new Error(`${eventId} の確認用URLがない`);
  if (!(await waitLive(e.previewUrl, e.buildId, { tries: 4, waitMs: 5000 }))) throw new Error(`確認用URLが開けない: ${eventId}`);
  const n = await notifyPreview(e, eventId, { update: (e.generations || 1) > 1 });
  e.status = "sent"; e.sentAt = new Date().toISOString(); e.notified = n;
  saveLedger(ledger);
  log(`${eventId}: 送付済み`);
}

/** 予定台帳・カレンダー・Notion・アルバムから開催日の候補を集める */
async function collectCandidates(albums) {
  const today = ymdJst();
  let schedule = [];
  try { schedule = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "schedule-events.json"), "utf8")).events || []; } catch {}
  let calendar = [];
  try {
    const from = new Date(Date.parse(`${today}T00:00:00+09:00`) - (CATCHUP_DAYS + 1) * 86400000).toISOString();
    const to = new Date(Date.parse(`${today}T00:00:00+09:00`) + 86400000).toISOString();
    calendar = (await calendarEvents(from, to)).map((e) => ({ summary: e.summary || "", date: e.start?.date || (e.start?.dateTime ? ymdJst(new Date(e.start.dateTime)) : "") }));
  } catch (e) { log(`カレンダー取得失敗（他の素材で続ける）: ${e.message}`); }
  const notes = [];
  try {
    for (const b of await listChildBlocks(BBQ_PARENT_PAGE_ID)) {
      if (b.type !== "child_page") continue;
      const t = b.child_page?.title || "";
      const m = t.match(/^(\d{4})(\d{2})(\d{2})/);
      if (m) notes.push({ date: `${m[1]}-${m[2]}-${m[3]}`, title: t });
    }
  } catch (e) { log(`Notion取得失敗（他の素材で続ける）: ${e.message}`); }
  return { cands: eventCandidates({ schedule, calendar, notes, albums }, today), notes };
}

/** アルバムが無い回: 翌日に「アルバムを作って」と1回知らせ、3日たって振り返りがあれば写真なしで作る */
async function missingAlbumTargets(albums, ledger) {
  const { cands, notes } = await collectCandidates(albums);
  const out = [];
  for (const c of cands) {
    const album = albums.find((a) => a.eventId.slice(0, 10) === c.date && (a.photos || 0) >= MIN_PHOTOS);
    if (album) continue; // 通常の経路（eventsToGenerate）で作る
    const entry = ledger[c.date] || {};
    const hasNotes = notes.some((n) => n.date === c.date && /(BBQ|ＢＢＱ|バーベキュー)/i.test(n.title)) || memosFor(c.date).length > 0;
    const photos = Math.max(0, ...albums.filter((a) => a.eventId.slice(0, 10) === c.date).map((a) => a.photos || 0));
    const act = missingAlbumAction(c, { photos, hasNotes, entry });
    log(`${c.date}: 開催日の候補（${c.sources.join("・")}／${c.titles.join("・").slice(0, 60)}）写真${photos}枚・振り返り${hasNotes ? "あり" : "なし"} → ${act}`);
    if (act === "remind" && !DRY) {
      const md = mdLabel(c.date);
      const { html, text } = renderReport({
        title: `${md}のBBQ、写真のアルバムが見つかりません`,
        dateLabel: `${c.date}（${c.titles[0] || "BBQ"}）`,
        legend: ["BBQレポートは、アルバムの写真・振り返り・LINEから作ります。", `管理ページ（yoron-bbq.com/admin.html）の「フォトアルバム」でアルバムを作り、写真を集めてもらえれば、自動でレポートを作ります。写真が無くても、振り返りがあれば${3}日後に写真なしで作ります。`],
        sections: [{ title: "見つけた手がかり", items: [{ title: c.titles.join("／") || "BBQ", meta: c.sources.map((s) => ({ schedule: "予定台帳", calendar: "カレンダー", notes: "Notionの振り返り", album: "アルバム" }[s] || s)).join("・") }] }],
        footer: "BBQレポート便",
      });
      const m = await sendReport({ subject: `【YORON BBQ レポート】${md}のBBQ、写真のアルバムがありません`, html, text, to: MAIL_TO, fromName: "YORON BBQ レポート" });
      log(`アルバム作成のお知らせ: ${m.ok ? m.id : m.error}`);
      if (m.ok) { ledger[c.date] = { ...entry, status: "reminded", remindedAt: new Date().toISOString(), titles: c.titles }; saveLedger(ledger); }
    }
    if (act === "notes-only") {
      const a = albums.find((x) => x.eventId.slice(0, 10) === c.date);
      out.push({ album: a || { eventId: c.date, albumId: "", label: c.titles[0] || "", place: "" }, reason: "notes-only" });
    }
  }
  return out;
}

async function main() {
  const ledger = loadLedger();
  const local = loadLocal();

  // A. 公開の指示（手動）
  if (arg("--publish")) return publish(arg("--publish"), ledger, "手動");

  // B. 承認待ちのうち「最後に送った1件」に、やまちゃんの「レポートOK」が来ていたら公開
  const last = latestSent(ledger);
  if (last && !(local.approverUserIds || []).length) {
    await throttledNotify("bbq-report-local", "BBQレポート便: scripts/report-local.json（承認者のLINE ID）が無いので、「レポートOK」を受け付けられません", { cooldownMin: 1440 });
  } else if (last) {
    const [eventId] = last;
    const cutoff = approvalCutoff(ledger);
    const ok = findApproval(await lineLogs(cutoff, new Date(Date.now() + 60000).toISOString()), cutoff, { approverUserIds: local.approverUserIds || [], groupId: local.groupId || "" });
    if (ok) {
      log(`${eventId}: 承認「${ok.text.slice(0, 30)}」(${ok.createdAt})`);
      if (DRY) log("[dry] 公開はしない");
      else {
        ledger._approvalUsedAt = ok.createdAt; // この承認はここで使い切る（古い回へ連鎖させない）
        saveLedger(ledger);
        await publish(eventId, ledger, ok.createdAt);
      }
    }
  }

  // C. 作ったのに送れていない回（built）は、作り直さずに送信だけやり直す
  for (const [eventId, e] of Object.entries(ledger)) {
    if (!eventId.startsWith("_") && e.status === "built" && !DRY) await sendBuilt(eventId, e, ledger);
  }

  // D. 新しい回の確認用を作る
  const albums = await listAlbums();
  let targets;
  if (arg("--event")) {
    const a = albums.find((x) => x.eventId === arg("--event") || x.albumId.startsWith(arg("--event")));
    if (!a) throw new Error(`アルバムが見つからない: ${arg("--event")}`);
    targets = [{ album: a, reason: "manual" }];
  } else {
    const today = ymdJst();
    for (const a of albums) {
      const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${a.eventId.slice(0, 10)}T00:00:00Z`)) / 86400000);
      if (diff < 0 || diff > CATCHUP_DAYS) continue; // 写真数・振り返りは直近の回だけ数える
      a.photos = (await listPhotos(a)).length;
      if (ledger[a.eventId]?.status === "sent") a.notesEditedAt = (await notesFor(a.eventId.slice(0, 10), { withText: false })).map((n) => n.edited).sort().pop() || "";
    }
    targets = eventsToGenerate(albums, ledger);
    // アルバムが無い／写真が足りない開催日を、予定台帳・カレンダー・Notionからも拾う（漏れ防止）
    for (const t of await missingAlbumTargets(albums, ledger)) targets.push(t);
  }
  if (!targets.length) { log("対象の回なし"); return; }

  for (const { album, reason } of targets) {
    log(`${album.eventId}: 生成（${reason}）`);
    const prev = ledger[album.eventId] || {};
    let b;
    try { b = await buildPreview(album, { contentPath: arg("--content") }); }
    catch (err) {
      if (err.genFailed && !DRY) {
        ledger[album.eventId] = { ...prev, status: prev.status === "sent" ? "sent" : "failed", failures: (prev.failures || 0) + 1, lastError: String(err.message).slice(0, 300) };
        saveLedger(ledger);
        if ((prev.failures || 0) + 1 >= MAX_FAILURES) await throttledNotify(`bbq-report-gen:${album.eventId}`, `BBQレポート便: ${album.eventId} の生成が${MAX_FAILURES}回うまくいかず止めました\n${String(err.message).slice(0, 300)}`, { cooldownMin: 1440 });
      }
      throw err;
    }
    if (DRY) { log(`[dry] 仕上がり: ${b.siteDir}/index.html`); continue; }
    const objectName = `report-previews/${album.eventId}-${crypto.randomBytes(6).toString("hex")}.html`;
    const previewUrl = await uploadPreview(objectName, selfContained(b.siteDir));
    if (prev.previewObject) await deletePreview(prev.previewObject); // 更新版を出したら前の確認用は消す
    ledger[album.eventId] = {
      ...prev, status: "built", label: album.label, place: album.place, title: b.page.title, lead: String(b.page.lead || "").replace(/\*\*/g, ""),
      previewUrl, previewObject: objectName, buildId: b.buildId, buildDir: b.siteDir, thumb: b.thumb, photos: b.photos, failures: 0,
      notesEditedAt: b.notesEditedAt || album.notesEditedAt || prev.notesEditedAt || "", generations: (prev.generations || 0) + 1, builtAt: new Date().toISOString(),
    };
    saveLedger(ledger);
    await sendBuilt(album.eventId, ledger[album.eventId], ledger);
  }
}

async function publish(eventId, ledger, approvedBy) {
  if (DRY) throw new Error("--dry-run では公開しない");
  const e = ledger[eventId];
  if (!e?.buildDir || !fs.existsSync(path.join(e.buildDir, "index.html"))) throw new Error(`${eventId} の仕上がりが見つからない（${e?.buildDir}）`);
  // 承認した版（送った版）と同じものだけを公開する
  if (!fs.readFileSync(path.join(e.buildDir, "index.html"), "utf8").includes(`content="${e.buildId}"`)) throw new Error(`${eventId}: 仕上がりの版(${e.buildId})が送った版と一致しない`);
  const date = eventId.slice(0, 10);
  const dst = path.join(ROOT, "report", date);
  fs.mkdirSync(path.join(ROOT, "report"), { recursive: true });
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(e.buildDir, dst, { recursive: true });
  const idx = path.join(dst, "index.html");
  fs.writeFileSync(idx, fs.readFileSync(idx, "utf8").replace(ROBOTS_RE, "")); // page-kit既定のnoindexも含めて全部外す
  const pages = fs.readdirSync(path.join(ROOT, "report"), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, html: fs.existsSync(path.join(ROOT, "report", d.name, "index.html")) ? fs.readFileSync(path.join(ROOT, "report", d.name, "index.html"), "utf8") : "" }));
  fs.writeFileSync(path.join(ROOT, "report/index.html"), indexHtml(reportIndexItems(pages)));
  addToSitemap(`${SITE}/report/${date}/`);
  addToSitemap(`${SITE}/report/`);
  pushPaths([`report/${date}`, "report/index.html", "sitemap.xml"], `BBQレポート: ${eventId} を公開`);
  const url = `${SITE}/report/${date}/`;
  if (!(await waitLive(url, e.buildId))) throw new Error(`公開URLが本番に出てこない: ${url}`);
  Object.assign(e, { status: "published", publicPath: `report/${date}/`, approvedAt: approvedBy, publishedAt: new Date().toISOString() });
  saveLedger(ledger);
  log(`公開を本番で確認: ${url}`);
  if (e.previewObject) await deletePreview(e.previewObject);
  if (NO_LINE) log("LINE: 今回は送らない（--no-line）");
  else await linePush(`BBQレポートを公開したよ！\n${url}\n一覧はこちら → ${SITE}/report/`);
  const { html, text } = renderReport({ title: "BBQレポートを公開しました", dateLabel: `${date} 開催分`, sections: [{ title: e.title || "", items: [{ title: "公開ページ", link: url, linkLabel: url }, { title: "レポート一覧", link: `${SITE}/report/`, linkLabel: `${SITE}/report/` }] }], footer: "BBQレポート便" });
  const m = await sendReport({ subject: `【YORON BBQ レポート】公開しました：${e.title || date}`.slice(0, 120), html, text, to: MAIL_TO, fromName: "YORON BBQ レポート" });
  log(`公開メール: ${m.ok ? m.id : m.error}`);
}

const isDirect = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main()
    .then(() => { breakerOk("bbq-report"); flushLog(); })
    .catch(async (e) => {
      log(`クラッシュ: ${e.stack || e.message}`);
      flushLog();
      if (e.limit) return; // 定額枠の上限は自然回復を待つ（通知しない）
      await throttledNotify("bbq-report-crash", `BBQレポート便が失敗\n${String(e.message).slice(0, 300)}\nログ: ~/dev/bbq/bbq-site/scripts/report-run.log`, { cooldownMin: 60 });
      await breaker("bbq-report", { max: 5, label: LAUNCHD_LABEL });
      process.exit(1);
    });
}
