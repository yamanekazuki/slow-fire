// GA4 Admin API: イベントスコープのカスタムディメンション cta_location を登録する一回限りのセットアップ。
// 実行環境: GitHub Actions（secrets: GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID）
// 冪等: 既に存在すれば何もせず成功扱い。
import crypto from "node:crypto";

const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const property = process.env.GA4_PROPERTY_ID;
if (!sa || !property) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID が未設定");

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
  iss: sa.client_email,
  scope: "https://www.googleapis.com/auth/analytics.edit",
  aud: sa.token_uri,
  iat: now,
  exp: now + 3600,
})}`;
const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
const tr = await fetch(sa.token_uri, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${sig}`,
  }),
});
const tj = await tr.json();
if (!tj.access_token) throw new Error(`トークン取得失敗: ${JSON.stringify(tj).slice(0, 300)}`);
const H = { Authorization: `Bearer ${tj.access_token}`, "Content-Type": "application/json" };
const base = `https://analyticsadmin.googleapis.com/v1beta/properties/${property}/customDimensions`;

const list = await (await fetch(base, { headers: H })).json();
if (list.error) throw new Error(`一覧取得失敗: ${JSON.stringify(list.error).slice(0, 300)}`);
if ((list.customDimensions || []).some((d) => d.parameterName === "cta_location")) {
  console.log("cta_location は登録済み。何もしません。");
  process.exit(0);
}
const cr = await fetch(base, {
  method: "POST",
  headers: H,
  body: JSON.stringify({
    parameterName: "cta_location",
    displayName: "CTA Location yoron cross site",
    description: "shop→yoron-bbq.com 誘導クリックの設置場所（banner/comm-site/comm-event/article-cta）",
    scope: "EVENT",
  }),
});
const cj = await cr.json();
if (cj.error) throw new Error(`作成失敗: ${JSON.stringify(cj.error).slice(0, 300)}`);
console.log(`作成成功: ${cj.name} (${cj.parameterName})`);
