// =============================================================================
// SLOW FIRE JOURNAL — ブログ改善ループ Phase 1（分析 → 改善提案）
// -----------------------------------------------------------------------------
// GitHub Actions から定期実行。GA4 Data API と Search Console API で
// ブログ(journal)のPV・流入・検索KWを集め、Claude(opus-4-8)が
// 「どの記事をどう直すか」の具体的な改善提案TOP3を生成してメールHTMLを組む。
// メール送信はワークフロー側（dawidd6/action-send-mail）が担当。
//
// PM Quest の dailySiteImprovement のBBQ版。土台がGitHub Actionsなので
// Firebase不要。既存のGA4サービスアカウント・Anthropicキーをそのまま再利用する。
//
// 必要な環境変数（GitHub Secrets）:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントのJSONキー全文（必須）
//   GA4_PROPERTY_ID             … GA4の数値プロパティID（必須）
//   ANTHROPIC_API_KEY           … Claude APIキー（必須）
//   SC_SITE_URL                 … Search Consoleプロパティ（省略時 slow-fire-shop）
//   BLOG_MODEL                  … 使用モデル（省略時 claude-opus-4-8）
//   JOURNAL_INDEX_URL           … 記事インベントリJSON（省略時 公開search-index.json）
//   GA4_DASHBOARD_URL           … 「GA4で詳細を見る」リンク先
// 必須シークレットが無いときは、何もせず正常終了（ready=false）する。
// =============================================================================

import crypto from "node:crypto";
import { appendFileSync } from "node:fs";

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.GA4_PROPERTY_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const SC_SITE = process.env.SC_SITE_URL || "https://yamanekazuki.github.io/slow-fire-shop/";
const MODEL = process.env.BLOG_MODEL || "claude-opus-4-8";
const INDEX_URL =
  process.env.JOURNAL_INDEX_URL ||
  "https://yamanekazuki.github.io/slow-fire-shop/journal/search-index.json";
const GA4_LINK = process.env.GA4_DASHBOARD_URL || "https://analytics.google.com/";
// ブログ記事を識別するパスの目印（GA4 pagePath / SC page をこれで絞り込む）
const JOURNAL_MARK = "/journal/";

// ---- GITHUB_OUTPUT ヘルパ -----------------------------------------------------
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

if (!SA_JSON || !PROPERTY || !API_KEY) {
  console.log("未設定（GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID / ANTHROPIC_API_KEY）。スキップします。");
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
async function scQuery(token, requestBody) {
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC_SITE)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );
  if (!res.ok) throw new Error(`SC ${res.status}: ${await res.text()}`);
  return res.json();
}

// journal だけに絞る GA4 dimensionFilter
const journalFilter = {
  filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: JOURNAL_MARK } },
};

// ---- Claude（structured output / 依存ゼロ）-----------------------------------
const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "ブログ全体の現状を2〜3文で。前期比の主因と、いま一番のボトルネックを率直に。",
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
            description: "対象記事のURLまたはパス。新規記事の提案なら『新規記事』と書く",
          },
          change: { type: "string", description: "何をどう変えるか。タイトル・見出し・導入・内部リンク・新規記事など具体的に" },
          impact: { type: "string", description: "期待できる効果と、その根拠になっている数値（表示回数・順位・CTR等）" },
        },
        required: ["title", "priority", "effort", "target", "change", "impact"],
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

