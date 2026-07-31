#!/usr/bin/env node
/**
 * request-loop — LINE修正受付システムの処理側（Mac / launchd 10分おき）
 *
 * 受付側: functions/index.js の lineWebhook が、運営LINEグループでの
 *         「公式アカウントへの呼びかけ」を Firestore site_requests に pending で積む。
 * 処理側: このスクリプトが pending を拾い、claude CLI ヘッドレス（定額枠・従量API不使用）で
 *         依頼を解釈し、
 *           - 原則すべて自動実装 → push → 本番200確認 → LINEへ「こう直したよ」報告 → status=done
 *             （曖昧な依頼も質問で返さず、直近のやり取りを文脈に最良解釈で実装。
 *               追加メッセージは前の指示への「追加指示」として扱う。山根さん指示 2026-07-27）
 *           - 破壊的・事実変更・サーバ設定のみ → 実装せずLINEへ確認質問 → status=needs_clarification
 *                                   ＋ Slack DM(claude2 → 山根さん)で通知
 *
 * 使い方:
 *   node scripts/request-loop.mjs               通常実行
 *   node scripts/request-loop.mjs --dry-run     実装・push・LINE送信をせず、判定と文面だけ出す
 *   node scripts/request-loop.mjs --no-line     実装・pushはするがLINE送信はしない（文面はログ）
 *   node scripts/request-loop.mjs --no-push     実装はするが commit/push しない（差分を人が見る用）
 *   node scripts/request-loop.mjs --limit 1     1件だけ処理
 *
 * 安全弁（設計判断・根拠=山根さんの「可逆性×宛先」原理）:
 *   - 触ってよいのは bbq-site リポジトリ内のみ。
 *   - functions/ 配下、firebase.json、firestore.rules、*.plist、.env、secrets 類は自動修正の対象外。
 *     （サーバ側の挙動と権限に関わる変更は不可逆かつ影響範囲が読めないため、人間の判断に戻す）
 *   - 料金・思想に関わる文言、ページ削除、大量置換は自動実装しない。
 *   - 1回の実行で実装するのは最大2件（暴走時の被害を限定）。
 */
