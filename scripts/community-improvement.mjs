// =============================================================================
// YORON BBQコミュニティ — サイト改善レポート（分析 → 改善提案TOP3 → メール）
// -----------------------------------------------------------------------------
// SLOW FIRE の読み物（blog-improvement.mjs）と同じ形で、コミュニティサイト（yoron-bbq.com）の
// 28日間のPV・流入・検索の言葉を集め、Claudeが「どのページをどう直すか」の改善提案TOP3を作る。
// 2026-10-29 山根さん「YORONバーベキューのコミュニティのサイトも同じようにやってほしい」。
// 第1段階＝提案メールまで。自動実装（軽い直しは自動・入会/申込フォームは承認制）は第2段階で足す。
// メール送信はワークフロー側（dawidd6/action-send-mail）が担当。
//
// 必要な環境変数（GitHub Secrets）:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントのJSONキー全文（必須）
//   ANTHROPIC_API_KEY           … Claude APIキー（必須）
//   COMMUNITY_GA4_PROPERTY_ID   … 省略時 543026880（yoron-bbq.com だけが入っている箱）
//   COMMUNITY_SC_SITE_URL       … Search Consoleプロパティ（省略時 https://yoron-bbq.com/）
//   COMMUNITY_MODEL             … 使用モデル（省略時 claude-opus-5-5）
// 必須シークレットが無いときは、何もせず正常終了（ready=false）する。
// =============================================================================

import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SITES, range, aboutBox } from "./lib/report-period.mjs";

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.COMMUNITY_GA4_PROPERTY_ID || "543026880";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const SC_SITE = process.env.COMMUNITY_SC_SITE_URL || "https://yoron-bbq.com/";
const MODEL = process.env.COMMUNITY_MODEL || "claude-opus-5-5";
const SITEMAP_URL = "https://yoron-bbq.com/sitemap.xml";
const GA4_LINK = process.env.GA4_DASHBOARD_URL || "https://analytics.google.com/";
// 念のため hostName でも絞る（箱には yoron-bbq.com しか入っていないが、ローカル確認の 127.0.0.1 等を除く）
const HOST = "yoron-bbq.com";
function setOutput(pairs) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) {
    for (const [k, v] of Object.entries(pairs)) {
      if (k !== "html") console.log(`OUTPUT ${k}=${String(v).slice(0, 120)}`);
    }
    return;
  }
  let body = "";
  for (const [k, v] of Object.entries(pairs)) body += `${k}<<RPTEOF\n${v}\nRPTEOF\n`;
  appendFileSync(f, body);
}

// テストから部品だけ読み込めるよう、直接実行したときだけ動かす
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || "").href;

if (IS_MAIN && (!SA_JSON || !PROPERTY || !API_KEY)) {
  console.log("未設定（GOOGLE_SERVICE_ACCOUNT_JSON / ANTHROPIC_API_KEY）。スキップします。");
  setOutput({ ready: "false" });
  process.exit(0);
}

