// 日程調整ページの表示計算（週表示のマス目・なぞった範囲・塗りからの集計・カレンダーからの初期値）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const L = createRequire(import.meta.url)(path.join(ROOT, "meet-logic.js"));
const Core = createRequire(import.meta.url)(path.join(ROOT, "functions/meet-core.js"));
const MEM = [{ key: "uetaku" }, { key: "anri" }, { key: "yoshi" }];
const NOW = new Date("2026-10-05T01:00:00Z");
const poll = Core.normalizePollInput({ from: "2026-10-09", to: "2026-10-13" }, NOW);
const cells = Core.buildCells(poll, NOW).map((c) => ({ id: c.id, day: c.day, busy: false }));
const slots = Core.buildSlots(poll, NOW);
const id = (day, hm) => Core.jstInstant(day, hm).toISOString();

test("週表示: 月曜はじまりで週に分け、行は11:00〜16:30の12段", () => {
  const g = L.grid(cells);
  assert.deepEqual(g.weeks.map((w) => w.days), [["2026-10-09"], ["2026-10-12", "2026-10-13"]]);
  assert.equal(g.times.length, 12);
  assert.equal(g.times[0], "11:00");
  assert.equal(g.at("2026-10-12", "13:30").id, id("2026-10-12", "13:30"));
  assert.equal(L.dayLabel("2026-10-13"), "10/13(火)");
});

test("なぞった長方形の範囲を塗る・消す（やまちゃんが埋まっているマスは飛ばす）", () => {
  const cs = cells.map((c) => (c.id === id("2026-10-12", "11:30") ? { ...c, busy: true } : c));
  const g = L.grid(cs);
  const days = g.weeks[1].days;
  const ids = L.rectIds(g, days, { d: 0, t: 0 }, { d: 1, t: 2 }); // 10/12〜10/13 の 11:00〜12:00 台の3段
  assert.equal(ids.length, 5);
  assert.ok(!ids.includes(id("2026-10-12", "11:30")));
  const painted = L.paint([], ids, true);
  assert.deepEqual(L.paint(painted, [id("2026-10-13", "11:00")], false).length, 4);
});

test("塗りから枠を数え直す: サーバー側の集計と同じ結果", () => {
  const answers = {
    uetaku: { ok: [id("2026-10-12", "13:00"), id("2026-10-12", "13:30")] },
    anri: { ok: [id("2026-10-12", "13:00"), id("2026-10-12", "13:30"), id("2026-10-12", "14:00")] },
    yoshi: { ok: [] },
  };
  const mine = [id("2026-10-12", "13:00"), id("2026-10-12", "13:30")];
  const rows = L.recount(slots.map((s) => ({ ...s })), MEM, answers, "yoshi", mine, 60);
  const server = Core.tally(slots, [], { ...answers, yoshi: { ok: mine } }, 60);
  assert.deepEqual(rows.filter((r) => r.allOk).map((r) => r.id), server.allOkIds);
  assert.deepEqual(server.allOkIds, [id("2026-10-12", "13:00")]);
  assert.deepEqual(L.bestRows(rows, MEM, 5).kind, "all");
  assert.equal(L.heat(cells, MEM, answers, "yoshi", mine)[id("2026-10-12", "13:00")], 4);
  assert.deepEqual(L.slotCellIds(slots[0], 60), Core.slotCellIds(slots[0], 60));
});

test("カレンダーから最初の塗り: やまちゃんが空いていて自分の予定もないマスだけ", () => {
  const cs = cells.slice(0, 3).map((c, i) => ({ ...c, busy: i === 0 }));
  assert.deepEqual(L.prefillFromBusy(cs, [cs[1].id]), [cs[2].id]);
});

test("2週間ずつの画面・塗った時間を「何月何日の何時〜何時」にまとめる", () => {
  const g = L.grid(cells);
  const pg = L.pages(g, 2);
  assert.equal(pg.length, 1);
  assert.deepEqual(pg[0].days, ["2026-10-09", "2026-10-12", "2026-10-13"]);
  assert.deepEqual(Object.keys(pg[0].weekStart), ["1"]); // 10/12(月)で週が変わる
  const r = L.ranges([id("2026-10-12", "13:30"), id("2026-10-12", "13:00"), id("2026-10-12", "14:00"), id("2026-10-12", "16:30"), id("2026-10-13", "11:00")]);
  assert.deepEqual(r.map((x) => x.label), ["10/12(月) 13:00〜14:30", "10/12(月) 16:30〜17:00", "10/13(火) 11:00〜11:30"]);
});

test("やまちゃんの予定が後から入ったマスは、塗りから外す（外した分も返す）", () => {
  const cs = [{ id: "a", busy: false }, { id: "b", busy: true }, { id: "c", busy: false }];
  assert.deepEqual(L.dropOwnerBusy(["a", "b", "c"], cs), { ids: ["a", "c"], dropped: ["b"] });
  assert.deepEqual(L.dropOwnerBusy([], cs), { ids: [], dropped: [] });
  assert.deepEqual(L.dropOwnerBusy(null, cs), { ids: [], dropped: [] });
  assert.deepEqual(L.dropOwnerBusy(["x"], cs), { ids: ["x"], dropped: [] }); // 候補にないマスはここでは触らない（サーバーの cleanAnswer が落とす）
});
