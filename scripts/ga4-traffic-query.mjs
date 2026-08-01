#!/usr/bin/env node
// 一時調査: 指定期間の流入元と member_join コンバージョンの流入元を出力する
// 実行環境: GitHub Actions (secrets: GOOGLE_SERVICE_ACCOUNT_JSON / GA4_PROPERTY_ID)
import crypto from "node:crypto";

const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const property = process.env.GA4_PROPERTY_ID;
if (!sa || !property) throw new Error("secrets未設定");

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000);
  const jwt = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(jwt).sign(sa.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}.${sig}`,
  });
  return (await res.json()).access_token;
}

const t = await token();
async function report(body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return (j.rows || []).map((r) => [...r.dimensionValues.map((d) => d.value), ...r.metricValues.map((m) => m.value)]);
}

const range = [{ startDate: "2026-07-28", endDate: "2026-08-01" }];

console.log("=== member_join の流入元（日付/参照元/メディア） ===");
for (const row of await report({
  dateRanges: range,
  dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }, { name: "landingPagePlusQueryString" }],
  metrics: [{ name: "eventCount" }],
  dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "member_join" } } },
})) console.log(row.join(" | "));

console.log("\n=== 期間全体のセッション流入元 ===");
for (const row of await report({
  dateRanges: range,
  dimensions: [{ name: "date" }, { name: "sessionSource" }, { name: "sessionMedium" }],
  metrics: [{ name: "sessions" }],
  orderBys: [{ dimension: { dimensionName: "date" } }],
})) console.log(row.join(" | "));

console.log("\n=== オーガニック検索のランディングページ ===");
for (const row of await report({
  dateRanges: range,
  dimensions: [{ name: "date" }, { name: "landingPagePlusQueryString" }],
  metrics: [{ name: "sessions" }],
  dimensionFilter: { filter: { fieldName: "sessionMedium", stringFilter: { value: "organic" } } },
})) console.log(row.join(" | "));
