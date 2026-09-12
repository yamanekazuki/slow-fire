#!/usr/bin/env node
/**
 * minutes-todo — BBQ定例の議事録から「ToDo（Next Action）を全部」拾って、実行まで落とし込むループ
 *                （2026-09-12 山根さん依頼で新設。旧 minutes-act.mjs の後継＝サイト反映だけでなく全ToDoを扱う）
 *
 * 山根さんの指示（原文の要点）:
 *   「TLDVのテキストデータからToDo＝NextActionを炙り出して、届けてほしい。
 *     だいたい半分はコミュニティサイトへの反映。残りは画像を作る・ページを作る・スプレッドシートを作るといった作りもの。
 *     それを実行して、LINEに『こう実装したよ』と自動で報告してほしい。確実に漏らさない仕組みまで作ってほしい」
 *
 * 流れ:
 *   ① Notion「🐿️ バーベキュー」配下の新しい「YYYYMMDD YORONバーベキュー定例 議事録」を検知
 *      （議事録そのものは tl;dv → Notion の既存ループが作る。こちらはその成果物を読む）
 *   ② claude が議事録から **ToDoを全部** 抽出し、4分類に振り分ける
 *        site  : yoron-bbq.com の既存ページの文言・数字・見た目の修正
 *        build : 新しく作るもの（新規ページ・招待状・チラシ/POP・図・一覧表 など）
 *        human : 3人が現実世界でやること（保健所へ行く、物を買う、人に連絡する 等）＝自動化できない
 *        skip  : 決定していない案・感想（台帳に残すが何もしない）
 *   ③ site / build は Firestore site_requests に起票 → 既存の request-loop が
 *      実装 → 独立検証 → push → 本番200確認 → LINEグループへ「直したよ」報告 まで自動で行う
 *   ④ human は台帳に残し、LINEで「これは3人の手作業だよ」と名指しで伝える（=できないことを黙らない）
 *   ⑤ **漏らさない仕組み**: 全ToDoを scripts/todo-ledger.json に1件1レコードで保存し、
 *      毎回の実行で Firestore の実際の状態と突合して status を更新する。
 *      48時間動いていないものは LINE とSlackに再掲する（自然に消えることがない）。
 *      未完了のものは agenda-loop が次回アジェンダの「前回ToDoの進み具合」に必ず載せる。
 *
 *   node scripts/minutes-todo.mjs             通常実行
 *   node scripts/minutes-todo.mjs --dry-run   起票・LINE送信せず、抽出結果だけ表示
 *   node scripts/minutes-todo.mjs --page <notionPageId>  特定の議事録を対象に再実行
 *   node scripts/minutes-todo.mjs --reconcile-only       抽出せず、台帳と実態の突合だけ
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  HOME, BBQ_PARENT_PAGE_ID, BBQ_LINE_GROUP_ID, GCP_PROJECT,
  slackDM, linePush, listChildBlocks, pageText, claudeJson, notionUrl,
} from "./lib/bbq-notion.mjs";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const LEDGER = path.join(SCRIPTS, "todo-ledger.json");
const LOG = path.join(SCRIPTS, "minutes-todo-run.log");
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const TITLE_RE = /^(\d{8}) YORONバーベキュー定例 議事録$/;
const MAX_TICKETS_PER_MEETING = 6; // 1回の定例からrequest-loopに流す上限（暴走時の被害限定）
const STALE_HOURS = 48;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const RECONCILE_ONLY = argv.includes("--reconcile-only");
const NO_LINE = argv.includes("--no-line") || DRY_RUN; // 初期投入など、LINEに出さずに台帳だけ作るとき
const ONLY_PAGE = (() => { const i = argv.indexOf("--page"); return i >= 0 ? argv[i + 1] : null; })();

const logLines = [];
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); logLines.push(l); };
const flushLog = () => { try { fs.appendFileSync(LOG, logLines.join("\n") + "\n"); } catch {} };

// ---------- 台帳 ----------
const loadLedger = () => {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { note: "BBQ定例ToDo台帳。1ToDo=1レコード。status: queued(起票済) / implementing / done / manual(3人の手作業) / blocked(要確認) / dropped。agenda-loopが未完了を次回アジェンダに載せる。", pages: [], items: [] }; }
};
const saveLedger = (l) => fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
const todoId = (ymd, s) => `${ymd}-${crypto.createHash("sha1").update(s).digest("hex").slice(0, 8)}`;

// ---------- Firestore ----------
async function fsFetch(url, init = {}) {
  const token = await gcpAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Firestore ${init.method || "GET"} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const fsVal = (f) => f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? null;

async function enqueueRequest(item, ymd, pageId) {
  const prefix = item.category === "build"
    ? `（${ymd} 定例議事録からの自動起票・新しく作るもの）`
    : `（${ymd} 定例議事録からの自動起票）`;
  const text = `${prefix}${item.request}`;
  const j = await fsFetch(`${FS_BASE}/site_requests`, { method: "POST", body: JSON.stringify({ fields: {
    status: { stringValue: "pending" },
    who: { stringValue: "定例議事録" },
    text: { stringValue: text.slice(0, 1500) },
    groupId: { stringValue: BBQ_LINE_GROUP_ID },
    createdAt: { stringValue: new Date().toISOString() },
    source: { stringValue: "minutes-todo" },
    minutesPageId: { stringValue: pageId },
  } }) });
  return j.name.split("/").pop();
}
async function requestStatus(docId) {
  try {
    const j = await fsFetch(`${FS_BASE}/site_requests/${docId}`);
    const f = j.fields || {};
    return { status: fsVal(f.status), note: fsVal(f.note), url: fsVal(f.url) };
  } catch { return null; }
}

// ---------- 抽出 ----------
function extractPrompt(minutesText, ymd, known) {
  return `カレントディレクトリは YORON BBQ コミュニティサイト（https://yoron-bbq.com / 静的サイト・GitHub Pages）のリポジトリです。
以下は ${ymd} のYORON BBQ運営定例（山根＝やまちゃん／あんちゃん(ANRI)／うえたく(植田拓也)の3人）の議事録です。

この議事録から **ToDo（Next Action）を漏れなく全部** 洗い出し、4つに分類してください。
「決まったこと」だけでなく、「誰かがやると言ったこと」「やらないと次に進まないこと」も拾います。

【分類】
- "site"  : yoron-bbq.com の**既存ページ**の文言・数字・日付・料金・場所・見た目の修正
- "build" : **新しく作るもの**。新規ページ（告知・招待状・まとめ）、印刷物（チラシ・POP・カード）、
            図・一覧表・チェックリストなど。サイトのリポジトリ内にHTMLとして作れるものはここ
- "human" : 3人が現実世界でやること（保健所へ行く・買う・人に連絡する・現地を見る・写真を撮る 等）。
            自動化できないので、誰がやるかを owner に必ず入れる
- "skip"  : まだ決まっていない案・感想・議論の途中（記録だけ残す）

【厳守】
- site / build の候補は、**必ずリポジトリを grep 等で確認**し、すでに反映済みなら "skip" にして
  reason に「すでに反映済み（該当箇所）」と書く。ここを省略しない。
- site / build の request は、その文だけ読めば作業できる具体的な指示文にする
  （対象ファイル・変更前→変更後の値・新規なら何のページか）。
- 議事録に書かれていない数字・日付・金額を創作しない。
- サーバ側（functions/）・LINE配信の運用・お金のやり取りは "human" 扱い（自動修正の対象外）。

【すでに台帳にあるToDo（重複して起票しないこと。同じ内容ならitemsに入れない）】
${known || "（なし）"}

【議事録】
${minutesText}

出力は次のJSONだけ（前置き・後書き・コードフェンスの外に何も書かない）:
{
  "items": [
    {
      "summary": "ToDoを1文で（LINE報告にそのまま使う。山根本人の口調・常体・絵文字なし）",
      "category": "site" | "build" | "human" | "skip",
      "owner": "山根" | "あんちゃん" | "うえたく" | "" ,
      "request": "site/buildのとき、実装者向けの具体的な作業指示（他はの空文字）",
      "reason": "skipのとき、なぜ今は何もしないか1文（他は空文字）",
      "due": "議事録に期限が出ていればYYYY-MM-DD、なければ空文字"
    }
  ]
}`;
}

// ---------- 突合（漏らさない仕組みの中核） ----------
async function reconcile(ledger) {
  const moved = [];
  const stale = [];
  for (const it of ledger.items) {
    if (["done", "dropped", "manual"].includes(it.status)) continue;
    if (!it.requestId) continue;
    const r = await requestStatus(it.requestId);
    if (!r) continue;
    const before = it.status;
    if (r.status === "done") { it.status = "done"; it.doneAt = new Date().toISOString(); it.url = r.url || it.url; }
    else if (r.status === "needs_clarification") { it.status = "blocked"; it.note = r.note || it.note; }
    else if (r.status === "dismissed") { it.status = "dropped"; it.note = r.note || it.note; }
    else if (r.status === "pending") it.status = "queued";
    if (it.status !== before) { it.updatedAt = new Date().toISOString(); moved.push(it); }
    const ageH = (Date.now() - Date.parse(it.updatedAt || it.at)) / 3600000;
    if (["queued", "blocked"].includes(it.status) && ageH > STALE_HOURS) stale.push({ it, ageH: Math.round(ageH) });
  }
  return { moved, stale };
}

// ---------- 本体 ----------
async function main() {
  const ledger = loadLedger();

  // ① 新しい議事録を探す
  let targets = [];
  if (!RECONCILE_ONLY) {
    const done = new Set((ledger.pages || []).map((p) => p.pageId));
    const children = await listChildBlocks(BBQ_PARENT_PAGE_ID);
    targets = children.filter((b) => b.type === "child_page" && TITLE_RE.test(b.child_page?.title || ""));
    targets = ONLY_PAGE
      ? targets.filter((b) => b.id.replace(/-/g, "") === ONLY_PAGE.replace(/-/g, ""))
      : targets.filter((b) => !done.has(b.id));
  }

  // ② 新着議事録の処理
  for (const page of targets) {
    const title = page.child_page.title;
    const ymd = title.match(TITLE_RE)[1];
    log(`--- 議事録処理: ${title} (${page.id})`);
    const minutesText = await pageText(page.id);
    if (minutesText.length < 200) { log("本文が短すぎるため次回に持ち越し（生成途中の可能性）"); continue; }

    const known = ledger.items.filter((i) => !["done", "dropped"].includes(i.status))
      .map((i) => `- ${i.summary}`).join("\n").slice(0, 4000);
    const r = claudeJson(extractPrompt(minutesText.slice(0, 60000), ymd, known), { cwd: ROOT });
    const items = r.items || [];
    const byCat = items.reduce((a, i) => ((a[i.category] = (a[i.category] || 0) + 1), a), {});
    log(`抽出: 全${items.length}件 ${JSON.stringify(byCat)}`);

    const newItems = [];
    let ticketed = 0;
    for (const it of items) {
      const id = todoId(ymd, it.summary);
      if (ledger.items.some((x) => x.id === id)) { log(`  [重複] ${it.summary}`); continue; }
      const rec = {
        id, at: new Date().toISOString(), updatedAt: new Date().toISOString(),
        from: ymd, fromPageId: page.id, summary: it.summary, category: it.category,
        owner: it.owner || "", due: it.due || "", note: it.reason || "", status: "new",
      };
      if (it.category === "skip") { rec.status = "dropped"; log(`  [skip] ${it.summary} — ${it.reason || ""}`); }
      else if (it.category === "human") { rec.status = "manual"; log(`  [手作業:${rec.owner || "担当未定"}] ${it.summary}`); }
      else if (ticketed >= MAX_TICKETS_PER_MEETING) { rec.status = "queued_later"; log(`  [次回まわし:上限] ${it.summary}`); }
      else if (DRY_RUN) { log(`  [dry-run 起票] ${it.category}: ${it.summary}\n      → ${it.request}`); }
      else {
        rec.requestId = await enqueueRequest(it, ymd, page.id);
        rec.status = "queued";
        ticketed++;
        log(`  [起票 ${rec.requestId}] ${it.category}: ${it.summary}`);
      }
      newItems.push(rec);
    }

    if (!DRY_RUN) {
      ledger.items = [...newItems, ...ledger.items].slice(0, 500);
      ledger.pages = [{ pageId: page.id, title, at: new Date().toISOString(), counts: byCat }, ...(ledger.pages || [])].slice(0, 100);
      saveLedger(ledger);

      // ④ LINEへ「何を拾って、何を自動でやって、何が手作業か」を1通で伝える
      const auto = newItems.filter((i) => ["queued", "queued_later"].includes(i.status));
      const manual = newItems.filter((i) => i.status === "manual");
      const body = [
        `${ymd.slice(4, 6)}/${ymd.slice(6, 8)}の定例の議事録から、やることを${newItems.filter((i) => i.status !== "dropped").length}件ひろったよ。`,
        "",
        auto.length ? `【こっちで自動でやるやつ（${auto.length}件）】\n` + auto.map((i) => `・${i.summary}${i.status === "queued_later" ? "（順番待ち）" : ""}`).join("\n") : "【こっちで自動でやるやつ】なし",
        "",
        manual.length ? `【これは3人の手作業（${manual.length}件）】\n` + manual.map((i) => `・${i.owner || "担当きめよう"}: ${i.summary}`).join("\n") : "",
        "",
        auto.length ? "自動のやつは終わったら1件ずつここで報告するね！" : "",
      ].filter(Boolean).join("\n");
      await linePush(body, { noSend: NO_LINE });
    }
  }

  // ⑤ 突合（起票したものが本当に進んだか）
  const { moved, stale } = await reconcile(ledger);
  if (!DRY_RUN) saveLedger(ledger);
  if (moved.length) log(`突合: ${moved.length}件の状態が動いた（${moved.map((m) => `${m.summary}→${m.status}`).join(" / ")}）`);

  if (stale.length && !DRY_RUN) {
    const text = [
      `${STALE_HOURS}時間以上うごいてないやつがあるから、あげとくね。`,
      ...stale.map(({ it, ageH }) => `・${it.summary}（${it.status === "blocked" ? "こっちで判断できなくて止まってる" : "順番待ち"} / ${ageH}時間）`),
      "",
      "止まってるやつはこの後こっちで手を入れるね！",
    ].join("\n");
    await linePush(text, { noSend: NO_LINE });
    const { throttledNotify } = await import(`${HOME}/dev/tools/lib/failsafe.mjs`);
    await throttledNotify("bbq-minutes-todo:stale",
      `⏳ YORON BBQ ToDoが${STALE_HOURS}h以上停滞しています（${stale.length}件）\n` +
      stale.map(({ it, ageH }) => `• [${it.status}] ${it.summary}（${ageH}h）${it.note ? `\n   理由: ${String(it.note).slice(0, 150)}` : ""}`).join("\n"),
      { cooldownMin: 720 });
  }

  const open = ledger.items.filter((i) => !["done", "dropped"].includes(i.status));
  log(`台帳: 未完了${open.length}件（自動${open.filter((i) => i.status !== "manual").length} / 手作業${open.filter((i) => i.status === "manual").length}）`);
  flushLog();
}

main().catch(async (e) => {
  log(`⚠️ 異常終了: ${e.stack || e.message}`);
  try {
    const { throttledNotify } = await import(`${HOME}/dev/tools/lib/failsafe.mjs`);
    await throttledNotify("bbq-minutes-todo:crash", `🚨 minutes-todo（BBQ議事録→ToDo抽出）がクラッシュしました\n${String(e.message).slice(0, 400)}`, { cooldownMin: 120 });
  } catch { await slackDM(`🚨 minutes-todo クラッシュ: ${String(e.message).slice(0, 300)}`); }
  flushLog();
  process.exit(1);
});
