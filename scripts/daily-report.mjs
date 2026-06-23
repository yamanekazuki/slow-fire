// =============================================================================
// SLOW FIRE — 日次アナリティクスレポート生成
// -----------------------------------------------------------------------------
// 毎朝7:00 JST に GitHub Actions から実行。GA4 Data API と Search Console API を
// 叩いて「前日のサイト数値」レポートのHTMLを組み立て、GITHUB_OUTPUT に出力する。
// メール送信はワークフロー側（dawidd6/action-send-mail）が担当。
//
// 認証は Google サービスアカウントのJWTを自前で署名（外部依存なし / Node20+）。
//
// 必要な環境変数（GitHub Secrets）:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントのJSONキー全文（必須）
//   GA4_PROPERTY_ID             … GA4の数値プロパティID（例 123456789）（必須）
//   SC_SITE_URL                 … Search Consoleプロパティ（省略時 slow-fire のURL）
//   GA4_DASHBOARD_URL           … 「GA4で詳細を見る」リンク先（省略時 GA4トップ）
// 必須シークレットが無いときは、何もせず正常終了（generated=false）する。
// =============================================================================

import crypto from "node:crypto";
import { appendFileSync } from "node:fs";

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.GA4_PROPERTY_ID;
const SC_SITE = process.env.SC_SITE_URL || "https://yamanekazuki.github.io/slow-fire/";
const GA4_LINK = process.env.GA4_DASHBOARD_URL || "https://analytics.google.com/";

// ---- GITHUB_OUTPUT ヘルパ -----------------------------------------------------
function setOutput(pairs) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  let body = "";
  for (const [k, v] of Object.entries(pairs)) body += `${k}<<RPTEOF\n${v}\nRPTEOF\n`;
  appendFileSync(f, body);
}

if (!SA_JSON || !PROPERTY) {
  console.log("未設定（GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID）。レポートをスキップします。");
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
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token取得失敗 ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

// ---- API 呼び出し ------------------------------------------------------------
async function ga4RunReport(token, requestBody) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );
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

// ---- 日付（JST）-------------------------------------------------------------
const WD = "日月火水木金土";
function jstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}
const base = jstNow();
const yDate = addDays(base, -1);
const yesterday = ymd(yDate);
const sevenAgo = ymd(addDays(base, -7)); // 7daysAgo..yesterday = 7日間
// Search Console はデータ確定に遅延があるため、確定済みの窓（8〜2日前）を使う
const scStart = ymd(addDays(base, -8));
const scEnd = ymd(addDays(base, -2));
const headerDate = `${yDate.getUTCMonth() + 1}月${yDate.getUTCDate()}日（${WD[yDate.getUTCDay()]}）`;

// ---- 整形ヘルパ --------------------------------------------------------------
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function num(n) {
  return Number(n || 0).toLocaleString("ja-JP");
}
const C = { ink: "#1b1b1b", sub: "#666", line: "#ececec", fire: "#c2410c", bg: "#fff" };

function listSection(title, rows) {
  const body =
    rows.length === 0
      ? `<tr><td style="padding:10px 0;color:#999;font-size:13px">データなし</td></tr>`
      : rows
          .map(
            (r) =>
              `<tr><td style="padding:7px 2px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink}">${esc(
                r.label
              )}</td><td style="padding:7px 2px;border-bottom:1px solid ${C.line};text-align:right;font-weight:700;white-space:nowrap;font-size:13px;color:${C.ink}">${esc(
                r.value
              )}</td></tr>`
          )
          .join("");
  return `<h3 style="margin:26px 0 8px;font-size:14px;color:${C.ink}">${title}</h3>
    <table role="presentation" width="100%" style="border-collapse:collapse">${body}</table>`;
}