import { execFileSync, execSync } from "node:child_process";
import { accessSecret, gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(SCRIPTS, "..");
const LEDGER = path.join(SCRIPTS, "request-ledger.json");
const LOG = path.join(SCRIPTS, "request-run.log");
const SITE = "https://yoron-bbq.com";
const GCP_PROJECT = "cook-log-df240";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents`;
const SLACK_DM_USER = "U7XLRM33R"; // 山根さん

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const DRY_RUN = flag("--dry-run");
const NO_LINE = flag("--no-line") || DRY_RUN;
const NO_PUSH = flag("--no-push") || DRY_RUN;
const LIMIT = Number(opt("--limit") || 5);
const MAX_IMPLEMENT = 2;

// 自動修正を禁じるパス（前方一致 / 拡張子）
const FORBIDDEN = [
  "functions/", "firebase.json", "firestore.rules", "firestore.indexes.json",
  "storage.rules", ".firebaserc", ".github/", ".env", "firebase-config.js",
  "scripts/", ".gitignore",
];
const FORBIDDEN_EXT = [".plist", ".pem", ".key", ".json.enc"];

// ---------- ログ ----------
const logLines = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  try { fs.appendFileSync(LOG, logLines.join("\n") + "\n"); } catch {}
}

// ---------- claude ヘッドレス ----------
function claudeBin() {
  for (const p of [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}
function askClaude(prompt, { timeout = 900000, cwd = HOME, allowEdit = false } = {}) {
  const args = ["-p", prompt, "--model", "claude-opus-4-8"];
  if (allowEdit) args.push("--permission-mode", "acceptEdits");
  return execFileSync(claudeBin(), args, {
    encoding: "utf8", timeout, cwd, maxBuffer: 16 * 1024 * 1024,
  });
}
function parseJSON(out, what) {
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`${what}: JSONが見つからない`);
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- Firestore（REST / gcloud ADC） ----------
async function gcloudToken() {
  return gcpAccessToken();
}
async function fsFetch(url, init = {}) {
  const token = await gcloudToken();
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

async function fetchPending() {
  const body = {
    structuredQuery: {
      from: [{ collectionId: "site_requests" }],
      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
      limit: LIMIT,
    },
  };
  const rows = await fsFetch(`${FS_BASE}:runQuery`, { method: "POST", body: JSON.stringify(body) });
  return (rows || [])
    .filter((r) => r.document)
    .map((r) => {
      const f = r.document.fields || {};
      return {
        name: r.document.name,
        id: r.document.name.split("/").pop(),
        who: fsVal(f.who) || "不明",
        text: fsVal(f.text) || "",
        groupId: fsVal(f.groupId) || "",
        createdAt: fsVal(f.createdAt) || fsVal(f.timestamp) || "",
        stallNotifiedAt: fsVal(f.stallNotifiedAt) || "",
      };
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// 依頼者がLINEで送った参考写真（webhookが site_request_assets に保存）を直近24時間ぶん取得しローカルへ落とす
const BUCKET = "cook-log-df240.firebasestorage.app";
async function fetchRecentAssets(groupId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const body = {
    structuredQuery: {
      from: [{ collectionId: "site_request_assets" }],
      where: { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { stringValue: since } } },
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit: 8,
    },
  };
  const rows = await fsFetch(`${FS_BASE}:runQuery`, { method: "POST", body: JSON.stringify(body) });
  const dir = path.join(SCRIPTS, "tmp-assets");
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const r of rows || []) {
    if (!r.document) continue;
    const f = r.document.fields || {};
    if (groupId && fsVal(f.groupId) && fsVal(f.groupId) !== groupId) continue;
    const p = fsVal(f.path);
    if (!p) continue;
    const local = path.join(dir, path.basename(p));
    if (!fs.existsSync(local)) {
      const token = await gcloudToken();
      const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { log(`⚠️ 参考写真の取得失敗 ${res.status}: ${p}`); continue; }
      fs.writeFileSync(local, Buffer.from(await res.arrayBuffer()));
    }
    out.push({ local, who: fsVal(f.who), at: fsVal(f.createdAt) });
  }
  return out;
}

// グループの直近の会話ログ（メンションなしの発言・写真送信も含む）を古い順で取得
async function fetchGroupLog(groupId) {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const body = {
    structuredQuery: {
      from: [{ collectionId: "line_group_log" }],
      where: { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { stringValue: since } } },
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "DESCENDING" }],
      limit: 40,
    },
  };
  const rows = await fsFetch(`${FS_BASE}:runQuery`, { method: "POST", body: JSON.stringify(body) });
  return (rows || [])
    .filter((r) => r.document)
    .map((r) => r.document.fields || {})
    .filter((f) => !groupId || !fsVal(f.groupId) || fsVal(f.groupId) === groupId)
    .map((f) => ({ who: fsVal(f.who), text: fsVal(f.text), at: fsVal(f.createdAt) }))
    .reverse();
}
function formatGroupLog(msgs) {
  if (!msgs.length) return "（会話ログなし）";
  return msgs.map((m) => `[${(m.at || "").slice(5, 16)}] ${m.who}: ${m.text}`).join("\n");
}

async function setStatus(docName, status, extra = {}) {
  if (DRY_RUN) { log(`[dry-run] status=${status} にしない: ${docName.split("/").pop()}`); return; }
  const fields = { status: { stringValue: status }, processedAt: { stringValue: new Date().toISOString() } };
  for (const [k, v] of Object.entries(extra)) fields[k] = { stringValue: String(v).slice(0, 1500) };
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${k}`).join("&");
  await fsFetch(`https://firestore.googleapis.com/v1/${docName}?${mask}`, {
    method: "PATCH", body: JSON.stringify({ fields }),
  });
}

