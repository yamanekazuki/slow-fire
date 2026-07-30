#!/usr/bin/env node
/**
 * minutes-act — BBQ定例議事録の「確定事項」をサイト修正タスクとして自動起票するループ
 *
 * 流れ（2026-07-30 山根さん依頼: 議事録の決定事項をキャッチアップして自動実装まで繋ぐ）:
 *   ① Notion「🐿️ バーベキュー」ページ直下の「YYYYMMDD YORONバーベキュー定例 議事録」新着を検知
 *   ② claude ヘッドレス（定額枠）が議事録から「サイト(yoron-bbq.com)に反映すべき確定事項」を抽出。
 *      その場でリポジトリをgrepし、既に反映済みのもの・保留事項・サーバ/スクリプト側の作業は除外
 *   ③ 残った項目を Firestore site_requests に pending で起票
 *      → 既存の request-loop.mjs（10分おき）が通常のLINE修正依頼と同じ経路で
 *        解釈→実装→独立検証→push→本番200確認→LINEグループへ「直したよ」報告 まで行う
 *   ④ 起票結果を山根さんへSlack DM。クラッシュ時もSlack DM（恒久ルール）
 *
 * 設計判断: 実装・検証・報告の機構は request-loop に一本化し、本スクリプトは「抽出と投函」だけを持つ。
 *           料金・日程など事実の変更は request-loop 側の triage が LINE で確認質問に回す（安全弁を共有）。
 *
 *   node scripts/minutes-act.mjs             通常実行（新着議事録がなければLLM呼び出しゼロで終了）
 *   node scripts/minutes-act.mjs --dry-run   起票せず、抽出結果だけ表示
 *   node scripts/minutes-act.mjs --page <notionPageId>   特定の議事録ページを対象に再実行
 */
