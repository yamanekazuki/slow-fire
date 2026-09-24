// agenda-loop のURL台帳・サニタイズ・Notionリンク変換（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { STATIC_PAGES, linkCatalog, catalogText, extractUrls, sanitizeLinks, SITE } from "../lib/bbq-links.mjs";
import { markdownToBlocks } from "../lib/bbq-notion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("台帳の静的ページは全部リポジトリに実在する", () => {
  for (const p of STATIC_PAGES) {
    const f = p.path === "/" ? "index.html" : p.path.slice(1);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${p.path} が無い`);
  }
});

test("記事（blog/spice）が台帳に自動で乗り、URLは実ファイルに対応する", () => {
  const cat = linkCatalog(ROOT);
  const arts = cat.filter((c) => /\/(blog|spice)\/\d{4}-/.test(c.url));
  assert.ok(arts.length > 0);
  for (const a of arts) assert.ok(fs.existsSync(path.join(ROOT, a.url.slice(SITE.length + 1))), a.url);
  assert.match(catalogText(cat), /買い物チェック … https:\/\/yoron-bbq\.com\/shopping\.html/);
});

test("sanitizeLinks: 台帳に無いURLは剥がし、あるURLは残す（フェイルクローズ）", () => {
  const allowed = [`${SITE}/cooklog.html`];
  const md = "- 見る [COOK LOG](https://yoron-bbq.com/cooklog.html)・[偽物](https://yoron-bbq.com/nothing.html)\n- 裸 https://example.com/x と https://yoron-bbq.com/cooklog.html";
  const r = sanitizeLinks(md, allowed);
  assert.equal(r.markdown, "- 見る [COOK LOG](https://yoron-bbq.com/cooklog.html)・偽物\n- 裸  と https://yoron-bbq.com/cooklog.html");
  assert.deepEqual(r.removed, ["https://yoron-bbq.com/nothing.html", "https://example.com/x"]);
});

test("素材に出てきたURL（Notion等）は extractUrls 経由で許可される", () => {
  const src = "前回議事録 https://app.notion.com/p/abc123 を参照（末尾）";
  const allowed = extractUrls(src);
  assert.deepEqual(allowed, ["https://app.notion.com/p/abc123"]);
  assert.equal(sanitizeLinks("[前回](https://app.notion.com/p/abc123)", allowed).removed.length, 0);
});

test("markdownToBlocks: [ラベル](URL) が Notion の link 付き rich_text になる", () => {
  const b = markdownToBlocks("- 関連ページ：[買い物チェック](https://yoron-bbq.com/shopping.html)・**太字**")[0];
  const rt = b.bulleted_list_item.rich_text;
  const link = rt.find((r) => r.text.link);
  assert.equal(link.text.content, "買い物チェック");
  assert.equal(link.text.link.url, "https://yoron-bbq.com/shopping.html");
  assert.ok(rt.some((r) => r.annotations.bold && r.text.content === "太字"));
  assert.ok(rt.every((r) => r.text.content.length <= 2000));
});
