// BBQレポート便の判定・後処理（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventsToGenerate, isApprovalText, findApproval, approvalCutoff, latestSent, sanitizePage, reportIndexItems, jstHour } from "../report/pipeline.mjs";
import { ROBOTS_RE, selfContained, indexHtml } from "../report-loop.mjs";
import { postProcess, finalize } from "../report/post.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 2026-09-26 22:00 JST = 13:00Z / 2026-09-26 15:00 JST = 06:00Z
const NIGHT = new Date("2026-09-26T13:00:00Z");
const DAY = new Date("2026-09-26T06:00:00Z");
const album = (over = {}) => ({ eventId: "2026-09-26", albumId: "2026-09-26-abc", photos: 53, label: "x", ...over });

test("jstHour は実時刻からJSTの時を出す（+9hシフトしたDateを作らない）", () => {
  assert.equal(jstHour(NIGHT), 22);
  assert.equal(jstHour(new Date("2026-09-26T15:30:00Z")), 0);
});

test("開催当日は21時(JST)より前には作らない・21時以降に作る", () => {
  assert.equal(eventsToGenerate([album()], {}, DAY).length, 0);
  assert.deepEqual(eventsToGenerate([album()], {}, NIGHT).map((t) => t.reason), ["new"]);
});

test("写真が5枚未満・未来の回・4日以上前の回は作らない", () => {
  assert.equal(eventsToGenerate([album({ photos: 4 })], {}, NIGHT).length, 0);
  assert.equal(eventsToGenerate([album({ eventId: "2026-09-27" })], {}, NIGHT).length, 0);
  assert.equal(eventsToGenerate([album({ eventId: "2026-09-22" })], {}, NIGHT).length, 0);
  assert.equal(eventsToGenerate([album({ eventId: "2026-09-23" })], {}, NIGHT).length, 1);
});

test("送付済みは原則作り直さない。振り返りが後から書かれたら1回だけ作り直す", () => {
  const sent = { "2026-09-26": { status: "sent", generations: 1, photos: 53, sentAt: "2026-09-26T13:30:00Z", notesEditedAt: "" } };
  const next = new Date("2026-09-27T01:00:00Z");
  assert.equal(eventsToGenerate([album()], sent, next).length, 0);
  assert.deepEqual(eventsToGenerate([album({ notesEditedAt: "2026-09-26T23:00:00Z" })], sent, next).map((t) => t.reason), ["new-notes"]);
  assert.deepEqual(eventsToGenerate([album({ photos: 63 })], sent, next).map((t) => t.reason), ["more-photos"]);
  const twice = { "2026-09-26": { ...sent["2026-09-26"], generations: 2 } };
  assert.equal(eventsToGenerate([album({ photos: 99, notesEditedAt: "2026-09-27T00:00:00Z" })], twice, next).length, 0);
  for (const st of ["approved", "published"]) assert.equal(eventsToGenerate([album({ photos: 99 })], { "2026-09-26": { status: st } }, next).length, 0);
});

test("承認の言い回し: 短い承認文だけ拾い、疑問文・条件付き・否定・保留は拾わない", () => {
  for (const t of ["レポートOK", "レポート OK！", "レポートはOK", "レポートおけ", "レポートオッケー", "このレポートOKです", "レポート公開して", "レポートを公開OK", "ﾚﾎﾟｰﾄOK"]) assert.ok(isApprovalText(t), t);
  for (const t of ["レポートOKじゃない", "レポート待って", "OK", "ハニーマスタードOK", "レポートNG", "公開はまって",
    "このレポートOKかな？", "レポートOK？", "公開して", "公開OKです", "レポートは大丈夫", "レポートOKにする前に写真変えて", "まだレポートOKしないで", "レポートOKだけど鯛の説明直して", "公開してもいい？"]) assert.ok(!isApprovalText(t), t);
});

