#!/usr/bin/env node
/**
 * line-tips — YORON BBQ 公式LINE「登録者向けのお便り」（launchd: com.yamane.bbq-line-tips・火/金 18:00 のまま）
 *
 * 2026-11-08 作り替え（11/5定例の決定「LINE自動投稿の見直し」・山根さん依頼）:
 *   - 登録者（公式LINEの友だち）へ週1回まで。運営4人のグループには、この便からは何も送らない
 *   - 原稿は山根さんにメールで送り、山根さんが運営LINEで「配信OK」と返したものだけ一斉配信する
 *   - 中身は ①次の月1BBQの案内 ②BBQレポート ③BBQのコツ（line-tips-queue.json）＋新しい読みもの
 *   - 文面はテンプレートと事前執筆の原稿だけ（送信時のLLM呼び出しゼロ）。AI・自動などの言葉は lintLetter で止める
 *   - 月の無料枠（200通）を、運営グループの分（GROUP_RESERVE）を残して使う。足りなければ送らずメールで知らせる
 * 判定は lib/line-letter.mjs（テスト=test/line-letter.test.mjs）。
 *
 *   node scripts/line-tips.mjs --dry-run   何をするか表示するだけ（メールもLINEも送らない）
 *   node scripts/line-tips.mjs --send      本番（launchd から）
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { accessSecret, gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import { sendReport, renderReport, esc } from "../../../tools/lib/report-mail.mjs";
import { dispJst } from "../../../tools/lib/jst.mjs";
import { decide, pickContent, composeLetter, lintLetter, findLetterApproval, quotaAllows, reportTitle, ymdJst, weekKeyJst, SITE } from "./lib/line-letter.mjs";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(DIR, "..");
const QUEUE = path.join(DIR, "line-tips-queue.json");
const LEDGER = path.join(DIR, "line-letter-ledger.json"); // 原稿と配信記録（gitに入れない）
const LOCAL = path.join(DIR, "report-local.json"); // 承認者のLINE ID・運営グループID（レポート便と共用・gitに入れない）
const GCP_PROJECT = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const SLACK_DM_USER = "U7XLRM33R"; // 山根さん
const APPROVER_MAIL = ["yamane@potentialight.com"];

const SEND = process.argv.includes("--send");
// 山根さんがターミナルで「送って」と言った時用。原稿のIDまで指定させ、見ていない原稿は送れないようにする
const APPROVE_ID = (process.argv.find((a) => a.startsWith("--approve=")) || "").slice("--approve=".length) || null;
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function slackDM(text) {
  if (!SEND) return log(`[Slack未送信] ${text}`);
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
    });
  } catch (e) { log(`Slack DM失敗: ${e.message}`); }
}

function gitSync(args) {
  try { execSync(`git ${args}`, { cwd: ROOT, stdio: "pipe", timeout: 60000 }); return true; }
  catch (e) { log(`git ${args.split(" ")[0]}失敗: ${String(e.message).slice(0, 200)}`); return false; }
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const loadLedger = () => readJson(LEDGER, { drafts: [], announced: {} });
function saveLedger(l) { if (SEND) fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n"); }

const lineToken = async () => process.env.LINE_CHANNEL_TOKEN?.trim() || (await accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN"));

async function lineGet(p) {
  const r = await fetch(`https://api.line.me/v2/bot/${p}`, { headers: { Authorization: `Bearer ${await lineToken()}` } });
  if (!r.ok) throw new Error(`LINE ${p} HTTP ${r.status}`);
  return r.json();
}

/** 一斉配信が届く人数（ブロックを除いた友だち数）。Insightは前日分までしか出ないので最大3日さかのぼる */
async function recipients() {
  for (let back = 1; back <= 3; back++) {
    const ymd = ymdJst(new Date(Date.now() - back * 86400000)).replace(/-/g, "");
    const j = await lineGet(`insight/followers?date=${ymd}`);
    if (j.status === "ready") return Number(j.targetedReaches ?? j.followers) || 0;
  }
  throw new Error("友だち数が取れない（Insightが未集計）");
}

async function quota(n) {
  const q = await lineGet("message/quota");
  const c = await lineGet("message/quota/consumption");
  return { ...quotaAllows({ limit: q.type === "none" ? "none" : q.value, used: c.totalUsage, recipients: n }), limit: q.value, used: c.totalUsage };
}

