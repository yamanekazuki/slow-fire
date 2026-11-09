// コミュニティサイトの自動で直す係の安全弁（lib/site-patch.mjs）。仮フォルダだけで試す・本番ファイルと外部通信には触らない
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAllowedFile, resolveTarget, resolveTargets, checkPatch, checkSiteWide, applyProposalPatches, listSiteHtml } from "../lib/site-patch.mjs";
import { buildSubject } from "../community-improvement.mjs";

const PAGE = `<html><body><header><a href="index.html">ロゴ</a></header>
<main><h1>イベント一覧</h1><p class="lead">月1BBQ</p>
<form id="apply" action="https://example.com/x"><input name="n"><button type="submit">送る</button><p>注意書き</p></form>
<script>var s = "<h1>イベント一覧</h1>";</script></main></body></html>`;

function tmpSite() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "site-patch-"));
  fs.writeFileSync(path.join(d, "index.html"), PAGE.replace("イベント一覧", "トップ"));
  fs.writeFileSync(path.join(d, "event.html"), PAGE);
  fs.mkdirSync(path.join(d, "report/2026-11-06"), { recursive: true });
  fs.writeFileSync(path.join(d, "report/2026-11-06/index.html"), `<a href="index.html">x</a>`);
  fs.mkdirSync(path.join(d, "functions"));
  fs.writeFileSync(path.join(d, "functions/a.html"), `<a href="index.html">x</a>`);
  fs.writeFileSync(path.join(d, "admin.html"), `<a href="index.html">x</a>`);
  return d;
}

test("公開ページだけを対象にする（運営用ページ・関数・運営用は不可）", () => {
  assert.equal(isAllowedFile("event.html"), true);
  assert.equal(isAllowedFile("spice/a.html"), true);
  assert.equal(isAllowedFile("admin.html"), false);
  assert.equal(isAllowedFile("functions/a.html"), false);
  assert.equal(isAllowedFile("report-ops/a.html"), false);
  assert.equal(isAllowedFile("../x.html"), false);
  assert.equal(isAllowedFile("community.js"), false);
});

test("提案の対象URLをファイルに直す", () => {
  const d = tmpSite();
  assert.equal(resolveTarget("https://yoron-bbq.com/", d), "index.html");
  assert.equal(resolveTarget("https://yoron-bbq.com/event.html", d), "event.html");
  assert.equal(resolveTarget("/event", d), "event.html");
  assert.equal(resolveTarget("/report/2026-11-06/", d), "report/2026-11-06/index.html");
  assert.equal(resolveTarget("新規ページ", d), null);
  assert.equal(resolveTarget("https://yoron-bbq.com/admin.html", d), null);
});

test("対象に2ページ書かれていても両方拾う（全角かっこ・読点つき）", () => {
  const d = tmpSite();
  assert.deepEqual(resolveTargets("https://yoron-bbq.com/event.html（あわせて https://yoron-bbq.com/）", d), ["event.html", "index.html"]);
  assert.deepEqual(resolveTargets("/event.html、/report/2026-11-06/", d), ["event.html", "report/2026-11-06/index.html"]);
  assert.deepEqual(resolveTargets("新規ページ", d), []);
});

test("一括置換が見つからない時は、その置換だけ飛ばして他の直しは進める", () => {
  const d = tmpSite();
  const r = applyProposalPatches({ patches: [{ file: "event.html", find: '<p class="lead">月1BBQ</p>', replace: '<p class="lead">月1BBQ！</p>' }], siteWide: [{ find: 'href="index.html#join"', replace: 'href="/#join"' }] }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, ["event.html"]);
  assert.match(r.skipped[0], /対象なし/);
  assert.equal(applyProposalPatches({ siteWide: [{ find: 'href="nai.html"', replace: 'href="/"' }] }, d).ok, false);
});

test("見出しの直後に導線を足す普通の直しは通る", () => {
  const r = checkPatch(PAGE.replace(`<script>var s = "<h1>イベント一覧</h1>";</script>`, ""), "<h1>イベント一覧</h1>", `<h1>イベント一覧</h1><div class="next"><p>次回のBBQ</p><a class="btn" href="#apply">申し込む</a></div>`);
  assert.equal(r.ok, true);
  assert.match(r.out, /href="#apply"/);
});

