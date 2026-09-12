#!/usr/bin/env node
/**
 * agenda-loop — YORON BBQ定例の「当日朝アジェンダ」自動生成ループ（2026-09-12 山根さん依頼で新設）
 *
 * 何をするか:
 *   ① Googleカレンダー（山根さんのカレンダー）に今日「あんBBQ」の予定が入っているかを見る
 *      （曜日固定ではなく、水→木→金と動くのでカレンダーが唯一の正）
 *   ② 入っていれば、当日の朝にアジェンダを自動生成して
 *      Notion「🐿️ バーベキュー」配下に「YYYYMMDD YORONバーベキューミーティングアジェンダ」を作成
 *   ③ 3人のLINEグループへ「今日◯時から定例だよ。アジェンダ置いたよ」と通知
 *
 * アジェンダの素材（山根さんの指示どおり全部混ぜる）:
 *   - 前回の議事録（ToDo・保留・決定事項）           … Notion
 *   - 前回のアジェンダ（消化できたか）               … Notion
 *   - 積み残しToDo台帳（minutes-todo が管理）        … scripts/todo-ledger.json
 *   - 前回定例以降のLINEグループ会話（流れてしまう話）… Firestore line_group_log
 *   - 山根さんのメモ・音声メモのBBQ段落             … memo-sync RECENT.md / AQUA-RECENT.md
 *   - 直近のサイト更新（何が実際に反映されたか）     … git log
 *   - BBQ予定台帳                                    … scripts/schedule-events.json
 *
 *   node scripts/agenda-loop.mjs              通常実行（今日が定例日でなければLLM呼び出しゼロで終了）
 *   node scripts/agenda-loop.mjs --dry-run    NotionにもLINEにも出さず、生成結果を表示
 *   node scripts/agenda-loop.mjs --force      今日が定例日でなくても、直近の定例予定を対象に生成する
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  HOME, BBQ_PARENT_PAGE_ID, slackDM, linePush, listChildBlocks, pageText,
  markdownToBlocks, createChildPage, appendBlocks, notionUrl, claudeJson,
  calendarEvents, isBbqTeirei, lineGroupLog,
} from "./lib/bbq-notion.mjs";
import { ymdJst, partsJst, dispJst } from "../../../tools/lib/jst.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const LEDGER = path.join(SCRIPTS, "agenda-ledger.json");
const TODO_LEDGER = path.join(SCRIPTS, "todo-ledger.json");
const LOG = path.join(SCRIPTS, "agenda-run.log");

const AGENDA_TITLE_RE = /^(\d{8}) YORONバーベキューミーティング\s?アジェンダ$/;
const MINUTES_TITLE_RE = /^(\d{8}) YORONバーベキュー定例 議事録$/;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FORCE = argv.includes("--force");

const logLines = [];
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); logLines.push(l); };
const flushLog = () => { try { fs.appendFileSync(LOG, logLines.join("\n") + "\n"); } catch {} };
const readIf = (p, max = 200000) => { try { return fs.readFileSync(p, "utf8").slice(-max); } catch { return ""; } };

// ---------- 素材あつめ ----------
/** 山根さんのメモ／音声メモから「BBQ文脈の段落」だけ（人材・PIIは段落ごと除外） */
const BBQ_WORDS = ["BBQ", "ＢＢＱ", "バーベキュー", "与論", "ヨロン", "あんちゃん", "うえたく", "YORON", "SLOW FIRE",
  "グリル", "スモーク", "グリリスト", "Weber", "ウェーバー", "キッチンカー", "民泊", "スパイス"];
const EXCLUDE_WORDS = ["人材紹介", "PORTERS", "ポーターズ", "スカウト", "年収", "面談", "面接", "求人", "内定", "候補者",
  "商談", "受注", "売上目標", "パスワード", "@gmail", "@potentialight"];
