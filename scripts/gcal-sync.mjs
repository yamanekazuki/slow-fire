#!/usr/bin/env node
/**
 * gcal-sync — BBQ予定台帳(schedule-events.json)をGoogleカレンダーへ同期
 *
 * 経緯: 2026-08-12 あんちゃんのLINE依頼「BBQのスケジュールを今後Googleカレンダーと
 * 連携して欲しい（afroanri0126@gmail.com）」。
 * SA(local-loops@)が所有する「YORON BBQ」カレンダーを作り、あんちゃん・山根さんへ
 * 共有（初回に招待メールが届く）。以後は台帳が正本で、このスクリプトが
 * 追加・変更・削除を丸ごと反映する（LLM呼び出しゼロ・冪等）。
 *
 * 呼び出し元: schedule-digest.mjs（週次）＋ request-loop.mjs（日程依頼の処理直後）
 * 単体実行:   node scripts/gcal-sync.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { gcpAccessToken } from "../../../tools/lib/gcp-sa.mjs";

const SCRIPTS = path.dirname(new URL(import.meta.url).pathname);
const LEDGER = path.join(SCRIPTS, "schedule-events.json");
const STATE = path.join(SCRIPTS, "gcal-sync-state.json");
const SCOPE = "https://www.googleapis.com/auth/calendar";
const API = "https://www.googleapis.com/calendar/v3";
const SHARE_WITH = ["afroanri0126@gmail.com", "yamane@potentialight.com"];
const ID_PREFIX = "bb"; // このスクリプトが作ったイベントの目印（他の予定は絶対に消さない）。※GCalのIDはa-vと数字のみ可

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

async function call(method, url, body) {
  const token = await gcpAccessToken(SCOPE);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.status === 204 ? {} : res.json();
}

// イベントIDは date+title から決定的に生成（同じ予定は何度流しても同じID＝冪等）
const eventId = (e) => ID_PREFIX + crypto.createHash("md5").update(`${e.date}|${e.title}`).digest("hex");

async function ensureCalendar(state) {
  if (state.calendarId) {
    const got = await call("GET", `${API}/calendars/${encodeURIComponent(state.calendarId)}`);
    if (!got.notFound) return state.calendarId;
  }
  const cal = await call("POST", `${API}/calendars`, { summary: "YORON BBQ", timeZone: "Asia/Tokyo" });
  state.calendarId = cal.id;
  log(`カレンダー新規作成: ${cal.id}`);
  for (const email of SHARE_WITH) {
    await call("POST", `${API}/calendars/${encodeURIComponent(cal.id)}/acl?sendNotifications=true`, {
      role: "writer", scope: { type: "user", value: email },
    });
    log(`共有(writer): ${email}`);
  }
  return cal.id;
}

async function main() {
  const ledger = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
  const calId = await ensureCalendar(state);
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

  const wanted = new Map();
  for (const e of ledger.events || []) {
    if (!e.date || !e.title) continue;
    const end = new Date(Date.parse(e.date) + 24 * 3600 * 1000).toISOString().slice(0, 10);
    wanted.set(eventId(e), {
      summary: e.title + (e.place ? `＠${e.place}` : ""),
      description: e.url || "",
      start: { date: e.date },
      end: { date: end },
    });
  }

  // 既存イベント一覧（自分が作ったID_PREFIX付きだけを管理対象にする）
  const existing = new Map();
  let pageToken = "";
  do {
    const j = await call("GET", `${API}/calendars/${encodeURIComponent(calId)}/events?maxResults=250&showDeleted=false${pageToken ? `&pageToken=${pageToken}` : ""}`);
    for (const ev of j.items || []) if (ev.id.startsWith(ID_PREFIX)) existing.set(ev.id, ev);
    pageToken = j.nextPageToken || "";
  } while (pageToken);

  let created = 0, updated = 0, removed = 0;
  for (const [id, body] of wanted) {
    const cur = existing.get(id);
    if (!cur) {
      await call("POST", `${API}/calendars/${encodeURIComponent(calId)}/events`, { id, ...body });
      created++;
    } else if (
      cur.summary !== body.summary || (cur.description || "") !== body.description ||
      cur.start?.date !== body.start.date || cur.end?.date !== body.end.date
    ) {
      await call("PATCH", `${API}/calendars/${encodeURIComponent(calId)}/events/${id}`, body);
      updated++;
    }
  }
  for (const id of existing.keys()) {
    if (!wanted.has(id)) { await call("DELETE", `${API}/calendars/${encodeURIComponent(calId)}/events/${id}`); removed++; }
  }
  log(`同期完了: 追加${created} 更新${updated} 削除${removed}（台帳${wanted.size}件 / カレンダー=${calId}）`);
}

main().catch((e) => { log(`⚠️ 同期失敗: ${e.message}`); process.exit(1); });
