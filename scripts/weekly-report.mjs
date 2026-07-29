#!/usr/bin/env node
// =============================================================================
// YORON BBQ — コミュニティ数値の週次レポート便（毎週月曜 5:40 launchd）
// -----------------------------------------------------------------------------
// 集計: ①コミュニティ会員数（Firestore members / 役割内訳 / 週次増分）
//       ②LINE友だち数（LINE Insight API）
//       ③月1BBQ申込数（event_regs / 開催回別）
//       ④提供人数累計（data/serve-ledger.json）
// 送信: 運営LINEグループ（line_state/config.groupIds）。冒頭は「やまちゃんです！」名乗り。
// 前週比: scripts/weekly-report-ledger.json に毎回スナップショットを保存して算出。
// クラッシュ時: Slack DM（claude2 bot → 山根さん）で即通知。
// フラグ: --dry-run（送信・保存なし） --no-line（LINE送信だけ抑止）
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { gcpAccessToken, accessSecret } from "../../../tools/lib/gcp-sa.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const SNAP = path.join(SCRIPTS, "weekly-report-ledger.json");
const SERVE = path.join(ROOT, "data", "serve-ledger.json");
const GCP_PROJECT = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const SLACK_DM_USER = "U7XLRM33R"; // 山根さん

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const NO_LINE = argv.includes("--no-line") || DRY_RUN;

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function fsFetch(url, init = {}) {
  const token = await gcpAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`Firestore ${init.method || "GET"} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? null : res.json();
}
const fsVal = (v) => {
  if (v == null) return "";
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  return "";
};

async function listAll(collectionId, pageSize = 300) {
  const docs = [];
  let pageToken = "";
  do {
    const url = `${FS_BASE}/${collectionId}?pageSize=${pageSize}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const j = await fsFetch(url);
    docs.push(...(j.documents || []));
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return docs;
}

async function lineToken() {
  if (process.env.LINE_CHANNEL_TOKEN) return process.env.LINE_CHANNEL_TOKEN.trim();
  return accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN");
}

