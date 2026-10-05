#!/usr/bin/env node
// =============================================================================
// YORON BBQ — コミュニティ数値の週次レポート便（毎週月曜 5:40 launchd）
// -----------------------------------------------------------------------------
// 集計: ①コミュニティ会員数（Firestore members / 役割内訳 / 週次増分）
//       ②LINE友だち数（LINE Insight API）
//       ③月1BBQ申込数（event_regs / 開催回別）
//       ④提供人数累計（data/serve-ledger.json）
//       ⑤サイトのPV・ユーザー数と、よく見られたページ（GA4 プロパティ 543026880・hostName=yoron-bbq.com）※2026-09-27追加
//       ⑥BBQの実施回数（予定台帳の開催済みの回・BBQレポートの公開数）※2026-09-27追加
// 送信: 運営LINEグループ（line_state/config.groupIds）＋運営メンバーへメール（config/bbq_admins。LINEの月間上限でも届くように）
// 前週比: scripts/weekly-report-ledger.json に毎回スナップショットを保存して算出。
// クラッシュ時: Slack DM（claude2 bot → 山根さん）で即通知。
// フラグ: --dry-run（送信・保存なし） --no-line（LINE送信だけ抑止）
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { gcpAccessToken, accessSecret } from "../../../tools/lib/gcp-sa.mjs";
import { ymdJst } from "../../../tools/lib/jst.mjs";
import { renderReport, sendReport } from "../../../tools/lib/report-mail.mjs";
import { adminEmails } from "./lib/bbq-admins.mjs";
import { isBbqEventTitle } from "./report/pipeline.mjs";
import { SITES, range, md, addDays as addDaysYmd } from "./lib/report-period.mjs";

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
    const ymd = ymdJst(new Date(Date.now() - back * 86400e3)).replace(/-/g, ""); // JSTの日付（実時刻から表示用に変換するだけ）
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

