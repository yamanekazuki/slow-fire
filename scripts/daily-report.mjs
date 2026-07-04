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
//   SITE_ORIGIN                 … 人気ページのリンク先ドメイン（省略時 SC_SITEのorigin）
// 必須シークレットが無いときは、何もせず正常終了（generated=false）する。
// =============================================================================

import crypto from "node:crypto";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const PROPERTY = process.env.GA4_PROPERTY_ID;
const SC_SITE = process.env.SC_SITE_URL || "https://yamanekazuki.github.io/slow-fire/";
const GA4_LINK = process.env.GA4_DASHBOARD_URL || "https://analytics.google.com/";
const LABEL = process.env.SITE_LABEL || "SLOW FIRE"; // メール件名・ヘッダのサイト名
// 人気ページをクリックできるようにするためのサイトのドメイン（例 https://yamanekazuki.github.io）
const ORIGIN = process.env.SITE_ORIGIN || (() => { try { return new URL(SC_SITE).origin; } catch { return ""; } })();

// ---- GITHUB_OUTPUT ヘルパ -----------------------------------------------------
function setOutput(pairs) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  let body = "";
  for (const [k, v] of Object.entries(pairs)) body += `${k}<<RPTEOF\n${v}\nRPTEOF\n`;
  appendFileSync(f, body);
}

// ※秘密未設定チェックは buildDailyReport() 内で行う（shop-improvement.mjs からの
//   import時に process.exit してしまわないように。単体実行時はCLI部で ready=false を出す）

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
const C = { ink: "#1b1b1b", sub: "#666", faint: "#9a9a9a", line: "#ececec", fire: "#c2410c", bg: "#fff" };

// ---- 用語・分類の日本語辞書 ---------------------------------------------------
// 流入元（チャネル大分類）→ [日本語名, ひとこと説明]
const CH_JP = {
  "Direct": ["直接", "URL直打ち・ブックマーク・アプリ・QR等（経由元なし）"],
  "Organic Search": ["自然検索", "Google・Yahoo等の検索結果から（広告・AI検索は含まない）"],
  "Organic Social": ["SNS", "X・Instagram等の投稿やプロフィール経由"],
  "Organic Video": ["動画", "YouTube等の動画から"],
  "Organic Shopping": ["ショッピング", "Googleショッピング等の無料枠から"],
  "Referral": ["他サイト", "別サイトに貼られたリンク経由"],
  "Paid Search": ["検索広告", "リスティング広告から"],
  "Paid Social": ["SNS広告", "SNS上の広告から"],
  "Paid Shopping": ["ショッピング広告", "商品広告から"],
  "Display": ["ディスプレイ広告", "バナー広告から"],
  "Email": ["メール", "メール内のリンクから"],
  "Affiliate": ["アフィリエイト", "提携サイト経由"],
  "Audio": ["音声", "Podcast等の音声から"],
  "SMS": ["SMS", "ショートメッセージから"],
  "Mobile Push Notifications": ["プッシュ通知", "アプリ通知から"],
  "Cross-network": ["広告横断", "Google広告の複数面をまたぐ配信（参照元は非開示のことが多い）"],
  "Unassigned": ["未分類", "判別情報が取得できず、どの経路か特定できなかったセッション"],
  "(other)": ["その他", "少数のその他チャネル"],
};
function chParts(name) {
  return CH_JP[name] || [name || "(不明)", ""];
}

