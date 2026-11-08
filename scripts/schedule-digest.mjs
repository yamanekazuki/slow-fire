// これからのBBQ予定を毎週水曜夕方に運営メンバーへメールする（LLM呼び出しゼロ。2026-11-08からLINEグループには送らない）
// 台帳 = scripts/schedule-events.json（アジェンダ/議事録/LINEで決まった予定はここに追記）
// 実行: node schedule-digest.mjs [--dry]
import fs from "node:fs";
import path from "node:path";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run"); // ほかの便と同じ --dry-run でも送らない（2026-09-28 取り違えで1通送信した再発防止）
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
  "予定の追加・修正は運営のLINEグループに書いてもらえれば反映します。",
].join("\n");

if (DRY) {
  console.log(text);
  process.exit(0);
}
// 2026-11-08 山根さん: 運営LINEグループに流すのはアジェンダ・議事録・BBQレポートだけ（無料の通数を登録者向けに回す）。
// この便はLINEには送らず、運営メンバーへのメールだけにする
const { mailCopy } = await import("./lib/bbq-notion.mjs");
await mailCopy(text.replace(/^やまちゃんです！/, ""), { subject: "これからのBBQの予定", lineOk: null });
console.log("メール送信:", text.split("\n")[0]);

// 台帳→Googleカレンダー同期（あんちゃん依頼 2026-08-12。失敗しても配信自体は成功扱い、ログにだけ残す）
try {
  const { execFileSync } = await import("node:child_process");
  console.log(execFileSync(process.execPath, [path.join(SCRIPTS, "gcal-sync.mjs")], { encoding: "utf8", timeout: 120000 }));
} catch (e) {
  console.error(`gcal-sync失敗: ${String(e.message || e).slice(0, 300)}`);
}