test("承認は送付後・承認者のuserId・運営グループの発言だけ。設定が無ければ必ず承認なし", () => {
  const opt = { approverUserIds: ["U-yama"], groupId: "G-ops" };
  const logs = [
    { who: "yama", userId: "U-yama", groupId: "G-ops", text: "レポートOK", createdAt: "2026-09-26T12:00:00Z" },   // 送付前
    { who: "yama", userId: "U-fake", groupId: "G-ops", text: "レポートOK", createdAt: "2026-09-26T14:00:00Z" },   // 表示名だけyama
    { who: "yama", userId: "U-yama", groupId: "G-other", text: "レポートOK", createdAt: "2026-09-26T14:01:00Z" }, // 別グループ
    { who: "yama", userId: "U-yama", groupId: "G-ops", text: "レポートOK！", createdAt: "2026-09-26T14:05:00Z" },
  ];
  assert.equal(findApproval(logs, "2026-09-26T13:30:00Z", opt).createdAt, "2026-09-26T14:05:00Z");
  assert.equal(findApproval(logs.slice(0, 3), "2026-09-26T13:30:00Z", opt), null);
  assert.equal(findApproval(logs, "2026-09-26T13:30:00Z", {}), null);
});

test("承認が効くのは最後に送った1件だけ", () => {
  const l = { "2026-09-26": { status: "sent", sentAt: "2026-09-26T13:00:00Z" }, "2026-10-04": { status: "sent", sentAt: "2026-10-04T13:00:00Z" }, "2026-10-18": { status: "built" } };
  assert.equal(latestSent(l)[0], "2026-10-04");
  assert.equal(latestSent({}), null);
});

test("失敗した回は3回まで作り直す・built は作り直さない（送信だけやり直す）", () => {
  assert.deepEqual(eventsToGenerate([album()], { "2026-09-26": { status: "failed", failures: 2 } }, NIGHT).map((t) => t.reason), ["retry"]);
  assert.equal(eventsToGenerate([album()], { "2026-09-26": { status: "failed", failures: 3 } }, NIGHT).length, 0);
  assert.equal(eventsToGenerate([album()], { "2026-09-26": { status: "built" } }, NIGHT).length, 0);
});

test("公開時は robots meta を全部外す（page-kit既定のnoindexと確認用のnoindexの両方）", () => {
  const html = '<head>\n<meta name="robots" content="noindex,nofollow,noarchive">\n<meta name="robots" content="noindex,nofollow">\n<title>x</title>';
  assert.doesNotMatch(html.replace(ROBOTS_RE, ""), /robots/);
});

test("確認用は画像を埋め込んだ1ファイル・noindexはちょうど1つ", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-sc-"));
  fs.mkdirSync(path.join(dir, "img/bbq"), { recursive: true });
  fs.writeFileSync(path.join(dir, "img/bbq/yama.svg"), "<svg/>");
  fs.writeFileSync(path.join(dir, "index.html"), '<html><head>\n<meta name="robots" content="noindex,nofollow"><title>t</title></head><body><img src="img/bbq/yama.svg"><img src="img/photos/none.jpg"></body></html>');
  const out = selfContained(dir, { shrink: false });
  assert.equal((out.match(/name="robots"/g) || []).length, 1);
  assert.match(out, /src="data:image\/svg\+xml;base64,/);
  assert.match(out, /src="img\/photos\/none\.jpg"/); // 無いファイルは触らない
});

test("特設一覧のHTMLはタイトルをエスケープする", () => {
  const h = indexHtml([{ path: "report/2026-09-26/", date: "2026-09-26", title: "<script>x</script>&", place: "庄内緑地", thumb: "img/photos/25.jpg" }]);
  assert.doesNotMatch(h, /<script>x/);
  assert.match(h, /&lt;script&gt;x&lt;\/script&gt;&amp;/);
  assert.match(indexHtml([]), /まだレポートはありません/);
});

