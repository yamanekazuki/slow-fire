// YORON BBQ ループ共通: Notion読み書き・LINE送信・Slack DM・claudeヘッドレスの薄いラッパ
// （agenda-loop / minutes-todo が共用。正本はここ）
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accessSecret } from "../../../../tools/lib/gcp-sa.mjs";

export const HOME = os.homedir();
export const BBQ_PARENT_PAGE_ID = "2d608460013480cb94afdb1564a84f86"; // Notion「🐿️ バーベキュー」
export const BBQ_LINE_GROUP_ID = "C29fee6f13100a7aa7f25a03270a24e7b"; // 3人の運営LINEグループ
export const NOTION_PROJECT = "tldv-notion-pote";
export const GCP_PROJECT = "cook-log-df240";
export const SLACK_DM_USER = "U7XLRM33R"; // 山根さん

// ---------- Slack DM ----------
export async function slackDM(text) {
  try {
    const token = process.env.SLACK_BOT_TOKEN?.trim() || (await accessSecret("foward-deployed-pm", "SLACK_BOT_TOKEN"));
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: SLACK_DM_USER, text }),
    });
  } catch (e) { console.error(`Slack DM失敗: ${e.message}`); }
}

// ---------- LINE ----------
let _lineToken;
export async function linePush(text, { noSend = false } = {}) {
  const body = `やまちゃんです！\n${text}`;
  if (noSend) { console.log(`[LINE未送信]\n----\n${body}\n----`); return true; }
  _lineToken ||= process.env.LINE_CHANNEL_TOKEN?.trim() || (await accessSecret(GCP_PROJECT, "LINE_CHANNEL_TOKEN"));
  try {
    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${_lineToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: BBQ_LINE_GROUP_ID, messages: [{ type: "text", text: body.slice(0, 4900) }] }),
    });
    if (res.ok) return true;
    const detail = (await res.text()).slice(0, 200);
    console.error(`LINE push失敗 ${res.status}: ${detail}`);
    await enqueueOutbox(body, `${res.status}: ${detail}`);
  } catch (e) {
    console.error(`LINE push例外: ${e.message}`);
    await enqueueOutbox(body, String(e.message).slice(0, 200));
  }
  return false;
}
// 送信できなかった報告は request-loop と同じ送信箱へ（無音消失ゼロ）
async function enqueueOutbox(text, lastError) {
  try {
    const { gcpAccessToken } = await import("../../../../tools/lib/gcp-sa.mjs");
    const token = await gcpAccessToken();
    await fetch(`https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents/line_outbox`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        groupId: { stringValue: BBQ_LINE_GROUP_ID },
        text: { stringValue: text.slice(0, 4900) },
        createdAt: { stringValue: new Date().toISOString() },
        lastError: { stringValue: String(lastError).slice(0, 300) },
      } }),
    });
    console.log("→ 送信箱(line_outbox)に退避。送れるようになったら request-loop が再送する");
  } catch (e) { console.error(`送信箱への退避も失敗: ${e.message}`); }
}