function keywordSection(rows) {
  const head = `<tr>
      <th align="left"  style="font-size:11px;color:${C.sub};font-weight:600;padding:4px 2px;border-bottom:2px solid ${C.line}">キーワード</th>
      <th align="right" style="font-size:11px;color:${C.sub};font-weight:600;padding:4px 2px;border-bottom:2px solid ${C.line}">クリック</th>
      <th align="right" style="font-size:11px;color:${C.sub};font-weight:600;padding:4px 2px;border-bottom:2px solid ${C.line}">表示</th>
      <th align="right" style="font-size:11px;color:${C.sub};font-weight:600;padding:4px 2px;border-bottom:2px solid ${C.line}">平均順位</th>
    </tr>`;
  const body =
    rows.length === 0
      ? `<tr><td colspan="4" style="padding:10px 0;color:#999;font-size:13px">データなし（Search Console未接続、またはデータ蓄積待ち）</td></tr>`
      : rows
          .map(
            (r) =>
              `<tr>
        <td style="font-size:13px;padding:6px 2px;border-bottom:1px solid ${C.line};color:${C.ink}">${esc(r.q)}</td>
        <td align="right" style="font-size:13px;padding:6px 2px;border-bottom:1px solid ${C.line};font-weight:700">${num(r.clicks)}</td>
        <td align="right" style="font-size:13px;padding:6px 2px;border-bottom:1px solid ${C.line}">${num(r.impr)}</td>
        <td align="right" style="font-size:13px;padding:6px 2px;border-bottom:1px solid ${C.line}">${r.pos.toFixed(1)}位</td>
      </tr>`
          )
          .join("");
  return `<h3 style="margin:26px 0 8px;font-size:14px;color:${C.ink}">🔍 検索キーワード TOP10（直近7日・Google検索）</h3>
    <table role="presentation" width="100%" style="border-collapse:collapse">${head}${body}</table>`;
}

