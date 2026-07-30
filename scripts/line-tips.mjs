#!/usr/bin/env node
/**
 * line-tips — YORON BBQ 公式LINE 定期便（週2回・火/金 18:00、launchd: com.yamane.bbq-line-tips）
 *
 * 2026-07-30 定例で決定: 週2回、①バーベキューの基本スキル ②活動報告 をファン向けに配信する。
 * 本文は line-tips-queue.json に事前執筆したものを上から順に1通ずつ送る（送信時のLLM呼び出しなし）。
 * ネタが尽きたら送らずに山根さんへSlack DMで知らせる。臨時の一斉配信は従来どおり line-broadcast.mjs。
 *
 *   node scripts/line-tips.mjs --dry-run   次に送る本文を表示するだけ
 *   node scripts/line-tips.mjs --send      1通配信してキューに送信日時を記録
 */
import fs from "node:fs";
import path from "node:path";
import { accessSecret } from "../../../tools/lib/gcp-sa.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const QUEUE = path.join(DIR, "line-tips-queue.json");
const GCP_PROJECT = "cook-log-df240";
const SLACK_DM_USER = "U7XLRM33R"; // 山根さん

const SEND = process.argv.includes("--send");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function slackDM(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
    });
  } catch (e) { log(`Slack DM失敗: ${e.message}`); }
}

async function main() {
  const queue = JSON.parse(fs.readFileSync(QUEUE, "utf8"));
  const next = queue.items.find((it) => !it.sentAt);
  const remaining = queue.items.filter((it) => !it.sentAt).length;

  if (!next) {
    log("キューが空。配信スキップ");
    await slackDM("⚠️ BBQ定期便: 配信キューが空です。scripts/line-tips-queue.json にネタを補充してください（今回は未配信）");
    return;
  }

  log(`次の配信: ${next.id} (${next.type}) 残り${remaining}通`);
  if (!SEND) { console.log("---- dry-run 本文 ----\n" + next.text); return; }

  const token = process.env.LINE_CHANNEL_TOKEN?.trim() || (await accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN"));
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ type: "text", text: next.text }] }),
  });
  if (!res.ok) throw new Error(`broadcast失敗 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  next.sentAt = new Date().toISOString();
  fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + "\n");
  log(`配信完了: ${next.id}`);
  if (remaining - 1 <= 2) {
    await slackDM(`ℹ️ BBQ定期便: キュー残り${remaining - 1}通。scripts/line-tips-queue.json への補充をそろそろ`);
  }
}

main().catch(async (e) => {
  log(`クラッシュ: ${e.message}`);
  await slackDM(`🚨 BBQ定期便(line-tips)がクラッシュ: ${e.message}`);
  process.exit(1);
});