async function lineFollowers() {
  // Insight APIは集計に1日かかるため前日分を見る（未確定なら順に遡って最大3日）
  const token = await lineToken();
  for (let back = 1; back <= 3; back++) {
    const d = new Date(Date.now() + 9 * 3600e3 - back * 86400e3); // JST
    const ymd = d.toISOString().slice(0, 10).replace(/-/g, "");
    const res = await fetch(`https://api.line.me/v2/bot/insight/followers?date=${ymd}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const j = await res.json();
    if (j.status === "ready") return { count: j.followers, targeted: j.targetedReaches, date: `${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}` };
  }
  return null;
}

async function groupIds() {
  try {
    const j = await fsFetch(`${FS_BASE}/line_state/config`);
    const arr = j?.fields?.groupIds?.arrayValue?.values || [];
    return arr.map((v) => v.stringValue).filter(Boolean);
  } catch { return []; }
}

async function linePush(to, text) {
  text = `やまちゃんです！\n${text}`;
  if (NO_LINE) { log(`[LINE未送信] to=${to}\n----\n${text}\n----`); return; }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${await lineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function slackDM(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    if (!token) return;
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
    });
  } catch (e) { log(`Slack DM失敗: ${e.message}`); }
}

// ネット自己回線チェック（誤報防止・feedback_monitor_loops_self_network_check）
async function netOk() {
  for (const url of ["https://www.google.com/generate_204", "https://api.line.me/"]) {
    try { await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) }); return true; } catch {}
  }
  return false;
}

const ROLE_JA = { fan: "ファン", ambassador: "アンバサダー", sommelier: "BBQソムリエ", pitmaster: "焼き手" };

async function main() {
  if (!(await netOk())) { log("回線不通のためスキップ（誤報防止）"); return; }

  const now = new Date(Date.now() + 9 * 3600e3);
  const today = now.toISOString().slice(0, 10);
  const prev = fs.existsSync(SNAP) ? JSON.parse(fs.readFileSync(SNAP, "utf8")) : null;

  // ① members
  const members = await listAll("members");
  const roles = {};
  for (const m of members) {
    const r = fsVal(m.fields?.role) || "fan";
    roles[r] = (roles[r] || 0) + 1;
  }
  const memberCount = members.length;

  // ② LINE
  const line = await lineFollowers();

  // ③ event_regs（開催回別・waitlist含む申込延べ人数）
  const regs = await listAll("event_regs");
  const byEvent = {};
  for (const r of regs) {
    const ev = fsVal(r.fields?.eventId) || "不明";
    const party = Number(fsVal(r.fields?.party)) || 1;
    byEvent[ev] = (byEvent[ev] || 0) + party;
  }

  // ④ 提供人数
  let serve = null;
  try { serve = JSON.parse(fs.readFileSync(SERVE, "utf8")); } catch {}

  const diff = (cur, key) => {
    if (!prev || prev[key] == null) return "";
    const d = cur - prev[key];
    return d === 0 ? "（前週と同じ）" : `（前週${prev.date}比 ${d > 0 ? "+" : ""}${d}）`;
  };

  const lines = [];
  lines.push("YORON BBQ 週次数字レポート");
  lines.push(`対象: 〜${today} 時点の累計。比較基準日: ${prev ? prev.date : "初回のため前週比なし"}`);
  lines.push("読み方: 会員数=サイト入会フォーム登録の累計人数、LINE=公式アカウント友だち数、申込=月1BBQの申込延べ人数（同伴・キャンセル待ち含む）、提供=これまでBBQを振る舞った延べ人数");
  lines.push("");
  lines.push(`- コミュニティ会員: ${memberCount}人 ${diff(memberCount, "members")}`);
  const roleLine = Object.entries(roles).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${ROLE_JA[k] || k}${v}`).join(" / ");
  if (roleLine) lines.push(`- 役割の内訳: ${roleLine}`);
  if (line) lines.push(`- LINE友だち: ${line.count}人 ${diff(line.count, "line")}（${line.date}時点の確定値）`);
  else lines.push("- LINE友だち: 取得できず（未検証）");
  const evEntries = Object.entries(byEvent).sort();
  if (evEntries.length) for (const [ev, n] of evEntries) lines.push(`- 月1BBQ申込 ${ev}: 延べ${n}人`);
  else lines.push("- 月1BBQ申込: 0件（フォーム経由の申込なし）");
  if (serve) lines.push(`- 提供人数の累計: BBQ ${serve.totals.bbq}人（スマッシュバーガー含む全累計 ${serve.totals.all}人・台帳${serve.updatedAt}時点）`);
  lines.push("");
  lines.push("提供人数が増えてたら、このグループで「@YORON 提供人数 +◯人（どこで誰に）」って送って！台帳とサイトの数字を更新するよ");

  const msg = lines.join("\n");
  const gids = await groupIds();
  if (!gids.length) { log("グループID未取得。送信スキップ"); await slackDM(`⚠️ BBQ週次レポート便: LINEグループID未取得のため送信できず（${today}）`); }
  for (const g of gids) await linePush(g, msg);

  if (!DRY_RUN) {
    fs.writeFileSync(SNAP, JSON.stringify({ date: today, members: memberCount, line: line?.count ?? null, roles, byEvent }, null, 2) + "\n");
  }
  log(`完了 members=${memberCount} line=${line?.count ?? "?"} groups=${gids.length}`);
}

main().catch(async (e) => {
  log(`❌ クラッシュ: ${e.stack || e.message}`);
  await slackDM(`❌ BBQ週次レポート便がクラッシュ\n${String(e.message).slice(0, 300)}\nログ: ~/dev/bbq/bbq-site/scripts/weekly-run.log`);
  process.exit(1);
});
