#!/usr/bin/env node
/**
 * guest-guide-loop — 月1BBQなどの参加者へ「当日のご案内」を送る前日に、運営メンバーへ知らせる便
 *
 * 依頼（2026-09-28 山根さん）: 開催5日前に参加者へ連絡したい。その前にメールで運営（山根・うえたく・あんちゃん・ヨッシー）へ
 *   知らせてほしい。参加者に見てもらう案内ページ（8/29 木場公園の当日案内が見本）も自動で作る。
 *
 * 流れ（mini launchd 毎朝 5:40）:
 *   ① Firestore event_regs を開催日ごとに集める
 *   ② 開催6日前〜前日で、まだ知らせていない回を選ぶ（参加者0人の回は知らせない）
 *   ③ 案内ページを Firestore guest_guides に置く → yoron-bbq.com/guide.html?g=ID（住所を含むので公開リポジトリには置かない）
 *   ④ 運営メンバー（config/bbq_admins）へメール：参加者一覧・案内ページ・そのまま送れる文面・BCC入りmailto
 *   ⑤ 送った後に住所が登録されたら、住所入りで1回だけ送り直す
 * 参加者へ直接は送らない（社外への送信は運営が自分で送る）。
 *
 *   node scripts/guest-guide-loop.mjs               通常
 *   node scripts/guest-guide-loop.mjs --dry-run     送らない・置かない。対象と文面を表示
 *   node scripts/guest-guide-loop.mjs --event 2026-10-04 [--force|--page-only]   その回だけ（--force=送信済みでも送る／--page-only=ページだけ作り直す）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import { breaker, breakerOk, throttledNotify } from "../../../tools/lib/failsafe.mjs";
import { sendReport } from "../../../tools/lib/report-mail.mjs";
import { ymdJst } from "../../../tools/lib/jst.mjs";
import { adminEmails } from "./lib/bbq-admins.mjs";
import { dueEvents, roster, renderGuide, participantMailText, adminMailHtml, buildMailto, jpDate } from "./guest-guide/core.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS, "..");
const EVENTS = path.join(SCRIPTS, "guest-guide/events.json");
const LOCAL = path.join(SCRIPTS, "guest-guide-local.json");
const LEDGER = path.join(SCRIPTS, "guest-guide-ledger.json");
const LOGF = path.join(SCRIPTS, "guest-guide-run.log");
const GCP = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP}/databases/(default)/documents`;
const SITE = "https://yoron-bbq.com";
const LAUNCHD_LABEL = "com.yamane.bbq-guest-guide";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force");
const PAGE_ONLY = argv.includes("--page-only"); // 案内ページだけ作り直す（メールは送らない・送信記録は変えない）
const ONLY = argv.includes("--event") ? argv[argv.indexOf("--event") + 1] : null;

const logs = [];
const log = (s) => { const l = `[${new Date().toISOString()}] ${s}`; logs.push(l); console.log(l); };
const flushLog = () => { try { fs.appendFileSync(LOGF, logs.join("\n") + "\n"); } catch {} };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

let _tok;
const token = async () => (_tok ||= await gcpAccessToken());
const val = (f) => f?.stringValue ?? f?.integerValue ?? f?.booleanValue ?? f?.timestampValue ?? "";

async function fetchRegs() {
  const out = {};
  let pageToken = "";
  do {
    const r = await fetch(`${FS_BASE}/event_regs?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ""}`, { headers: { Authorization: `Bearer ${await token()}` } });
    if (!r.ok) throw new Error(`event_regs ${r.status}`);
    const j = await r.json();
    for (const d of j.documents || []) {
      const f = d.fields || {};
      const id = String(val(f.eventId));
      (out[id] ||= []).push({ name: val(f.name), email: val(f.email), party: val(f.party), status: val(f.status), note: val(f.note) });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

/** 案内ページを Firestore guest_guides/{slug} に置く → yoron-bbq.com/guide.html?g=slug で開く（住所を公開リポジトリに置かないため） */
async function saveGuide(slug, date, html) {
  const r = await fetch(`${FS_BASE}/guest_guides/${slug}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { html: { stringValue: html }, date: { stringValue: date }, updatedAt: { stringValue: new Date().toISOString() } } }),
  });
  if (!r.ok) throw new Error(`案内ページの保存失敗 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return `${SITE}/guide.html?g=${slug}`;
}

async function handle(id, regs, cfg, local, ledger, { resend = false } = {}) {
  const ev = cfg.events?.[id];
  if (!ev) {
    log(`${id}: events.json に回の情報が無い → 運営へ知らせる`);
    if (!DRY && !ledger[id]?.missingNotified) {
      await sendReport({ subject: `【YORON BBQ】${jpDate(id)}の当日案内の元がありません`, fromName: "YORON BBQ 当日案内便", to: await adminEmails(),
        html: `<p>${jpDate(id)}の回に申込があるのに、当日案内便の設定（scripts/guest-guide/events.json）がありません。山根さん経由でClaudeに「${id}の案内を作って」と伝えてください。</p>`,
        text: `${id} の当日案内の設定がありません。` });
      ledger[id] = { ...(ledger[id] || {}), missingNotified: new Date().toISOString() };
    }
    return;
  }
  const info = { ...cfg.defaults, ...ev };
  const venue = local.venues?.[ev.venueKey] || null;
  const ros = roster(regs);
  const html = renderGuide({ date: id, info, venue });
  // 同じ回は同じURLのまま中身を差し替える（送り直しても参加者に送ったURLが生きる）
  const slug = ledger[id]?.slug || crypto.randomBytes(5).toString("hex");
  const guideUrl = DRY ? "(dry-run)" : await saveGuide(slug, id, html);
  const text = participantMailText({ date: id, info, venue, guideUrl });
  if (PAGE_ONLY) {
    log(`${id}: 案内ページだけ更新 ${guideUrl}`);
    if (!DRY) ledger[id] = { ...(ledger[id] || {}), guideUrl, slug };
    return;
  }
  const subject = `【YORON BBQ】${jpDate(id)} 当日のご案内`;
  const mailto = buildMailto({ bcc: ros.ok.map((r) => r.email).filter(Boolean), subject, body: text });
  const to = await adminEmails();
  const head = resend ? "【住所を入れて送り直し】" : "";
  const r = await sendReport({
    subject: `${head}【YORON BBQ】${jpDate(id)}の参加者${ros.people}名へ、当日の案内を送りましょう`,
    fromName: "YORON BBQ 当日案内便", to, dry: DRY,
    html: adminMailHtml({ date: id, info, venue, guideUrl, ros, mailto, text }), text,
  });
  if (!r.ok) throw new Error(`メール送信失敗: ${r.error}`);
  log(`${id}: 運営${to.length}人へ送信${DRY ? "(dry)" : ""} 参加${ros.people}名 住所${venue?.address ? "あり" : "なし"} id=${r.id || "-"}`);
  if (DRY) { console.log(text); return; }
  ledger[id] = { ...(ledger[id] || {}), sentAt: new Date().toISOString(), withAddress: !!venue?.address, people: ros.people, guideUrl, slug, mailId: r.id };
}

async function main() {
  const today = ymdJst(new Date());
  const cfg = readJson(EVENTS, { events: {} });
  const local = readJson(LOCAL, {});
  const ledger = readJson(LEDGER, {});
  const regsByEvent = await fetchRegs();
  let ids = ONLY ? [ONLY] : dueEvents({ today, eventIds: Object.keys(regsByEvent), regsByEvent, ledger });
  if (ONLY && ledger[ONLY]?.sentAt && !FORCE && !PAGE_ONLY) { log(`${ONLY}: 送信済み（--force で再送）`); ids = []; }
  log(`today=${today} 対象=${ids.join(",") || "なし"}`);
  for (const id of ids) await handle(id, regsByEvent[id] || [], cfg, local, ledger);
  // 住所なしで送った回に、あとから住所が入ったら1回だけ送り直す
  if (!ONLY) for (const [id, l] of Object.entries(ledger)) {
    if (!l.sentAt || l.withAddress || l.resentAt || id < today) continue;
    const ev = cfg.events?.[id];
    if (ev && local.venues?.[ev.venueKey]?.address) {
      await handle(id, regsByEvent[id] || [], cfg, local, ledger, { resend: true });
      if (!DRY) ledger[id].resentAt = new Date().toISOString();
    }
  }
  if (!DRY) fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => { breakerOk("bbq-guest-guide"); flushLog(); })
    .catch(async (e) => {
      log(`失敗: ${e.stack || e.message}`); flushLog();
      await throttledNotify("bbq-guest-guide-crash", `BBQ当日案内便が失敗\n${String(e.message).slice(0, 300)}\nログ: ~/dev/bbq/bbq-site/scripts/guest-guide-run.log`, { cooldownMin: 60 });
      await breaker("bbq-guest-guide", { max: 5, label: LAUNCHD_LABEL });
      process.exit(1);
    });
}