// ---------- LINE ----------
async function lineToken() {
  if (process.env.LINE_CHANNEL_TOKEN) return process.env.LINE_CHANNEL_TOKEN.trim();
  return accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN");
}
async function linePush(groupId, text) {
  // グループ投稿は「やまちゃんです！」と名乗る（あんちゃんのツボ・山根さん指示 2026-07-25）
  text = `やまちゃんです！\n${text}`;
  if (NO_LINE) { log(`[LINE未送信] to=${groupId || "(未取得)"}\n----\n${text}\n----`); return; }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${await lineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) log(`⚠️ LINE push失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  else log(`LINE送信: ${text.split("\n")[0]}`);
}

// ---------- Slack DM（claude2 bot → 山根さん） ----------
async function slackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN.trim();
  try {
    return await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN");
  } catch { return ""; }
}
async function slackDM(text) {
  const token = await slackToken();
  if (!token) { log("Slack DM: トークン未取得のためスキップ（要確認）"); return; }
  if (DRY_RUN) { log(`[dry-run] Slack DM: ${text.split("\n")[0]}`); return; }
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
    });
    const j = await res.json();
    if (!j.ok) log(`⚠️ Slack DM失敗: ${j.error}`);
  } catch (e) { log(`⚠️ Slack DM例外: ${e.message}`); }
}

// ---------- 台帳 ----------
function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, "utf8")); }
  catch { return { note: "LINE修正受付システムの処理台帳。同じ依頼を二度実装しないための重複防止も兼ねる。", items: [] }; }
}
function saveLedger(l) {
  if (DRY_RUN) return;
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n");
}

// ---------- 停滞通知（依頼者を絶対に無音で待たせない。山根さん指示 2026-07-30） ----------
// pending のまま処理を持ち越すとき、依頼者へ「受け取ってる・遅れてる」を1回だけLINEし、山根さんへSlack DM
async function stallNotice(req, why) {
  await slackDM(`⏳ YORON BBQ 修正依頼が停滞しています（pendingのまま持ち越し）\n依頼者: ${req.who}\n依頼: ${req.text.slice(0, 200)}\n理由: ${why}`);
  if (req.stallNotifiedAt) return; // LINEは1回だけ（10分ごとの再試行で連投しない）
  await linePush(req.groupId, `${nick(req.who)}、さっきの依頼ちゃんと受け取ってるよ！こっちの作業がちょっと詰まってて時間かかってる。直したら必ずここで報告するね、ごめん！`);
  if (DRY_RUN) return;
  try {
    await fsFetch(`https://firestore.googleapis.com/v1/${req.name}?updateMask.fieldPaths=stallNotifiedAt`, {
      method: "PATCH", body: JSON.stringify({ fields: { stallNotifiedAt: { stringValue: new Date().toISOString() } } }),
    });
    req.stallNotifiedAt = new Date().toISOString();
  } catch (e) { log(`⚠️ stallNotifiedAt 記録失敗: ${e.message.slice(0, 120)}`); }
}

// ---------- git ----------
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
function changedFiles() {
  return git("status", "--porcelain").split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
}
function isForbidden(f) {
  return FORBIDDEN.some((p) => f === p || f.startsWith(p)) || FORBIDDEN_EXT.some((e) => f.endsWith(e));
}

// ---------- 呼び名（LINE表示名→BBQ仲間のあだ名。山根さん指示 2026-07-25） ----------
function nick(who) {
  const s = String(who || "");
  if (/植田|うえたく|ueda|takuya/i.test(s)) return "うえたく";
  if (/あん|杏|anri|an-?chan/i.test(s)) return "あんちゃん";
  if (/yama|山根|やま/i.test(s)) return "やまちゃん";
  return s ? `${s}さん` : "";
}

// ---------- 所要時間の目安と実測（山根さん指示 2026-07-31: 拾ったら「今から実装するね＋目安◯分」、完了時に実測を報告） ----------
// 目安 = 台帳に記録された直近の実測(durationSec)の中央値。実測が溜まるほど正確になる
function estimateMinutes(ledger) {
  const ds = (ledger.items || []).map((i) => i.durationSec).filter((n) => typeof n === "number" && n > 0).slice(0, 10);
  if (!ds.length) return 8;
  const s = [...ds].sort((a, b) => a - b);
  return Math.max(2, Math.ceil(s[Math.floor(s.length / 2)] / 60));
}
function fmtDur(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}分${s}秒` : `${s}秒`;
}

// ---------- 共有コンテキストノート（ターミナル側セッションの調査結果を引き継ぐ・2026-07-31） ----------
const CONTEXT_NOTES = path.join(SCRIPTS, "context-notes.md");
function sharedNotesBlock() {
  try {
    const n = fs.readFileSync(CONTEXT_NOTES, "utf8").split("\n").slice(-80).join("\n").trim();
    return n ? `\n【共有コンテキスト — ターミナル側のClaude Codeセッションが既に調査・実装した結果。二重調査せず、これを前提に判断する】\n${n}\n` : "";
  } catch { return ""; }
}

// ---------- 直近のやり取り（文脈） ----------
// 追加メッセージを「前の指示への追加指示」として扱うため、台帳の直近項目をプロンプトに渡す
// （山根さん指示 2026-07-27: 質問で返さず、直前の依頼に上乗せして解釈する）
function recentContext(ledger, currentId) {
  const items = (ledger.items || []).filter((i) => i.id !== currentId).slice(0, 8).reverse();
  if (!items.length) return "（まだない）";
  return items.map((i) =>
    `- [${(i.at || "").slice(0, 16)}] ${i.who}: ${i.text}` +
    (i.decision === "auto" ? `\n  → 対応済み: ${i.note || ""}` : `\n  → まだ実装していない（当時は確認質問を返した）`)
  ).join("\n");
}

// ---------- 判定プロンプト ----------
function triagePrompt(req, fileList, context, groupLog = "（会話ログなし）") {
  return `あなたは YORON BBQ コミュニティサイト（${SITE} / 静的サイト・GitHub Pages）の保守担当です。