// ---------- GA4（サイトのPV） ----------
const GA4_PROPERTY = "543026880"; // 「SLOW FIRE」プロパティ＝yoron-bbq.com（計測ID G-S66C9TDVT2）
const GA4_KEY = process.env.GA4_SA_JSON || path.join(os.homedir(), "dev/media-fleet/.secrets/ga4-sa.json");
async function ga4Token() {
  const sa = JSON.parse(fs.readFileSync(GA4_KEY, "utf8"));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: "RS256", typ: "JWT" });
  const c = b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  const sig = crypto.createSign("RSA-SHA256").update(`${h}.${c}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${h}.${c}.${sig}` });
  return (await r.json()).access_token;
}
/** 直近7日（昨日まで）と、その前の7日のPV・ユーザー数、よく見られたページ上位5 */
async function sitePv() {
  const t = await ga4Token();
  const q = async (body) => {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`, { method: "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(`GA4: ${j.error.message}`);
    return j.rows || [];
  };
  const host = { filter: { fieldName: "hostName", stringFilter: { value: "yoron-bbq.com" } } };
  const tot = await q({ dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }, { startDate: "14daysAgo", endDate: "8daysAgo" }], metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }], dimensionFilter: host });
  const cur = tot.find((r) => !r.dimensionValues || r.dimensionValues[0]?.value === "date_range_0") || tot[0];
  const prv = tot.find((r) => r.dimensionValues?.[0]?.value === "date_range_1");
  const num = (r, i) => Number(r?.metricValues?.[i]?.value || 0);
  const pages = await q({ dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }], dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }], dimensionFilter: host, orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: 5 });
  return { pv: num(cur, 0), users: num(cur, 1), prevPv: prv ? num(prv, 0) : null, prevUsers: prv ? num(prv, 1) : null, pages: pages.map((r) => ({ path: r.dimensionValues[0].value, pv: Number(r.metricValues[0].value) })) };
}

// ---------- BBQの実施回数 ----------
/** 予定台帳の「BBQの回」のうち開催済みのもの（今年・直近7日）と、公開したBBQレポートの数 */
export function bbqCounts(events, today, reportDirs = []) {
  const held = (events || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date || "") && e.date <= today && isBbqEventTitle(e.title));
  const year = today.slice(0, 4);
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  return {
    thisYear: held.filter((e) => e.date.startsWith(year)).length,
    lastWeek: held.filter((e) => e.date > weekAgo).map((e) => `${e.date.slice(5).replace("-", "/")} ${e.title}`),
    reports: reportDirs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).length,
  };
}

const ROLE_JA = { fan: "ファン", ambassador: "アンバサダー", sommelier: "BBQソムリエ", pitmaster: "グリリスト" };

async function main() {
  if (!(await netOk())) { log("回線不通のためスキップ（誤報防止）"); return; }

  const today = ymdJst(new Date());
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

  // ⑤ サイトのPV
  let pv = null;
  try { pv = await sitePv(); } catch (e) { log(`GA4取得失敗: ${e.message}`); }
  // ⑥ BBQの実施回数
  let events = [];
  try { events = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "schedule-events.json"), "utf8")).events || []; } catch {}
  let reportDirs = [];
  try { reportDirs = fs.readdirSync(path.join(ROOT, "report")); } catch {}
  const counts = bbqCounts(events, today, reportDirs);

  const diff = (cur, key) => {
    if (!prev || prev[key] == null) return "";
    const d = cur - prev[key];
    return d === 0 ? `（先週${md(prev.date, { weekday: false })}と同じ）` : `（先週${md(prev.date, { weekday: false })}より ${d > 0 ? "+" : ""}${d}）`;
  };

  // 期間ラベル（2026-10-05 山根さん「日次か週次か、期間が分からない」）
  const site = SITES.community;
  const W = range(7, 1);   // GA4: 7daysAgo〜yesterday
  const PW = range(14, 8); // GA4: 14daysAgo〜8daysAgo
  const asOf = `${md(today)}の朝の時点`;
  const vsPrev = prev ? `先週（${md(prev.date)}）のメールとの差` : "初回のため前週との差なし";

  const lines = [];
  lines.push(`${site.name} 週次レポート（毎週月曜の朝）`);
  lines.push(`人数は${asOf}の累計。カッコ内は${vsPrev}。サイトの数字は${W.label}`);
  lines.push("読み方: 会員数=サイト入会フォーム登録の累計人数、LINE=公式アカウント友だち数、申込=月1BBQの申込延べ人数（同伴・キャンセル待ち含む）、提供=これまでBBQを振る舞った延べ人数");
  lines.push("");
  lines.push(`- コミュニティ会員: ${memberCount}人 ${diff(memberCount, "members")}`);
  const roleLine = Object.entries(roles).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${ROLE_JA[k] || k}${v}`).join(" / ");
  if (roleLine) lines.push(`- 役割の内訳: ${roleLine}`);
  if (line) lines.push(`- LINE友だち: ${line.count}人 ${diff(line.count, "line")}（${md(line.date)}の確定値）`);
  else lines.push("- LINE友だち: 取得できず（未検証）");
  const evEntries = Object.entries(byEvent).sort();
  if (evEntries.length) for (const [ev, n] of evEntries) lines.push(`- 月1BBQ申込 ${ev}: 延べ${n}人`);
  else lines.push("- 月1BBQ申込: 0件（フォーム経由の申込なし）");
  if (pv) lines.push(`- サイト（${site.url}）のPV（${W.short}）: ${pv.pv}（その前の7日 ${pv.prevPv ?? "?"}）・見た人 ${pv.users}人`);
  else lines.push("- サイトのPV: 取得できず（未検証）");
  lines.push(`- BBQの実施回数: 今年${counts.thisYear}回（予定台帳の開催済みの回）・BBQレポート公開${counts.reports}本${counts.lastWeek.length ? `・この1週間: ${counts.lastWeek.join("／")}` : ""}`);
  if (serve) lines.push(`- 提供人数の累計: BBQ ${serve.totals.bbq}人（スマッシュバーガー含む全累計 ${serve.totals.all}人・台帳${serve.updatedAt}時点）`);
  lines.push("");
  lines.push("提供人数が増えてたら、このグループで「@YORON 提供人数 +◯人（どこで誰に）」って送って！台帳とサイトの数字を更新するよ");

  const msg = lines.join("\n");
  const gids = await groupIds();
  if (!gids.length) { log("グループID未取得。送信スキップ"); await slackDM(`⚠️ BBQ週次レポート便: LINEグループID未取得のため送信できず（${today}）`); }
  for (const g of gids) {
    try { await linePush(g, msg); }
    catch (e) { log(`LINE送信失敗（メールは送る）: ${e.message}`); } // LINEの月間上限(429)でもメールで届ける
  }

  // メール（運営メンバー全員）
  const pct = (a, b) => (b ? `${a - b >= 0 ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : "");
  const kpis = [
    { label: "コミュニティ会員", value: `${memberCount}人`, period: `${asOf}の累計`, note: diff(memberCount, "members").replace(/[（）]/g, "") },
    { label: "LINE友だち", value: line ? `${line.count}人` : "取得できず", period: line ? `${md(line.date)}の確定値` : "", note: line ? diff(line.count, "line").replace(/[（）]/g, "") : "" },
    { label: "サイトのPV", value: pv ? `${pv.pv}` : "取得できず", period: W.short, note: pv && pv.prevPv != null ? `その前の7日（${PW.short.replace(/の7日間$/, "")}）は ${pv.prevPv}（${pct(pv.pv, pv.prevPv)}）` : "" },
    { label: "サイトを見た人", value: pv ? `${pv.users}人` : "取得できず", period: W.short, note: pv && pv.prevUsers != null ? `その前の7日は ${pv.prevUsers}人` : "" },
    { label: "BBQ実施", value: `${counts.thisYear}回`, period: `${today.slice(0, 4)}年1/1〜${md(today, { weekday: false })}`, note: "予定台帳の開催済みの回" },
    { label: "BBQレポート公開", value: `${counts.reports}本`, period: `${asOf}の累計`, note: "yoron-bbq.com/report/" },
  ];
  const sections = [];
  if (pv?.pages?.length) sections.push({ title: "よく見られたページ", period: W.label, kind: "bars", items: pv.pages.map((p) => ({ label: p.path === "/" ? "トップ" : p.path, value: p.pv, display: `${p.pv} PV` })) });
  sections.push({ title: "月1BBQの申込（延べ人数）", period: `${asOf}の累計`, items: evEntries.length ? evEntries.map(([ev, n]) => ({ title: ev, meta: `延べ${n}人` })) : [] });
  if (counts.lastWeek.length) sections.push({ title: "この1週間のBBQ", period: `${md(addDaysYmd(today, -6), { weekday: false })}〜${md(today, { weekday: false })}`, items: counts.lastWeek.map((t) => ({ title: t })) });
  const mail = renderReport({
    title: `${site.name} 週次レポート`,
    dateLabel: `${asOf}／${vsPrev}`,
    legend: [
      `どのサイト：${site.name}（${site.url}）＝${site.what}`,
      `届く頻度：週1回（毎週月曜の朝）。サイトの数字は${W.label}、人数はその朝の時点の累計です`,"会員数=サイト入会フォームの累計／LINE=公式アカウントの友だち数（前日までの確定値）", "PV=yoron-bbq.com のページが見られた回数（GA4・昨日までの7日間）／見た人=その期間の利用者数", "BBQ実施=予定台帳でBBQの回として登録され、開催日を過ぎたもの（定例ミーティング・講座は除く）"],
    kpis, sections,
    footer: `${site.name}の週次レポート（毎週月曜の朝）。LINEグループにも同じ内容を送っています。`,
  });
  if (DRY_RUN) log(`[メール未送信] ${mail.text.slice(0, 600)}`);
  else {
    const m = await sendReport({ subject: `【${site.name}｜週次】${md(today, { weekday: false })}の朝の時点｜会員${memberCount}人${line ? `・LINE${line.count}人` : ""}${pv ? `・サイトPV ${pv.pv}（${W.short}）` : ""}`, html: mail.html, text: mail.text, to: await adminEmails(), fromName: `${site.name} 週次レポート` });
    log(`メール: ${m.ok ? m.id : m.error}`);
  }

  if (!DRY_RUN) {
    fs.writeFileSync(SNAP, JSON.stringify({ date: today, members: memberCount, line: line?.count ?? null, roles, byEvent, pv: pv?.pv ?? null, users: pv?.users ?? null, bbqThisYear: counts.thisYear }, null, 2) + "\n");
  }
  log(`完了 members=${memberCount} line=${line?.count ?? "?"} groups=${gids.length}`);
}

const isDirect = process.argv[1] && fs.realpathSync(process.argv[1]) === new URL(import.meta.url).pathname;
if (isDirect) main().catch(async (e) => {
  log(`❌ クラッシュ: ${e.stack || e.message}`);
  await slackDM(`❌ BBQ週次レポート便がクラッシュ\n${String(e.message).slice(0, 300)}\nログ: ~/dev/bbq/bbq-site/scripts/weekly-run.log`);
  process.exit(1);
});