test("ページ内で複数回一致する find は止める", () => {
  const r = checkPatch(PAGE, "<h1>イベント一覧</h1>", "<h1>一覧</h1>");
  assert.equal(r.ok, false);
  assert.match(r.reason, /2回一致/);
});

test("フォームの中・scriptの中は書き換えない", () => {
  assert.match(checkPatch(PAGE, "<p>注意書き</p>", "<p>変更</p>").reason, /フォームの中/);
  assert.match(checkPatch(PAGE, 'var s = "', 'var t = "').reason, /script/);
  assert.match(checkPatch(PAGE, '<form id="apply" action="https://example.com/x">', '<form id="apply" action="https://evil.example/">').reason, /フォーム/);
});

test("置換後に入力欄・script・onclick・送信先を入れさせない", () => {
  const src = `<p class="lead">月1BBQ</p>`;
  for (const bad of [`<p class="lead">月1BBQ<input name="x"></p>`, `<p class="lead">月1BBQ<script>x()</script></p>`, `<p class="lead" onclick="x()">月1BBQ</p>`, `<p class="lead"><a href="javascript:alert(1)">x</a></p>`]) {
    assert.equal(checkPatch(src, src, bad).ok, false, bad);
  }
});

test("タグの開閉がずれる置換は止める", () => {
  const src = `<p class="lead">月1BBQ</p>`;
  const r = checkPatch(src, src, `<p class="lead">月1BBQ</p><div class="x">`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /div/);
});

test("サイト全体の一括置換は href 属性だけ", () => {
  assert.equal(checkSiteWide('href="index.html"', 'href="/"').ok, true);
  assert.equal(checkSiteWide("ロゴ", "LOGO").ok, false);
  assert.equal(checkSiteWide('href="index.html"', 'href="javascript:x"').ok, false);
});

test("提案1件の直しはまとめて適用し、運営用ページ・関数のファイルには一括置換が及ばない", () => {
  const d = tmpSite();
  const r = applyProposalPatches({ patches: [{ file: "event.html", find: '<p class="lead">月1BBQ</p>', replace: '<p class="lead">月1BBQ・手ぶらでOK</p>' }], siteWide: [{ find: 'href="index.html"', replace: 'href="/"' }] }, d);
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(path.join(d, "event.html"), "utf8"), /手ぶらでOK/);
  assert.match(fs.readFileSync(path.join(d, "report/2026-11-06/index.html"), "utf8"), /href="\/"/);
  assert.match(fs.readFileSync(path.join(d, "admin.html"), "utf8"), /href="index.html"/);
  assert.match(fs.readFileSync(path.join(d, "functions/a.html"), "utf8"), /href="index.html"/);
  assert.deepEqual(listSiteHtml(d), ["event.html", "index.html", "report/2026-11-06/index.html"]);
});

test("1つでも不合格なら、その提案は何も書き換えない（半端に直さない）", () => {
  const d = tmpSite();
  const before = fs.readFileSync(path.join(d, "event.html"), "utf8");
  const r = applyProposalPatches({ patches: [
    { file: "event.html", find: '<p class="lead">月1BBQ</p>', replace: '<p class="lead">変更</p>' },
    { file: "event.html", find: "<p>注意書き</p>", replace: "<p>変更</p>" },
  ] }, d);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(d, "event.html"), "utf8"), before);
});

test("直す箇所が空なら止める", () => {
  assert.equal(applyProposalPatches({ patches: [], siteWide: [] }, tmpSite()).ok, false);
});

test("件名に自動で直した件数が出る（止めている時は従来どおり）", () => {
  assert.match(buildSubject({ short: "10/12〜11/8", pv: 457, ppv: 456, count: 3, applied: 2 }), /改善案3件・自動で直した2件$/);
  assert.match(buildSubject({ short: "10/12〜11/8", pv: 457, ppv: 456, count: 3 }), /改善案3件$/);
});