運営LINEグループに来た修正依頼を読み、対応方針を決めてください。

【依頼】
依頼者: ${req.who}
本文: ${req.text}

【直近のやり取り（古い順）】
${sharedNotesBlock()}
${context}

【グループの直近の会話ログ（メンションなしの雑談・写真送信も含む・古い順）】
${groupLog}
※依頼は単独メッセージではなく、この会話の流れの一部として人間のように読むこと。
  LINEの仕様で写真とテキストは別メッセージになるため、依頼の前後にある「（写真を1枚送った）」や
  補足の発言は、その依頼の一部（参考写真・追加説明）として扱う。

【リポジトリ直下のファイル】
${fileList}

【方針 — 原則はすべて auto（質問で返さない）】
- 依頼が曖昧でも、直近のやり取りとサイトの文脈から最も自然な解釈を自分で決めて auto にする。
  解釈は summary と interpretation に明記する（実装後に「こう直したよ」と報告し、違ったら直す運用）。
- 今回の依頼が直近のやり取りの続き・補足に見える場合は、独立した新依頼ではなく
  「前の指示への追加指示」として解釈する（前の指示内容＋今回の内容を合わせた一つの作業とみなす）。
- 「↑」「あれ、まだ？」「できてる？」「拾ってない？」のような短い催促・指摘は新しい依頼ではない。
  直近のやり取りで未実装・未対応になっている項目への再実行要求として扱い、その依頼内容を引き継いで判定する。
- 複数の解釈がある・対象が特定しきれない、は ask の理由にならない。決めて進める。

【skip にするもの — サイト修正の依頼ではないメッセージ】
- 雑談・冗談・共有だけのメッセージ、テスト投稿、「何もしなくていい」と明言されたもの
- 直前の依頼の取り消し（「さっきの取り消しといて」等）で、まだ実装していない場合
- サイトの修正では応えられない質問（登録状況の確認など運営側の確認事項）→ reason に内容を書く（Slackで山根さんに回る）

【例外 — ask にするのは次だけ】
- ページやセクションの削除
- 料金・日程・定員など「事実」の変更（依頼文だけでは真偽を確かめられない）
- YORON BBQ / SLOW FIRE の思想・コンセプトの根幹を書き換えるもの
- サーバ側（functions/）・設定・シークレットに関わるもの
- サイト全体に及ぶ大規模な変更

出力は次のJSONだけ（前置き・後書きなし）:
{
  "decision": "auto" | "ask" | "skip",
  "reason": "判定理由を1〜2文",
  "summary": "依頼の要約を1文（LINE報告に使う）",
  "interpretation": "autoのとき、曖昧さを自分でどう解釈したか1〜2文（直近のやり取りとの合流も含む）。明確な依頼なら空文字",
  "targets": ["変更対象と思われるファイル名"],
  "question": "askのとき、LINEでそのまま送れる確認質問。『〜という理解で合ってる？』の形で、具体案を1つ添える。口調は山根一城本人（常体・カジュアル・絵文字なし・感情は『！』で表す・短く要点から）。auto のときは空文字"
}`;
}

function implementPrompt(req, triage, context, assets = [], groupLog = "（会話ログなし）") {
  return `カレントディレクトリは YORON BBQ コミュニティサイトのリポジトリ（静的サイト / GitHub Pages / ${SITE}）です。
