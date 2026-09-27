#!/usr/bin/env node
// page-kit の出力を「YORON BBQ レポート」に仕上げる後処理。
//   ・写真(--photos)とBBQの2Dキャラ(chars/)を出力フォルダへコピー
//   ・吹き出しの画像を、ラベル先頭のローマ字(ANCHAN/YAMACHAN/UETAKU/YOSSY/YUTA)で2Dキャラに差し替え
//   ・登場人物の頭文字アイコンを2Dキャラの顔に差し替え
//   ・ヘッダー/フッター/配色/フォントを yoron-bbq.com（YORON BBQ COMMUNITY）と同じトーンにする
//   ・写真は本文より目立たない大きさに抑える（2026-09-27 山根さん「写真が大きすぎる」）
//   node post.mjs out/<id> [--photos <写真フォルダ>] [--emphasis 語]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'https://yoron-bbq.com';
export const LABEL_TO_CHAR = { ANCHAN: 'anchan', YAMACHAN: 'yama', UETAKU: 'uetaku', YOSSY: 'yossy', YUTA: 'yuta' };
export const NAME_TO_CHAR = { 'あんちゃん': 'anchan', 'やまちゃん': 'yama', 'うえたく': 'uetaku', 'ヨッシー': 'yossy', '裕太さん': 'yuta' };

// サイトと同じファビコン
const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23d95f3b'/%3E%3Ctext x='16' y='23' font-family='sans-serif' font-size='16' font-weight='700' fill='%23fff' text-anchor='middle'%3EY%3C/text%3E%3C/svg%3E`;

// yoron-bbq.com の community.css（:root・nav・footer）を写したもの。
// フッターだけはサイトの黒でなくクリーム（制作ルール: 黒ベタ背景NG・page-kit check の no-dark-serif）
const THEME_CSS = `<style id="yoron-theme">
:root{--ground:#f6f1e4;--soft:#efe8d6;--paper:#fffdf6;--paper2:#fffdf6;--ink:#2d251c;--ink2:#5b5044;--muted:#8a8177;--ac:#d95f3b;--ac2:#b74a2c;--acbg:rgba(217,95,59,.08);--am:#e89b3f;--bl:#b74a2c;--blbg:rgba(217,95,59,.09);--line:rgba(45,37,28,.14)}
body{font-family:'Zen Maru Gothic','Noto Sans JP',sans-serif;background:var(--ground);background-image:radial-gradient(circle at 12% 8%,rgba(232,155,63,.10),transparent 38%),radial-gradient(circle at 88% 30%,rgba(217,95,59,.07),transparent 40%);background-attachment:fixed}
.top{background:rgba(246,241,228,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.ybrand{font-weight:900;font-size:1.1rem;letter-spacing:.06em;text-decoration:none;color:var(--ink);display:flex;align-items:baseline;gap:.5rem;white-space:nowrap}
.ybrand small{font-size:.6rem;font-weight:700;letter-spacing:.22em;color:var(--ac)}
.ylinks{display:flex;gap:1.1rem;align-items:center;list-style:none;margin:0;padding:0}
.ylinks a{text-decoration:none;font-size:.8rem;font-weight:700;color:var(--ink2);white-space:nowrap}
.ylinks a:hover{color:var(--ac)}
.ylinks a.ycta{background:var(--ac);color:#fff;padding:.45rem 1.05rem;border-radius:100px}
.ylinks a.ycta:hover{background:var(--ac2);color:#fff}
.docbar{background:rgba(255,253,246,.94)}
.yeyebrow{display:block;font-size:.68rem;letter-spacing:.3em;color:var(--ac);font-weight:900;margin-bottom:.35rem}
.hero h1 em{font-style:normal;color:var(--ac)}
.spk .p .av img{height:44px;width:44px;object-fit:contain}
/* 吹き出しのキャラ: 大きさを固定し、枠や影で四角く見えないように */
.yn img{width:74px!important;height:auto!important;max-height:140px;flex:none;filter:none!important;border:0!important;background:none!important;box-shadow:none!important;border-radius:0!important}
.yn.hero img{width:84px!important}
/* 写真は本文の脇役。PCでも幅は本文の6割まで・高さも抑える */
.f-img{max-width:min(460px,100%);margin:0 auto;border-radius:14px}
.f-img img{max-height:320px;width:100%;object-fit:cover}
.f-img.wide{max-width:min(620px,100%)}
.f-img.wide img{max-height:none;object-fit:contain}
.yphs{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 16px}
.yph{flex:0 1 210px;margin:0}
.yph img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block}
.yph figcaption{font-size:11.5px;font-weight:700;color:var(--ink2);margin-top:5px;line-height:1.5}
@media (max-width:600px){.yph{flex:0 1 calc(50% - 6px)}}
footer.yfoot{background:#efe8d6;color:#5b5044;padding:3.6rem 1.6rem 2rem;margin-top:4rem;border-radius:40px 40px 0 0}
.yfoot .in{max-width:1140px;margin:0 auto}
.yfoot .top2{display:flex;justify-content:space-between;gap:2.4rem;flex-wrap:wrap;margin-bottom:2.4rem}
.yfoot .lg{font-weight:900;font-size:1.25rem;color:#2d251c;letter-spacing:.06em}
.yfoot .lg small{display:block;font-size:.6rem;color:#d95f3b;letter-spacing:.26em;font-weight:800;margin-top:.3rem}
.yfoot .tg{font-size:.85rem;margin-top:.9rem}
.yfoot nav{display:grid;grid-template-columns:repeat(2,auto);gap:.55rem 2.2rem;align-content:start}
.yfoot nav a{color:#5b5044;text-decoration:none;font-size:.84rem;font-weight:700}
.yfoot nav a:hover{color:#d95f3b}
.yfoot .bt{border-top:1px solid rgba(45,37,28,.14);padding-top:1.4rem;display:flex;justify-content:space-between;flex-wrap:wrap;gap:.6rem;font-size:.74rem}
@media (max-width:760px){.ylinks li.hide-sp{display:none}.ybrand{font-size:.95rem}.ybrand small{font-size:.52rem}.f-img img{max-height:240px}}
</style>`;

