// BBQレポート便の判定・後処理（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventsToGenerate, isApprovalText, findApproval, approvalCutoff, latestSent, sanitizePage, reportIndexItems, jstHour } from "../report/pipeline.mjs";
import { ROBOTS_RE, selfContained, indexHtml, normCrop, photoCrops, checkReport } from "../report-loop.mjs";
import { renderReportHtml, buildSite, voiceHtml, figureHtml, menuHtml } from "../report/render.mjs";

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
  assert.deepEqual(sanitizePage({ title: "x", chapters: [{}], keypoints: [] }).errors, ["章が2つ未満"]);
  const k = sanitizePage({ title: "x", chapters: [{}, {}], keypoints: [{}], disclaimer: "d" }).page;
  assert.equal(k.keypoints, undefined); assert.equal(k.disclaimer, undefined); // 要点・注意書きは載せない
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

const PAGE = {
  title: "ハニーマスタードと大根に、BBQの幅を広げてもらった日", kind: "BBQレポート｜9/26 名古屋・庄内緑地", lead: "**12品**を焼いた <script>",
  speakers: [{ name: "ヨッシー", role: "鶏" }, { name: "たろうさん", role: "飲み物" }],
  voice: { text: "最高だった", label: "YAMACHAN — LINE" },
  figures: [{ kind: "stat", items: [{ v: "12", u: "品", l: "料理" }] },
    { kind: "table", cap: "今日のメニュー", head: ["料理", "焼き方", "担当", "写真"], rows: [["ズッキーニ", "切れ目", "あんちゃん", "13.jpg"], ["ブレッドプディング", "チョコ", "—", ""]] }],
  keypoints: [{ t: "x" }],
  chapters: [
    { title: "鶏は、はちみつで抜けられる", lead: "l", voice: { text: "楽しみ", label: "ANCHAN — LINE" }, figuresTop: [{ kind: "image", url: "img/photos/25.jpg", cap: "鶏" }], body: ["a"], figures: [{ kind: "vs", left: { lb: "前", t: "ラブ" }, right: { lb: "後", t: "はちみつ" } }] },
    { title: "野菜が主役になった", body: ["b"], voice: { text: "見当たらない", label: "UETAKU — LINE" }, figuresTop: [{ kind: "image", url: "img/photos/13.jpg", cap: "ズッキーニ" }, { kind: "image", url: "img/photos/11.jpg", cap: "大根" }] },
  ],
};

test("BBQレポート: サイトのヘッダー・今日の人・メニューカード・章の2段組み・拡大表示", () => {
  const h = renderReportHtml(PAGE);
  assert.match(h, /class="logo"[^>]*>YORON BBQ<small>/);
  assert.match(h, /<h1>ハニーマスタードと大根に、BBQの幅を広げてもらった日<\/h1>/);
  assert.match(h, /img\/bbq\/yossy-face\.svg/);
  assert.match(h, /<span class="av">た<\/span>/); // キャラがいない人は頭文字
  assert.match(h, /<div class="dish"><img src="img\/photos\/13\.jpg"/);
  assert.match(h, /<div class="ph">写真なし<\/div>/);
  assert.equal((h.match(/<section class="sec" id="c\d+">/g) || []).length, 2);
  assert.match(h, /<div class="cols"><div class="body">/);
  assert.match(h, /img\/bbq\/uetaku\.svg/);
  assert.match(h, /id="ylb"/);
  assert.match(h, /<b>12品<\/b>を焼いた &lt;script&gt;/); // 太字だけ通し、それ以外はエスケープ
  assert.deepEqual(checkReport(h), []);
});

test("BBQレポート: ビジネス資料の部品・社名・黒ベタ・言っていない人のキャラを出さない", () => {
  const h = renderReportHtml(PAGE);
  for (const w of ["持ち帰る要点", "本編", "次にやること", "推奨しない", "Potentialight", "potentialight.com", "#191410"]) assert.ok(!h.includes(w), w);
  assert.equal(voiceHtml({ text: "x", label: "TAKASHI — y" }).includes("img/bbq/yama.svg"), true);
  assert.equal(voiceHtml(null), "");
  assert.equal(figureHtml({ kind: "image" }), "");
  assert.ok(checkReport(h.replace("<h1>", "<h1>持ち帰る要点")).length > 0);
});

test("BBQレポート: 写真は右の列いっぱい（110pxの小ささに戻さない）", () => {
  const h = renderReportHtml(PAGE);
  assert.match(h, /\.yph img\{width:100%;height:auto;max-height:300px/);
  assert.doesNotMatch(h, /\.yph img\{height:110px/);
  assert.match(h, /\.dish img\{width:96px;height:96px/); // メニューの写真も小さくしすぎない
});

test("buildSite: 写真とキャラをコピーして index.html を書く", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-site-"));
  const photos = fs.mkdtempSync(path.join(os.tmpdir(), "bbq-photos-"));
  fs.writeFileSync(path.join(photos, "13.jpg"), "x");
  buildSite(PAGE, out, photos);
  for (const f of ["index.html", "img/photos/13.jpg", "img/bbq/uetaku.svg", "img/bbq/anchan-face.svg"]) assert.ok(fs.existsSync(path.join(out, f)), f);
});

test("指示書に山根さんのFBが焼き込まれている", () => {
  const p = fs.readFileSync(path.join(HERE, "../report/prompt.md"), "utf8");
  for (const must of ["Q&A", "次にやること", "写真は脇役", "要点まとめ", "まだ本人に伝えていない話", "ANCHAN / YAMACHAN / UETAKU / YOSSY / YUTA", "会の名目", "やまちゃんに偏らせない"]) assert.ok(p.includes(must), must);
});

test("切り抜き範囲: 指定を0〜1に丸める・不正や指定なしは写真全体・同じ写真は最初の指定", () => {
  assert.deepEqual(normCrop([0.1, 0.33, 0.9, 0.36]), [0.1, 0.33, 0.9, 0.36]);
  assert.deepEqual(normCrop(undefined), [0, 0, 1, 1]);
  assert.deepEqual(normCrop([0, 0, "x", 1]), [0, 0, 1, 1]);
  assert.deepEqual(normCrop([-1, 0.95, 2, 0.5]), [0, 0.95, 1, 0.1]); // はみ出しは丸め、最小10%は残す
  const page = { figures: [{ kind: "table" }], chapters: [
    { figuresTop: [{ kind: "image", url: "img/photos/11.jpg", crop: [0.1, 0.33, 0.9, 0.36] }] },
    { figures: [{ kind: "image", url: "img/photos/11.jpg", crop: [0, 0, 1, 1] }, { kind: "image", url: "img/photos/13.jpg" }] },
  ] };
  assert.deepEqual(photoCrops(page), { "11.jpg": [0.1, 0.33, 0.9, 0.36], "13.jpg": [0, 0, 1, 1] });
});