運営LINEグループから来た修正依頼を実装してください。

【依頼】${req.who} さん: ${req.text}
【要約】${triage.summary}
【解釈】${triage.interpretation || "（依頼どおり）"}
【直近のやり取り（古い順）— 今回の依頼が続き・補足の場合は前の指示と合わせて一つの作業として実装する】
${context}
${sharedNotesBlock()}
【想定対象】${(triage.targets || []).join(", ") || "（自分で特定してください）"}
${assets.length ? `【参考写真 — 依頼者がLINEで送った画像。Readツールで必ず見てから作業すること】\n${assets.map((a) => `- ${a.local}（${a.who} / ${a.at}）`).join("\n")}` : ""}
【グループの直近の会話ログ（古い順）— 依頼はこの流れの一部として読む。前後の発言・写真は依頼の補足】
${groupLog}

【サイト固有の知識】
- キャラクター（あんちゃん等）の絵は3箇所に分かれて存在する: ①anchan.js（吹き出し用マスコット）
  ②index.html内のインラインSVG（ヒーロー「anri-float」とチームイラスト「team-illust」）
  ③team.html内のインラインSVG（同じチームイラストが3回複製されている）。
  キャラの見た目を変える依頼では、grep で該当箇所を全て洗い出してから漏れなく直すこと（2026-07-27の修正漏れの教訓）。

【厳守】
- 変更してよいのはこのリポジトリ内のHTML/CSS/JS/画像参照など「サイトの見た目と文言」だけです。
- 次は絶対に触らないでください: functions/ 配下、firebase.json、firestore.rules、firestore.indexes.json、
  storage.rules、.firebaserc、.github/、firebase-config.js、scripts/ 配下、各種シークレット・トークン。
- ファイルの新規作成・削除はしないでください（依頼が明確に既存ファイルの編集で済む範囲のはずです）。
- 依頼の範囲を超えた「ついでのリファクタ・整理」はしないでください。
- 既存のトーン（です・ます基調、絵文字は本文に使わない）を崩さないでください。
- git のコミット・push はしないでください（呼び出し側が行います）。

実装が終わったら、最後に次のJSONだけを出力してください:
{ "done": true, "files": ["変更したファイル"], "note": "何をどう変えたかを1〜2文。LINE報告にそのまま使うので、口調は山根一城本人（常体・カジュアル・絵文字なし・例:『トップの料金表記を5,000円に直しておいた！』）" }
実装できなかった場合は { "done": false, "note": "できなかった理由" } を出力してください。`;
}

// 実装後・push前の独立検証（2026-07-27 修正漏れ事故の再発防止）
// 実装者とは別のclaude呼び出しが「依頼に対して差分が完全か」を検証し、漏れがあれば1回だけ自動リペア
function verifyPrompt(req, triage, diff) {
  return `あなたは検証者です。実装者とは独立した目で、修正依頼に対して差分が「完全」かを判定してください。
カレントディレクトリは YORON BBQ コミュニティサイトのリポジトリです。

【依頼】${req.who} さん: ${req.text}
【実装者の解釈】${triage.interpretation || triage.summary}
【今回の差分（git diff）】
${diff}

【検証の観点】
- 依頼が「全て」「全部」等の網羅を求めている場合、対象がリポジトリ内の他の場所（別ファイル・インラインSVG・
  複製されたマークアップ）にも存在しないか、grep 等で必ず確認すること。差分に含まれない残存箇所が命取り。
- 依頼された変更が差分に実際に含まれているか（コメントだけ・一部だけになっていないか）。