// ---- メイン ------------------------------------------------------------------
async function main() {
  const creds = JSON.parse(SA_JSON);
  const token = await getAccessToken(creds, [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);

  // 前日の合計（PV/ユーザー/セッション/イベント）
  const totalsBody = (start, end) => ({
    dateRanges: [{ startDate: start, endDate: end }],
    metrics: [
      { name: "screenPageViews" },
      { name: "totalUsers" },
      { name: "sessions" },
      { name: "eventCount" },
    ],
  });
  const dayT = await ga4RunReport(token, totalsBody("yesterday", "yesterday"));
  const weekT = await ga4RunReport(token, totalsBody("7daysAgo", "yesterday"));
  const mv = (r) => (r.rows && r.rows[0] ? r.rows[0].metricValues.map((m) => Number(m.value)) : [0, 0, 0, 0]);
  const [pv, users, sessions, events] = mv(dayT);
  const [wpv, wusers, wsessions] = mv(weekT);

  // 各内訳（GA4）— 1つ失敗しても全体は止めない
  const dimReport = async (dims, metric, limit) => {
    try {
      const res = await ga4RunReport(token, {
        dateRanges: [{ startDate: "yesterday", endDate: "yesterday" }],
        dimensions: dims.map((name) => ({ name })),
        metrics: [{ name: metric }],
        orderBys: [{ metric: { metricName: metric }, desc: true }],
        limit: String(limit),
      });
      return (res.rows || []).map((row) => ({
        labels: row.dimensionValues.map((d) => d.value),
        value: Number(row.metricValues[0].value),
      }));
    } catch (e) {
      console.error("dimReport失敗:", e.message);
      return null;
    }
  };

  const channels = await dimReport(["sessionDefaultChannelGroup"], "sessions", 8);
  const referrals = await dimReport(["sessionSource", "sessionMedium"], "sessions", 8);
  const pages = await dimReport(["pagePath"], "screenPageViews", 10);
  const actions = await dimReport(["eventName"], "eventCount", 20);

  // 検索キーワード（Search Console）
  let keywords = [];
  try {
    const sc = await scQuery(token, {
      startDate: scStart,
      endDate: scEnd,
      dimensions: ["query"],
      rowLimit: 10,
    });
    keywords = (sc.rows || []).map((r) => ({
      q: r.keys[0],
      clicks: r.clicks,
      impr: r.impressions,
      pos: r.position,
    }));
  } catch (e) {
    console.error("Search Console取得失敗:", e.message);
  }

  // ---- HTML 組み立て ----
  const stat = (n, label) =>
    `<td align="center" style="padding:6px 10px"><div style="font-size:30px;font-weight:800;color:${C.ink};line-height:1">${num(
      n
    )}</div><div style="font-size:11px;color:${C.sub};margin-top:4px">${label}</div></td>`;

  const sections = [];
  sections.push(
    listSection(
      "🟧 流入元（前日・大分類／セッション）",
      channels ? channels.map((r) => ({ label: r.labels[0] || "(不明)", value: num(r.value) })) : []
    )
  );
  sections.push(
    listSection(
      "🔗 参照元の詳細（前日・どのサイト/検索から／セッション）",
      referrals
        ? referrals.map((r) => ({ label: `${r.labels[0] || "(not set)"}　${r.labels[1] || ""}`.trim(), value: num(r.value) }))
        : []
    )
  );
  sections.push(keywordSection(keywords));
  sections.push(
    listSection(
      "📄 人気ページ TOP10（前日・PV）",
      pages ? pages.map((r) => ({ label: r.labels[0] || "/", value: num(r.value) })) : []
    )
  );
  sections.push(
    listSection(
      "⚡ 主なアクション（前日・イベント数）",
      actions ? actions.map((r) => ({ label: r.labels[0], value: num(r.value) })) : []
    )
  );

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:620px;margin:0 auto;background:${C.bg};color:${C.ink}">
  <div style="background:#080604;border-radius:10px 10px 0 0;padding:22px 24px">
    <div style="color:${C.fire};font-size:12px;letter-spacing:.12em;font-weight:700">SLOW FIRE — DAILY ANALYTICS</div>
    <div style="color:#fff;font-size:21px;font-weight:800;margin-top:6px">${headerDate}（前日）のサイト数値</div>
  </div>
  <div style="border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:22px 24px">
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:6px"><tr>
      ${stat(pv, "PV")}${stat(users, "ユーザー")}${stat(sessions, "セッション")}${stat(events, "イベント")}
    </tr></table>
    <div style="background:#faf7f2;border:1px solid ${C.line};border-radius:6px;padding:10px 12px;font-size:12px;color:${C.sub};text-align:center">
      直近7日合計：PV ${num(wpv)} ／ ユーザー ${num(wusers)} ／ セッション ${num(wsessions)}
    </div>
    ${sections.join("\n")}
    <div style="margin:28px 0 6px">
      <a href="${GA4_LINK}" style="display:inline-block;background:${C.fire};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:14px">GA4で詳細を見る</a>
    </div>
    <h3 style="margin:26px 0 8px;font-size:13px;color:${C.ink}">📖 用語の説明</h3>
    <div style="font-size:12px;color:${C.sub};line-height:1.9">
      <b>PV</b>：ページが表示された回数。1人が3ページ見れば3PV。<br>
      <b>ユーザー</b>：来た人数（重複なし）。<br>
      <b>セッション</b>：訪問の回数。朝と夜なら2セッション。<br>
      <b>イベント</b>：表示・スクロール・クリック等あらゆる操作の回数。<br>
      <b>流入元</b>：そのセッションがどこ経由で来たか（検索/SNS/直接など）。
    </div>
    <div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:11px;color:#aaa">
      SLOW FIRE（${SC_SITE}）／ 毎朝7時に自動送信
    </div>
  </div>
</div>`;

  const subject = `【SLOW FIRE 日次レポート】${headerDate}｜PV ${num(pv)}・ユーザー ${num(users)}`;
  setOutput({ ready: "true", subject, html, date: yesterday });
  console.log(`レポート生成完了: ${subject}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