async function fsQuery(collectionId, where) {
  const r = await fetch(`${FS_BASE}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await gcpAccessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where, limit: 500 } }),
  });
  if (!r.ok) throw new Error(`${collectionId} runQuery HTTP ${r.status}`);
  return (await r.json()).filter((x) => x.document).map((x) => x.document.fields || {});
}
const val = (v) => (v ? v.stringValue ?? v.integerValue ?? v.doubleValue ?? v.booleanValue ?? null : null);

async function regsFor(dates) {
  const out = {};
  for (const d of dates) {
    const rows = await fsQuery("event_regs", { fieldFilter: { field: { fieldPath: "eventId" }, op: "EQUAL", value: { stringValue: d } } });
    out[d] = rows.reduce((s, f) => s + (Number(val(f.party)) || 1), 0);
  }
  return out;
}

async function lineLogs(fromIso) {
  const rows = await fsQuery("line_group_log", { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { stringValue: fromIso } } });
  return rows.map((f) => ({ userId: val(f.userId) || "", groupId: val(f.groupId) || "", text: val(f.text) || "", createdAt: val(f.createdAt) || "" }));
}

/** サイトの公開物（読みもの・スパイス大全・BBQレポート・月1BBQの予定）を読む */
function siteContent() {
  const posts = [];
  for (const [dir, file] of [["blog", "blog/posts.json"], ["spice", "spice/posts.json"]]) {
    const j = readJson(path.join(ROOT, file), []);
    for (const p of Array.isArray(j) ? j : j.posts || []) if (p.date && p.title && p.file) posts.push({ date: p.date, title: p.title, url: `${SITE}/${dir}/${p.file}` });
  }
  const reports = [];
  for (const d of fs.readdirSync(path.join(ROOT, "report"))) {
    const f = path.join(ROOT, "report", d, "index.html");
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && fs.existsSync(f)) reports.push({ date: d, title: reportTitle(fs.readFileSync(f, "utf8")) });
  }
  const events = createRequire(import.meta.url)(path.join(ROOT, "next-events.js")).EVENTS;
  return { posts, reports, events };
}

async function mail(subject, title, lines, text) {
  const html = renderReport({ title, dateLabel: ymdJst(), legend: lines, sections: text ? [{ title: "登録者に届く文面", kind: "html", html: `<div style="white-space:pre-wrap;background:#fff;border-radius:12px;padding:14px;font-size:14px;line-height:1.8">${esc(text)}</div>` }] : [] });
  if (!SEND) { log(`[メール未送信] ${subject}\n${lines.join("\n")}\n----\n${text || ""}`); return true; }
  let m;
  try { m = await sendReport({ subject, html: html.html, text: `${lines.join("\n")}\n\n----\n${text || ""}`, to: APPROVER_MAIL, fromName: "YORON BBQ LINE配信" }); }
  catch (e) { m = { ok: false, error: e.message }; }
  log(`メール: ${m.ok ? m.id : m.error}`);
  // メールが届かないと山根さんが原稿を見られないので、Slackに同じ内容を出す
  if (!m.ok) await slackDM(`BBQのLINE配信: メールが送れなかったのでこちらに出します（${m.error}）\n${subject}\n${lines.join("\n")}\n----\n${text || ""}`);
  return m.ok;
}

async function broadcast(text, retryKey) {
  const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await lineToken()}`, "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ messages: [{ type: "text", text }] }),
  });
  // 409=同じリトライキーで受付済み（前回届いている）
  if (!res.ok && res.status !== 409) throw new Error(`broadcast失敗 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function main() {
  gitSync("pull --rebase --autostash"); // 最新の記事・予定を読むため（配信記録は台帳=ローカル）
  const ledger = loadLedger();
  ledger.drafts ||= []; ledger.announced ||= {};
  const local = readJson(LOCAL, {});
  const now = new Date();

  const waiting = ledger.drafts.find((d) => d.status === "waiting");
  let approval = null;
  if (waiting && APPROVE_ID) {
    if (APPROVE_ID !== waiting.id) { log(`--approve=${APPROVE_ID} は承認待ちの原稿（${waiting.id}）と違うので送りません`); return; }
    approval = { createdAt: new Date().toISOString(), via: "terminal" };
  } else if (waiting) {
    if (!(local.approverUserIds || []).length || !local.groupId) {
      await slackDM("BBQのLINE配信: report-local.json（承認者のLINE ID・運営グループ）が無いので「配信OK」を受け付けられません");
    } else {
      approval = findLetterApproval(await lineLogs(waiting.mailedAt || waiting.createdAt), waiting.mailedAt || waiting.createdAt, local);
    }
  }

  let plan = decide({ ledger, now, approval });
  log(`判定: ${plan.action}${plan.reason ? `（${plan.reason}）` : ""}`);

  if (plan.action === "stuck") {
    await slackDM(`BBQのLINE配信: ${plan.draft.id} が配信の途中で止まっています。登録者に届いたかLINE公式アカウントの管理画面で確かめ、scripts/line-letter-ledger.json の status を sent（届いた）か waiting（届いていない）に直してください。二重配信を避けるため、それまで止めています`);
    return;
  }

  if (plan.action === "expire") {
    plan.draft.status = "expired";
    for (const k of plan.draft.keys || []) {
      // 見送られた中身は次回選ばない。ただし月1BBQの案内は代わりが無いので、案内期間内ならまた選べるようにする
      if (!k.startsWith("event:")) ledger.announced[k] ||= `skipped:${now.toISOString()}`;
    }
    plan.draft.expiredAt = now.toISOString();
    saveLedger(ledger);
    await mail(`【YORON BBQ｜LINE配信】${plan.draft.createdAt.slice(5, 10).replace("-", "/")}の原稿は送らずに取り下げました`, "LINE配信の原稿を取り下げました",
      ["1週間のうちに送れなかったので、この原稿は登録者に送っていません。", "次の原稿は別の中身で作ります（BBQ開催の案内は、案内できる期間ならもう一度お送りします）。"], plan.draft.text);
    plan = decide({ ledger, now, approval: null });
    log(`再判定: ${plan.action}`);
  }

  if (plan.action === "send") {
    const d = plan.draft;
    const errs = lintLetter(d.text);
    if (errs.length) { await slackDM(`BBQのLINE配信: 承認された原稿に問題があるので送りませんでした（${errs.join("・")}）`); return; }
    const n = await recipients();
    const q = await quota(n);
    log(`届く人数${n}人・今月の残り${q.left}通`);
    if (!q.ok) {
      const month = ymdJst(now).slice(0, 7);
      if (ledger.quotaNoticeMonth === month) return log("無料枠不足（今月はもう知らせた）");
      ledger.quotaNoticeMonth = month; saveLedger(ledger);
      await mail("【YORON BBQ｜LINE配信】無料枠が足りないので今週は送っていません", "LINE配信を見送りました",
        [`登録者${n}人に送ると、今月の残り${q.left}通から運営グループ用の分が足りなくなります。`, "この原稿は1週間たつと取り下げます。来月の枠に戻ったら、また原稿をお送りします。", "毎週送るなら、LINE公式アカウントの有料プランへの切り替えが必要です。"], d.text);
      return;
    }
    if (!SEND) return log(`[LINE未送信] 登録者${n}人へ\n----\n${d.text}`);
    d.retryKey ||= crypto.randomUUID();
    d.status = "sending"; d.sendingAt = new Date().toISOString();
    saveLedger(ledger); // 先に「配信中」を残す（応答が返らずに落ちても、次回に二重配信しない）
    await broadcast(d.text, d.retryKey);
    d.status = "sent"; d.sentAt = new Date().toISOString(); d.approvedAt = approval.createdAt; d.approvedVia = approval.via || "line"; d.recipients = n;
    for (const k of d.keys || []) ledger.announced[k] = d.sentAt;
    saveLedger(ledger);
    log(`配信完了: ${d.id}（${n}人）`);
    // BBQのコツの原稿は、公開リポのキューにも送信日時を残す（ネタの残り数の管理用）
    const tipKey = (d.keys || []).find((k) => k.startsWith("tip:"));
    if (tipKey) {
      const queue = readJson(QUEUE, { items: [] });
      const it = queue.items.find((x) => `tip:${x.id}` === tipKey);
      if (it) {
        it.sentAt = d.sentAt;
        fs.writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + "\n");
        gitSync(`add ${JSON.stringify(QUEUE)}`); gitSync(`commit -m "line-tips: ${it.id} 登録者へ配信"`); gitSync("push");
      }
      const left = queue.items.filter((x) => !x.sentAt).length;
      if (left <= 2) await slackDM(`BBQのLINE配信: コツの原稿の残りが${left}本です。scripts/line-tips-queue.json に補充を`);
    }
    await mail(`【YORON BBQ｜LINE配信】登録者${n}人に送りました`, "LINEで登録者に送りました", [`${approval.via === "terminal" ? "Claude Codeでの承認" : "「配信OK」"}（${dispJst(new Date(approval.createdAt))}）を受けて、登録者${n}人に送りました。`], d.text);
    return;
  }

  if (plan.action !== "draft") return;

  const site = siteContent();
  const today = ymdJst(now);
  const bbqDates = site.events.filter((e) => e.kind === "bbq" && e.date >= today).map((e) => e.date);
  const regs = await regsFor(bbqDates);
  const queue = readJson(QUEUE, { items: [] });
  const lastSent = ledger.drafts.filter((d) => d.status === "sent").map((d) => d.sentAt).sort().pop();
  const pick = pickContent({ today, events: site.events, regs, reports: site.reports, posts: site.posts, tips: queue.items, announced: ledger.announced, lastSentYmd: lastSent ? ymdJst(new Date(lastSent)) : "" });
  if (!pick) {
    log("送る中身が無い（予定・レポート・コツの原稿・新しい読みものが全部なし）");
    await slackDM("BBQのLINE配信: 今週は送る中身がありません。scripts/line-tips-queue.json にコツの原稿を補充してください");
    return;
  }
  const text = composeLetter(pick);
  const errs = lintLetter(text);
  if (errs.length) { await slackDM(`BBQのLINE配信: 原稿に問題があるので作り直しが必要です（${errs.join("・")}）`); return; }

  const keys = [pick.main.key, ...pick.extras.map((x) => x.key)].filter(Boolean);
  const draft = { id: `${weekKeyJst(now)}-${ledger.drafts.length + 1}`, status: "waiting", createdAt: now.toISOString(), mailedAt: null, keys, text };
  const what = { event: "次の月1BBQの案内", report: "BBQレポートの紹介", tip: "BBQのコツ", posts: "新しい読みものの紹介" }[pick.main.kind];
  const lines = [
    `今回の中身: ${what}${pick.extras.length ? `＋新しい読みもの${pick.extras.length}本` : ""}`,
    ...(pick.main.kind === "event" ? [`申込は今${pick.main.regs}人（定員${pick.main.capacity}人）`] : []),
    "送ってよければ、運営のLINEグループで「配信OK」とだけ送ってください（@YORON は付けないでください。付けるとサイトの修正依頼として受け付けてしまいます）。次の火曜か金曜の18時に、登録者のみなさんに届きます。",
    "送らない時は何もしなくて大丈夫です（1週間で取り下げます）。直したい所がある時は、Claude Codeに伝えてください。",
  ];
  if (!SEND) { log(`[台帳未保存] ${draft.id}`); return mail("（試し）", "LINE配信の原稿", lines, text); }
  ledger.drafts.push(draft);
  saveLedger(ledger); // 先に台帳へ（メールが二重に飛ばないように）
  await mail(`【YORON BBQ｜LINE配信の確認】${today.slice(5).replace("-", "/")}の原稿（${what}）`, "登録者向けLINEの原稿です", lines, text);
  draft.mailedAt = new Date().toISOString(); // メールが失敗した時はSlackに同じ内容が出ている
  saveLedger(ledger);
}

// LINE無料枠の月次上限(HTTP 429 "monthly limit")は月初に回復する一時状態。クラッシュ扱いせず見送る（2026-10-17）
function isLineMonthlyLimit(msg) {
  return /HTTP 429/i.test(msg) && /monthly limit/i.test(msg);
}
main().catch(async (e) => {
  const msg = e.message || String(e);
  if (isLineMonthlyLimit(msg)) { log("SKIP: LINE月次上限(429)につき今回は見送り"); process.exit(0); }
  log(`クラッシュ: ${msg}`);
  await slackDM(`BBQのLINE配信(line-tips)が止まりました: ${msg}`);
  process.exit(1);
});