function memoBbq(sinceIso, budget = 12000) {
  const srcs = [
    readIf(path.join(HOME, "dev/tools/memo-sync/RECENT.md"), 400000),
    readIf(path.join(HOME, "dev/tools/memo-sync/AQUA-RECENT.md"), 400000),
  ].join("\n\n");
  const paras = srcs.split(/\n{2,}/);
  const hits = paras.filter((p) => {
    const t = p.trim();
    if (t.length < 40 || t.length > 4000) return false;
    if (!BBQ_WORDS.some((w) => t.includes(w))) return false;
    if (EXCLUDE_WORDS.some((w) => t.includes(w))) return false;
    return true;
  });
  const picked = [];
  let total = 0;
  for (const p of hits.reverse()) {
    if (total + p.length > budget) break;
    picked.push(p.trim()); total += p.length;
  }
  return picked.join("\n\n") || "（今回は該当メモなし）";
}
function recentCommits(sinceIso) {
  try {
    return execFileSync("git", ["log", `--since=${sinceIso}`, "--pretty=format:%ad %s", "--date=short"],
      { cwd: ROOT, encoding: "utf8" }).trim().slice(0, 6000) || "（サイト更新なし）";
  } catch { return "（git log取得失敗）"; }
}
function openTodos() {
  try {
    const l = JSON.parse(fs.readFileSync(TODO_LEDGER, "utf8"));
    const open = (l.items || []).filter((i) => !["done", "dropped"].includes(i.status));
    if (!open.length) return "（積み残しなし）";
    return open.map((i) =>
      `- [${i.status}] ${i.owner || "担当未定"}: ${i.summary}（${i.category} / ${String(i.from || "").slice(0, 8)}の定例で発生）` +
      (i.note ? ` — ${String(i.note).slice(0, 120)}` : "")).join("\n");
  } catch { return "（積み残し台帳なし）"; }
}
function schedule() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "schedule-events.json"), "utf8"));
    const today = ymdJst();
    return (j.events || []).filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 12)
      .map((e) => `- ${e.date} ${e.title}${e.place ? `（${e.place}）` : ""}`).join("\n") || "（先の予定なし）";
  } catch { return "（予定台帳なし）"; }
}

// ---------- 台帳 ----------
const loadLedger = () => { try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); } catch { return { note: "アジェンダ自動生成の台帳。dateで重複防止。", pages: [] }; } };

