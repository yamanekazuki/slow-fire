// 運営メンバーの宛先・週報の実施回数（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdmins, FALLBACK } from "../lib/bbq-admins.mjs";
import { bbqCounts } from "../weekly-report.mjs";

test("宛先: Firestoreの配列から、重複・空・形の崩れたアドレスを除いて読む", () => {
  const doc = { fields: { emails: { arrayValue: { values: [{ stringValue: "A@example.com" }, { stringValue: "a@example.com " }, { stringValue: "" }, { stringValue: "not-an-email" }, { stringValue: "b@example.jp" }] } } } };
  assert.deepEqual(parseAdmins(doc), ["a@example.com", "b@example.jp"]);
  assert.deepEqual(parseAdmins(null), []);
  assert.deepEqual(FALLBACK, ["yamane@potentialight.com"]); // 読めないときは山根さんだけに届く
});

test("実施回数: 予定台帳のBBQの回のうち開催済みだけ数える（定例・講座・未来の回は数えない）", () => {
  const ev = [
    { date: "2026-08-23", title: "第2回 月1BBQ（11:00〜）" },
    { date: "2026-09-26", title: "裕太さん送別バーベキュー" },
    { date: "2026-09-24", title: "YORONバーベキュー定例" },
    { date: "2026-10-11", title: "Grillist Basic Course 講座" },
    { date: "2026-10-18", title: "531バーベキュー第2回" },
    { date: "2025-12-01", title: "去年のBBQ" },
  ];
  const c = bbqCounts(ev, "2026-09-28", ["2026-09-26", "index.html", "p-x"]);
  assert.equal(c.thisYear, 2);
  assert.deepEqual(c.lastWeek, ["09/26 裕太さん送別バーベキュー"]);
  assert.equal(c.reports, 1);
});
