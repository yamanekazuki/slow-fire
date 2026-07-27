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
function gcloudToken() {
  return execFileSync("gcloud", ["auth", "print-access-token", `--project=${GCP_PROJECT}`], {
    encoding: "utf8",
  }).trim();
}
async function fsFetch(url, init = {}) {
  const token = gcloudToken();
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
      };
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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
function lineToken() {
  if (process.env.LINE_CHANNEL_TOKEN) return process.env.LINE_CHANNEL_TOKEN.trim();
  return execFileSync("gcloud", [
    "secrets", "versions", "access", "latest", "--secret=LINE_CHANNEL_TOKEN", `--project=${GCP_PROJECT}`,
  ], { encoding: "utf8" }).trim();
}
async function linePush(groupId, text) {
  // グループ投稿は「やまちゃんです！」と名乗る（あんちゃんのツボ・山根さん指示 2026-07-25）
  text = `やまちゃんです！\n${text}`;
  if (NO_LINE) { log(`[LINE未送信] to=${groupId || "(未取得)"}\n----\n${text}\n----`); return; }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${lineToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) log(`⚠️ LINE push失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  else log(`LINE送信: ${text.split("\n")[0]}`);
}

// ---------- Slack DM（claude2 bot → 山根さん） ----------
function slackToken() {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN.trim();
  try {
    return execFileSync("gcloud", [
      "secrets", "versions", "access", "latest",
      "--secret=SLACK_BOT_TOKEN", "--project=foward-deployed-pm",
    ], { encoding: "utf8" }).trim();
  } catch { return ""; }
}
async function slackDM(text) {
  const token = slackToken();
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
function triagePrompt(req, fileList, context) {
  return `あなたは YORON BBQ コミュニティサイト（${SITE} / 静的サイト・GitHub Pages）の保守担当です。
運営LINEグループに来た修正依頼を読み、対応方針を決めてください。

【依頼】
依頼者: ${req.who}
本文: ${req.text}

【直近のやり取り（古い順）】
${context}

【リポジトリ直下のファイル】
${fileList}

【方針 — 原則はすべて auto（質問で返さない）】
- 依頼が曖昧でも、直近のやり取りとサイトの文脈から最も自然な解釈を自分で決めて auto にする。
  解釈は summary と interpretation に明記する（実装後に「こう直したよ」と報告し、違ったら直す運用）。
- 今回の依頼が直近のやり取りの続き・補足に見える場合は、独立した新依頼ではなく
  「前の指示への追加指示」として解釈する（前の指示内容＋今回の内容を合わせた一つの作業とみなす）。
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

function implementPrompt(req, triage, context) {
  return `カレントディレクトリは YORON BBQ コミュニティサイトのリポジトリ（静的サイト / GitHub Pages / ${SITE}）です。
運営LINEグループから来た修正依頼を実装してください。

【依頼】${req.who} さん: ${req.text}
【要約】${triage.summary}
【解釈】${triage.interpretation || "（依頼どおり）"}
【直近のやり取り（古い順）— 今回の依頼が続き・補足の場合は前の指示と合わせて一つの作業として実装する】
${context}
【想定対象】${(triage.targets || []).join(", ") || "（自分で特定してください）"}

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
  let triage;
  try {
    triage = parseJSON(askClaude(triagePrompt(req, fileList, context), { timeout: 300000 }), "triage");
  } catch (e) {
    log(`⚠️ 判定に失敗: ${e.message}`);
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
    return;
  }
  if (DRY_RUN) {
    log(`[dry-run] ここで実装します → ${implementPrompt(req, triage).slice(0, 200)}...`);
    return;
  }

  // 作業前にツリーがきれいか確認（他作業の巻き込みcommitを防ぐ）
  const dirtyBefore = changedFiles();
  if (dirtyBefore.length) {
    log(`⚠️ 要確認: 作業ツリーに未コミットの変更があります（${dirtyBefore.join(", ")}）。安全のため今回は実装しません`);
    return;
  }

  let impl;
  try {
    impl = parseJSON(askClaude(implementPrompt(req, triage, context), { timeout: 900000, cwd: ROOT, allowEdit: true }), "implement");
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

  const bad = files.filter(isForbidden);
  if (bad.length) {
    log(`⚠️ 禁止パスに変更が出たため全て破棄: ${bad.join(", ")}`);
    git("checkout", "--", ".");
    try { execSync("git clean -fd", { cwd: ROOT }); } catch {}
    await slackDM(`⛔ YORON BBQ 自動修正が禁止パスに触れたため破棄しました\n依頼: ${req.text}\n対象: ${bad.join(", ")}`);
    await setStatus(req.name, "needs_clarification", { note: `禁止パスに変更: ${bad.join(", ")}` });
    return;
  }

  log(`変更ファイル: ${files.join(", ")}`);
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
  const page = (files.find((f) => f.endsWith(".html")) || "index.html").replace(/^\.\//, "");
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

  await linePush(req.groupId,
    `${nick(req.who)}、直したよ！\n${impl.note || triage.summary}\n${url}` +
    (ok ? "" : "\n（反映まで数分かかるかも）") +
    (triage.interpretation ? "\nイメージと違ったら言ってね、また直すよ！" : ""));
  await setStatus(req.name, "done", { note: impl.note || triage.summary, files: files.join(", "), url });
  ledger.items.unshift({
    id: req.id, at: new Date().toISOString(), who: req.who, text: req.text.slice(0, 200),
    decision: "auto", files, url, note: impl.note || "",
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
    catch (e) { log(`⚠️ ${req.id} の処理で例外: ${e.stack || e.message}`); }
  }
  ledger.items = ledger.items.slice(0, 300);
  saveLedger(ledger);
  flushLog();
}

main().catch((e) => { log(`⚠️ 異常終了: ${e.stack || e.message}`); flushLog(); process.exit(1); });