// ---------- 生成 ----------
function buildPrompt(ctx) {
  return `あなたは YORON BBQ（山根一城＝やまちゃん・あんちゃん(ANRI)・うえたく(植田拓也)の3人で運営するバーベキューコミュニティ）の定例ミーティングの進行役です。
今日 ${ctx.todayJa} の定例（${ctx.timeLabel}）の**アジェンダ**を、下の素材だけを根拠にMarkdownで書いてください。

# 誰が読むか
3人だけが読みます。書き手は山根（やまちゃん）です。山根が「今日はこれを話したい」と3人に出す議題表です。

# フォーマット（過去のアジェンダと同じ形。厳守）
## 0. 今週のバーベキューの軌跡（M/D〜M/D）
まず1週間の動きの共有から。
- 実際に起きたこと（BBQ開催・講座・サイト更新・申込状況）を箇条書き。数字・日付・固有名詞は省略しない
- サイト側の更新は「9/8：〜」のように日付つきで列挙する

## 1. （議題タイトル：山根が今日決めたいことを一言で）
1つ目は、〜という話。（1〜2文で背景）
- 具体の材料を箇条書きで。数字・金額・日付・URL・人名は省略しない
- 今日決めたいこと：①〜 ②〜（必ず各議題の最後に置く）

## 2. …（議題の数だけ続ける。5〜9個が目安）

## 前回ToDoの進み具合
### 山根 / あんちゃん / うえたく（該当する人だけ）
- 済/未の別を明記して1行ずつ

## 保留になっているものの棚卸し
- 置きっぱなしの論点を1行ずつ（結論は書かない。確認だけ）

# 書き方のルール
- 山根本人の口調。常体まじりの落ち着いた文。絵文字は使わない。「〜だと思っている」「〜を今日決めたい」のように主語を持つ
- **素材にない事実を作らない**。申込人数・金額・日程は素材に書かれた値をそのまま使う。素材にないものは議題に「（要確認）」と添える
- 議題は「前回の積み残し」→「今週新しく出てきたこと」→「先の予定の準備」の順に並べる
- LINEの雑談から拾った論点は、流れて消えやすいので必ず議題か棚卸しに入れる
- 前置き・締めの挨拶は書かない。「## 0.」から始める

# 素材
## 前回の定例（${ctx.prevMinutesTitle}）の議事録
${ctx.prevMinutes || "（前回議事録なし）"}

## 前回のアジェンダ（${ctx.prevAgendaTitle}）
${ctx.prevAgenda || "（前回アジェンダなし）"}

## 積み残しToDo台帳（未完了のもの。これは必ず「前回ToDoの進み具合」に反映する）
${ctx.todos}

## 前回定例以降のLINEグループの会話（3人の生の会話。流れて消えている論点の宝庫）
${ctx.lineLog || "（会話なし）"}

## 山根さんのメモ・音声メモからBBQ関係の段落
${ctx.memo}

## 前回定例以降のサイト更新（実際にコミットされたもの）
${ctx.commits}

## この先のBBQ予定台帳
${ctx.schedule}

出力は次のJSONだけ（前置き・後書き・コードフェンスの外に何も書かない）:
{
  "markdown": "アジェンダ本文のMarkdown（上のフォーマット）",
  "lineSummary": "LINEに流す3〜5行の要約。1行目は「今日◯時から定例だね」。今日の議題を3つだけ短く挙げる。山根本人の口調・絵文字なし",
  "agendaCount": 議題の数(数値)
}`;
}

