#!/usr/bin/env node
/**
 * line-broadcast — YORON BBQ 公式LINE（@637uooyi）の一斉配信スクリプト（土台）
 *
 * ⚠️ 自動実行はまだ登録していません。配信は必ず山根さんの承認後に手動で叩きます。
 *    編集方針は LINE-POLICY.md（月2回上限・「本当に有益な時だけ」）を必ず読んでから使うこと。
 *
 * 使い方:
 *   node scripts/line-broadcast.mjs --dry-run --text "本文"        本文と月内の配信回数を確認するだけ
 *   node scripts/line-broadcast.mjs --dry-run --file draft.txt      ファイルから本文を読む
 *   node scripts/line-broadcast.mjs --send --text "本文"            実際に配信（承認後のみ）
 *   node scripts/line-broadcast.mjs --send --text "..." --urgent    上限カウント外の緊急連絡
 *
 * トークンの取得順（平文の埋め込みは禁止）:
 *   1. 環境変数 LINE_CHANNEL_TOKEN
 *   2. gcloud secrets versions access latest --secret=LINE_CHANNEL_TOKEN --project=cook-log-df240
 */
import { execFileSync } from "node:child_process";
import { accessSecret } from "../../../tools/lib/gcp-sa.mjs";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const LEDGER = path.join(DIR, "line-broadcast-ledger.json");
const GCP_PROJECT = "cook-log-df240";
const SECRET_NAME = "LINE_CHANNEL_TOKEN";
const MONTHLY_LIMIT = 2;

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const SEND = flag("--send");
const DRY = !SEND || flag("--dry-run");
const URGENT = flag("--urgent");

function getText() {
  const f = opt("--file");
  if (f) return fs.readFileSync(f, "utf8").trim();
  const t = opt("--text");
  if (t) return t.trim();
  throw new Error("本文がありません。--text か --file を指定してください");
}

/** トークンは環境変数 → Secret Manager の順。値は絶対に出力しない */
async function getToken() {
  if (process.env.LINE_CHANNEL_TOKEN) return process.env.LINE_CHANNEL_TOKEN.trim();
  try {
    return await accessSecret(GCP_PROJECT, SECRET_NAME);
  } catch (e) {
    throw new Error(`チャネルトークンを取得できませんでした（環境変数 LINE_CHANNEL_TOKEN か Secret Manager ${SECRET_NAME}）`);
  }
}

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { note: "LINE一斉配信の台帳。月2回上限の判定に使う（LINE-POLICY.md）", sends: [] }; }
}

function checkPolicy(ledger, month) {
  const inMonth = ledger.sends.filter(s => s.date.startsWith(month) && !s.urgent);
  const issues = [];
  if (!URGENT && inMonth.length >= MONTHLY_LIMIT)
    issues.push(`${month} はすでに${inMonth.length}回配信済みです（上限${MONTHLY_LIMIT}回）。今回は送らない判断を推奨します。`);
  return { count: inMonth.length, issues };
}

function checkText(text) {
  const issues = [];
  if (text.length > 300) issues.push(`本文が${text.length}字です（300字以内）`);
  const links = text.match(/https?:\/\/\S+/g) || [];
  if (links.length > 1) issues.push(`リンクが${links.length}本あります（1本まで）`);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) issues.push("絵文字が含まれています（使わない方針）");
  if (/(だ。|である。)/.test(text)) issues.push("常体が混ざっています（です・ます基調）");
  return issues;
}

async function main() {
  const text = getText();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const month = date.slice(0, 7);
  const ledger = loadLedger();

  const policy = checkPolicy(ledger, month);
  const textIssues = checkText(text);

  console.log("--- 配信案 ---");
  console.log(text);
  console.log(`\n本文 ${text.length}字 / 今月の配信 ${policy.count}回（上限${MONTHLY_LIMIT}）${URGENT ? " ※緊急扱い" : ""}`);
  for (const i of [...policy.issues, ...textIssues]) console.log(`⚠️ ${i}`);

  if (DRY) {
    console.log("\n[dry-run] 送信していません。LINE-POLICY.md を確認し、山根さんの承認を得てから --send で実行してください。");
    return;
  }
  if (policy.issues.length) {
    console.error("\n配信を中止しました（月次上限）。緊急連絡なら --urgent を付けてください。");
    process.exit(1);
  }
  if (textIssues.length) {
    console.error("\n配信を中止しました（本文が方針違反）。文面を直してください。");
    process.exit(1);
  }

  const token = await getToken();
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    console.error(`配信失敗: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  ledger.sends = [{ date, urgent: URGENT, chars: text.length, preview: text.slice(0, 40) }, ...ledger.sends];
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  console.log("\n配信しました。");
}

main().catch(e => { console.error(`エラー: ${e.message}`); process.exit(1); });
