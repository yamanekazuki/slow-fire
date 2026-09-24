/**
 * bbq-links — アジェンダ/議事録に貼ってよい「実在URLの台帳」（2026-09-24 山根さん要望）
 *   ・LLMにURLを創作させない。ここにあるURL＋素材に実際に出てきたURLだけを許し、それ以外は sanitizeLinks で剥がす（フェイルクローズ）
 *   ・静的ページはこのファイルの STATIC_PAGES が正本。blog/・spice/ の記事はディレクトリを走査して自動で足す
 */
import fs from "node:fs";
import path from "node:path";

export const SITE = "https://yoron-bbq.com";

export const STATIC_PAGES = [
  { path: "/cooklog.html",   label: "COOK LOG（焼いた一皿の記録）", hint: "cooklog・料理写真・作った記録" },
  { path: "/shopping.html",  label: "買い物チェック",             hint: "持ち込み分担・買い出し・担当" },
  { path: "/event.html",     label: "バーベキューイベント一覧",    hint: "月1BBQ・グリリスト講座の申込・残枠" },
  { path: "/lecture.html",   label: "グリリスト講座（初級編）",     hint: "講座の価格・修了証・内容" },
  { path: "/menu.html",      label: "メニュー台帳（作り方とその理由）", hint: "レシピ・メニュー・menu-harvest" },
  { path: "/cookbook.html",  label: "24品の料理ガイド",           hint: "何を作るか" },
  { path: "/spice.html",     label: "BBQスパイス大全",            hint: "ラブ・黄金比・スパイス講座" },
  { path: "/blog.html",      label: "読みもの（SLOW FIRE）",       hint: "記事一覧・自然検索の入口" },
  { path: "/album.html",     label: "フォトアルバム",             hint: "写真共有・Googleフォト" },
  { path: "/bring-guide.html", label: "持ち物チェックリスト",       hint: "会場別の持ち物" },
  { path: "/venues.html",    label: "蓋付きBBQスポット検索",       hint: "会場探し・施設一覧・貸別荘" },
  { path: "/venue-kiba.html", label: "木場公園の案内",             hint: "10/18 木場公園・参加者向け" },
  { path: "/venue-kiba-host.html", label: "木場公園 運営メモ",      hint: "木場公園の焼く側の段取り" },
  { path: "/sourcing.html",  label: "食材の仕入れガイド",          hint: "丸鶏・ジビエ・市場・魚" },
  { path: "/tip.html",       label: "チップで応援",               hint: "チップ受け皿・PayPay" },
  { path: "/roles.html",     label: "役割図鑑",                   hint: "ファン・アンバサダー・グリリスト" },
  { path: "/helpers.html",   label: "お手伝いリスト",             hint: "当日の手伝い分担" },
  { path: "/team.html",      label: "3人の物語",                  hint: "運営紹介" },
  { path: "/context.html",   label: "はじめての方へ",             hint: "コミュニティの全体像・導線" },
  { path: "/academy.html",   label: "YORON BBQ ACADEMY",          hint: "学ぶ・温度と道具" },
  { path: "/contact.html",   label: "お問い合わせ（法人・団体）",   hint: "法人相談" },
  { path: "/admin.html",     label: "運営管理画面",               hint: "運営だけ・パスコード・申込状況・cooklog投稿" },
  { path: "/",               label: "トップページ",               hint: "サイト全体" },
];

function titleOf(file) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 6000);
    const m = head.match(/<title>([^<]*)<\/title>/);
    return (m ? m[1] : path.basename(file)).split(/[｜|]/)[0].trim();
  } catch { return path.basename(file); }
}

/** blog/・spice/ の記事を新しい順に最大 n 件 */
export function articleCatalog(root, { perDir = 12 } = {}) {
  const out = [];
  for (const dir of ["blog", "spice"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.html$/.test(f)).sort().reverse().slice(0, perDir);
    for (const f of files) out.push({ url: `${SITE}/${dir}/${f}`, label: titleOf(path.join(d, f)), hint: `${dir === "spice" ? "スパイス大全" : "読みもの"}の記事（${f.slice(0, 10)}）` });
  }
  return out;
}

export function linkCatalog(root) {
  const stat = STATIC_PAGES.map((p) => ({ url: `${SITE}${p.path}`, label: p.label, hint: p.hint }));
  return root ? stat.concat(articleCatalog(root)) : stat;
}

export function catalogText(cat) {
  return cat.map((c) => `- ${c.label} … ${c.url}（${c.hint}）`).join("\n");
}

const URL_RE = /https?:\/\/[^\s)<>"'）」】]+/g;
export function extractUrls(text) {
  return Array.from(new Set(String(text || "").match(URL_RE) || []));
}

/**
 * 許可リストに無いURLを本文から剥がす。
 *  - [ラベル](URL) → 不許可ならラベルだけ残す
 *  - 裸URL → 不許可なら削除
 * 戻り: { markdown, removed: [url...] }
 */
export function sanitizeLinks(markdown, allowedUrls) {
  const allowed = new Set((allowedUrls || []).map((u) => u.replace(/\/$/, "")));
  const ok = (u) => allowed.has(u.replace(/\/$/, ""));
  const removed = [];
  let md = String(markdown || "").replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (all, label, url) => {
    if (ok(url)) return all;
    removed.push(url);
    return label;
  });
  md = md.replace(URL_RE, (url) => {
    if (ok(url)) return url;
    removed.push(url);
    return "";
  });
  return { markdown: md.replace(/[ \t]+$/gm, ""), removed };
}