async function main() {
  const now = new Date();
  const today = ymdJst(now);
  const ledger = loadLedger();

  // ① 今日「あんBBQ」がカレンダーにあるか
  const from = new Date(now.getTime() - 10 * 86400000).toISOString();
  const to = new Date(now.getTime() + 2 * 86400000).toISOString();
  const events = await calendarEvents(from, to);
  const teirei = events.filter(isBbqTeirei);
  let todayEvent = teirei.find((e) => ymdJst(new Date(e.start?.dateTime || `${e.start?.date}T09:00:00+09:00`)) === today);
  if (!todayEvent && FORCE) todayEvent = teirei[teirei.length - 1];
  if (!todayEvent) {
    log(`今日(${today})は定例なし。カレンダー「あんBBQ」の直近=${teirei.map((e) => (e.start?.dateTime || e.start?.date || "").slice(0, 16)).join(", ") || "なし"}（LLM呼び出しゼロで終了）`);
    flushLog();
    return;
  }
  const startMs = Date.parse(todayEvent.start?.dateTime || `${todayEvent.start?.date}T12:00:00+09:00`);
  const eventDay = ymdJst(new Date(startMs));
  const ymd = eventDay.replace(/-/g, "");
  if (!DRY_RUN && ledger.pages.some((p) => p.ymd === ymd)) {
    log(`${ymd} のアジェンダは作成済み。何もしません`);
    flushLog();
    return;
  }
  log(`定例を検知: ${dispJst(new Date(startMs))}「${todayEvent.summary}」→ アジェンダを作ります`);

  // ② 素材あつめ
  const children = await listChildBlocks(BBQ_PARENT_PAGE_ID);
  const pick = (re) => children.filter((b) => b.type === "child_page" && re.test(b.child_page?.title || ""))
    .map((b) => ({ id: b.id, title: b.child_page.title, ymd: b.child_page.title.match(re)[1] }))
    .sort((a, b) => b.ymd.localeCompare(a.ymd));
  const prevMinutesPage = pick(MINUTES_TITLE_RE).find((p) => p.ymd < ymd) || pick(MINUTES_TITLE_RE)[0];
  const prevAgendaPage = pick(AGENDA_TITLE_RE).find((p) => p.ymd < ymd) || null;

  const prevMinutes = prevMinutesPage ? (await pageText(prevMinutesPage.id)).slice(0, 22000) : "";
  const prevAgenda = prevAgendaPage ? (await pageText(prevAgendaPage.id)).slice(0, 14000) : "";
  const sinceIso = prevMinutesPage
    ? new Date(`${prevMinutesPage.ymd.slice(0, 4)}-${prevMinutesPage.ymd.slice(4, 6)}-${prevMinutesPage.ymd.slice(6, 8)}T00:00:00+09:00`).toISOString()
    : new Date(now.getTime() - 14 * 86400000).toISOString();

  let lineLog = "";
  try {
    const msgs = await lineGroupLog(sinceIso);
    lineLog = msgs.map((m) => `[${m.at.slice(5, 16)}] ${m.who}: ${m.text}`).join("\n").slice(-14000);
    log(`LINE会話ログ ${msgs.length}件（${sinceIso.slice(0, 10)}以降）`);
  } catch (e) { log(`⚠️ 会話ログ取得に失敗（なしで続行）: ${e.message.slice(0, 150)}`); }

  const p = partsJst(new Date(startMs));
  const ctx = {
    todayJa: `${p.y}年${p.m}月${p.d}日（${"日月火水木金土"[p.dow]}）`,
    timeLabel: `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}〜`,
    prevMinutesTitle: prevMinutesPage?.title || "なし",
    prevAgendaTitle: prevAgendaPage?.title || "なし",
    prevMinutes, prevAgenda, lineLog,
    todos: openTodos(),
    memo: memoBbq(sinceIso),
    commits: recentCommits(sinceIso.slice(0, 10)),
    schedule: schedule(),
  };

  // ③ 生成
  const r = claudeJson(buildPrompt(ctx), { cwd: ROOT });
  if (!r.markdown || r.markdown.length < 500) throw new Error(`アジェンダ本文が短すぎます（${(r.markdown || "").length}字）`);
  log(`生成: 議題${r.agendaCount || "?"}件 / ${r.markdown.length}字`);

  const title = `${ymd} YORONバーベキューミーティングアジェンダ`;
  if (DRY_RUN) {
    log(`[dry-run] Notionページ「${title}」は作りません。本文:\n${r.markdown}`);
    log(`[dry-run] LINE文面:\n${r.lineSummary}`);
    flushLog();
    return;
  }

  const pageId = await createChildPage(title);
  await appendBlocks(pageId, [{ object: "block", type: "table_of_contents", table_of_contents: {} }]);
  await appendBlocks(pageId, markdownToBlocks(r.markdown));
  const url = notionUrl(pageId);
  log(`Notionページ作成: ${url}`);

  await linePush(`${r.lineSummary}\n\nアジェンダはここに置いたよ\n${url}`);
  ledger.pages.unshift({ ymd, title, pageId, url, at: new Date().toISOString(), agendaCount: r.agendaCount || null });
  ledger.pages = ledger.pages.slice(0, 100);
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  await slackDM(`📋 YORON BBQ定例（${ymd} ${ctx.timeLabel}）のアジェンダを自動生成しました\n議題${r.agendaCount || "?"}件\n${url}`);
  flushLog();
}

main().catch(async (e) => {
  log(`⚠️ 異常終了: ${e.stack || e.message}`);
  try {
    const { throttledNotify } = await import(`${HOME}/dev/tools/lib/failsafe.mjs`);
    await throttledNotify("bbq-agenda:crash", `🚨 agenda-loop（BBQ定例アジェンダ自動生成）がクラッシュしました\n${String(e.message).slice(0, 400)}`, { cooldownMin: 120 });
  } catch { await slackDM(`🚨 agenda-loop クラッシュ: ${String(e.message).slice(0, 300)}`); }
  flushLog();
  process.exit(1);
});
