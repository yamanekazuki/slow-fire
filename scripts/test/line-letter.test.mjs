// 登録者向けLINEのお便り（lib/line-letter.mjs）。外部通信なし・本番に触らない
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isLetterApprovalText, findLetterApproval, weekKeyJst, pickContent, composeLetter, lintLetter,
  quotaAllows, decide, reportTitle, mdDow,
} from "../lib/line-letter.mjs";

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("承認の言葉: 「配信OK」系だけを拾い、レポートOKや質問は拾わない", () => {
  for (const t of ["配信OK", "配信ok！", "配信 OK です", "この配信はOK", "配信して", "LINE配信OK", "配信オッケー", "@YORON 配信OK"]) assert.equal(isLetterApprovalText(t), true, t);
  for (const t of ["レポートOK", "OK", "配信OK?", "配信いつ？", "配信は来週にしよう", "配信OKかな？", ""]) assert.equal(isLetterApprovalText(t), false, t);
});

test("承認者・運営グループ・原稿を送った後の発言だけを承認とみなす（設定が無ければ必ず不承認）", () => {
  const logs = [
    { userId: "Uyama", groupId: "G", text: "配信OK", createdAt: "2026-11-10T08:00:00Z" },
    { userId: "Uother", groupId: "G", text: "配信OK", createdAt: "2026-11-11T08:00:00Z" },
  ];
  const opt = { approverUserIds: ["Uyama"], groupId: "G" };
  assert.ok(findLetterApproval(logs, "2026-11-10T07:00:00Z", opt));
  assert.equal(findLetterApproval(logs, "2026-11-10T09:00:00Z", opt), null, "原稿より前の発言");
  assert.equal(findLetterApproval(logs, "2026-11-10T07:00:00Z", { approverUserIds: ["Uother"], groupId: "X" }), null, "別グループ");
  assert.equal(findLetterApproval(logs, "2026-11-10T07:00:00Z", { approverUserIds: [], groupId: "G" }), null, "承認者未設定");
});

test("週は日本時間の月曜はじまり（日曜深夜のUTCずれで前後しない）", () => {
  assert.equal(weekKeyJst(new Date("2026-11-08T14:59:00Z")), "2026-11-02"); // JST 11/8(日) 23:59
  assert.equal(weekKeyJst(new Date("2026-11-08T15:00:00Z")), "2026-11-09"); // JST 11/9(月) 0:00
  assert.equal(mdDow("2026-11-22"), "11月22日（日）");
});

const EVENTS = [
  { date: "2026-11-22", kind: "bbq", no: "第4回", place: "新木場公園バーベキュー場" },
  { date: "2027-01-17", kind: "bbq", no: "第5回", place: "新木場か木場のバーベキュー場（調整中）" },
];
const TIPS = [{ id: "a", type: "tip", text: "やまちゃんです！コツの話。", sentAt: null }, { id: "b", type: "tip", text: "二つ目", sentAt: null }];

test("中身の選び方: 満員の回・会場調整中の回は案内しない／レポート→コツの順に本題を選ぶ", () => {
  const base = { today: "2026-11-08", events: EVENTS, tips: TIPS, reports: [{ date: "2026-10-25", title: "日曜日" }] };
  let p = pickContent({ ...base, regs: { "2026-11-22": 3 } });
  assert.equal(p.main.kind, "event", "空きがあれば月1BBQの案内");
  p = pickContent({ ...base, regs: { "2026-11-22": 15 } });
  assert.equal(p.main.kind, "report", "満員なら案内しない");
  p = pickContent({ ...base, today: "2026-12-20", regs: {} });
  assert.equal(p.main.kind, "tip", "1/17は会場調整中なので案内しない・レポートは21日を過ぎた");
  p = pickContent({ ...base, regs: { "2026-11-22": 15 }, announced: { "report:2026-10-25": "x", "tip:a": "x" } });
  assert.equal(p.main.tip.id, "b", "案内済みは飛ばす");
  p = pickContent({ ...base, today: "2026-11-15", regs: {} });
  assert.equal(p.main.kind, "report", "開催まで14日を切った回は案内しない");
});

test("おまけの読みもの: 前回のお便り以降の新しいものを最大2本", () => {
  const posts = [
    { date: "2026-11-06", title: "A", url: "u1" }, { date: "2026-11-05", title: "B", url: "u2" },
    { date: "2026-11-03", title: "C", url: "u3" }, { date: "2026-10-01", title: "古い", url: "u4" },
  ];
  const p = pickContent({ today: "2026-11-08", events: [], tips: TIPS, posts, lastSentYmd: "2026-11-02" });
  assert.deepEqual(p.extras.map((x) => x.post.title), ["A", "B"]);
  const onlyPosts = pickContent({ today: "2026-11-08", events: [], tips: [], posts });
  assert.equal(onlyPosts.main.kind, "posts");
  assert.equal(pickContent({ today: "2026-11-08", events: [], tips: [], posts: [] }), null);
});