// 参照元（source / medium）→ 人が読める名前
function srcJP(source, medium) {
  const s = (source || "").toLowerCase();
  const m = (medium || "").toLowerCase();
  const key = `${s} / ${m}`;
  const map = [
    [/^google\b.*(organic|referral)/, "Google（自然検索）"],
    [/^google\b.*(cpc|paid|ppc)/, "Google広告"],
    [/^yahoo\b.*organic/, "Yahoo（自然検索）"],
    [/^bing\b.*organic/, "Bing（自然検索）"],
    [/duckduckgo/, "DuckDuckGo（検索）"],
    [/\(direct\)|(^|\s)direct\b|\/ *\(none\)/, "直接（URL・ブックマーク等）"],
    [/chatgpt|openai|chat\.com/, "ChatGPT（AI検索）"],
    [/perplexity/, "Perplexity（AI検索）"],
    [/gemini|bard/, "Gemini（AI検索）"],
    [/copilot/, "Copilot（AI検索）"],
    [/\bt\.co[ /]|x\.com|twitter/, "X（旧Twitter）"],
    [/note\.com/, "note"],
    [/youtube|youtu\.be/, "YouTube"],
    [/instagram/, "Instagram"],
    [/facebook|fb\.com|l\.facebook/, "Facebook"],
    [/lin\.ee|^line[ /]/, "LINE"],
    [/linkedin/, "LinkedIn"],
    [/data not available/, "非開示（Google広告等・参照元が公開されない）"],
    [/not set|not provided/, "不明（参照元が記録されなかった）"],
  ];
  for (const [re, jp] of map) if (re.test(key)) return jp;
  // 該当なしは「参照元（種別）」で素直に表示
  return `${source || "不明"}${medium && medium !== "(none)" ? `（${medium}）` : ""}`;
}

// 主なアクション（eventName）→ 日本語の意味
const EVENT_JP = {
  page_view: "ページ表示（＝PV。1ページ開くごとに1件）",
  user_engagement: "実際に見て操作していた滞在（画面を開いていた時間の記録）",
  session_start: "訪問（セッション）の開始",
  first_visit: "そのユーザーの初回訪問",
  scroll: "ページを最後（約9割）まで読み進めた",
  click: "外部リンクのクリック",
  view_search_results: "サイト内検索を実行した",
  form_start: "フォームの入力を開始した",
  form_submit: "フォームを送信した",
  file_download: "ファイルをダウンロードした",
  video_start: "動画の再生を開始した",
  video_progress: "動画を一定まで再生した",
  video_complete: "動画を最後まで再生した",
  purchase: "購入が完了した",
  begin_checkout: "購入手続きを開始した",
  add_to_cart: "カートに追加した",
  view_item: "商品を閲覧した",
  select_content: "コンテンツ（リンク等）を選択した",
  scroll_to_bottom: "ページ最下部まで到達した",
};
function eventJP(name) {
  return EVENT_JP[name] || "サイト上の操作（カスタム計測）";
}

// ---- セクション部品 ----------------------------------------------------------
// 見出し（＋任意の注釈）
function heading(title, note) {
  return `<h3 style="margin:26px 0 ${note ? "2px" : "8px"};font-size:14px;color:${C.ink}">${title}</h3>${
    note ? `<div style="font-size:11px;color:${C.faint};margin:0 0 8px;line-height:1.6">${note}</div>` : ""
  }`;
}

// 汎用の2列リスト（label に説明を添えられる版）
function listSection(title, note, rows) {
  const body =
    rows.length === 0
      ? `<tr><td style="padding:10px 0;color:#999;font-size:13px">データなし</td></tr>`
      : rows
          .map(
            (r) =>
              `<tr><td style="padding:7px 2px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink}">${
                r.label
              }${r.sub ? `<div style="font-size:11px;color:${C.faint};margin-top:1px;line-height:1.5">${r.sub}</div>` : ""}</td><td style="padding:7px 2px;border-bottom:1px solid ${C.line};text-align:right;font-weight:700;white-space:nowrap;font-size:13px;color:${C.ink};vertical-align:top">${esc(
                r.value
              )}</td></tr>`
          )
          .join("");
  return `${heading(title, note)}
    <table role="presentation" width="100%" style="border-collapse:collapse">${body}</table>`;
}