出力は次のJSONだけ:
{ "complete": true | false, "missing": "漏れの内容と箇所を具体的に（completeなら空文字）" }`;
}

// ---------- 1件処理 ----------
async function handle(req, ledger, state) {
  log(`--- 依頼 ${req.id} / ${req.who}: ${req.text.slice(0, 80)}`);

  // 実装済み(auto)・スキップ済み(skip)のみ重複扱い。ask（旧・質問返し）は再処理してよい
  if (ledger.items.some((i) => i.id === req.id && i.decision !== "ask")) {
    log("台帳に処理済み記録あり。スキップして status を締めます");
    await setStatus(req.name, "done", { note: "台帳に処理済み記録あり（重複）" });
    return;
  }

  const fileList = fs.readdirSync(ROOT).filter((f) => !f.startsWith(".") && f !== "node_modules").join(", ");
  const context = recentContext(ledger, req.id);
  let groupLog = "（会話ログなし）";
  try { groupLog = formatGroupLog(await fetchGroupLog(req.groupId)); }
  catch (e) { log(`⚠️ 会話ログ取得でエラー（ログなしで続行）: ${e.message.slice(0, 120)}`); }
  let triage;
  try {
    triage = parseJSON(askClaude(triagePrompt(req, fileList, context, groupLog), { timeout: 300000 }), "triage");
  } catch (e) {
    log(`⚠️ 判定に失敗: ${e.message}`);
    await stallNotice(req, `依頼内容の判定(claude)に失敗: ${e.message.slice(0, 200)}`);
    return; // pending のまま次回に持ち越し
  }
  log(`判定: ${triage.decision} — ${triage.reason}`);

  // ---- 修正依頼ではない（雑談・テスト・取り消し等）→ 黙って閉じる ----
  if (triage.decision === "skip") {
    log(`skip: ${triage.reason}`);
    await slackDM(`💬 YORON BBQ: 修正依頼ではないと判断してスキップしました\n${req.who}: ${req.text.slice(0, 120)}\n理由: ${triage.reason}`);
    await setStatus(req.name, "dismissed", { note: triage.reason });
    ledger.items.unshift({ id: req.id, at: new Date().toISOString(), who: req.who, text: req.text.slice(0, 200), decision: "skip", reason: triage.reason });
    return;
  }

  // ---- 確認が必要 ----
  if (triage.decision !== "auto") {
    const q = triage.question || `「${triage.summary}」の件、こっちで判断しきれないところがあった！もう少し具体的に教えてもらっていい？`;
    await linePush(req.groupId, `${nick(req.who)}、ありがとう！\n${q}`);
    await slackDM(`🔥 YORON BBQ サイト修正依頼が確認待ちです\n依頼者: ${req.who}\n依頼: ${req.text}\n理由: ${triage.reason}\nLINEに投げた質問: ${q}`);
    await setStatus(req.name, "needs_clarification", { note: triage.reason, question: q });
    ledger.items.unshift({ id: req.id, at: new Date().toISOString(), who: req.who, text: req.text.slice(0, 200), decision: "ask", reason: triage.reason });
    return;
  }

  // ---- 自動実装 ----
  if (state.implemented >= MAX_IMPLEMENT) {
    log(`このrunの実装上限(${MAX_IMPLEMENT}件)に達したため次回へ持ち越し`);
    const ageMin = req.createdAt ? (Date.now() - Date.parse(req.createdAt)) / 60000 : 0;
    if (ageMin > 30) await stallNotice(req, `実装上限による持ち越しが続き受付から${Math.round(ageMin)}分経過`);
    return;
  }
  if (DRY_RUN) {
    log(`[dry-run] ここで実装します → ${implementPrompt(req, triage).slice(0, 200)}...`);
    return;
  }

  // 作業前にツリーがきれいか確認（他作業の巻き込みcommitを防ぐ）
  // ループ自身が生む台帳・ログ類は自動コミットして進む（2026-07-30 ANRIさん依頼が数時間止まった事故の再発防止）
  const isLoopOwned = (f) => f.startsWith("scripts/") && (f.endsWith("-ledger.json") || f.endsWith("-queue.json") || f.endsWith(".log"));
  let dirtyBefore = changedFiles();
  if (dirtyBefore.length && dirtyBefore.every(isLoopOwned)) {
    log(`ループ台帳の未コミット変更を自動コミット: ${dirtyBefore.join(", ")}`);
    git("add", ...dirtyBefore);
    git("commit", "-m", "ループ台帳の自動コミット（request-loop）");
    try { git("push"); } catch (e) { log(`⚠️ 台帳pushに失敗（続行）: ${e.message.slice(0, 120)}`); }
    dirtyBefore = changedFiles();
  }
  if (dirtyBefore.length) {
    log(`⚠️ 要確認: 作業ツリーに未コミットの変更があります（${dirtyBefore.join(", ")}）。安全のため今回は実装しません`);
    await stallNotice(req, `作業ツリーに未コミットの変更があり実装を保留: ${dirtyBefore.join(", ")}`);
    return;
  }

  let assets = [];
  try { assets = await fetchRecentAssets(req.groupId); } catch (e) { log(`⚠️ 参考写真の取得でエラー（写真なしで続行）: ${e.message.slice(0, 120)}`); }
  if (assets.length) log(`参考写真 ${assets.length}件をローカルに用意`);

  // 依頼が写真を参照しているのに、依頼の前後10分〜以降の写真がまだ届いていなければ最大30分待つ
  // （LINEの仕様で写真とテキストが別メッセージになるタイムラグ対策。2026-07-30 山根さん指示）
  if (/写真|画像|添付|イメージ/.test(req.text)) {
    const reqAt = Date.parse(req.createdAt || "") || Date.now();
    const hasFreshPhoto = assets.some((a) => Date.parse(a.at || "") >= reqAt - 10 * 60 * 1000);
    const ageMin = (Date.now() - reqAt) / 60000;
    if (!hasFreshPhoto && ageMin < 30) {
      log(`写真待ち: 依頼が画像を参照しているが未着（受付から${Math.round(ageMin)}分）。次回に持ち越し`);
      return;
    }
  }

  // 拾った合図＋目安（依頼者を無音で待たせない三段構えの先頭。目安は過去実測の中央値）
  const workStart = Date.now();
  const estMin = estimateMinutes(ledger);
  await linePush(req.groupId, `${nick(req.who)}、依頼拾ったよ！「${triage.summary}」だね。今から直すね、目安${estMin}分くらい。終わったらまたここで報告する！`);

  let impl;
  try {
    impl = parseJSON(askClaude(implementPrompt(req, triage, context, assets, groupLog), { timeout: 900000, cwd: ROOT, allowEdit: true }), "implement");
  } catch (e) {
    log(`⚠️ 実装に失敗: ${e.message}`);
    try { git("checkout", "--", "."); } catch {}
    await linePush(req.groupId, `${nick(req.who)}、ごめん！「${triage.summary}」の自動修正がうまくいかなかった。あとで俺が手で見るね`);
    await slackDM(`⚠️ YORON BBQ 自動修正が失敗しました\n依頼: ${req.text}\nエラー: ${e.message.slice(0, 300)}`);
    await setStatus(req.name, "needs_clarification", { note: `自動実装に失敗: ${e.message}`.slice(0, 500) });
    return;
  }

  const files = changedFiles();
  if (!impl.done || files.length === 0) {
    log(`実装なし（${impl.note || "変更ファイルなし"}）`);
    try { git("checkout", "--", "."); } catch {}
    await linePush(req.groupId, `${nick(req.who)}、「${triage.summary}」の件、こっちで直す箇所をうまく特定できなかったから、あとで俺が直接見るね！`);
    await slackDM(`⚠️ YORON BBQ 自動修正で箇所を特定できず（手対応が必要です）\n依頼: ${req.text}\nメモ: ${impl.note || "変更ファイルなし"}`);
    await setStatus(req.name, "needs_clarification", { note: impl.note || "変更ファイルなし" });
    return;
  }

  // 独立検証: 修正漏れがあれば1回だけ自動リペア（それでも漏れたらSlackで報告して人に戻す）
  try {
    const diff = git("diff").slice(0, 12000);
    const v = parseJSON(askClaude(verifyPrompt(req, triage, diff), { timeout: 300000, cwd: ROOT }), "verify");
    if (!v.complete && v.missing) {
      log(`検証NG（リペア実行）: ${v.missing.slice(0, 200)}`);
      const repair = `${implementPrompt(req, triage, context, assets, groupLog)}\n\n【検証者が見つけた修正漏れ — これを必ず直してください】\n${v.missing}`;
      impl = parseJSON(askClaude(repair, { timeout: 900000, cwd: ROOT, allowEdit: true }), "repair");
      const v2 = parseJSON(askClaude(verifyPrompt(req, triage, git("diff").slice(0, 12000)), { timeout: 300000, cwd: ROOT }), "verify2");
      if (!v2.complete && v2.missing) {
        log(`⚠️ リペア後も検証NG。実装分は破棄して人に戻します: ${v2.missing.slice(0, 200)}`);
        git("checkout", "--", "."); try { execSync("git clean -fd", { cwd: ROOT }); } catch {}
        await linePush(req.groupId, `${nick(req.who)}、「${triage.summary}」の件、ちゃんと直しきれてる自信がなかったから、あとで俺が直接見るね！`);
        await slackDM(`⚠️ YORON BBQ 自動修正が検証を2回通らず破棄（手対応が必要です）\n依頼: ${req.text}\n漏れ: ${v2.missing.slice(0, 400)}`);
        await setStatus(req.name, "needs_clarification", { note: `検証NG: ${v2.missing}`.slice(0, 500) });
        return;
      }
      log("リペア後の検証OK");
    } else {
      log("検証OK（漏れなし）");
    }
  } catch (e) {
    log(`⚠️ 検証ステップでエラー（実装は破棄せず続行）: ${e.message.slice(0, 150)}`);
  }
  const filesAfterVerify = changedFiles();

  const bad = filesAfterVerify.filter(isForbidden);
  if (bad.length) {
    log(`⚠️ 禁止パスに変更が出たため全て破棄: ${bad.join(", ")}`);
    git("checkout", "--", ".");
    try { execSync("git clean -fd", { cwd: ROOT }); } catch {}
    await slackDM(`⛔ YORON BBQ 自動修正が禁止パスに触れたため破棄しました\n依頼: ${req.text}\n対象: ${bad.join(", ")}`);
    await setStatus(req.name, "needs_clarification", { note: `禁止パスに変更: ${bad.join(", ")}` });
    return;
  }

  log(`変更ファイル: ${filesAfterVerify.join(", ")}`);
  if (NO_PUSH) {
    log(`[--no-push] commit/push はしません。差分を確認してください:\n${git("diff", "--stat")}`);
    log(`[LINE送信予定の文面]\n${nick(req.who)}、直したよ！\n${impl.note || triage.summary}\n${SITE}/`);
    return;
  }
  git("add", "-A");
  git("commit", "-m", `LINE修正依頼: ${triage.summary}`.slice(0, 100));
  git("push");
  state.implemented += 1;
  log("push完了。本番反映を待ちます");

  // 本番200確認（GitHub Pagesの反映を待つ）
  const page = (filesAfterVerify.find((f) => f.endsWith(".html")) || "index.html").replace(/^\.\//, "");
  const url = `${SITE}/${page === "index.html" ? "" : page}`;
  let ok = false;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 20000));
    try {
      const res = await fetch(url, { method: "GET", cache: "no-store" });
      if (res.ok) { ok = true; break; }
    } catch {}
  }
  log(ok ? `本番200確認: ${url}` : `⚠️ 要確認: ${url} の200を確認できませんでした（反映待ちの可能性）`);

  const durationSec = Math.round((Date.now() - workStart) / 1000);
  await linePush(req.groupId,
    `${nick(req.who)}、直したよ！\n${impl.note || triage.summary}\n${url}` +
    (ok ? "" : "\n（反映まで数分かかるかも）") +
    `\n今回かかった時間: ${fmtDur(durationSec)}（目安は${estMin}分って言ってたやつ）` +
    (triage.interpretation ? "\nイメージと違ったら言ってね、また直すよ！" : ""));
  await setStatus(req.name, "done", { note: impl.note || triage.summary, files: filesAfterVerify.join(", "), url, durationSec });
  ledger.items.unshift({
    id: req.id, at: new Date().toISOString(), who: req.who, text: req.text.slice(0, 200),
    decision: "auto", files: filesAfterVerify, url, note: impl.note || "", durationSec, estimatedMin: estMin,
  });
}

// ---------- main ----------
async function main() {
  const pending = await fetchPending();
  if (!pending.length) { log(`pending なし${DRY_RUN ? "（dry-run）" : ""}`); flushLog(); return; }
  log(`pending ${pending.length}件`);

  const ledger = loadLedger();
  const state = { implemented: 0 };
  for (const req of pending) {
    try { await handle(req, ledger, state); }
    catch (e) {
      log(`⚠️ ${req.id} の処理で例外: ${e.stack || e.message}`);
      try { await stallNotice(req, `処理中の例外: ${String(e.message || e).slice(0, 200)}`); } catch {}
    }
  }
  ledger.items = ledger.items.slice(0, 300);
  saveLedger(ledger);
  flushLog();
}

main().catch((e) => { log(`⚠️ 異常終了: ${e.stack || e.message}`); flushLog(); process.exit(1); });
