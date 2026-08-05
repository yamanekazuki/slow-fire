// これからのBBQ予定を毎週水曜夕方に3人LINEグループへ配信する（LLM呼び出しゼロ）
// 台帳 = scripts/schedule-events.json（アジェンダ/議事録/LINEで決まった予定はここに追記）
// 実行: node schedule-digest.mjs [--dry]
import fs from "node:fs";
import path from "node:path";
import { accessSecret } from "../../../tools/lib/gcp-sa.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const GCP_PROJECT = "cook-log-df240";
const GROUP_ID = "C29fee6f13100a7aa7f25a03270a24e7b"; // 3人の運営LINEグループ
const DRY = process.argv.includes("--dry");
const NAMES = { yama: "やまちゃん", an: "あんちゃん", ueta: "うえたく" };

const ledger = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "schedule-events.json"), "utf8"));
const now = new Date(Date.now() + 9 * 3600 * 1000); // JST
const today = now.toISOString().slice(0, 10);

const upcoming = ledger.events
  .filter((e) => e.date >= today)
  .sort((a, b) => a.date.localeCompare(b.date));

function fmt(e) {
  const d = new Date(e.date + "T00:00:00+09:00");
  const youbi = "日月火水木金土"[d.getDay()];
  const md = `${d.getMonth() + 1}/${d.getDate()}(${youbi})`;
  const who = (e.who || []).map((w) => NAMES[w] || w).join("・");
  const days = Math.round((d - new Date(today + "T00:00:00+09:00")) / 86400000);
  let line = `・${md} ${e.title}${e.place ? `（${e.place}）` : ""}`;
  if (who) line += `／${who}`;
  line += `　あと${days}日`;
  if (e.url) line += `\n　${e.url}`;
  return line;
}

const thisMonth = today.slice(0, 7);
const recurringLines = (ledger.recurring || [])
  .filter((r) => (r.months || []).some((m) => m >= thisMonth))
  .map((r) => `・${r.label}`);

const text = [
  "やまちゃんです！これからのBBQの予定です。",
  "",
  ...upcoming.map(fmt),
  ...(recurringLines.length ? ["", "【日程これから】", ...recurringLines] : []),
  "",
  "予定の追加・修正はこのグループに書いてもらえれば反映します。",
].join("\n");

if (DRY) {
  console.log(text);
  process.exit(0);
}
const token = (await accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN")).trim();
const res = await fetch("https://api.line.me/v2/bot/message/push", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ to: GROUP_ID, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
});
if (!res.ok) {
  console.error(`LINE push失敗 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
console.log("配信OK:", text.split("\n")[0]);