function proposalCard(p, i) {
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
  </div>`;
}

// ---- メイン ------------------------------------------------------------------
async function main() {
  const creds = JSON.parse(SA_JSON);
  const token = await getAccessToken(creds, [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);

  // 1) ブログ全体の合計（直近28日 vs その前28日）
  const totalsBody = (start, end) => ({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensionFilter: journalFilter,
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

  // 2) 記事別 PV（直近28日 top20）
  let topPages = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      dimensionFilter: journalFilter,
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
      dimensionFilter: journalFilter,
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "8",
    });
    channels = (res.rows || []).map((r) => ({ name: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value) }));
  } catch (e) {
    console.error("channels失敗:", e.message);
  }

  // 4) 検索KW（Search Console・直近28日・journalページに限定）
  let keywords = [];
  let scAvailable = false;
  try {
    const base = new Date(Date.now() + 9 * 3600 * 1000);
    const ymd = (d) => d.toISOString().slice(0, 10);
    const sc = await scQuery(token, {
      startDate: ymd(new Date(base.getTime() - 30 * 86400000)),
      endDate: ymd(new Date(base.getTime() - 3 * 86400000)),
      dimensions: ["query"],
      dimensionFilterGroups: [
        { filters: [{ dimension: "page", operator: "contains", expression: JOURNAL_MARK }] },
      ],
      rowLimit: 25,
    });
    keywords = (sc.rows || []).map((r) => ({
      q: r.keys[0],
      clicks: r.clicks,
      impr: r.impressions,
      ctr: r.ctr,
      pos: r.position,
    }));
    scAvailable = keywords.length > 0;
  } catch (e) {
    console.error("Search Console取得失敗:", e.message);
  }

  // 5) 記事インベントリ（公開済みsearch-index.json）
  let inventory = [];
  try {
    const r = await fetch(INDEX_URL);
    if (r.ok) {
      const arr = await r.json();
      inventory = (Array.isArray(arr) ? arr : []).map((a) => ({
        title: a.title,
        desc: a.desc,
        keywords: a.keywords,
        url: a.url,
      }));
    }
  } catch (e) {
    console.error("インベントリ取得失敗:", e.message);
  }

  // ---- Claudeへ渡すデータ要約 ----
  const dataForAI = {
    期間: "直近28日（前28日との比較）",
    ブログ全体: {
      PV: pv, 前期PV: ppv, PV前期比: `${delta(pv, ppv)}%`,
      ユーザー: users, セッション: sessions,
      エンゲージメント率: pct(engage), 前期エンゲージメント率: pct(pengage),
    },
    記事別PV_TOP20: topPages.map((p) => ({
      path: p.path, title: p.title, PV: p.pv, ユーザー: p.users,
      平均滞在秒: p.users > 0 ? Math.round(p.engSec / p.users) : 0,
    })),
    流入元: channels,
    検索KW_TOP25: keywords.map((k) => ({
      KW: k.q, クリック: k.clicks, 表示: k.impr, CTR: pct(k.ctr), 平均順位: Number(k.pos.toFixed(1)),
    })),
    記事インベントリ: inventory.slice(0, 60),
  };

  const system = `あなたはSLOW FIRE（アメリカンBBQのメディア／EC）のブログ「SLOW FIRE JOURNAL」専属のSEO/コンテンツ戦略家です。
GA4とSearch Consoleの実データから、PVと検索流入を伸ばすための「具体的で実装できる」改善提案を作ります。

# 出力の鉄則
- 提案は最大3件、優先度順。各提案は「どの記事に・何を・どう変えるか」を実装できる粒度で書く。
- 必ず根拠の数値を添える（例：「表示○回・平均順位○位だがCTRが○%と低い → タイトルに数値と便益を入れる」）。
- 一番おいしいのは「表示回数は多いのに順位が低い／CTRが低い」検索KWと、それに対応する既存記事のテコ入れ。次に内部リンク・導入文・構造化。新規記事は本当に空白がある時だけ。
- 抽象論（"質を上げる"など）は禁止。SLOW FIREのトーンは落ち着いた実用志向で、煽らない。
- 対象が既存記事ならtargetにそのURL（インベントリ参照）、新規なら『新規記事』。`;

  const userMsg = `以下はSLOW FIRE JOURNALの直近28日の実データです。これを分析し、PV/検索流入を伸ばす改善提案TOP3を作ってください。\n\n${JSON.stringify(dataForAI, null, 2)}`;

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
  const base = new Date(Date.now() + 9 * 3600 * 1000);
  const when = `${base.getUTCMonth() + 1}月${base.getUTCDate()}日`;
  const arrow = (d) => (d > 0 ? `<span style="color:#16a34a">▲${d}%</span>` : d < 0 ? `<span style="color:#dc2626">▼${Math.abs(d)}%</span>` : "±0%");
  const stat = (n, label, sub) =>
    `<td align="center" style="padding:6px 10px"><div style="font-size:28px;font-weight:800;color:${C.ink};line-height:1">${num(n)}</div><div style="font-size:11px;color:${C.sub};margin-top:4px">${label}</div>${sub ? `<div style="font-size:10px;margin-top:2px">${sub}</div>` : ""}</td>`;

  const cards = proposals.length
    ? proposals.map((p, i) => proposalCard(p, i)).join("")
    : `<div style="padding:16px;color:#94a3b8;font-size:13px">本日は特筆すべき改善提案はありませんでした。</div>`;

  const scNote = scAvailable
    ? ""
    : `<div style="font-size:11px;color:#94a3b8;background:#faf7f2;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 12px;margin:0 0 16px">※ Search Console（検索KW）が未接続/データ蓄積待ちのため、今回はGA4中心の分析です。</div>`;

  const topPagesRows = topPages.slice(0, 8).map((p) =>
    `<tr><td style="font-size:12px;padding:6px 2px;border-bottom:1px solid ${C.line};color:${C.ink}">${esc(p.title || p.path)}</td>
     <td align="right" style="font-size:12px;padding:6px 2px;border-bottom:1px solid ${C.line};font-weight:700">${num(p.pv)}</td></tr>`
  ).join("");

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:640px;margin:0 auto;background:${C.bg};color:${C.ink}">
  <div style="background:#080604;border-radius:10px 10px 0 0;padding:22px 24px">
    <div style="color:${C.fire};font-size:12px;letter-spacing:.12em;font-weight:700">SLOW FIRE JOURNAL — AI改善提案</div>
    <div style="color:#fff;font-size:21px;font-weight:800;margin-top:6px">${when} ブログ分析と改善提案</div>
  </div>
  <div style="border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:22px 24px">
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:14px"><tr>
      ${stat(pv, "PV(28日)", arrow(delta(pv, ppv)))}${stat(users, "ユーザー")}${stat(sessions, "セッション")}${stat(Math.round(engage * 100), "Eng率%")}
    </tr></table>

    <h3 style="margin:8px 0 8px;font-size:13px;color:${C.ink}">🧭 いま何が起きているか</h3>
    <div style="font-size:13px;color:${C.ink};line-height:1.85;background:#faf7f2;border:1px solid ${C.line};border-radius:8px;padding:12px 14px;margin-bottom:18px">${esc(result.summary || "")}</div>

    <h3 style="margin:8px 0 12px;font-size:13px;color:${C.ink}">🛠 改善提案 TOP3</h3>
    ${scNote}
    ${cards}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">📄 人気記事 TOP8（直近28日・PV）</h3>
    <table role="presentation" width="100%" style="border-collapse:collapse">${topPagesRows || '<tr><td style="color:#999;font-size:13px;padding:8px 0">データなし</td></tr>'}</table>

    <div style="margin:24px 0 6px">
      <a href="${GA4_LINK}" style="display:inline-block;background:${C.fire};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:700;font-size:14px">GA4で詳細を見る</a>
    </div>
    <div style="margin-top:16px;padding:13px 15px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:12px;color:${C.warm};line-height:1.8">
      この提案はまだ<b>「提案」段階</b>です。次のステップ（Phase 2）で各提案に<b>［承認］ボタン</b>を付け、押すとAIが該当記事を直して公開まで自動で回す形にします。まずは提案の精度をご確認ください。
    </div>
    <div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:11px;color:#aaa">
      SLOW FIRE JOURNAL（${esc(SC_SITE)}）／ GA4・Search Console をAIが分析
    </div>
  </div>
</div>`;

  const subject = `【SLOW FIRE JOURNAL】AI改善提案 ${proposals.length}件｜${when}（PV ${num(pv)}・前期比${delta(pv, ppv) >= 0 ? "+" : ""}${delta(pv, ppv)}%）`;
  setOutput({ ready: "true", subject, html });
  console.log(`提案 ${proposals.length}件 生成。PV=${pv} (前期比 ${delta(pv, ppv)}%)`);
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  setOutput({ ready: "false" });
  process.exit(0);
});
