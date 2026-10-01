#!/usr/bin/env node
/**
 * guest-guide-loop — 月1BBQなどの参加者へ「当日のしおり」を送る便（送る前に山根さんへメールで確認）
 *
 * 依頼（2026-09-28 山根さん）: 案内ページ（木場公園の来る人用しおり＝venue-kiba.html の型）をテンプレにして、
 *   開催5日前ぐらいに参加者へ送る。送る時は山根さんにメールで確認を取る。
 *
 * 流れ（mini launchd 毎朝 5:40）:
 *   ① Firestore event_regs を開催日ごとに集める。開催5日前〜前日の回が対象
 *   ② 案内ページを Firestore guest_guides に置く → yoron-bbq.com/guide.html?g=ID（住所を含むので公開リポジトリには置かない）
 *   ③ まだ送っていない参加者がいれば、送信予定（宛先・文面・合言葉）を guest_guide_sends に置き、山根さんへ確認メール
 *   ④ 山根さんが確認画面で「送る」→ Functions bbqGuestGuideSend が参加者へ1人ずつ送り、運営メンバーへ「送りました」
 *   ⑤ そのあと申し込んだ人がいれば、その人の分だけ翌朝また確認メール
 *   ⓪ 開催1週間前には、うえたく・山根さんへ「メニューどうする？」（menu-pick.html＝確定の料理＋やりたいを付け合う・買い物チェックと連動）
 *
 *   node scripts/guest-guide-loop.mjs               通常
 *   node scripts/guest-guide-loop.mjs --dry-run     何も置かない・送らない。対象と文面を表示
 *   node scripts/guest-guide-loop.mjs --event 2026-10-04 --menu   その回のメニュー相談だけ出す
 *   node scripts/guest-guide-loop.mjs --event 2026-10-04 [--force|--page-only]   その回だけ（--force=同じ宛先でも確認を出し直す／--page-only=ページだけ作り直す）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import { breaker, breakerOk, throttledNotify } from "../../../tools/lib/failsafe.mjs";
import { sendReport } from "../../../tools/lib/report-mail.mjs";
import { ymdJst } from "../../../tools/lib/jst.mjs";
import { dueEvents, roster, renderGuide, participantMailText, participantMailHtml, confirmMailHtml, pendingOf, pendingKey, jpDate, SEND_FN, menuDueEvents, menuConsultMail, withoutSkipped } from "./guest-guide/core.mjs";

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
const OWNER = "yamane@potentialight.com"; // 送る前の確認は山根さんだけ（2026-09-28）

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const FORCE = argv.includes("--force"); // 同じ宛先でも確認メールを出し直す
const PAGE_ONLY = argv.includes("--page-only");
const MENU_ONLY = argv.includes("--menu"); // --event と一緒に: その回のメニュー相談だけ出す // 案内ページだけ作り直す（メールは送らない・送信記録は変えない）
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

async function fsDoc(pathRel) {
  const r = await fetch(`${FS_BASE}/${pathRel}`, { headers: { Authorization: `Bearer ${await token()}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${pathRel} ${r.status}`);
  return (await r.json()).fields || {};
}
/** 送信予定を置く（sentTo は触らない＝送った記録は関数側だけが書く） */
async function saveSendPlan(slug, plan) {
  const fields = {
    token: { stringValue: plan.token }, subject: { stringValue: plan.subject }, mailHtml: { stringValue: plan.mailHtml },
    dateLabel: { stringValue: plan.dateLabel }, guideUrl: { stringValue: plan.guideUrl }, eventId: { stringValue: plan.eventId },
    requestedAt: { stringValue: new Date().toISOString() },
    pending: { arrayValue: { values: plan.pending.map((p) => ({ mapValue: { fields: { name: { stringValue: p.name }, email: { stringValue: p.email } } } })) } },
  };
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  const r = await fetch(`${FS_BASE}/guest_guide_sends/${slug}?${mask}`, { method: "PATCH", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`送信予定の保存失敗 ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function handle(id, regs, cfg, local, ledger) {
  const ev = cfg.events?.[id];
  if (!ev) {
    log(`${id}: events.json に回の情報が無い → 山根さんへ知らせる`);
    if (!DRY && !ledger[id]?.missingNotified) {
      await sendReport({ subject: `【YORON BBQ】${jpDate(id)}の当日案内の元がありません`, fromName: "YORON BBQ 当日案内便", to: [OWNER],
        html: `<p>${jpDate(id)}の回に申込があるのに、当日案内便の設定（scripts/guest-guide/events.json）がありません。Claudeに「${id}の案内を作って」と伝えてください。</p>`,
        text: `${id} の当日案内の設定がありません。` });
      ledger[id] = { ...(ledger[id] || {}), missingNotified: new Date().toISOString() };
    }
    return;
  }
  const info = { ...cfg.defaults, ...ev };
  const venue = local.venues?.[ev.venueKey] || null;
  // 同じ回は同じURLのまま中身を差し替える（送ったあとに直しても、参加者の手元のURLで最新が見える）
  const slug = ledger[id]?.slug || crypto.randomBytes(5).toString("hex");
  const guideUrl = DRY ? `${SITE}/guide.html?g=${slug}` : await saveGuide(slug, id, renderGuide({ date: id, info, venue }));
  if (!DRY) ledger[id] = { ...(ledger[id] || {}), slug, guideUrl };
  if (PAGE_ONLY) { log(`${id}: 案内ページだけ更新 ${guideUrl}`); return; }

  const sends = DRY ? null : await fsDoc(`guest_guide_sends/${slug}`);
  const sentTo = (sends?.sentTo?.arrayValue?.values || []).map((v) => v.stringValue);
  // 送信の途中で止まったまま（sendingAt が30分以上残っている）→ 山根さんへ知らせる。送った人は sentTo にあるので、残りは下で改めて確認に回る
  const sendingAt = sends?.sendingAt?.stringValue;
  if (sendingAt && Date.now() - Date.parse(sendingAt) > 30 * 60 * 1000) {
    log(`${id}: 送信が途中で止まった形跡（sendingAt=${sendingAt}）`);
    if (!DRY) await throttledNotify(`bbq-guest-guide-stuck:${id}`, `BBQ当日案内便: ${id} の参加者への送信が途中で止まったようです（送れた${sentTo.length}名は記録済み・残りは確認メールを出し直します）`, { cooldownMin: 1440 });
  }
  const ros = roster(regs);
  const pending = pendingOf(ros, sentTo);
  if (!pending.length) { log(`${id}: 未送信の参加者なし（送信済み${sentTo.length}名）`); return; }
  const key = pendingKey(pending);
  // 返事待ち＝合言葉がまだ残っている間は出し直さない。合言葉が消えている（送信を試した）のに残っている人＝送れなかった人は、翌朝もう一度確認を出す
  const awaiting = !!sends?.token?.stringValue;
  if (awaiting && ledger[id]?.requestedKey === key && !FORCE) { log(`${id}: 同じ${pending.length}名分は確認メール送信済み（返事待ち）`); return; }

  const text = participantMailText({ date: id, info, venue, guideUrl });
  const subject = `【YORON BBQ】${jpDate(id)} 当日のご案内`;
  const tok = crypto.randomBytes(16).toString("hex");
  const approveUrl = `${SEND_FN}?g=${slug}&t=${tok}`;
  if (!DRY) await saveSendPlan(slug, { token: tok, subject, mailHtml: participantMailHtml({ text, guideUrl }), dateLabel: jpDate(id), guideUrl, eventId: id, pending });
  const r = await sendReport({
    subject: `【確認】${jpDate(id)}のBBQ参加者${pending.length}名へ、当日の案内を送っていいですか？`,
    fromName: "YORON BBQ 当日案内便", to: [OWNER], dry: DRY,
    html: confirmMailHtml({ date: id, info, guideUrl, pending, sentCount: sentTo.length, approveUrl, text }), text,
  });
  if (!r.ok) throw new Error(`確認メール送信失敗: ${r.error}`);
  log(`${id}: 山根さんへ確認メール${DRY ? "(dry)" : ""} 未送信${pending.length}名 住所${venue?.address ? "あり" : "なし"} id=${r.id || "-"}`);
  if (DRY) { console.log(text); return; }
  ledger[id] = { ...ledger[id], requestedKey: key, requestedAt: new Date().toISOString(), mailId: r.id };
}

const S = (v) => ({ stringValue: v });
const A = (a) => ({ arrayValue: { values: a.map(S) } });
/** その回の買い物チェック（shoplists）を用意する。events.json の shoplist → 台帳 → 新規作成 の順 */
async function ensureShoplist(id, ev, info, ledger) {
  if (ev.shoplist) return ev.shoplist;
  if (ledger[id]?.shoplist) return ledger[id].shoplist;
  // 管理ページで先に作ってあればそれを使う（menu_picks/{開催日}・2026-10-01）
  const pickRef = `${FS_BASE}/menu_picks/${id}`;
  const got = await fetch(pickRef, { headers: { Authorization: `Bearer ${await token()}` } });
  if (got.ok) { const sl = (await got.json()).fields?.shoplist?.stringValue; if (sl) return sl; }
  else if (got.status !== 404) throw new Error(`menu_picks の確認失敗 ${got.status}`);
  const sid = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  const fixed = info.menuFixed || {};
  const now = new Date().toISOString();
  const fields = {
    title: S(`${id.replace(/-/g, "")} ${info.shortTitle || "月1BBQ"}`), owners: A(["やまちゃん", "うえたく"]), members: A(["やまちゃん", "うえたく"]),
    who: { mapValue: {} }, checks: { mapValue: {} }, skips: { mapValue: {} }, wants: { mapValue: {} },
    dishes: A(Object.keys(fixed)), menuFixed: { mapValue: { fields: Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, S(v)])) } },
    createdAt: S(now), updatedAt: S(now),
  };
  const r = await fetch(`${FS_BASE}/shoplists?documentId=${sid}`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
  if (!r.ok) throw new Error(`買い物チェックの作成失敗 ${r.status}`);
  // 管理ページ側からも同じ回だと分かるように残す（既にあれば上書きしない）
  const w = await fetch(`${FS_BASE}/menu_picks?documentId=${id}`, { method: "POST", headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: JSON.stringify({ fields: { eventId: S(id), shoplist: S(sid), by: S("guest-guide-loop"), createdAt: S(now) } }) });
  if (!w.ok && w.status !== 409) log(`${id}: menu_picks の記録失敗 ${w.status}（買い物チェックは作成済み ${sid}）`);
  return sid;
}

/** 開催1週間前: うえたく・山根さんへメニュー相談（確定の料理＋やりたいを付け合うページ） */
async function menuConsult(id, regs, cfg, local, ledger) {
  const ev = cfg.events?.[id];
  if (!ev) return; // 回の設定が無い回は当日案内側で知らせる
  const info = { ...cfg.defaults, ...ev };
  const to = local.menuConsultTo?.length ? local.menuConsultTo : [OWNER];
  if (!local.menuConsultTo?.length) log(`${id}: menuConsultTo が無いので山根さんだけに送る`);
  const shoplist = DRY ? (ev.shoplist || "(dry)") : await ensureShoplist(id, ev, info, ledger);
  const pickUrl = `${SITE}/menu-pick.html?l=${shoplist}`;
  const m = menuConsultMail({ date: id, info, fixed: info.menuFixed || {}, pickUrl, people: roster(regs).people });
  const r = await sendReport({ subject: m.subject, html: m.html, text: m.text, to, fromName: "やまちゃん（YORON BBQ）", replyTo: OWNER, dry: DRY });
  if (!r.ok) throw new Error(`メニュー相談メール失敗: ${r.error}`);
  log(`${id}: メニュー相談を${to.length}人へ${DRY ? "(dry)" : ""} ${pickUrl} id=${r.id || "-"}`);
  if (DRY) { console.log(m.text); return; }
  ledger[id] = { ...(ledger[id] || {}), shoplist, menuAskedAt: new Date().toISOString(), menuMailId: r.id };
}

async function main() {
  const today = ymdJst(new Date());
  const cfg = readJson(EVENTS, { events: {} });
  const local = readJson(LOCAL, {});
  const ledger = readJson(LEDGER, {});
  const regsByEvent = await fetchRegs();
  const ids = withoutSkipped(ONLY ? [ONLY] : dueEvents({ today, eventIds: Object.keys(regsByEvent), regsByEvent, ledger }), cfg);
  log(`today=${today} 当日案内の対象=${ids.join(",") || "なし"}`);
  const menuIds = withoutSkipped(ONLY ? (MENU_ONLY ? [ONLY] : []) : menuDueEvents({ today, eventIds: Object.keys(regsByEvent), regsByEvent, ledger }), cfg);
  for (const id of menuIds) await menuConsult(id, regsByEvent[id] || [], cfg, local, ledger);
  if (MENU_ONLY) { if (!DRY) fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n"); return; }
  for (const id of ids) await handle(id, regsByEvent[id] || [], cfg, local, ledger);
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
