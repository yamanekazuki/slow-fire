// =============================================================================
// SLOW FIRE SHOP（EC）— サイト改善ループ Phase 1（分析 → 改善提案）
// -----------------------------------------------------------------------------
// GitHub Actions から毎日実行。GA4 Data API と Search Console API で
// ショップ本体（/journal/ ブログを除く EC・商品・ランディング・導線）の
// PV・流入・滞在・検索KWを集め、Claude(opus-4-8)が「どこをどう直すか」の
// 具体的な改善提案TOP3を生成してメールHTMLを組む。
// メール送信はワークフロー側（dawidd6/action-send-mail）が担当。
//
// PM Quest の dailySiteImprovement のショップ版（毎日・Phase1=提案のみ）。
// ブログ記事の改善は別ワークフロー（blog-improvement.yml）が担当＝役割分担。
// 既存のGA4サービスアカウント・Anthropicキーをそのまま再利用する。
//
// 必要な環境変数（GitHub Secrets）:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントのJSONキー全文（必須）
//   GA4_PROPERTY_ID             … GA4の数値プロパティID（必須）
//   ANTHROPIC_API_KEY           … Claude APIキー（必須）
//   SC_SITE_URL                 … Search Consoleプロパティ（省略時 slow-fire-shop）
//   SHOP_MODEL / BLOG_MODEL     … 使用モデル（省略時 claude-opus-4-8）
//   GA4_DASHBOARD_URL           … 「GA4で詳細を見る」リンク先
// 必須シークレットが無いときは、何もせず正常終了（ready=false）する。
// =============================================================================

import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
// 日次レポート（前日の数値・流入・検索KW・人気ページ）を同じメールに統合する
// （2026-07-05 山根さん指示：日次レポートとAI改善提案を別便にせず1通で）
import { buildDailyReport } from "./daily-report.mjs";

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.GA4_PROPERTY_ID;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const SC_SITE = process.env.SC_SITE_URL || "https://yamanekazuki.github.io/slow-fire-shop/";
const MODEL = process.env.SHOP_MODEL || process.env.BLOG_MODEL || "claude-opus-4-8";
const GA4_LINK = process.env.GA4_DASHBOARD_URL || "https://analytics.google.com/";
// ブログ記事のパスの目印。ショップ分析ではこれを「除外」してEC本体に絞る。
const JOURNAL_MARK = "/journal/";
// Phase 2：承認ボタンの受け口（cook-logのFirebase関数URL）と署名鍵。
// 両方が揃っているときだけメールに［承認して実装］ボタンを出す（無ければPhase1のまま）。
const FN_BASE = process.env.APPROVAL_FN_BASE || "";
const APPROVAL_SECRET = process.env.APPROVAL_SECRET || "";

// 署名付きリンク：payloadをbase64url化し、HMACで改ざん/総当りを防ぐ。
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function signToken(d) {
  return crypto.createHmac("sha256", String(APPROVAL_SECRET)).update(d).digest("hex").slice(0, 32);
}
// proposal に domain:"shop" を埋めて送る → 受け口が implement-shop をディスパッチする。
function approveLink(kind, proposal) {
  if (!FN_BASE || !APPROVAL_SECRET) return "";
  const d = b64urlJson({ kind, proposal: { ...proposal, domain: "shop" } });
  return `${FN_BASE}/bbqProposalAction?d=${d}&t=${signToken(d)}`;
}

// 承認の自動化：人間の✅クリックを待たず、承認リンクをサーバー側から叩いて実装を起動する。
// ＝ボタンと完全に同じ経路（cook-log の bbqProposalAction → implement-shop ディスパッチ）。
// 山根さん要望（2026-07-02）「承認ボタンは結局いつも押すだけ。勝手に回して、どう実装したかの結論だけくれ」。
//   → 既定で【全提案】を1回のバッチ dispatch でまとめて自動実装する。実装エンジン(run.mjs)は
//     1回のワークフロー実行で直列に実装→採点→（合格なら）自動公開し、結果を1通のサマリーで報告する。
//     人の操作はゼロ（合わなければ事後の［元に戻す］でワンクリック）＝[[feedback_loop_human_not_bottleneck]]原則②。
// AUTO_IMPLEMENT_COUNT を明示すると件数を絞れる（0で自動化オフ＝従来の手動ボタン運用）。未指定＝全件。
const AUTO_COUNT = process.env.AUTO_IMPLEMENT_COUNT != null && process.env.AUTO_IMPLEMENT_COUNT !== ""
  ? Math.max(0, Number(process.env.AUTO_IMPLEMENT_COUNT) || 0)
  : Infinity;