import { execFileSync } from "node:child_process";
import { accessSecret, gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const LEDGER = path.join(SCRIPTS, "minutes-act-ledger.json");
const LOG = path.join(SCRIPTS, "minutes-act-run.log");

const BBQ_PARENT_PAGE_ID = "2d608460013480cb94afdb1564a84f86"; // 🐿️ バーベキュー
const BBQ_LINE_GROUP_ID = "C29fee6f13100a7aa7f25a03270a24e7b"; // 3人の運営LINEグループ（報告先。request-loop が使う）
const TITLE_RE = /^(\d{8}) YORONバーベキュー定例 議事録$/;
const NOTION_PROJECT = "tldv-notion-pote";
const GCP_PROJECT = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const SLACK_DM_USER = "U7XLRM33R"; // 山根さん
const MAX_ITEMS = 5; // 1回の定例から起票する上限（暴走時の被害限定）

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONLY_PAGE = (() => { const i = argv.indexOf("--page"); return i >= 0 ? argv[i + 1] : null; })();

const logLines = [];
const log = (m) => { const l = `[${new Date().toISOString()}] ${m}`; console.log(l); logLines.push(l); };
const flushLog = () => { try { fs.appendFileSync(LOG, logLines.join("\n") + "\n"); } catch {} };

// ---------- Slack DM（クラッシュ通知・結果通知） ----------
async function slackDM(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
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
function blockText(b) {
  const d = b[b.type] || {};
  const text = rt(d.rich_text);
  switch (b.type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "paragraph": return text;
    case "quote": return `> ${text}`;
    default: return text;
  }
}

// ---------- claude ヘッドレス（抽出） ----------
function claudeBin() {
  for (const p of [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}
function extract(minutesText, ymd) {
  const prompt = `カレントディレクトリは YORON BBQ コミュニティサイト（https://yoron-bbq.com / 静的サイト・GitHub Pages）のリポジトリです。
以下は ${ymd} のBBQ運営定例（山根・あんちゃん・うえたく）の議事録です。
この中から「このサイトのHTML/CSS/JS（見た目・文言・構成）に反映すべき確定事項」だけを抽出してください。

【抽出のルール】
- 「決定事項」として確定しているものだけ。保留・持ち越し・アイデア段階・単なる感想は含めない。
- サイト以外の作業（LINE配信の運用、サーバ側/functions、スクリプト、リアルイベントの段取り、金銭のやり取り等）は含めない。
- 抽出候補ごとに、リポジトリを grep 等で確認し、既にサイトへ反映済みのものは除外する（除外したものは already に入れる）。
- 各項目の request は、サイト保守担当がそれだけ読めば作業できる具体的な修正指示文にする
  （対象ページ・変更前後が議事録から分かるなら含める）。

【議事録】
${minutesText}

出力は次のJSONだけ（前置き・後書き・コードフェンスなし）:
{
  "items": [ { "summary": "1文の要約", "request": "実装者向けの具体的な修正指示" } ],
  "already": [ "反映済みとして除外した項目の要約" ],
  "none_reason": "itemsが空のときの理由1文（空でなければ空文字）"
}`;
  const out = execFileSync(claudeBin(), ["-p", prompt, "--model", "claude-opus-4-8"], {
    encoding: "utf8", timeout: 600000, cwd: ROOT, maxBuffer: 16 * 1024 * 1024,
  });
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("抽出結果にJSONが見つからない");
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- Firestore 起票 ----------
async function enqueue(item, ymd, pageId) {
  const token = await gcpAccessToken();
  const text = `（${ymd} 定例議事録からの自動起票）${item.request}`;
  const res = await fetch(`${FS_BASE}/site_requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      status: { stringValue: "pending" },
      who: { stringValue: "定例議事録" },
      text: { stringValue: text.slice(0, 1500) },
      groupId: { stringValue: BBQ_LINE_GROUP_ID },
      createdAt: { stringValue: new Date().toISOString() },
      source: { stringValue: "minutes-act" },
      minutesPageId: { stringValue: pageId },
    } }),
  });
  if (!res.ok) throw new Error(`Firestore起票失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).name.split("/").pop();
}

// ---------- 台帳 ----------
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { note: "定例議事録→サイト修正 自動起票の処理台帳。pageIdで重複防止。", pages: [] }; }
}

async function main() {
  const ledger = loadLedger();
  const done = new Set(ledger.pages.map((p) => p.pageId));

  const children = await listChildBlocks(BBQ_PARENT_PAGE_ID);
  let targets = children.filter((b) => b.type === "child_page" && TITLE_RE.test(b.child_page?.title || ""));
  targets = ONLY_PAGE
    ? targets.filter((b) => b.id.replace(/-/g, "") === ONLY_PAGE.replace(/-/g, ""))
    : targets.filter((b) => !done.has(b.id));
  if (!targets.length) { log("新着の定例議事録なし（LLM呼び出しゼロで終了）"); flushLog(); return; }

  for (const page of targets) {
    const title = page.child_page.title;
    const ymd = title.match(TITLE_RE)[1];
    log(`--- 議事録処理: ${title} (${page.id})`);

    const blocks = await listChildBlocks(page.id);
    const minutesText = blocks.map(blockText).filter(Boolean).join("\n");
    if (minutesText.length < 200) { log("本文が短すぎるため次回に持ち越し（生成途中の可能性）"); continue; }

    const r = extract(minutesText, ymd);
    log(`抽出: 起票候補${(r.items || []).length}件 / 反映済み除外${(r.already || []).length}件`);
    for (const a of r.already || []) log(`  [反映済みスキップ] ${a}`);

    const items = (r.items || []).slice(0, MAX_ITEMS);
    const ticketed = [];
    for (const it of items) {
      if (DRY_RUN) { log(`[dry-run] 起票: ${it.summary}\n    → ${it.request}`); continue; }
      const id = await enqueue(it, ymd, page.id);
      log(`起票: ${id} — ${it.summary}`);
      ticketed.push(it.summary);
    }

    if (!DRY_RUN) {
      ledger.pages.unshift({ pageId: page.id, title, at: new Date().toISOString(), ticketed, already: r.already || [] });
      ledger.pages = ledger.pages.slice(0, 100);
      fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
      await slackDM(
        `📋 BBQ定例議事録（${ymd}）からサイト修正を自動起票しました\n` +
        (ticketed.length ? ticketed.map((s) => `• ${s}`).join("\n") : `• 起票なし（${r.none_reason || "サイト反映すべき確定事項なし"}）`) +
        ((r.already || []).length ? `\n反映済みで除外: ${(r.already || []).join(" / ")}` : "") +
        (ticketed.length ? "\nこのあと request-loop が実装→検証→LINE報告まで自動で行います" : "")
      );
    }
  }
  flushLog();
}

main().catch(async (e) => {
  log(`⚠️ 異常終了: ${e.stack || e.message}`);
  await slackDM(`🚨 minutes-act（BBQ議事録→サイト修正起票）がクラッシュしました\n${String(e.message).slice(0, 400)}`);
  flushLog();
  process.exit(1);
});