// ---- 認証（サービスアカウントJWT → アクセストークン）-------------------------
function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function getAccessToken(creds, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(creds.private_key);
  const jwt = `${unsigned}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token取得失敗 ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ---- API 呼び出し ------------------------------------------------------------
async function ga4RunReport(token, requestBody) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) throw new Error(`GA4 ${res.status}: ${await res.text()}`);
  return res.json();
}
async function scQuery(token, requestBody, site = SC_SITE) {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );
  if (!res.ok) throw new Error(`SC ${res.status}: ${await res.text()}`);
  return res.json();
}

// yoron-bbq.com だけに絞る GA4 dimensionFilter
const hostFilter = {
  filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: HOST } },
};

// ---- Claude（structured output / 依存ゼロ）-----------------------------------
const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "コミュニティサイト全体の現状を2〜3文で。前期比の主因と、いま一番の課題を率直に。サイトに詳しくない人が読んでも一度で分かる日本語で書く（CTR→クリックされた割合、KW→検索された言葉、Organic Search→Google検索から、のように英語・専門用語は言い換える）。「直近28日」等の期間の言葉は書かない（メール側で実日付を出す）。",
    },
    proposals: {
      type: "array",
      description: "優先度順の改善提案。最大3件。実装できる粒度で具体的に。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "提案の見出し（具体的に）" },
          priority: { type: "string", enum: ["高", "中", "低"] },
          effort: { type: "string", description: "実装規模（小／中／大）" },
          target: {
            type: "string",
            description: "対象ページのURLまたはパス。新しいページの提案なら『新規ページ』と書く",
          },
          rootCause: { type: "string", description: "数値から推定した根本原因（ファネルのどの段階で何が起きているか）" },
          change: { type: "string", description: "何をどう変えるか。find/replaceで実装できる粒度で。タイトル・見出し・導入文・ボタンの文言・内部リンク等を具体的に" },
          expectedLift: { type: "string", description: "どの指標がどの方向にどれくらい動く見込みか（仮説でよいが対象KWや数値に紐づける）" },
          impact: { type: "string", description: "期待できる効果と、その根拠になっている数値（表示回数・順位・CTR等）" },
          selfCheck: { type: "string", description: "本当に効くか／安全に実装できるかの自己評価。懸念があれば正直に書く" },
        },
        required: ["title", "priority", "effort", "target", "rootCause", "change", "expectedLift", "impact", "selfCheck"],
      },
    },
  },
  required: ["summary", "proposals"],
};

async function callClaude(system, userMsg, schema) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system,
      output_config: { effort: "high", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("Claude が応答を拒否しました。");
  const t = (data.content || []).find((b) => b.type === "text");
  if (!t) throw new Error("テキストブロックなし");
  return JSON.parse(t.text);
}

// ---- 整形ヘルパ --------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function num(n) {
  return Number(n || 0).toLocaleString("ja-JP");
}
function pct(n) {
  return `${(Number(n || 0) * 100).toFixed(1)}%`;
}
const C = { ink: "#1b1b1b", sub: "#666", line: "#ececec", fire: "#c2410c", warm: "#B45309", bg: "#fff" };
const PRI = {
  高: { bg: "#fef2f2", bd: "#fecaca", fg: "#b91c1c" },
  中: { bg: "#fffbeb", bd: "#fde68a", fg: "#b45309" },
  低: { bg: "#f0fdf4", bd: "#bbf7d0", fg: "#15803d" },
};

// 第1段階は提案メールまで（承認ボタン・自動実装は第2段階で足す）
function actionButtons() {
  return "";
}

function proposalCard(p, i, auto) {
  const s = PRI[p.priority] || { bg: "#f8fafc", bd: "#e2e8f0", fg: "#475569" };
  const row = (label, val) =>
    val
      ? `<tr><td style="padding:5px 0;font-size:11px;font-weight:800;color:${C.sub};white-space:nowrap;vertical-align:top;width:64px">${label}</td>
         <td style="padding:5px 0 5px 10px;font-size:13px;color:${C.ink};line-height:1.7">${esc(val)}</td></tr>`
      : "";
  return `<div style="border:1px solid ${s.bd};background:${s.bg};border-radius:12px;padding:16px 18px;margin-bottom:14px">
    <div style="margin-bottom:8px">
      <span style="display:inline-block;background:${s.fg};color:#fff;font-size:10.5px;font-weight:800;padding:3px 9px;border-radius:999px">優先度 ${esc(p.priority || "-")}</span>
      <span style="font-size:10.5px;color:#94a3b8;margin-left:6px">実装規模：${esc(p.effort || "-")}</span>
    </div>
    <div style="font-size:15px;font-weight:900;color:#0f172a;line-height:1.5;margin-bottom:10px">${i + 1}. ${esc(p.title || "")}</div>
    <table style="width:100%;border-collapse:collapse">
      ${row("対象", p.target)}
      ${row("変更内容", p.change)}
      ${row("期待効果", p.impact)}
    </table>
    ${actionButtons(p, auto)}
  </div>`;
}

// 期間ごとの数字の定義（GA4の nDaysAgo で数える。1daysAgo＝昨日）
const PERIOD_DEFS = [
  { key: "d7", name: "直近7日", from: 7, to: 1 },
  { key: "p7", name: "その前の7日", from: 14, to: 8 },
  { key: "d28", name: "直近28日", from: 28, to: 1 },
  { key: "p28", name: "その前の28日", from: 56, to: 29 },
];
const PERIOD_METRICS = [
  { key: "screenPageViews", label: "見られた回数（PV）", fmt: (v) => num(v) },
  { key: "totalUsers", label: "見た人の数（UU）", fmt: (v) => num(v) },
  { key: "newUsers", label: "初めて来た人", fmt: (v) => num(v) },
  { key: "sessions", label: "訪問の回数", fmt: (v) => num(v) },
  { key: "screenPageViewsPerSession", label: "1回の訪問で見たページ数", fmt: (v) => v.toFixed(1) },
  { key: "averageSessionDuration", label: "1回の訪問の平均時間", fmt: (v) => fmtDuration(v) },
  { key: "engagementRate", label: "じっくり見た割合", fmt: (v) => pct(v) },
];
const GOALS = [
  { key: "member_join", label: "入会" },
  { key: "event_register", label: "BBQの申込" },
  { key: "form_start", label: "申込フォームを開いた" },
];
const CHANNEL_JA = {
  "Organic Search": "Google等の検索", Direct: "直接（ブックマーク・URL入力・LINE内など）", Referral: "他のサイトのリンク",
  "Organic Social": "SNS", Unassigned: "不明", "Paid Search": "検索広告", Email: "メール", "Organic Video": "動画", "AI Assistant": "AI（ChatGPT等）",
};
const DEVICE_JA = { mobile: "スマホ", desktop: "パソコン", tablet: "タブレット" };

// ---- 純関数（テスト対象）-----------------------------------------------------
export function sitemapUrls(xml) {
  return [...String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
}

export function monthLabel(ym) {
  return `${String(ym).slice(0, 4)}年${Number(String(ym).slice(4, 6))}月`;
}

// GA4の isoYearIsoWeek（例 202643）→「10/19〜10/25」。最後の週は昨日（end）で切る
export function weekLabel(yw, end) {
  const y = Number(String(yw).slice(0, 4));
  const w = Number(String(yw).slice(4));
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const mon = new Date(jan4.getTime() + (-((jan4.getUTCDay() + 6) % 7) + (w - 1) * 7) * 86400000);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const f = (d) => `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  const last = end && sun.toISOString().slice(0, 10) > end ? new Date(`${end}T00:00:00Z`) : sun;
  return `${f(mon)}〜${f(last)}`;
}