test("sanitizePage: Q&A・次にやること・知らない人の吹き出し・存在しない写真を外す", () => {
  const raw = {
    title: "t", keypoints: [{}, {}, {}], qa: [{}], next: [{}], lite: true,
    voice: { text: "a", label: "TAKASHI — x" },
    chapters: [
      { title: "a", voice: { text: "b", label: "ANCHAN — LINE" }, do: ["x"], figuresTop: [{ kind: "image", url: "img/photos/01.jpg" }, { kind: "image", url: "img/photos/99.jpg" }] },
      { title: "b", figures: [{ kind: "table", head: [], rows: [] }] },
    ],
  };
  const { page, errors } = sanitizePage(raw, { photoNames: ["01.jpg"] });
  assert.deepEqual(errors, []);
  assert.equal(page.qa, undefined); assert.equal(page.next, undefined); assert.equal(page.lite, false);
  assert.equal(page.voice, undefined);
  assert.equal(page.chapters[0].voice.label, "ANCHAN — LINE");
  assert.equal(page.chapters[0].do, undefined);
  assert.deepEqual(page.chapters[0].figuresTop.map((f) => f.url), ["img/photos/01.jpg"]);
  assert.ok(sanitizePage({ title: "x", chapters: [{}], keypoints: [] }).errors.length >= 2);
});

test("特設一覧は report/<日付>/ を走査して作る（台帳に依存しない）・新しい順", () => {
  const page = (h1, kind) => `<html><head></head><body><span class="kick">${kind}</span><h1>${h1}</h1><img src="img/photos/25.jpg"></body></html>`;
  const items = reportIndexItems([
    { dir: "2026-09-26", html: page("ハニーマスタードと<em>BBQの幅</em>", "BBQレポート｜9/26 名古屋・庄内緑地") },
    { dir: "2026-10-18", html: page("B", "BBQレポート｜10/18 世田谷") },
    { dir: "p-old", html: page("x", "y") },
    { dir: "2026-10-04", html: "" },
  ]);
  assert.deepEqual(items.map((i) => i.id), ["2026-10-18", "2026-09-26"]);
  assert.equal(items[1].title, "ハニーマスタードとBBQの幅");
  assert.equal(items[1].place, "名古屋・庄内緑地");
  assert.equal(items[1].thumb, "img/photos/25.jpg");
});

test("1回の「レポートOK」は1件だけ: 公開して使った承認は、1つ前の送付済みの回に連鎖しない", () => {
  const opt = { approverUserIds: ["U-yama"], groupId: "G-ops" };
  const ok = { who: "yama", userId: "U-yama", groupId: "G-ops", text: "レポートOK", createdAt: "2026-10-04T14:00:00Z" };
  const ledger = { "2026-09-26": { status: "sent", sentAt: "2026-09-26T13:00:00Z" }, "2026-10-04": { status: "sent", sentAt: "2026-10-04T13:00:00Z" } };
  // 1回目: 最新(10/04)に効く
  assert.equal(latestSent(ledger)[0], "2026-10-04");
  assert.ok(findApproval([ok], approvalCutoff(ledger), opt));
  // 公開して承認を使い切った後: 9/26 が最新の送付済みになっても、同じOKでは公開しない
  ledger["2026-10-04"].status = "published"; ledger._approvalUsedAt = ok.createdAt;
  assert.equal(latestSent(ledger)[0], "2026-09-26");
  assert.equal(findApproval([ok], approvalCutoff(ledger), opt), null);
  // 公開済みの回の送付時刻より前のOKも使わない（使用記録が無くても）
  delete ledger._approvalUsedAt;
  assert.equal(approvalCutoff(ledger), "2026-10-04T13:00:00Z");
});

test("送付済みの作り直しは失敗3回で止める（Opusを呼び続けない）", () => {
  const sent = { "2026-09-26": { status: "sent", generations: 1, photos: 10, sentAt: "2026-09-26T13:30:00Z", failures: 3 } };
  assert.equal(eventsToGenerate([album({ photos: 99 })], sent, new Date("2026-09-27T01:00:00Z")).length, 0);
});