// ---------- Notion ----------
let _notionToken;
export async function notionToken() {
  _notionToken ||= process.env.NOTION_TOKEN?.trim() || (await accessSecret(NOTION_PROJECT, "NOTION_TOKEN"));
  return _notionToken;
}
export async function notion(pathname, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${await notionToken()}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`Notion ${method} ${pathname} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
export async function listChildBlocks(blockId) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const j = await notion(`/blocks/${blockId}/children${q}`);
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out;
}
const rt = (arr) => (arr || []).map((t) => t.plain_text || "").join("");
export function blockText(b) {
  const d = b[b.type] || {};
  const text = rt(d.rich_text);
  switch (b.type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${d.checked ? "x" : " "}] ${text}`;
    case "paragraph": return text;
    case "quote": return `> ${text}`;
    default: return text;
  }
}
/** ページ本文をMarkdown相当のテキストで取得（入れ子1段まで） */
export async function pageText(pageId, { depth = 1 } = {}) {
  const lines = [];
  const walk = async (id, d) => {
    for (const b of await listChildBlocks(id)) {
      const t = blockText(b);
      if (t) lines.push("  ".repeat(depth - d) + t);
      if (b.has_children && d > 0 && b.type !== "child_page") await walk(b.id, d - 1);
    }
  };
  await walk(pageId, depth);
  return lines.join("\n");
}
function toRichText(text) {
  const parts = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ content: text.slice(last, m.index), bold: false });
    parts.push({ content: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ content: text.slice(last), bold: false });
  if (!parts.length) parts.push({ content: text || "", bold: false });
  const rich = [];
  for (const p of parts) {
    let s = p.content;
    while (s.length > 2000) {
      rich.push({ type: "text", text: { content: s.slice(0, 2000) }, annotations: { bold: p.bold } });
      s = s.slice(2000);
    }
    rich.push({ type: "text", text: { content: s }, annotations: { bold: p.bold } });
  }
  return rich;
}
function lineToBlock(line) {
  const t = line.trimEnd();
  if (!t.trim()) return null;
  if (/^(---|\*\*\*)$/.test(t.trim())) return { object: "block", type: "divider", divider: {} };
  let m;
  if ((m = t.match(/^###\s+(.*)/))) return { object: "block", type: "heading_3", heading_3: { rich_text: toRichText(m[1]) } };
  if ((m = t.match(/^##\s+(.*)/))) return { object: "block", type: "heading_2", heading_2: { rich_text: toRichText(m[1]) } };
  if ((m = t.match(/^#\s+(.*)/))) return { object: "block", type: "heading_1", heading_1: { rich_text: toRichText(m[1]) } };
  if ((m = t.match(/^\s*[-*]\s+\[([ x])\]\s+(.*)/i))) return { object: "block", type: "to_do", to_do: { rich_text: toRichText(m[2]), checked: m[1].toLowerCase() === "x" } };
  if ((m = t.match(/^\s*[-*]\s+(.*)/))) return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: toRichText(m[1]) } };
  if ((m = t.match(/^\s*\d+\.\s+(.*)/))) return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: toRichText(m[1]) } };
  if ((m = t.match(/^>\s+(.*)/))) return { object: "block", type: "quote", quote: { rich_text: toRichText(m[1]) } };
  return { object: "block", type: "paragraph", paragraph: { rich_text: toRichText(t) } };
}
export function markdownToBlocks(md) {
  return (md || "").split("\n").map(lineToBlock).filter(Boolean);
}
export async function createChildPage(title) {
  const j = await notion("/pages", { method: "POST", body: {
    parent: { page_id: BBQ_PARENT_PAGE_ID },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
  } });
  return j.id;
}
export async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pageId}/children`, { method: "PATCH", body: { children: blocks.slice(i, i + 100) } });
  }
}
export const notionUrl = (pageId) => `https://app.notion.com/p/${String(pageId).replace(/-/g, "")}`;

// ---------- claude ヘッドレス（定額枠） ----------
export function claudeBin() {
  for (const p of [path.join(HOME, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (fs.existsSync(p)) return p;
  }
  return "claude";
}
export function claudeJson(prompt, { cwd = process.cwd(), model = "claude-opus-4-8", timeout = 900000 } = {}) {
  const out = execFileSync(claudeBin(), ["-p", prompt, "--model", model], {
    encoding: "utf8", timeout, cwd, maxBuffer: 32 * 1024 * 1024,
  });
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : out;
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error(`claude出力にJSONが見つからない: ${out.slice(0, 300)}`);
  return JSON.parse(raw.slice(s, e + 1));
}

// ---------- Googleカレンダー（山根さんのカレンダー＝あんBBQの招待が入る） ----------
const CAL_PROJECT = "foward-deployed-pm";
export async function calendarToken() {
  const [id, secret, refresh] = await Promise.all([
    accessSecret(CAL_PROJECT, "GMAIL_CLIENT_ID"),
    accessSecret(CAL_PROJECT, "GMAIL_CLIENT_SECRET"),
    accessSecret(CAL_PROJECT, "GCAL_REFRESH_TOKEN"),
  ]);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`カレンダー認証の更新に失敗: ${JSON.stringify(j).slice(0, 200)}`);
  return j.access_token;
}
/** 指定期間のイベント（yamane@potentialight.com のカレンダー） */
export async function calendarEvents(timeMinIso, timeMaxIso) {
  const token = await calendarToken();
  const u = new URL("https://www.googleapis.com/calendar/v3/calendars/yamane%40potentialight.com/events");
  u.searchParams.set("timeMin", timeMinIso);
  u.searchParams.set("timeMax", timeMaxIso);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", "250");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`カレンダー取得に失敗 HTTP ${r.status}`);
  return ((await r.json()).items || []).filter((e) => e.status !== "cancelled");
}
/** BBQ定例のカレンダー予定か（招待名「あんBBQ」。表記ゆれも拾う） */
export const isBbqTeirei = (ev) => /あんBBQ|あん ?BBQ|YORON ?BBQ ?定例|バーベキュー定例/i.test(ev?.summary || "");

// ---------- Firestore（LINEグループ会話ログ） ----------
export async function lineGroupLog(sinceIso) {
  const { gcpAccessToken } = await import("../../../../tools/lib/gcp-sa.mjs");
  const token = await gcpAccessToken();
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "line_group_log" }],
      where: { fieldFilter: { field: { fieldPath: "createdAt" }, op: "GREATER_THAN", value: { stringValue: sinceIso } } },
      orderBy: [{ field: { fieldPath: "createdAt" }, direction: "ASCENDING" }],
      limit: 400,
    } }),
  });
  if (!res.ok) throw new Error(`会話ログ取得に失敗 HTTP ${res.status}`);
  const v = (f) => f?.stringValue ?? "";
  return (await res.json()).filter((r) => r.document).map((r) => {
    const f = r.document.fields || {};
    return { who: v(f.who), text: v(f.text), at: v(f.createdAt), groupId: v(f.groupId) };
  }).filter((m) => !m.groupId || m.groupId === BBQ_LINE_GROUP_ID);
}