// 直近8週（今週の途中まで含む）の始まり＝7週前の月曜。週の途中から数えて端数の週ができないようにする
export function weeksStart(yesterday, n = 8) {
  const d = new Date(`${yesterday}T00:00:00Z`);
  const mon = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000 - (n - 1) * 7 * 86400000);
  return mon.toISOString().slice(0, 10);
}

// 同じ名前のページ（/ と /index.html など）が並ぶときは住所を添えて見分けられるようにする
export function pageNames(pages) {
  const count = {};
  for (const p of pages) count[p.title] = (count[p.title] || 0) + 1;
  return pages.map((p) => (!p.title ? p.path : count[p.title] > 1 ? `${p.title}（${p.path}）` : p.title));
}

// Search Console の登録一覧から、このサイトの登録を選ぶ（URL型 → ドメイン型 → www付き の順）
export function pickScSite(sites, host, preferred) {
  const want = [preferred, `https://${host}/`, `sc-domain:${host}`, `https://www.${host}/`, `http://${host}/`].filter(Boolean);
  return want.find((w) => sites.includes(w)) || null;
}

const SOURCE_JA = {
  google: "Google", "(direct)": "直接（ブックマーク・URL入力・LINE内など）", yahoo: "Yahoo!", bing: "Bing",
  "l.instagram.com": "Instagram", "instagram.com": "Instagram", "m.facebook.com": "Facebook", "line.me": "LINE",
  "chatgpt.com": "ChatGPT", "t.co": "X（旧Twitter）", "(not set)": "不明", "l.facebook.com": "Facebook",
  "an-bbq": "SLOW FIRE", "an-bbq.jp": "SLOW FIRE", "yoron-bbq.web.app": "与論島ガイド",
  "firebasestorage.googleapis.com": "ネットに置いたファイル（チラシ・PDF等）のリンク",
};
export function sourceName(src) {
  if (!SOURCE_JA[src]) return src;
  return src.startsWith("(") ? SOURCE_JA[src] : `${SOURCE_JA[src]}（${src}）`;
}

export function fmtDuration(sec) {
  const t = Math.round(Number(sec) || 0);
  return t >= 60 ? `${Math.floor(t / 60)}分${t % 60}秒` : `${t}秒`;
}

const TH = `style="font-size:11px;color:#666;font-weight:700;padding:6px 4px;border-bottom:1px solid #ececec;white-space:nowrap"`;
const TD = `style="font-size:12px;padding:6px 4px;border-bottom:1px solid #ececec"`;

export function simpleTable(head, rows) {
  if (!rows.length) return `<div style="color:#999;font-size:13px;padding:8px 0">データなし</div>`;
  const th = head.map((h, i) => `<td ${TH}${i ? ' align="right"' : ""}>${esc(h)}</td>`).join("");
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td ${TD}${i ? ' align="right"' : ""}>${esc(String(c))}</td>`).join("")}</tr>`).join("");
  return `<table role="presentation" width="100%" style="border-collapse:collapse"><tr>${th}</tr>${tr}</table>`;
}