test("postProcess: 2Dキャラ・サイトのヘッダー/フッター・写真の横並び・noindex", () => {
  const html = `<html><head><link rel="icon" href="img/mark.png"></head><body><header class="top"><div class="wrap"><a class="brand">Potentialight</a></div></header>
<div class="verbar"><div class="wrap"><a href="lite/">簡略版</a></div></div>
<div class="yn br"><img src="img/char/present.png" alt="" loading="lazy"><div class="sb">x<span class="lb">ANCHAN — LINE</span></div></div>
<div class="yn tl"><img src="img/char/wave.png" alt="" loading="lazy"><div class="sb">y<span class="lb">TAKASHI — z</span></div></div>
<div class="spk"><div class="p"><span class="av">ヨ</span><div><div class="n">ヨッシー</div></div></div></div>
<div class="fig"><div class="cap"><span class="ms">photo_camera</span>鯛</div><div class="f-img"><img src="img/photos/19.jpg" alt="鯛" loading="lazy"></div></div>
<div class="fig"><div class="cap"><span class="ms">photo_camera</span>サバ</div><div class="f-img"><img src="img/photos/20.jpg" alt="サバ" loading="lazy"></div></div>
<h1>ハニーとBBQの幅</h1><div class="hero"><div>
<footer class="foot">© POTENTIALIGHT inc. yamane@potentialight.com</footer></body></html>`;
  const out = postProcess(html, { noindex: true, emphasis: "BBQの幅" });
  assert.match(out, /img\/bbq\/anchan\.svg/);
  assert.match(out, /img\/bbq\/yama\.svg/); // 知らない人のラベルはやまちゃんに寄せる（吹き出し自体はsanitizePageで事前に外す）
  assert.match(out, /img\/bbq\/yossy-face\.svg/);
  assert.doesNotMatch(out, /img\/char\//);
  assert.doesNotMatch(out, /Potentialight|POTENTIALIGHT|potentialight\.com/);
  assert.match(out, /class="ybrand"[^>]*>YORON BBQ <small>/);
  assert.doesNotMatch(out, /class="verbar"/);
  assert.match(out, /<div class="yphs"><figure class="yph"><img src="img\/photos\/19\.jpg"[^>]*><figcaption>鯛<\/figcaption><\/figure>\s*<figure class="yph">/);
  assert.doesNotMatch(out, /img\/photos\/19\.jpg"[^>]*loading="lazy"/);
  assert.match(out, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(out, /<h1>ハニーと<em>BBQの幅<\/em><\/h1>/);
  assert.doesNotMatch(postProcess(html, {}), /noindex/);
  // 写真はサムネイル（幅120px）で、押すと拡大する
  assert.match(out, /\.yph\{flex:0 0 120px/);
  assert.match(out, /id="ylb"/);
  assert.doesNotMatch(postProcess(html.replace(/<div class="fig">[\s\S]*?<\/div><\/div>\n/g, ""), {}), /id="ylb"/);
});

test("finalize: 公開物に簡略版・3Dキャラ・リマインド用ファイルを残さない", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-report-"));
  fs.mkdirSync(path.join(out, "lite")); fs.mkdirSync(path.join(out, "img/char"), { recursive: true });
  fs.writeFileSync(path.join(out, "actions.json"), "{}"); fs.writeFileSync(path.join(out, "img/mark.png"), "x");
  fs.writeFileSync(path.join(out, "index.html"), "<html><head></head><body></body></html>");
  const photos = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-photos-"));
  fs.writeFileSync(path.join(photos, "01.jpg"), "x");
  finalize(out, { photos });
  for (const gone of ["lite", "img/char", "actions.json", "img/mark.png"]) assert.ok(!fs.existsSync(path.join(out, gone)), gone);
  assert.ok(fs.existsSync(path.join(out, "img/photos/01.jpg")));
  assert.ok(fs.existsSync(path.join(out, "img/bbq/yossy.svg")));
  assert.ok(fs.existsSync(path.join(out, "img/bbq/anchan-face.svg")));
});

test("指示書に山根さんのFBが焼き込まれている", () => {
  const p = fs.readFileSync(path.join(HERE, "../report/prompt.md"), "utf8");
  for (const must of ["Q&A", "次にやること", "写真は脇役", "まだ本人に伝えていない話", "ANCHAN / YAMACHAN / UETAKU / YOSSY / YUTA"]) assert.ok(p.includes(must), must);
});
