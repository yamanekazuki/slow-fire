// BBQレポートの「参加者の声」は下の段に穴が空かない列数で並べる（2026-10-12 講座レポートに感想が6件→4列だと2つ穴）
import test from "node:test";
import assert from "node:assert/strict";
import { gvColumns, renderReportHtml } from "../report/render.mjs";

test("件数ごとの列数＝最後の段が埋まるか、穴が最小", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(gvColumns), [1, 2, 3, 4, 3, 3, 3, 4, 3]);
});

test("描画した声の欄に列数が入り、名前は出ない", () => {
  const html = renderReportHtml({ title: "t", date: "2026-10-11", chapters: [], guestVoices: Array.from({ length: 6 }, (_, i) => ({ text: `感想${i}`, name: "なお" })) });
  assert.match(html, /class="gv" style="--gvc:3"/);
  assert.equal((html.match(/class="gvi"/g) || []).length, 6);
  assert.ok(!html.includes("なお"));
});