// バッチ用に提案を実装エンジンが使う項目だけに絞る（URL長を抑える。downstreamは title/target/change/impact のみ使用）。
function slimProposal(p) {
  return { title: p.title, priority: p.priority, effort: p.effort, target: p.target, change: p.change, impact: p.impact };
}
// 複数提案を1つの envelope（domain:"shop" + batch:[...]）にまとめ、承認リンク経由で1回だけ dispatch する。
// cook-log は client_payload をそのまま中継するので、run.mjs 側が proposal.batch を検知して直列処理する。
async function autoApproveBatch(proposals) {
  if (!FN_BASE || !APPROVAL_SECRET || !proposals.length) return false;
  const envelope = { domain: "shop", title: `${proposals.length}件の改善を自動実装`, batch: proposals.map(slimProposal) };
  const d = b64urlJson({ kind: "approve", proposal: envelope });
  const url = `${FN_BASE}/bbqProposalAction?d=${d}&t=${signToken(d)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    console.log(`autoApproveBatch ${res.status}: ${proposals.length}件 (URL長 ${url.length})`);
    return res.ok;
  } catch (e) {
    console.error(`autoApproveBatch失敗: ${e.message}`);
    return false;
  }
}

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

// ブログ(/journal/)を除外して EC本体に絞る GA4 dimensionFilter
const excludeJournalFilter = {
  notExpression: { filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: JOURNAL_MARK } } },
};

// ---- Claude（structured output / 依存ゼロ）-----------------------------------
const PROPOSAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "ショップ全体の現状を2〜3文で。前期比の主因と、購入導線でいま一番のボトルネックを率直に。",
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
            description: "対象ページのパス。必ず後述の『対象ページ候補』一覧から実在する1ページを選ぶ（例 index.html / product.html / essentials.html）。括弧の注釈や『サイト全体』は書かない。横断的に効く施策でも、まず主担当となる単一ページ（多くはトップ index.html か商品ページ product.html）を選ぶ。",
          },
          rootCause: { type: "string", description: "数値から推定した根本原因（集客・回遊・購入導線のどの段階で離脱しているか）" },
          change: { type: "string", description: "何をどう変えるか。実装できる粒度で。CTA・商品説明・価格表示・導線・LP見出し・内部リンク等を具体的に" },
          expectedLift: { type: "string", description: "どの指標がどの方向にどれくらい動く見込みか（仮説でよいが数値に紐づける）" },
          impact: { type: "string", description: "期待できる効果と、その根拠になっている数値（PV・滞在・流入・検索表示等）" },
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

function actionButtons(p, auto) {
  // 自動実装する提案は、人間のクリックを待たずに進行中であることを示す（ボタンは出さない）。
  if (auto) {
    return `<div style="margin-top:14px;display:inline-block;background:#ecfdf5;border:1px solid #a7f3d0;color:#15803d;font-size:12px;font-weight:800;padding:9px 14px;border-radius:9px">🤖 自動で実装します — 合格すれば承認を待たず本番公開し、結果を別便のサマリーで報告します</div>`;
  }
  const approve = approveLink("approve", p);
  if (!approve) return "";
  const reject = approveLink("reject", p);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px;border-collapse:collapse"><tr>
      <td style="padding:0 8px 0 0"><a href="${approve}" style="display:inline-block;background:#16a34a;color:#fff;font-size:13px;font-weight:800;text-decoration:none;padding:11px 20px;border-radius:9px">✅ 承認して実装する</a></td>
      <td style="padding:0"><a href="${reject}" style="display:inline-block;background:#fff;color:#64748b;font-size:13px;font-weight:700;text-decoration:none;padding:10px 18px;border-radius:9px;border:1px solid #cbd5e1">却下</a></td>
    </tr></table>`;
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
      ${row("根本原因", p.rootCause)}
      ${row("変更内容", p.change)}
      ${row("期待効果", p.impact)}
    </table>
    ${actionButtons(p, auto)}
  </div>`;
}

// ---- メイン ------------------------------------------------------------------
async function main() {
  const creds = JSON.parse(SA_JSON);
  const token = await getAccessToken(creds, [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);

  // 1) ショップ本体の合計（直近28日 vs その前28日 / journal除外）
  const totalsBody = (start, end) => ({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensionFilter: excludeJournalFilter,
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

  // 2) ページ別 PV・滞在（直近28日 top20 / journal除外）
  let topPages = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "pagePath" }, { name: "pageTitle" }],
      dimensionFilter: excludeJournalFilter,
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

  // 3) ランディングページ（直近28日・どこから入って離脱しているか / journal除外）
  let landings = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "landingPagePlusQueryString" }],
      dimensionFilter: excludeJournalFilter,
      metrics: [{ name: "sessions" }, { name: "engagementRate" }, { name: "bounceRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "12",
    });
    landings = (res.rows || []).map((r) => ({
      path: r.dimensionValues[0].value,
      sessions: Number(r.metricValues[0].value),
      engageRate: Number(r.metricValues[1].value),
      bounceRate: Number(r.metricValues[2].value),
    }));
  } catch (e) {
    console.error("landings失敗:", e.message);
  }

  // 4) 流入元（直近28日 / journal除外）
  let channels = [];
  try {
    const res = await ga4RunReport(token, {
      dateRanges: [{ startDate: "28daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      dimensionFilter: excludeJournalFilter,
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: "8",
    });
    channels = (res.rows || []).map((r) => ({ name: r.dimensionValues[0].value, sessions: Number(r.metricValues[0].value) }));
  } catch (e) {
    console.error("channels失敗:", e.message);
  }

  // 5) 検索KW（Search Console・直近28日・journalページは除外）
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
        { filters: [{ dimension: "page", operator: "notContains", expression: JOURNAL_MARK }] },
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

  // ---- 対象ページ候補（実在する単一ページ）----
  // 提案の target に実在ページを必ず選ばせるための一覧。実装エンジンが単一HTMLに落とせるよう、
  // GA4で実際に閲覧されているページパスを正規化して使い、主要EC固定ページで補完する。
  // ＝『サイト全体』など実装エンジンが弾く曖昧targetを発生源から無くす。
  const SHOP_HOST = "yamanekazuki.github.io/slow-fire-shop";
  const normPath = (p) => {
    let s = String(p || "").trim();
    s = s.replace(/^https?:\/\/[^/]+/i, "");        // ドメイン除去
    s = s.replace(/^\/?slow-fire-shop/i, "");        // Pages接頭辞
    s = s.replace(/[?#].*$/, "").replace(/^\/+/, ""); // クエリ/先頭スラッシュ
    if (s === "" ) return "index.html";
    if (s.endsWith("/")) s += "index.html";
    return s;
  };
  // 主要EC固定ページ（GA4に出てこない日でも候補に入れておく）
  const CANONICAL_PAGES = [
    "index.html", "product.html", "essentials.html", "cookbook.html", "recipe.html",
    "rub-guide.html", "pairing-guide.html", "team.html", "contact/index.html",
    "tools/index.html", "bbq-spots/index.html", "bbq-spots/map.html",
  ];
  const seenPaths = new Set();
  const pageCandidates = [];
  for (const p of [...topPages.map((x) => x.path), ...landings.map((x) => x.path)]) {
    const n = normPath(p);
    if (!n.endsWith(".html") || n.includes("/journal/") || n.startsWith("journal/")) continue;
    if (/^(404|admin|style-guide|google[0-9a-f]+)\.html$/i.test(n.split("/").pop())) continue;
    if (!seenPaths.has(n)) { seenPaths.add(n); pageCandidates.push(n); }
  }
  for (const p of CANONICAL_PAGES) if (!seenPaths.has(p)) { seenPaths.add(p); pageCandidates.push(p); }

  // ---- Claudeへ渡すデータ要約 ----
  const dataForAI = {
    対象ページ候補_この中から選ぶ: pageCandidates,
    期間: "直近28日（前28日との比較）",
    対象: "SLOW FIRE SHOP（EC本体・ブログ/journalは除外）",
    ショップ全体: {
      PV: pv, 前期PV: ppv, PV前期比: `${delta(pv, ppv)}%`,
      ユーザー: users, セッション: sessions,
      エンゲージメント率: pct(engage), 前期エンゲージメント率: pct(pengage),
    },
    ページ別_TOP20: topPages.map((p) => ({
      path: p.path, title: p.title, PV: p.pv, ユーザー: p.users,
      平均滞在秒: p.users > 0 ? Math.round(p.engSec / p.users) : 0,
    })),
    ランディングページ: landings.map((l) => ({
      path: l.path, セッション: l.sessions,
      エンゲージ率: pct(l.engageRate), 直帰率: pct(l.bounceRate),
    })),
    流入元: channels,
    検索KW_TOP25: keywords.map((k) => ({
      KW: k.q, クリック: k.clicks, 表示: k.impr, CTR: pct(k.ctr), 平均順位: Number(k.pos.toFixed(1)),
    })),
  };

  const system = `あなたはSLOW FIRE（アメリカンBBQのメディア／EC）のオンラインショップ「SLOW FIRE SHOP」専属のEC/CRO（コンバージョン改善）戦略家です。
GA4とSearch Consoleの実データから、まず根本原因を特定し、そこに直接効く「具体的で実装できる」改善提案だけを作ります。

# 出力の鉄則
- まず根本原因を切り分ける：問題がどこで起きているか（①そもそも集客できていない ②流入はあるがランディングで直帰している ③回遊はするが商品ページ/カートで離脱している）を数値から特定し、その原因に直接効く打ち手だけを選ぶ。思いつきは出さない。
- 提案は最大3件、優先度順。各提案は「どのページに・何を・どう変えるか」を実装できる粒度で書く（CTA文言・商品説明・価格や送料の見せ方・ファーストビュー・導線・内部リンク・FAQ等）。
- 必ず根拠の数値を添える（例：「このLPはセッション○・直帰率○%と高い → ファーストビューに価値提案と価格を明示」）。
- 一番おいしいのは「流入は多いのに直帰/離脱が高いランディングページ」と「表示は多いのに順位/CTRが低い購入意図の検索KW」。次に商品ページの説明・CTA・送料/決済の不安解消。
- 抽象論（"質を上げる""魅力的にする"など）は禁止。SLOW FIREのトーンは落ち着いた実用志向で、煽らない。
- 出す前に各提案を自己批判する：「この変更で本当にその指標が動くか？」「安全に実装できるか？」を確認し、弱い案は強い案に差し替える。
- ブログ記事(/journal/)の改善は別ループが担当するので、ここではEC本体（トップ・商品・カート・LP・導線）に集中する。
- 【最重要】各提案の target は、データに添える「対象ページ候補」一覧から実在する単一ページを必ず1つ選ぶ（例 index.html / product.html / essentials.html）。『サイト全体』『全ページ』や括弧注釈は絶対に書かない。これは承認後にAIがそのページを実際に編集して実装するため＝対象が曖昧だと実装できず無駄になる。横断的に効く施策でも主担当ページ1枚に落として書くこと。
- change は、その単一ページのHTMLに対する find/replace で実装できる粒度（見出し・本文・CTA文言・リンク・FAQ一文の追加/修正など）に必ず収める。ページの作り直しやデザイン全面刷新のような実装不能な大改修は提案しない。`;

  const userMsg = `以下はSLOW FIRE SHOP（EC本体）の直近28日の実データです。これを分析し、購入導線とコンバージョンを伸ばす改善提案TOP3を作ってください。\n\n${JSON.stringify(dataForAI, null, 2)}`;

  let result;
  try {
    result = await callClaude(system, userMsg, PROPOSAL_SCHEMA);
  } catch (e) {
    console.error("Claude分析失敗:", e.message);
    setOutput({ ready: "false" });
    process.exit(0);
  }
  const proposals = Array.isArray(result.proposals) ? result.proposals.slice(0, 3) : [];

  // ---- 承認の自動化（山根さん要望：承認クリックを無くし、全提案を自動実装→結論だけ報告）----
  // 優先度（高>中>低）で並べ、上位 AUTO_COUNT 件（既定=全件）を1回のバッチで自動承認＝実装を起動する。
  // 実装エンジンが1実行で直列に実装→採点→（合格なら）自動公開し、結果を1通のサマリーで報告する。
  const PRI_RANK = { 高: 0, 中: 1, 低: 2 };
  const ranked = proposals
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => (PRI_RANK[a.p.priority] ?? 1) - (PRI_RANK[b.p.priority] ?? 1) || a.idx - b.idx);
  const autoSet = new Set();
  if (FN_BASE && APPROVAL_SECRET && AUTO_COUNT > 0) {
    const chosen = ranked.slice(0, AUTO_COUNT === Infinity ? proposals.length : AUTO_COUNT);
    const ok = await autoApproveBatch(chosen.map(({ p }) => p));
    if (ok) for (const { idx } of chosen) autoSet.add(idx); // 起動成功した提案を「自動実装中」表示に
  }

  // ---- メールHTML ----
  const base = new Date(Date.now() + 9 * 3600 * 1000);
  const when = `${base.getUTCMonth() + 1}月${base.getUTCDate()}日`;
  const arrow = (d) => (d > 0 ? `<span style="color:#16a34a">▲${d}%</span>` : d < 0 ? `<span style="color:#dc2626">▼${Math.abs(d)}%</span>` : "±0%");
  const stat = (n, label, sub) =>
    `<td align="center" style="padding:6px 10px"><div style="font-size:28px;font-weight:800;color:${C.ink};line-height:1">${num(n)}</div><div style="font-size:11px;color:${C.sub};margin-top:4px">${label}</div>${sub ? `<div style="font-size:10px;margin-top:2px">${sub}</div>` : ""}</td>`;

  const cards = proposals.length
    ? proposals.map((p, i) => proposalCard(p, i, autoSet.has(i))).join("")
    : `<div style="padding:16px;color:#94a3b8;font-size:13px">本日は特筆すべき改善提案はありませんでした。</div>`;

  const scNote = scAvailable
    ? ""
    : `<div style="font-size:11px;color:#94a3b8;background:#faf7f2;border:1px dashed #cbd5e1;border-radius:8px;padding:9px 12px;margin:0 0 16px">※ Search Console（検索KW）が未接続/データ蓄積待ちのため、今回はGA4中心の分析です。</div>`;

  const landingRows = landings.slice(0, 8).map((l) =>
    `<tr><td style="font-size:12px;padding:6px 2px;border-bottom:1px solid ${C.line};color:${C.ink}">${esc(l.path)}</td>
     <td align="right" style="font-size:12px;padding:6px 2px;border-bottom:1px solid ${C.line};font-weight:700">${num(l.sessions)}</td>
     <td align="right" style="font-size:12px;padding:6px 2px;border-bottom:1px solid ${C.line};color:${l.bounceRate > 0.7 ? "#dc2626" : C.sub}">${pct(l.bounceRate)}</td></tr>`
  ).join("");

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:640px;margin:0 auto;background:${C.bg};color:${C.ink}">
  <div style="background:#080604;border-radius:10px 10px 0 0;padding:22px 24px">
    <div style="color:${C.fire};font-size:12px;letter-spacing:.12em;font-weight:700">SLOW FIRE SHOP — AI改善提案</div>
    <div style="color:#fff;font-size:21px;font-weight:800;margin-top:6px">${when} ショップ分析と改善提案</div>
  </div>
  <div style="border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:22px 24px">
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:14px"><tr>
      ${stat(pv, "PV(直近28日計)", arrow(delta(pv, ppv)))}${stat(users, "ユーザー")}${stat(sessions, "セッション")}${stat(Math.round(engage * 100), "Eng率%")}
    </tr></table>

    <h3 style="margin:8px 0 8px;font-size:13px;color:${C.ink}">🧭 いま何が起きているか</h3>
    <div style="font-size:13px;color:${C.ink};line-height:1.85;background:#faf7f2;border:1px solid ${C.line};border-radius:8px;padding:12px 14px;margin-bottom:18px">${esc(result.summary || "")}</div>

    <h3 style="margin:8px 0 12px;font-size:13px;color:${C.ink}">🛠 改善提案 TOP3</h3>
    ${scNote}
    ${cards}

    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">🛬 主なランディングページ（直近28日・セッション/直帰率）</h3>
    <table role="presentation" width="100%" style="border-collapse:collapse">
      <tr><td style="font-size:10.5px;color:#94a3b8;padding:0 2px 4px">ページ</td><td align="right" style="font-size:10.5px;color:#94a3b8;padding:0 2px 4px">SS</td><td align="right" style="font-size:10.5px;color:#94a3b8;padding:0 2px 4px">直帰</td></tr>
      ${landingRows || '<tr><td style="color:#999;font-size:13px;padding:8px 0">データなし</td></tr>'}
    </table>

    <div style="margin:24px 0 6px">
      <a href="${GA4_LINK}" style="display:inline-block;background:${C.fire};color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:700;font-size:14px">GA4で詳細を見る</a>
    </div>
    <div style="margin-top:16px;padding:13px 15px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:12px;color:${C.warm};line-height:1.8">
      ${FN_BASE && APPROVAL_SECRET && AUTO_COUNT > 0
        ? `${AUTO_COUNT === Infinity ? "すべての提案" : `上位${AUTO_COUNT}件`}を<b>自動で実装します</b>（🤖表示）。AIが対象ページを直して自己採点し、合格したものは<b>承認を待たず自動で本番公開</b>します。<b>あなたの操作は不要です</b> — 実装結果（公開・見送りの内訳）は別便のサマリーメールでまとめて報告します（各変更に［↩️ 元に戻す］付き・履歴に残るので公開後でも戻せます）。ショップ本体（EC）が対象で、ブログ記事は別便が担当します。`
        : FN_BASE && APPROVAL_SECRET
        ? "各提案の<b>［✅ 承認して実装する］</b>を押すと、AIがその対象ページを直して自己採点し、合格すればプレビューを作って「公開しますか？」とメールします（公開はもう一度ワンクリック・履歴に残るので元に戻せます）。見送る場合は<b>［却下］</b>。ショップ本体（EC）が対象で、ブログ記事は別便が担当します。"
        : "これはショップ本体（EC）の<b>毎日のAI改善提案</b>です。ブログ記事の改善は別便（SLOW FIRE JOURNAL 改善提案）が担当します。まずは提案の精度をご確認ください。"}
    </div>
    <div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:11px;color:#aaa">
      SLOW FIRE SHOP（${esc(SC_SITE)}）／ GA4・Search Console をAIが分析
    </div>
  </div>
</div>`;

  // ---- 日次レポートを統合して1通で送る（取得失敗時はAI改善のみで送る）----
  let daily = null;
  try { daily = await buildDailyReport(); }
  catch (e) { console.error("日次レポート統合失敗→AI改善のみで送信:", e.message); }

  const combinedHtml = daily ? `${daily.html}\n<div style="height:22px"></div>\n${html}` : html;
  const subject = daily
    ? `【SLOW FIRE 日次＋AI改善】${daily.headerDate}｜PV ${num(daily.pv)}・ユーザー ${num(daily.users)}｜改善${proposals.length}件${autoSet.size ? "(自動実装中)" : ""}`
    : `【SLOW FIRE SHOP】AI改善提案 ${proposals.length}件｜${when}（PV ${num(pv)}・前期比${delta(pv, ppv) >= 0 ? "+" : ""}${delta(pv, ppv)}%）`;
  setOutput({ ready: "true", subject, html: combinedHtml });
  console.log(`提案 ${proposals.length}件 生成。PV=${pv} (前期比 ${delta(pv, ppv)}%)、日次統合=${daily ? "あり" : "なし"}`);
}

main().catch((e) => {
  console.error("致命的エラー:", e);
  setOutput({ ready: "false" });
  process.exit(0);
});
