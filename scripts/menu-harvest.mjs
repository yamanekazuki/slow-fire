#!/usr/bin/env node
/**
 * menu-harvest — 「作った料理」をNotion振り返り＆LINEから拾ってメニュー台帳へ自動追加するループ
 *
 * 依頼（2026-09-20 山根さん）: 先週のBBQで作ったポテトグラタンやブレッドプディングのように、
 *   振り返り（Notion「🐿️ バーベキュー」配下）やLINEグループで「これ作った」と語られた料理を、
 *   買い物チェックの料理リスト（data/shopping-items.json の dishes）へ自動で足してほしい。
 *
 * 流れ:
 *   ① Notion: BBQ親ページ直下の子ページのうち「振り返り／気付き／バーベキュー当日／作ったシリーズ」系を対象。
 *      ledger の last_edited_time と比べて新規・更新分だけ本文を取得（未変更ならLLM呼び出しゼロ）
 *   ② LINE: Firestore line_group_log の前回位置以降で「作った／焼いた／料理／レシピ」を含む発言だけ集める
 *   ③ claude ヘッドレス（定額枠・Opus）が「実際にBBQで作った料理」だけを抽出し、
 *      既存の料理名（表記ゆれ含む）と重複しないものを items 付きで返す（保守的・1回最大5品）
 *   ④ shopping-items.json に追記 → git pull --rebase → commit → push（GitHub Pages が自動反映）
 *   ⑤ 追加があれば山根さんへ Slack DM 1通。追加なしは DM なし（ログのみ）。クラッシュは DM＋5連続でブレーカー
 *
 * 設計判断:
 *   - 既存の料理の材料は上書きしない（人が直したものを消さない）。改善案は DM に添えるだけ
 *   - 「作ってみたい／次回やりたい」は対象外。実際に焼いた・出した記述だけ
 *   - 店は stores リストの語だけ。量が本文に無ければ「適量」
 *
 *   node scripts/menu-harvest.mjs              通常実行
 *   node scripts/menu-harvest.mjs --dry-run    台帳更新・push・DMなし。抽出結果だけ表示
 *   node scripts/menu-harvest.mjs --page <id>  特定のNotionページだけ（ledger無視）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessSecret, gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import { breaker, breakerOk, throttledNotify } from "../../../tools/lib/failsafe.mjs";
import { ymdJst } from "../../../tools/lib/jst.mjs";

const HOME = os.homedir();
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const DATA = path.join(ROOT, "data/shopping-items.json");
const LEDGER = path.join(SCRIPTS, "menu-harvest-ledger.json");
const LOG = path.join(SCRIPTS, "menu-harvest-run.log");
const LAUNCHD_LABEL = "com.yamane.bbq-menu-harvest";

const BBQ_PARENT_PAGE_ID = "2d608460013480cb94afdb1564a84f86"; // 🐿️ バーベキュー
const NOTION_PROJECT = "tldv-notion-pote";
const GCP_PROJECT = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const SLACK_DM_USER = "U7XLRM33R";
const MAX_DISHES = 5;

// 対象ページの判定: 振り返り・気付き・当日・作ったシリーズ。会議系・企画系は除外
const INCLUDE_RE = /振り返り|気付き|気づき|バーベキュー当日|作ったシリーズ|バーベキュー$|バーベキュー\s*第\d+回|BBQ/i;
const EXCLUDE_RE = /議事録|アジェンダ|ミーティング|招待|効果|ECサイト|民泊|Airbnb|Booking|購入遷移|Weber|認識合わせ|話をして|話しをして|打ち合わせ|目指すべき|収支|コース|使い方|活用|温度チャート|整理$/;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONLY_PAGE = (() => { const i = argv.indexOf("--page"); return i >= 0 ? argv[i + 1] : null; })();

const logLines = [];
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); logLines.push(l); };
const flushLog = () => { try { fs.appendFileSync(LOG, logLines.join("\n") + "\n"); } catch {} };

async function slackDM(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_DM_USER, text, unfurl_links: false }),
    });
  } catch (e) { log(`⚠️ Slack DM失敗: ${e.message}`); }
}

// ---------- Notion ----------
let _notionToken;
async function notion(pathname) {
  _notionToken ||= process.env.NOTION_TOKEN?.trim() || (await accessSecret(NOTION_PROJECT, "NOTION_TOKEN"));
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    headers: { Authorization: `Bearer ${_notionToken}`, "Notion-Version": "2022-06-28" },
  });
  if (!res.ok) throw new Error(`Notion ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function listChildBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const j = await notion(`/blocks/${blockId}/children${q}`);
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}
const rt = (arr) => (arr || []).map((t) => t.plain_text || "").join("");
async function pageText(id, depth = 0) {
  const blocks = await listChildBlocks(id);
  let s = "";
  for (const b of blocks) {
    if (b.type === "child_page") continue; // 子ページは親の走査で別扱い
    const t = rt((b[b.type] || {}).rich_text);
    if (t) s += "\n" + "  ".repeat(depth) + t;
    if (b.has_children && depth < 2) s += await pageText(b.id, depth + 1);
  }
  return s;
}

// ---------- Firestore（LINEグループ会話ログ） ----------
async function fetchLineLog(sinceIso) {
  const token = await gcpAccessToken();
  const body = {
    structuredQuery: {
      from: [{ collectionId: "line_group_log" }],
      where: { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { stringValue: sinceIso } } },
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
      limit: 200,
    },
  };
  const res = await fetch(`${FS_BASE}:runQuery`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Firestore runQuery -> ${res.status}`);
  const rows = await res.json();
  const v = (f) => f?.stringValue ?? "";
  return (rows || []).filter((r) => r.document).map((r) => r.document.fields || {}).map((f) => ({ who: v(f.who), text: v(f.text), at: v(f.createdAt) }));
}

// ---------- claude ヘッドレス ----------
function claudeBin() {
  for (const p of [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}
function extract(sources, existingNames, stores, tags) {
  const prompt = `あなたは YORON BBQ（山根・あんちゃん・うえたく）の「買い物チェック」の料理リスト係です。
以下の素材（BBQの振り返りメモ／LINEグループの会話）から、「実際にBBQで作って出した料理」で、
既存リストに無いものだけを抽出し、買い物チェックに載せられる形（材料・購入場所付き）で返してください。

【既存の料理名（これらと同じ・表記ゆれ・部分一致のものは追加しない。例: プティング＝プディング、鶏＝鳥）】
${existingNames.join("／")}

【購入場所は必ずこの中から】 ${stores.join("／")}
【tag は次のどれか】 ${tags.join("／")}

【ルール（保守的に）】
- 「作った・焼いた・出した・提供した・うまくいった」など実施が読み取れる料理だけ。「やってみたい」「次回」「候補」は対象外。
- 材料は本文にあるものを優先。本文に無い場合だけ最小限の一般的材料を補い、その行の note に「（一般的な材料）」と書く。1品あたり最大6行。
- 量は本文にあればそのまま。無ければ "適量"。
- 既存の料理の改善点（材料の追加など）に気づいたら add ではなく suggest に1行で書く（既存は上書きしない）。
- 料理名が一般名だけ（例:「スープ」「サラダ」）で、本文から具体的な材料が分からないものは入れない（具体名が分かる料理だけ）。
- 迷ったら入れない。該当がなければ dishes は空配列。

【素材】
${sources}

出力は次のJSONだけ（前置き・後書き・コードフェンスなし）:
{
  "dishes": [ { "name": "料理名（既存の命名に合わせ簡潔に）", "tag": "…", "items": [ ["材料名","量","購入場所","メモ"] ], "source": "出典（ページ名や発言者・日付）", "evidence": "実施が分かる本文の一節（30字以内）" } ],
  "suggest": [ "既存料理への改善メモ（任意）" ],
  "none_reason": "dishesが空のときの理由1文（空でなければ空文字）"
}`;
  const out = execFileSync(claudeBin(), ["-p", prompt, "--model", "claude-opus-4-8"], {
    encoding: "utf8", timeout: 600000, cwd: ROOT, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CLAUDECODE: "" },
  });
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("抽出結果にJSONが見つからない");
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- 台帳 ----------
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { note: "menu-harvest 処理台帳。pages[pageId]=最後に処理した last_edited_time。lineCursor=LINEログの読み取り位置", pages: {}, lineCursor: new Date().toISOString(), added: [] }; }
}
const norm = (s) => String(s || "").replace(/[\s・（）()／/、。]/g, "").replace(/プティング/g, "プディング").replace(/鳥/g, "鶏").toLowerCase();

function validateDish(d, stores, tags, existingNorm) {
  if (!d || typeof d.name !== "string" || !d.name.trim() || d.name.length > 30) return "name不正";
  const n = norm(d.name);
  if ([...existingNorm].some((x) => x === n || (x.length >= 3 && n.includes(x)) || (n.length >= 3 && x.includes(n)))) return `既存と重複: ${d.name}`;
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 6) return `items不正: ${d.name}`;
  for (const it of d.items) {
    if (!Array.isArray(it) || it.length !== 4 || it.some((x) => typeof x !== "string")) return `item形式不正: ${d.name}`;
    if (!stores.includes(it[2])) it[2] = "スーパー";
  }
  if (d.items.some((it) => /具材|材料|適宜|お好み$/.test(it[0]))) return `材料が抽象的: ${d.name}`;
  const generic = d.items.filter((it) => /一般的な材料/.test(it[3])).length;
  if (generic === d.items.length && d.items.length < 2) return `根拠材料なし: ${d.name}`;
  if (!tags.includes(d.tag)) d.tag = "サイド";
  return null;
}

async function main() {
  const ledger = loadLedger();
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const existingNames = data.dishes.map((x) => x.name);
  const existingNorm = new Set(existingNames.map(norm));
  const tags = [...new Set(data.dishes.map((x) => x.tag).filter(Boolean))];

  // ① Notion
  const children = await listChildBlocks(BBQ_PARENT_PAGE_ID);
  let pages = children.filter((b) => b.type === "child_page").filter((b) => {
    const t = b.child_page?.title || "";
    return INCLUDE_RE.test(t) && !EXCLUDE_RE.test(t);
  });
  pages = ONLY_PAGE
    ? pages.filter((b) => b.id.replace(/-/g, "") === ONLY_PAGE.replace(/-/g, ""))
    : pages.filter((b) => (ledger.pages[b.id] || "") < b.last_edited_time);
  const sources = [];
  for (const p of pages) {
    const txt = await pageText(p.id);
    if (txt.trim().length < 80) { log(`短文スキップ: ${p.child_page.title}`); continue; }
    sources.push({ kind: "notion", id: p.id, edited: p.last_edited_time, title: p.child_page.title, text: txt.slice(0, 12000) });
    log(`Notion対象: ${p.child_page.title} (${p.last_edited_time.slice(0, 10)})`);
  }

  // ② LINE
  let lineRows = [];
  let lineCursor = ledger.lineCursor;
  if (!ONLY_PAGE) {
    try {
      const rows = await fetchLineLog(ledger.lineCursor);
      if (rows.length) lineCursor = rows[rows.length - 1].at;
      lineRows = rows.filter((r) => /作っ|焼い|料理|レシピ|グラタン|プディング|デザート|うまかった|美味し|おいし/.test(r.text));
      log(`LINE: 新着${rows.length}件 → 料理っぽい発言${lineRows.length}件`);
    } catch (e) { log(`⚠️ LINEログ取得失敗（Notionだけで続行）: ${e.message}`); }
  }
  if (lineRows.length) sources.push({ kind: "line", title: "LINEグループの会話", text: lineRows.map((r) => `- ${r.at.slice(0, 10)} ${r.who}: ${r.text}`).join("\n").slice(0, 8000) });

  if (!sources.length) {
    log("新規・更新の素材なし（LLM呼び出しゼロで終了）");
    if (!DRY_RUN && lineCursor !== ledger.lineCursor) { ledger.lineCursor = lineCursor; fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n"); }
    return;
  }

  // ③ 抽出
  const srcText = sources.map((s) => `### ${s.title}\n${s.text}`).join("\n\n");
  const r = extract(srcText, existingNames, data.stores, tags);
  const accepted = [], rejected = [];
  for (const d of (r.dishes || []).slice(0, MAX_DISHES)) {
    const why = validateDish(d, data.stores, tags, existingNorm);
    if (why) { rejected.push(why); continue; }
    accepted.push(d); existingNorm.add(norm(d.name));
  }
  log(`抽出: 追加${accepted.length}件／却下${rejected.length}件／改善メモ${(r.suggest || []).length}件${r.none_reason ? `／理由: ${r.none_reason}` : ""}`);
  rejected.forEach((x) => log(`  [却下] ${x}`));
  accepted.forEach((d) => log(`  [追加] ${d.name}（${d.tag}） ← ${d.source}｜${d.evidence}\n      ${d.items.map((i) => i.join("/")).join("、")}`));
  (r.suggest || []).forEach((x) => log(`  [改善メモ] ${x}`));

  if (DRY_RUN) { log("[dry-run] 台帳・push・DMなし"); return; }

  // ④ 反映
  if (accepted.length) {
    for (const d of accepted) data.dishes.push({ name: d.name.trim(), tag: d.tag, items: d.items });
    data.updated = ymdJst();
    fs.writeFileSync(DATA, JSON.stringify(data, null, 1) + "\n");
  }
  for (const s of sources) if (s.kind === "notion") ledger.pages[s.id] = s.edited;
  ledger.lineCursor = lineCursor;
  ledger.added = [...accepted.map((d) => ({ name: d.name, source: d.source, at: new Date().toISOString() })), ...(ledger.added || [])].slice(0, 200);
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");

  const git = (args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 120000 });
  git(["add", "data/shopping-items.json", "scripts/menu-harvest-ledger.json"]);
  const msg = accepted.length
    ? `メニュー自動追加: ${accepted.map((d) => d.name).join("・")}（menu-harvest／出典: ${[...new Set(accepted.map((d) => d.source))].join("、").slice(0, 80)}）`
    : "menu-harvest: 台帳更新のみ";
  try { git(["commit", "-qm", `${msg}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`]); } catch { log("コミット対象なし"); }
  try { git(["pull", "-q", "--rebase", "--autostash"]); } catch (e) { log(`pull失敗: ${e.message}`); }
  git(["push", "-q"]);
  log("push完了");

  // ⑤ 報告
  if (accepted.length) {
    const lines = accepted.map((d) => `・${d.name}（${d.tag}）← ${d.source}`);
    const sug = (r.suggest || []).length ? `\n改善メモ（未反映・見るだけ）:\n${(r.suggest || []).map((x) => `・${x}`).join("\n")}` : "";
    await slackDM(`🍳 メニュー便: ${accepted.length}品を買い物チェックの料理リストに足しました\n${lines.join("\n")}${sug}\nhttps://yoron-bbq.com/shopping.html`);
  }
}

main()
  .then(() => { breakerOk("bbq-menu-harvest"); flushLog(); })
  .catch(async (e) => {
    log(`💥 クラッシュ: ${e.stack || e.message}`);
    flushLog();
    await throttledNotify("bbq-menu-harvest-crash", `💥 menu-harvest（作った料理→メニュー自動追加便）が失敗\n${String(e.message).slice(0, 300)}\nログ: ~/dev/bbq/bbq-site/scripts/menu-harvest-run.log`, { cooldownMin: 60 });
    await breaker("bbq-menu-harvest", { max: 5, label: LAUNCHD_LABEL });
    process.exit(1);
  });