const HEADER = `<header class="top"><div class="wrap">
  <a class="ybrand" href="${SITE}/">YORON BBQ <small>COMMUNITY</small></a>
  <span class="sp"></span>
  <ul class="ylinks"><li class="hide-sp"><a href="${SITE}/event.html">バーベキューイベント</a></li><li class="hide-sp"><a href="${SITE}/cookbook.html">料理ガイド</a></li><li><a class="ycta" href="${SITE}/index.html#join">仲間に入る</a></li></ul>
</div></header>`;

const FOOTER = `<footer class="yfoot"><div class="in">
  <div class="top2">
    <div><div class="lg">YORON BBQ <small>COMMUNITY</small></div><p class="tg">「今週末、BBQしよう」が合言葉になる日本へ。</p></div>
    <nav aria-label="YORON BBQ のページ">
      <a href="${SITE}/context.html">はじめての方へ</a><a href="${SITE}/roles.html">役割図鑑</a>
      <a href="${SITE}/academy.html">学ぶ</a><a href="${SITE}/event.html">バーベキューイベント</a>
      <a href="${SITE}/cookbook.html">料理ガイド</a><a href="${SITE}/blog.html">読みもの</a>
      <a href="${SITE}/team.html">チーム</a><a href="${SITE}/contact.html">お問い合わせ</a>
    </nav>
  </div>
  <div class="bt"><p>© 2026 YORON BBQ COMMUNITY. All rights reserved.</p><p>当日の写真と振り返りからまとめたレポートです。</p></div>
</div></footer>`;