// 行＝数字の種類、列＝期間。前の期間との増減は「直近7日」「直近28日」の列に添える
export function periodTable(periods, goals, labels) {
  const chg = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0);
  const tag = (a, b) => {
    const d = chg(a, b);
    return `<div style="font-size:10px;color:${d > 0 ? "#16a34a" : d < 0 ? "#dc2626" : "#999"}">${d > 0 ? "▲" : d < 0 ? "▼" : "±"}${Math.abs(d)}%</div>`;
  };
  const head = `<tr><td ${TH}></td>${PERIOD_DEFS.map((d) => `<td ${TH} align="right">${esc(d.name)}<div style="font-weight:400;font-size:10px">${esc(labels[d.key] || "")}</div></td>`).join("")}</tr>`;
  const row = (label, get, fmt) => `<tr><td ${TD}>${esc(label)}</td>${PERIOD_DEFS.map((d) => {
    const v = get(d.key);
    const cmp = d.key === "d7" ? tag(v, get("p7")) : d.key === "d28" ? tag(v, get("p28")) : "";
    return `<td ${TD} align="right"><b>${esc(fmt(v))}</b>${cmp}</td>`;
  }).join("")}</tr>`;
  const body = [
    ...PERIOD_METRICS.map((m) => row(m.label, (k) => (periods[k] || {})[m.key] || 0, m.fmt)),
    ...GOALS.map((g) => row(g.label, (k) => (goals[k] || {})[g.key] || 0, (v) => num(v))),
  ].join("");
  return `<table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:18px">${head}${body}</table>`;
}

export function buildSubject({ short, pv, ppv, count }) {
  const d = ppv > 0 ? Math.round(((pv - ppv) / ppv) * 100) : pv > 0 ? 100 : 0;
  return `【YORON BBQ｜週次・サイト改善】${short}｜PV ${num(pv)}（前の28日比${d >= 0 ? "+" : "−"}${Math.abs(d)}%）・改善案${count}件`;
}