// 参照元をチャネル別に入れ子で表示（例：自然検索 10 → Google 8 / Yahoo 2）
function breakdownSection(title, note, rows) {
  // rows: [{ labels:[channel, source, medium], value }]
  if (!rows || rows.length === 0) {
    return `${heading(title, note)}<table role="presentation" width="100%" style="border-collapse:collapse"><tr><td style="padding:10px 0;color:#999;font-size:13px">データなし</td></tr></table>`;
  }
  const groups = new Map();
  for (const r of rows) {
    const ch = r.labels[0] || "Unassigned";
    if (!groups.has(ch)) groups.set(ch, { total: 0, subs: [] });
    const g = groups.get(ch);
    g.total += r.value;
    g.subs.push({ name: srcJP(r.labels[1], r.labels[2]), value: r.value });
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  let body = "";
  for (const [ch, g] of ordered) {
    const [jp] = chParts(ch);
    body += `<tr><td style="padding:9px 2px 3px;font-size:13px;font-weight:800;color:${C.ink}">${esc(jp)}</td><td style="padding:9px 2px 3px;text-align:right;font-weight:800;font-size:13px;color:${C.ink};white-space:nowrap">${num(g.total)}</td></tr>`;
    // 同一チャネル内は多い順、上位のみ
    g.subs.sort((a, b) => b.value - a.value);
    for (const s of g.subs) {
      body += `<tr><td style="padding:2px 2px 2px 14px;font-size:12px;color:${C.sub}">└ ${esc(s.name)}</td><td style="padding:2px 2px;text-align:right;font-size:12px;color:${C.sub};white-space:nowrap">${num(s.value)}</td></tr>`;
    }
  }
  return `${heading(title, note)}
    <table role="presentation" width="100%" style="border-collapse:collapse;border-bottom:1px solid ${C.line}">${body}</table>`;
}

// 人気ページ（日本語タイトル＋クリックできるURL）
function pageSection(title, note, rows) {
  const body =
    !rows || rows.length === 0
      ? `<tr><td style="padding:10px 0;color:#999;font-size:13px">データなし</td></tr>`
      : rows
          .map((r) => {
            const path = r.path || "/";
            const href = ORIGIN ? ORIGIN + path : "";
            const titleText = r.title && r.title !== "(not set)" ? r.title : path;
            const titleHtml = href
              ? `<a href="${esc(href)}" style="color:${C.fire};text-decoration:none;font-weight:600">${esc(titleText)}</a>`
              : `<span style="font-weight:600">${esc(titleText)}</span>`;
            return `<tr><td style="padding:8px 2px;border-bottom:1px solid ${C.line};font-size:13px;color:${C.ink}">${titleHtml}<div style="font-size:11px;color:${C.faint};margin-top:2px;word-break:break-all">${esc(path)}</div></td><td style="padding:8px 2px;border-bottom:1px solid ${C.line};text-align:right;font-weight:700;white-space:nowrap;font-size:13px;color:${C.ink};vertical-align:top">${num(r.value)}</td></tr>`;
          })
          .join("");
  return `${heading(title, note)}
    <table role="presentation" width="100%" style="border-collapse:collapse">${body}</table>`;
}

function keywordSection(rows) {
  const note = "Google検索で自社サイトが「どんな言葉で表示・クリックされたか」。SNSやAI検索（ChatGPT等）は含みません。";
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
  return `${heading("🔍 検索キーワード TOP10（直近7日・Google検索）", note)}
    <table role="presentation" width="100%" style="border-collapse:collapse">${head}${body}</table>`;
}

// ---- メイン ------------------------------------------------------------------
// 日次レポートを生成して {subject, html, pv, users, headerDate} を返す。
// 秘密が未設定なら null（shop-improvement.mjs の統合メールからも使う）。
export async function buildDailyReport() {
  if (!SA_JSON || !PROPERTY) {
    console.log("未設定（GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID）。日次レポートをスキップします。");
    return null;
  }
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

  // 汎用の内訳取得（1つ失敗しても全体は止めない）
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

  const channels = await dimReport(["sessionDefaultChannelGroup"], "sessions", 10);
  // 参照元はチャネル込みで取得 → チャネル別の入れ子表示にする
  const referrals = await dimReport(["sessionDefaultChannelGroup", "sessionSource", "sessionMedium"], "sessions", 25);
  // 人気ページはパス＋ページタイトルで取得 → パス単位に重複排除
  const pagesRaw = await dimReport(["pagePath", "pageTitle"], "screenPageViews", 25);
  const pages = (() => {
    if (!pagesRaw) return null;
    const seen = new Map();
    for (const r of pagesRaw) {
      const path = r.labels[0] || "/";
      if (!seen.has(path)) seen.set(path, { path, title: r.labels[1] || "", value: r.value });
      else seen.get(path).value += r.value; // 同一パスの別タイトルは合算
    }
    return [...seen.values()].sort((a, b) => b.value - a.value).slice(0, 10);
  })();
  const actions = await dimReport(["eventName"], "eventCount", 15);

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
  // 流入元（大分類）— 日本語名＋説明つき
  sections.push(
    listSection(
      "🟧 流入元（前日・大分類／セッション）",
      "そのセッションがどの経路で来たか。※AI検索（ChatGPT等）は「自然検索」に含まれず、多くは「他サイト」か「直接」に分類されます。",
      channels
        ? channels.map((r) => {
            const [jp, desc] = chParts(r.labels[0]);
            return { label: jp, sub: desc, value: num(r.value) };
          })
        : []
    )
  );
  // 参照元の詳細 — チャネル別の内訳（例：自然検索 10 → Google 8 / Yahoo 2）
  sections.push(
    breakdownSection(
      "🔗 参照元の詳細（前日・チャネル別の内訳／セッション）",
      "上の流入元を、具体的にどのサイト・検索からかまで分解したものです。",
      referrals
    )
  );
  sections.push(keywordSection(keywords));
  // 人気ページ — タイトル＋クリックできるURL
  sections.push(
    pageSection(
      "📄 人気ページ TOP10（前日・PV）",
      "どのページが見られたか。タイトルをクリックすると実際のページが開きます。",
      pages
    )
  );
  // 主なアクション — イベント名に日本語説明を添える
  sections.push(
    listSection(
      "⚡ 主なアクション（前日・イベント数）",
      "サイト内で起きた操作の回数。用語（page_view 等）の意味は各行の説明のとおりです。",
      actions ? actions.map((r) => ({ label: r.labels[0], sub: eventJP(r.labels[0]), value: num(r.value) })) : []
    )
  );

  const html = `<div style="font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;max-width:620px;margin:0 auto;background:${C.bg};color:${C.ink}">
  <div style="background:#080604;border-radius:10px 10px 0 0;padding:22px 24px">
    <div style="color:${C.fire};font-size:12px;letter-spacing:.12em;font-weight:700">${LABEL} — DAILY ANALYTICS</div>
    <div style="color:#fff;font-size:21px;font-weight:800;margin-top:6px">${headerDate}（前日）のサイト数値</div>
  </div>
  <div style="border:1px solid ${C.line};border-top:none;border-radius:0 0 10px 10px;padding:22px 24px">
    <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:6px"><tr>
      ${stat(pv, "PV")}${stat(users, "ユーザー")}${stat(sessions, "セッション")}${stat(events, "イベント")}
    </tr></table>
    <div style="font-size:11px;color:${C.faint};text-align:center;line-height:1.7;margin:2px 0 8px">
      PV＝表示回数　／　ユーザー＝訪問した人数（重複なし）　／　セッション＝訪問の回数　／　イベント＝操作の回数
    </div>
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
      <b>流入元</b>：そのセッションがどこ経由で来たか（検索/SNS/直接など）。<br>
      <b>自然検索</b>：Google・Yahoo等の検索結果からの訪問。広告・AI検索（ChatGPT等）は含みません。<br>
      <b>直接</b>：URL直打ち・ブックマーク・アプリ内リンクなど、経由元が分からない訪問。<br>
      <b>未分類（Unassigned）</b>：経路を判別する情報が取れなかった訪問。
    </div>
    <div style="border-top:1px solid ${C.line};margin-top:22px;padding-top:14px;font-size:11px;color:#aaa">
      ${LABEL}（${SC_SITE}）／ 毎朝5時に自動送信
    </div>
  </div>
</div>`;

  const subject = `【${LABEL} 日次レポート】${headerDate}｜PV ${num(pv)}・ユーザー ${num(users)}`;
  return { subject, html, pv, users, headerDate, date: yesterday };
}

// ---- CLI（単体実行時のみ。通常は shop-improvement.mjs が import して統合メールに使う）----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildDailyReport()
    .then((r) => {
      if (!r) { setOutput({ ready: "false" }); return; }
      setOutput({ ready: "true", subject: r.subject, html: r.html, date: r.date });
      console.log(`レポート生成完了: ${r.subject}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