test("文面: やまちゃんの口調で、AI・自動・絵文字などが入っていない", () => {
  const queue = JSON.parse(fs.readFileSync(path.join(SCRIPTS, "line-tips-queue.json"), "utf8"));
  const posts = [{ date: "2026-11-06", title: "子供が一人いるだけで、火はゆっくりになるんですよね", url: "https://yoron-bbq.com/blog/x.html" }];
  const picks = [
    pickContent({ today: "2026-11-08", events: EVENTS, regs: {}, tips: queue.items, posts }),
    pickContent({ today: "2026-11-08", events: [], reports: [{ date: "2026-10-25", title: "桜と栗の板" }], tips: [], posts }),
    pickContent({ today: "2026-11-08", events: [], tips: [], posts }),
    ...queue.items.map((t) => ({ main: { kind: "tip", key: `tip:${t.id}`, tip: t }, extras: [] })),
  ];
  for (const p of picks) {
    const text = composeLetter(p);
    assert.deepEqual(lintLetter(text), [], text);
    assert.match(text, /やまちゃん/);
  }
  assert.match(composeLetter(picks[0]), /11月22日（日）、新木場公園バーベキュー場/);
  assert.match(composeLetter(picks[1]), /https:\/\/yoron-bbq\.com\/report\/2026-10-25\//);
});

test("文面チェックは仕組みの気配を止める", () => {
  assert.ok(lintLetter("AIがまとめました").length);
  assert.ok(lintLetter("自動でお届けしています").length);
  assert.ok(lintLetter("日程は${date}").length);
  assert.ok(lintLetter("楽しかった🔥").length);
  assert.ok(lintLetter("").length);
  assert.equal(reportTitle("<title>桜と栗の板 | YORON BBQ レポート</title>"), "桜と栗の板");
});

test("無料枠: 運営グループの分を残せないなら送らない", () => {
  assert.equal(quotaAllows({ limit: 200, used: 40, recipients: 25 }).ok, true);
  assert.equal(quotaAllows({ limit: 200, used: 130, recipients: 25 }).ok, false);
  assert.equal(quotaAllows({ limit: "none", used: 999, recipients: 25 }).ok, true);
});

test("週1回まで・承認されたものだけ送る・1週間で取り下げ", () => {
  const now = new Date("2026-11-13T09:00:00Z"); // JST 11/13(金) 18:00
  const w = { id: "w", status: "waiting", createdAt: "2026-11-10T09:00:00Z" };
  assert.equal(decide({ ledger: { drafts: [] }, now }).action, "draft");
  assert.equal(decide({ ledger: { drafts: [w] }, now }).action, "wait");
  assert.equal(decide({ ledger: { drafts: [w] }, now, approval: { createdAt: "x" } }).action, "send");
  const sent = { status: "sent", createdAt: "2026-11-09T00:00:00Z", sentAt: "2026-11-10T09:00:00Z" };
  assert.equal(decide({ ledger: { drafts: [sent, w] }, now, approval: { createdAt: "x" } }).action, "wait", "今週はもう送った");
  assert.equal(decide({ ledger: { drafts: [sent] }, now }).action, "wait", "送った週は新しい原稿を作らない");
  assert.equal(decide({ ledger: { drafts: [w] }, now: new Date("2026-11-17T09:00:00Z") }).action, "expire");
  const expired = { ...w, status: "expired" };
  assert.equal(decide({ ledger: { drafts: [expired] }, now: new Date("2026-11-17T09:00:00Z") }).action, "draft", "取り下げた次の週は作り直す");
  assert.equal(decide({ ledger: { drafts: [w] }, now: new Date("2026-11-17T09:00:05Z"), approval: { createdAt: "x" } }).action, "send", "まる1週間後の便までにOKがあれば送る");
  assert.equal(decide({ ledger: { drafts: [w] }, now: new Date("2026-11-18T09:00:00Z"), approval: { createdAt: "x" } }).action, "expire", "承認済みでも1週間を過ぎた原稿は送らない");
  assert.equal(decide({ ledger: { drafts: [w] }, now: new Date("2026-11-16T12:00:00Z") }).action, "wait", "6日半より前はまだ待つ");
  assert.equal(decide({ ledger: { drafts: [{ ...w, status: "sending" }] }, now, approval: { createdAt: "x" } }).action, "stuck", "配信途中で止まった原稿があれば何もしない");
});

test("コツの枠には type が tip のものだけを使う（日付つきの古い告知は送らない）", () => {
  const tips = [{ id: "old", type: "activity", text: "やまちゃんです！8/23に野川公園で", sentAt: null }, { id: "t", type: "tip", text: "やまちゃんです！", sentAt: null }];
  const p = pickContent({ today: "2026-12-20", events: [], tips, posts: [] });
  assert.equal(p.main.tip.id, "t");
});