// ---- メイン ------------------------------------------------------------------
async function main() {
  const creds = JSON.parse(SA_JSON);
  const token = await getAccessToken(creds, [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);

  // 1) サイト全体の合計（直近28日 vs その前28日）
  const totalsBody = (start, end) => ({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensionFilter: hostFilter,
    metrics: [
      { name: "screenPageViews" },
      { name: "totalUsers" },
      { name: "sessions" },
      { name: "engagementRate" },
    ],
  });
  const curT = await ga4RunReport(token, totalsBody("28daysAgo", "yesterday"));
  const prevT = await ga4RunReport(token, totalsBody("56daysAgo", "29daysAgo"));
  const mv = (r) => (r.rows && r.rows[0] ? r.rows[0].metricValues.map((m) => Number(m.value)) : [0, 0, 0, 0]);
  const [pv, users, sessions, engage] = mv(curT);
  const [ppv, pusers, psessions, pengage] = mv(prevT);
  const delta = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : a > 0 ? 100 : 0);

  // 1b) 期間ごとの数字（直近7日・その前の7日・直近28日・その前の28日）
  // 2026-10-29 山根さん「UUとPVとか、さまざまデータほしい。期間なども」
  const periods = {};
  for (const d of PERIOD_DEFS) {
    const r = await ga4RunReport(token, {
      dateRanges: [{ startDate: `${d.from}daysAgo`, endDate: `${d.to}daysAgo` }],
      dimensionFilter: hostFilter,
      metrics: PERIOD_METRICS.map((m) => ({ name: m.key })),
    });
    const v = r.rows && r.rows[0] ? r.rows[0].metricValues.map((m) => Number(m.value)) : PERIOD_METRICS.map(() => 0);
    periods[d.key] = Object.fromEntries(PERIOD_METRICS.map((m, i) => [m.key, v[i]]));
  }

  // 1b') 月ごと（計測を始めた2026年7月から）と週ごと（直近8週・月曜はじまり）のUU・PV
  const byDim = async (dim, startDate) => {
    try {
      const r = await ga4RunReport(token, {
        dateRanges: [{ startDate, endDate: "yesterday" }],
        dimensions: [{ name: dim }],
        dimensionFilter: hostFilter,
        metrics: [{ name: "screenPageViews" }, { name: "totalUsers" }, { name: "newUsers" }, { name: "sessions" }],
        orderBys: [{ dimension: { dimensionName: dim } }],
      });
      return (r.rows || []).map((x) => ({ key: x.dimensionValues[0].value, pv: Number(x.metricValues[0].value), users: Number(x.metricValues[1].value), newUsers: Number(x.metricValues[2].value), sessions: Number(x.metricValues[3].value) }));
    } catch (e) {
      console.error(`${dim}の取得失敗:`, e.message);
      return [];
    }
  };
  const months = await byDim("yearMonth", "2026-07-01");
  const weeks = await byDim("isoYearIsoWeek", weeksStart(range(1, 1).end));

  // 1c) 成果（入会・BBQの申込・申込フォームを開いた）を期間ごとに
  const goals = {};
  for (const d of PERIOD_DEFS) {
    goals[d.key] = Object.fromEntries(GOALS.map((g) => [g.key, 0]));
    try {
      const r = await ga4RunReport(token, {
        dateRanges: [{ startDate: `${d.from}daysAgo`, endDate: `${d.to}daysAgo` }],
        dimensions: [{ name: "eventName" }],
        dimensionFilter: { andGroup: { expressions: [hostFilter, { filter: { fieldName: "eventName", inListFilter: { values: GOALS.map((g) => g.key) } } }] } },
        metrics: [{ name: "eventCount" }],
      });
      for (const row of r.rows || []) goals[d.key][row.dimensionValues[0].value] = Number(row.metricValues[0].value);
    } catch (e) {
      console.error("成果の取得失敗:", e.message);
    }
  }

  // 1d) 端末（スマホ・パソコン・タブレット）と、最初に開かれたページ（直近28日）
  let devices = [];
  let landings = [];
  try {
    const r = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "deviceCategory" }],
      dimensionFilter: hostFilter,
      metrics: [{ name: "totalUsers" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "totalUsers" }, desc: true }],
    });
    devices = (r.rows || []).map((x) => ({ name: x.dimensionValues[0].value, users: Number(x.metricValues[0].value), sessions: Number(x.metricValues[1].value) }));
  } catch (e) {
    console.error("端末の取得失敗:", e.message);
  }
  try {
    const r = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "landingPage" }],
      dimensionFilter: hostFilter,
      metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "bounceRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "8",
    });
    landings = (r.rows || []).map((x) => ({ path: x.dimensionValues[0].value, sessions: Number(x.metricValues[0].value), users: Number(x.metricValues[1].value), bounce: Number(x.metricValues[2].value) }));
  } catch (e) {
    console.error("最初に開かれたページの取得失敗:", e.message);
  }

  // 2) ページ別 PV（直近28日 top20）
  let topPages = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      dimensionFilter: hostFilter,
      metrics: [{ name: "screenPageViews" }, { name: "userEngagementDuration" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: "20",
    });
    topPages = (res.rows || []).map((r) => ({
      path: r.dimensionValues[0].value,
      title: r.dimensionValues[1].value,
      pv: Number(r.metricValues[0].value),
      engSec: Number(r.metricValues[1].value),
      users: Number(r.metricValues[2].value),
    }));
  } catch (e) {
    console.error("topPages失敗:", e.message);
  }

  // 3) 流入元（直近28日）
  let channels = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      dimensionFilter: hostFilter,
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "8",
    });
    channels = (res.rows || []).map((r) => ({ name: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value), users: Number(r.metricValues[1].value) }));
  } catch (e) {
    console.error("channels失敗:", e.message);
  }

  // 4) 検索された言葉（Search Console）。登録の形（URL型・ドメイン型）を一覧から自動で選ぶ
  // 2026-10-29 山根さん「どのワーディングから入ってきたのかとか、その辺もうまくやって」
  let keywords = [];
  let kwPages = [];
  let scAvailable = false;
  let scNoAccess = false;
  try {
    const list = await fetch("https://www.googleapis.com/webmasters/v3/sites", { headers: { authorization: `Bearer ${token}` } });
    const sites = list.ok ? ((await list.json()).siteEntry || []).map((x) => x.siteUrl) : [];
    const scSite = pickScSite(sites, HOST, SC_SITE);
    if (!scSite) {
      scNoAccess = true;
      throw new Error(`Search Consoleに ${HOST} の登録が見当たりません（見えている登録: ${sites.length}件）`);
    }
    // Search Console は2〜3日遅れで確定するので、3日前までの28日間で数える（JSTの暦日）
    const scRange = { startDate: range(30, 3).start, endDate: range(30, 3).end };
    const sc = await scQuery(token, { ...scRange, dimensions: ["query"], rowLimit: 25 }, scSite);
    keywords = (sc.rows || []).map((r) => ({ q: r.keys[0], clicks: r.clicks, impr: r.impressions, ctr: r.ctr, pos: r.position }));
    const sp = await scQuery(token, { ...scRange, dimensions: ["query", "page"], rowLimit: 50 }, scSite);
    kwPages = (sp.rows || [])
      .map((r) => ({ q: r.keys[0], page: r.keys[1].replace(/^https?:\/\/[^/]+/, ""), clicks: r.clicks, impr: r.impressions, pos: r.position }))
      .sort((x, y) => y.clicks - x.clicks || y.impr - x.impr);
    scAvailable = keywords.length > 0;
  } catch (e) {
    console.error("Search Console取得失敗:", e.message);
  }

  // 4b) 来た元のサイト・アプリ（google / instagram / line / chatgpt.com など）
  let sources = [];
  try {
    const r = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "sessionSource" }],
      dimensionFilter: hostFilter,
      metrics: [{ name: "sessions" }, { name: "totalUsers" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "10",
    });
    sources = (r.rows || []).map((x) => ({ name: x.dimensionValues[0].value, sessions: Number(x.metricValues[0].value), users: Number(x.metricValues[1].value) }));
  } catch (e) {
    console.error("来た元の取得失敗:", e.message);
  }

  // 5) ページ一覧（公開中の sitemap.xml）
  let inventory = [];
  try {
    const r = await fetch(SITEMAP_URL);
    if (r.ok) inventory = sitemapUrls(await r.text());
  } catch (e) {
    console.error("ページ一覧取得失敗:", e.message);
  }

  // ---- Claudeへ渡すデータ要約 ----
  const dataForAI = {
    期間: "直近28日（前28日との比較）",
    サイト全体: {
      PV: pv, 前期PV: ppv, PV前期比: `${delta(pv, ppv)}%`,
      ユーザー: users, セッション: sessions,
      エンゲージメント率: pct(engage), 前期エンゲージメント率: pct(pengage),
    },
    期間ごと: Object.fromEntries(PERIOD_DEFS.map((d) => [d.name, { ...periods[d.key], ...goals[d.key] }])),
    端末: devices,
    最初に開かれたページ: landings.map((l) => ({ path: l.path, 訪問: l.sessions, 見た人: l.users, すぐ帰った割合: pct(l.bounce) })),
    ページ別PV_TOP20: topPages.map((p) => ({
      path: p.path, title: p.title, PV: p.pv, ユーザー: p.users,
      平均滞在秒: p.users > 0 ? Math.round(p.engSec / p.users) : 0,
    })),
    流入元: channels,
    来た元のサイト: sources,
    検索の言葉と入ってきたページ: kwPages.slice(0, 30).map((k) => ({ KW: k.q, ページ: k.page, クリック: k.clicks, 表示: k.impr, 平均順位: Number(k.pos.toFixed(1)) })),
    検索KW_TOP25: keywords.map((k) => ({
      KW: k.q, クリック: k.clicks, 表示: k.impr, CTR: pct(k.ctr), 平均順位: Number(k.pos.toFixed(1)),
    })),
    ページ一覧: inventory.slice(0, 80),
  };

  const system = `あなたは「YORON BBQコミュニティ」（yoron-bbq.com）専属のサイト改善担当です。
このサイトは、月1回のバーベキューの会の入会・申込・開催レポートのサイトです。サイトの目的は「会を知った人が入会し、次回のBBQに申し込む」ことです。
GA4とSearch Consoleの実データから、まず根本原因を特定し、そこに直接効く「具体的で実装できる」改善提案だけを作ります。

# 出力の鉄則
- まず根本原因を切り分ける：問題がどこで起きているか（①そもそも見つけてもらえない ②来ても会の中身が伝わらず帰る ③中身は見るが入会・申込に進まない）を数値から特定し、その原因に直接効く打ち手だけを選ぶ。思いつきは出さない。
- 提案は最大3件、優先度順。各提案は「どのページに・何を・どう変えるか」を実装できる粒度で書く。
- 【実現可能性ゲート】提案は既存ページHTMLへの「安全な find/replace」で実装できる範囲に収める（タイトル/見出し/導入文/ボタンの文言/内部リンク/メタ等）。ページの作り直しや新規ページは、本当に空白がある時だけ。
- 入会・申込のフォームの仕組み（送信先・入力項目・保存処理）を変える案は出さない。フォームの前後の説明文やボタンの文言はよい。
- 必ず根拠の数値を添える（例：「トップに来た○人のうち申込ページへ進んだのは○人 → 次回の日程と申込ボタンをファーストビューに出す」）。
- 抽象論（"魅力を伝える"など）は禁止。参加者・会員の個人名や写真の個人情報を新たに載せる案は出さない。
- 出す前に各提案を自己批判する：「この変更で本当にその指標が動くか？」「安全に実装できるか？」を確認し、弱い案は強い案に差し替える。
- 対象が既存ページならtargetにそのURL（ページ一覧参照）、新規なら『新規ページ』。`;

  const userMsg = `以下はYORON BBQコミュニティのサイト（yoron-bbq.com）の直近28日の実データです。これを分析し、入会・申込と検索からの訪問を伸ばす改善提案TOP3を作ってください。\n\n${JSON.stringify(dataForAI, null, 2)}`;

  let result;
  try {
    result = await callClaude(system, userMsg, PROPOSAL_SCHEMA);
  } catch (e) {
    console.error("Claude分析失敗:", e.message);
    setOutput({ ready: "false" });
    process.exit(0);
  }
  const proposals = Array.isArray(result.proposals) ? result.proposals.slice(0, 3) : [];

  // ---- メールHTML ----
  const cur = range(28, 1);   // GA4: 28daysAgo〜yesterday
  const prev = range(56, 29); // GA4: 56daysAgo〜29daysAgo
  const site = SITES.community;
  const arrow = (d) => (d > 0 ? `<span style="color:#16a34a">▲${d}%</span>` : d < 0 ? `<span style="color:#dc2626">▼${Math.abs(d)}%</span>` : "±0%");
  const stat = (n, label, sub) =>
    `<td align="center" style="padding:6px 10px"><div style="font-size:28px;font-weight:800;color:${C.ink};line-height:1">${num(n)}</div><div style="font-size:11px;color:${C.sub};margin-top:4px">${label}</div>${sub ? `<div style="font-size:10px;margin-top:2px">${sub}</div>` : ""}</td>`;

  const cards = proposals.length
    ? proposals.map((p, i) => proposalCard(p, i, false)).join("")
    : `<div style="padding:16px;color:#94a3b8;font-size:13px">本日は特筆すべき改善提案はありませんでした。</div>`;

  const scNote = scAvailable || scNoAccess
    ? ""
    : `<div style="font-size:11px;color:#94a3b8;background:#faf7f2;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 12px;margin:0 0 16px">※ Search Console（検索KW）が未接続/データ蓄積待ちのため、今回はGA4中心の分析です。</div>`;

  const scLabel = range(30, 3).short;
  const labels = Object.fromEntries(PERIOD_DEFS.map((d) => [d.key, range(d.from, d.to).short]));

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:640px;margin:0 auto;background:${C.bg};color:${C.ink}">
  <div style="background:#080604;border-radius:10px 10px 0 0;padding:22px 24px">
    <div style="color:${C.fire};font-size:12px;letter-spacing:.12em;font-weight:700">${site.name} — 週次レポート（サイト改善）</div>
    <div style="color:#fff;font-size:21px;font-weight:800;margin-top:6px">${cur.short}のサイトの数字と、今週の改善案</div>
  </div>
  <div style="border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:22px 24px">
    ${aboutBox({ site, cadence: "週1回（毎週月曜の朝）", rows: [
      ["このメールの範囲", "コミュニティサイトのPVと改善案（会員数・LINEの人数は毎週月曜の別メール）"],
      ["数字の期間", "直近7日・直近28日・月ごと・週ごと（すべて昨日まで）"],
      ["比べた期間", `その前の${prev.label}`],
    ] })}
    <div style="font-size:12px;color:${C.sub};text-align:center;margin-bottom:2px">${cur.label}の合計</div>
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:14px"><tr>
      ${stat(pv, "見られた回数（PV）", `前の28日比 ${arrow(delta(pv, ppv))}`)}${stat(users, "見た人の数（UU）", `前の28日比 ${arrow(delta(users, pusers))}`)}${stat(goals.d28.member_join, "入会")}${stat(goals.d28.event_register, "BBQの申込")}
    </tr></table>

    <h3 style="margin:8px 0 8px;font-size:13px;color:${C.ink}">期間ごとの数字</h3>
    ${periodTable(periods, goals, labels)}

    <h3 style="margin:8px 0 8px;font-size:13px;color:${C.ink}">月ごとの数字（${months.length ? "計測を始めた7/25から" : ""}今月は昨日まで）</h3>
    ${simpleTable(["月", "PV", "見た人（UU）", "初めて来た人", "訪問"], months.map((m) => [monthLabel(m.key), num(m.pv), num(m.users), num(m.newUsers), num(m.sessions)]))}

    <h3 style="margin:22px 0 8px;font-size:13px;color:${C.ink}">週ごとの数字（月曜はじまり・直近8週）</h3>
    ${simpleTable(["週", "PV", "見た人（UU）", "初めて来た人", "訪問"], weeks.map((w) => [weekLabel(w.key, cur.end), num(w.pv), num(w.users), num(w.newUsers), num(w.sessions)]))}
    <div style="font-size:11px;color:#999;margin:4px 0 18px">※ 見た人（UU）は期間ごとに数えるため、週や月を足しても28日間の人数にはなりません（同じ人が何週も来るため）。</div>

    <h3 style="margin:8px 0 8px;font-size:13px;color:${C.ink}">いま何が起きているか（${cur.short}）</h3>
    <div style="font-size:13px;color:${C.ink};line-height:1.85;background:#faf7f2;border:1px solid ${C.line};border-radius:8px;padding:12px 14px;margin-bottom:18px">${esc(result.summary || "")}</div>

    <h3 style="margin:8px 0 12px;font-size:13px;color:${C.ink}">今週の改善案 TOP3（参考）</h3>
    ${scNote}
    ${cards}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">よく見られたページ TOP8（${cur.label}）</h3>
    ${simpleTable(["ページ", "PV", "見た人"], pageNames(topPages.slice(0, 8)).map((name, i) => [name, num(topPages[i].pv), num(topPages[i].users)]))}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">最初に開かれたページ TOP8（${cur.label}）</h3>
    ${simpleTable(["ページ", "訪問", "見た人", "すぐ帰った割合"], landings.map((l) => [l.path, num(l.sessions), num(l.users), pct(l.bounce)]))}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">どこから来たか（${cur.label}）</h3>
    ${simpleTable(["来た経路", "訪問", "見た人"], channels.map((c) => [CHANNEL_JA[c.name] || c.name, num(c.sessions), num(c.users)]))}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">来た元のサイト・アプリ TOP10（${cur.label}）</h3>
    ${simpleTable(["来た元", "訪問", "見た人"], sources.map((x) => [sourceName(x.name), num(x.sessions), num(x.users)]))}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">使った端末（${cur.label}）</h3>
    ${simpleTable(["端末", "見た人", "訪問"], devices.map((d) => [DEVICE_JA[d.name] || d.name, num(d.users), num(d.sessions)]))}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">Googleで検索された言葉 TOP15（${scLabel}・見えた回数順）</h3>
    ${scNoAccess ? `<div style="font-size:12px;color:${C.warm};background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:9px 12px">Search Console に、数字を取る係のアカウント（${esc(creds.client_email || "")}）が登録されていないため、検索された言葉を取れませんでした。Search Console の yoron-bbq.com の「設定 → ユーザーと権限」で、このアドレスを「制限付き」で追加すると、次の回から出ます。</div>` : simpleTable(["検索された言葉", "見えた回数", "クリック", "クリックされた割合", "平均の順位"], [...keywords].sort((a, b) => b.impr - a.impr).slice(0, 15).map((k) => [k.q, num(k.impr), num(k.clicks), pct(k.ctr), k.pos.toFixed(1)]))}

    ${scNoAccess ? "" : `<h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">どの言葉で、どのページに入ってきたか TOP15（${scLabel}・クリック順）</h3>` + simpleTable(["検索された言葉", "入ってきたページ", "クリック", "見えた回数", "平均の順位"], kwPages.slice(0, 15).map((k) => [k.q, k.page || "/", num(k.clicks), num(k.impr), k.pos.toFixed(1)]))}

    <div style="margin:24px 0 6px">
      <a href="${GA4_LINK}" style="display:inline-block;background:${C.fire};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:700;font-size:14px">GA4で詳細を見る</a>
    </div>
    <div style="margin-top:16px;padding:13px 15px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:12px;color:${C.warm};line-height:1.8">
      この提案はまだ<b>「提案」段階</b>です。次のステップで、文章・見出し・リンクなどの軽い直しは自動で実装し、入会・申込のフォームに触る直しだけ［承認］ボタンを押してから実装する形にします。
    </div>
    <div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:11px;color:#aaa">
      ${site.name}（${esc(SC_SITE)}）のサイト改善の週次レポート／毎週月曜の朝に届きます
    </div>
  </div>
</div>`;

  const subject = buildSubject({ short: cur.short, pv, ppv, count: proposals.length });
  setOutput({ ready: "true", subject, html });
  console.log(`提案 ${proposals.length}件 生成。PV=${pv} (前期比 ${delta(pv, ppv)}%)`);
}

if (IS_MAIN) main().catch((e) => {
  console.error("致命的エラー:", e);
  setOutput({ ready: "false" });
  process.exit(0);
});