export function postProcess(html, opts = {}) {
  // 吹き出し: ラベル先頭のローマ字でキャラを決める
  html = html.replace(/(<div class="yn[^"]*"><img src=")[^"]*img\/char\/[a-z-]+\.png("[^>]*>)(<div class="sb">[\s\S]*?<span class="lb">)([A-Z]+)/g,
    (m, a, b, c, key) => LABEL_TO_CHAR[key] ? `${a}img/bbq/${LABEL_TO_CHAR[key]}.svg${b}${c}${key}` : m);
  // 残った3Dキャラ（ラベルなし・未知の人）はやまちゃんに
  html = html.replace(/src="[^"]*img\/char\/[a-z-]+\.png"/g, 'src="img/bbq/yama.svg"');
  // 写真・キャラは遅延読み込みしない（スクロール位置によって空枠のまま残るため）
  html = html.replace(/(<img src="img\/(?:photos|bbq)\/[^"]+"[^>]*?) loading="lazy"/g, '$1');
  // 左右反転は3Dキャラ用なので外す
  html = html.replace('.yn.hero img{transform:scaleX(-1)}', '');
  // 章の写真は枠付きの大きな図にせず、小さな写真を横に並べる（連続する写真は1列にまとめる）
  html = html.replace(/<div class="fig"><div class="cap"><span class="ms">photo_camera<\/span>([^<]*)<\/div><div class="f-img">(<img[^>]*>)<\/div><\/div>/g,
    '<figure class="yph">$2<figcaption>$1</figcaption></figure>');
  html = html.replace(/(?:<figure class="yph">[\s\S]*?<\/figure>\s*)+/g, (m) => `<div class="yphs">${m.trim()}</div>\n`);
  // 一覧画像(menu-grid)は横長で見せる
  html = html.replace(/<div class="f-img">(<img src="img\/photos\/menu-grid)/g, '<div class="f-img wide">$1');
  // 登場人物のアイコン（顔のアップ）
  html = html.replace(/<span class="av">[^<]*<\/span>(<div><div class="n">([^<]+)<\/div>)/g,
    (m, rest, name) => NAME_TO_CHAR[name] ? `<span class="av" style="background:#fbf1e2;overflow:hidden;padding:0"><img src="img/bbq/${NAME_TO_CHAR[name]}-face.svg" alt=""></span>${rest}` : m);
  // ヘッダー・フッター・ファビコン・テーマ
  html = html.replace(/<header class="top">[\s\S]*?<\/header>/, HEADER);
  html = html.replace(/<footer class="foot">[\s\S]*?<\/footer>/, FOOTER);
  html = html.replace(/<link rel="icon" href="[^"]*">/, `<link rel="icon" href="${FAVICON}">`);
  html = html.replace('family=Zen+Maru+Gothic:wght@700;900', 'family=Zen+Maru+Gothic:wght@500;700;900');
  html = html.replace('</head>', `${THEME_CSS}\n</head>`);
  // 確認用（OK前）は検索に出さない
  if (opts.noindex) html = html.replace('<head>', '<head>\n<meta name="robots" content="noindex,nofollow,noarchive">');
  // 版切替バーは出さない（1ページに統合・2026-09-27 山根さん）
  html = html.replace(/<div class="verbar">[\s\S]*?<\/div><\/div>/, '');
  // 見出しの強調（opts.emphasis の語をサイトと同じ朱色に）と、英字の小見出し
  if (opts.emphasis) html = html.replace(new RegExp(`(<h1>[^<]*?)(${escapeRe(opts.emphasis)})`), '$1<em>$2</em>');
  html = html.replace(/(<div class="hero">\s*<div>)/, '$1<span class="yeyebrow">YORON BBQ REPORT</span>');
  return html;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
}

/** 出力フォルダを仕上げる（ループからも呼ぶ） */
export function finalize(out, { photos, emphasis = '', noindex = false } = {}) {
  if (photos) copyDir(photos, path.join(out, 'img/photos'));
  copyDir(path.join(ROOT, 'chars'), path.join(out, 'img/bbq'));
  // 公開物に要らないもの（page-kit のリマインド用・Potentialightのマーク・3Dキャラ・簡略版）
  for (const f of ['actions.json', 'img/mark.png']) fs.rmSync(path.join(out, f), { force: true });
  for (const d of ['img/char', 'lite', 'todo']) fs.rmSync(path.join(out, d), { recursive: true, force: true });
  const p = path.join(out, 'index.html');
  fs.writeFileSync(p, postProcess(fs.readFileSync(p, 'utf8'), { emphasis, noindex }));
}

const isDirect = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const a = process.argv.slice(2);
  const out = a[0];
  if (!out) { console.error('使い方: node post.mjs out/<id> [--photos <dir>] [--emphasis 語]'); process.exit(1); }
  const arg = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  finalize(out, { photos: arg('--photos'), emphasis: arg('--emphasis') || '', noindex: a.includes('--noindex') });
  console.log('後処理OK:', out);
}
