// BBQレポート便の判定ロジック（本番に触らない純関数だけ。report-loop.mjs とテストが共用）
//
// 流れ（2026-09-27 山根さん依頼）:
//   開催日の夜 → 写真・振り返り・LINEからレポートを自動生成 → 確認用URL(noindex)に置く
//   → 山根さんへメール＋運営LINEへ投稿 → やまちゃんがLINEで「レポートOK」→ /report/<日付>/ に公開
import { ymdJst } from "../../../../tools/lib/jst.mjs";

export const MIN_PHOTOS = 5;          // これ未満のアルバムは「まだ写真が集まっていない」とみなす
export const GENERATE_FROM_HOUR = 21; // 開催当日は21時(JST)以降に作る（写真が出そろうのを待つ）
export const CATCHUP_DAYS = 10;       // 開催から10日以内なら取りこぼしを拾う（2026-09-27「絶対漏れないように」）
export const REMIND_ALBUM_AFTER_DAYS = 1; // 翌日になってもアルバム（写真）が無ければ、山根さんへ「アルバムを作って」と1回知らせる
export const NOTES_ONLY_AFTER_DAYS = 3;  // 3日たっても写真が無く、振り返りだけある回は写真なしで作る
export const MAX_GENERATIONS = 2;     // 初回＋「振り返りが後から書かれた」ときの更新1回まで
export const LOOP_START = "2026-09-26";  // これより前の開催分は対象外（ループ開始前の回を急に作り始めない。9/26が初回）
export const MAX_FAILURES = 3;        // 生成に失敗した回を作り直す上限（毎回Opusを呼び続けない）

/** JSTの時(0-23)。Dateは実時刻のまま持ち、表示用に変換するだけ */
export function jstHour(now) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false }).format(now)) % 24;
}

/** YYYY-MM-DD 同士の日数差（b - a） */
export function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * レポートを作る対象の開催回を選ぶ。
 * albums: [{ eventId:'2026-09-26', albumId, photos:n, label, place }]
 * ledger: { [eventId]: { status, generations, ... } }
 * 戻り値: [{ album, reason }]
 */
export function eventsToGenerate(albums, ledger, now = new Date()) {
  const today = ymdJst(now);
  const hour = jstHour(now);
  const out = [];
  for (const a of albums) {
    const date = String(a.eventId || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const diff = dayDiff(date, today);
    if (diff < 0 || diff > CATCHUP_DAYS) continue;          // 未来の回・古すぎる回は対象外
    if (date < LOOP_START) continue;
    if (diff === 0 && hour < GENERATE_FROM_HOUR) continue;  // 当日は夜まで待つ
    if ((a.photos || 0) < MIN_PHOTOS) continue;
    const e = ledger[a.eventId];
    if (!e || ["reminded", "waiting"].includes(e.status)) { out.push({ album: a, reason: "new" }); continue; }
    if (["approved", "published", "built"].includes(e.status)) continue; // built は main が送信だけやり直す
    if (e.status === "failed") { if ((e.failures || 0) < MAX_FAILURES) out.push({ album: a, reason: "retry" }); continue; }
    // 送った後に写真が大きく増えた／振り返りが後から書かれた → 1回だけ作り直す
    if (e.status === "sent" && (e.generations || 1) < MAX_GENERATIONS && (e.failures || 0) < MAX_FAILURES) {
      const morePhotos = (a.photos || 0) >= (e.photos || 0) + 10;
      const newNotes = a.notesEditedAt && e.notesEditedAt !== a.notesEditedAt && a.notesEditedAt > (e.sentAt || "");
      const moreComments = (a.comments || 0) >= (e.comments || 0) + 2; // 参加者の感想が2件以上増えた
      if (morePhotos || newNotes || moreComments) out.push({ album: a, reason: morePhotos ? "more-photos" : newNotes ? "new-notes" : "more-comments" });
    }
  }
  return out;
}

/**
 * やまちゃんのLINE発言が「公開してOK」か。
 * メッセージ全体が短い承認文に一致したときだけ真（疑問文・条件付き・否定・長文の途中の「OK」は拾わない）
 */
export function isApprovalText(text) {
  const t = String(text || "").normalize("NFKC").replace(/[\s　]+/g, "").replace(/[!！。.、～〜]+$/g, "").replace(/(です|だよ|で|で大丈夫|でお願い|お願いします|お願い)$/g, "");
  if (/[?？]/.test(t)) return false;
  const OK = "(OK|ok|Ok|オッケー|おっけー|おけ|オーケー|いいよ)";
  // 「レポート」を含む短い文だけ（運営グループの別件への「公開して」「大丈夫」を拾わない）
  return new RegExp(`^(この)?(レポート|れぽーと)(は|も)?${OK}$`).test(t)
    || /^(この)?レポート(を)?公開(OK|ok|して|しよう|でOK)$/.test(t);
}

/**
 * 承認の判定。logs: [{ who, userId, groupId, text, createdAt(ISO) }]
 * 送信(sentAt)より後で、承認者のuserId・運営グループのgroupIdに一致する承認発言だけ。
 * approverUserIds が空なら必ず null（フェイルクローズ）
 */
export function findApproval(logs, sentAt, { approverUserIds = [], groupId = "" } = {}) {
  if (!approverUserIds.length || !groupId) return null;
  return (logs || []).find((l) => approverUserIds.includes(l.userId) && l.groupId === groupId
    && String(l.createdAt) > String(sentAt) && isApprovalText(l.text)) || null;
}

/**
 * 承認を探す起点の時刻。最後に送った1件の送付時刻・これまでに送った全回の送付時刻・使用済み承認の時刻のうち一番遅いもの。
 * これより前の「レポートOK」は、別の回（または使用済み）への返事なので使わない（1回のOKで古い回が連鎖公開されるのを防ぐ）
 */
export function approvalCutoff(ledger) {
  const times = Object.entries(ledger).filter(([k]) => !k.startsWith("_")).map(([, e]) => e.sentAt || "").filter(Boolean);
  if (ledger._approvalUsedAt) times.push(ledger._approvalUsedAt);
  return times.sort().pop() || "";
}

/** 承認待ち(sent)の回のうち、最後に送ったもの。承認は「今LINEに出ている最新の1件」にだけ効かせる */
export function latestSent(ledger) {
  return Object.entries(ledger).filter(([k, e]) => !k.startsWith("_") && e.status === "sent" && e.sentAt)
    .sort((a, b) => (a[1].sentAt < b[1].sentAt ? 1 : -1))[0] || null;
}

/** 生成されたpage.jsonを公開前に整える（言っていない吹き出し・知らない写真・ビジネス資料っぽい章を外す） */
export const KNOWN_LABELS = ["ANCHAN", "YAMACHAN", "UETAKU", "YOSSY", "YUTA"];
/** 絵文字を外す（LINEの発言の「‼️」「❗️」などは記号に置き換え、それ以外の絵文字は消す。サイトの文体に絵文字は使わない） */
export function stripEmoji(t) {
  return String(t)
    .replace(/\u203C\uFE0F?/g, "！！").replace(/[\u2757\u2755]\uFE0F?/g, "！").replace(/[\u2753\u2754]\uFE0F?/g, "？")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, "");
}
export function sanitizePage(page, { photoNames = [] } = {}) {
  const p = JSON.parse(JSON.stringify(page), (k, v) => (typeof v === "string" ? stripEmoji(v) : v));
  const errors = [];
  // BBQレポートに要らないビジネス資料の部品（要点・Q&A・次にやること・注意書き）は外す（2026-09-27 山根さんFB）
  for (const k of ["qa", "qaTitle", "qaSub", "next", "nextSub", "nextVoice", "todoPages", "todo", "feedback", "keypoints", "keypointsSub", "disclaimer"]) delete p[k];
  p.lite = false;
  const okVoice = (v) => v && typeof v.text === "string" && KNOWN_LABELS.includes(String(v.label || "").split(/\s/)[0]);
  if (p.voice && !okVoice(p.voice)) delete p.voice;
  // 参加者の声（アルバムの感想から）: 名前と短い感想だけ。最大8件・1件200字まで
  if (Array.isArray(p.guestVoices)) p.guestVoices = p.guestVoices.filter((g) => g && typeof g.text === "string" && g.text.trim()).slice(0, 8).map((g) => ({ name: String(g.name || "").slice(0, 20), text: g.text.slice(0, 200) }));
  else delete p.guestVoices;
  const okPhoto = (f) => f.kind !== "image" || photoNames.includes(String(f.url || "").replace(/^img\/photos\//, ""));
  for (const c of p.chapters || []) {
    if (c.voice && !okVoice(c.voice)) delete c.voice;
    delete c.do; delete c.dont;
    for (const k of ["figuresTop", "figures"]) if (Array.isArray(c[k])) c[k] = c[k].filter(okPhoto);
  }
  if (Array.isArray(p.figures)) p.figures = p.figures.filter(okPhoto);
  if (!p.title) errors.push("title がない");
  if (!Array.isArray(p.chapters) || p.chapters.length < 2) errors.push("章が2つ未満");
  for (const leak of recipeLeaks(splitPage(p).publicPage)) errors.push(`公開版に作り方の細部が残っている（recipe か members:true に移す）: ${leak}`);
  return { page: p, errors };
}

/**
 * 公開版とメンバー版に分ける（2026-10-01 定例の決定「レポートは出すが、レシピ全文は非公開。食べてみたくなる程度の紹介に」）
 * page.json の約束:
 *   chapters[].body            … 公開してよい紹介（味・見た目・その場の様子・感想）
 *   chapters[].recipe          … メンバー版だけに出す作り方の段落（分量・手順・火の入れ方）
 *   図・吹き出しの members:true … メンバー版だけに出す（作り方の表、分量を話している吹き出し など）
 *   今日のメニューの行の5列目   … メンバー版だけに出す作り方（2列目は公開してよいひとこと）
 * メンバー版は Firebase Storage のトークン付きURL（リンクを知っている人だけ・noindex）に置き、公開後も消さない
 */
export const RECIPE_NOTE = "作り方は、一緒に焼いたメンバーだけのお楽しみにしています。気になった料理は、バーベキューに来て焼き手に聞いてみてください。";
export const MEMBERS_NOTE = "メンバー用（作り方つき）のレポートです。リンクを知っている人だけが開けます。外には共有しないでください。";
export function splitPage(page) {
  const clone = () => JSON.parse(JSON.stringify(page));
  const isMenu = (f) => f && f.kind === "table" && /メニュー/.test(String(f.cap || ""));
  const pub = clone();
  const keep = (arr) => (Array.isArray(arr) ? arr.filter((f) => !f?.members) : arr);
  if (pub.voice?.members) delete pub.voice;
  if (Array.isArray(pub.figures)) pub.figures = keep(pub.figures);
  for (const f of pub.figures || []) if (isMenu(f)) f.rows = (f.rows || []).map((r) => r.slice(0, 4));
  let hidden = false;
  for (const c of pub.chapters || []) {
    if (Array.isArray(c.recipe) && c.recipe.length) hidden = true;
    delete c.recipe;
    if (c.voice?.members) { delete c.voice; hidden = true; }
    for (const k of ["figuresTop", "figures"]) {
      if (!Array.isArray(c[k])) continue;
      const before = c[k].length;
      c[k] = keep(c[k]);
      if (c[k].length !== before) hidden = true;
    }
  }
  if (hidden || (page.figures || []).some((f) => f?.members || (isMenu(f) && (f.rows || []).some((r) => r[4])))) pub.recipeNote = RECIPE_NOTE;

  const mem = clone();
  mem.membersNote = MEMBERS_NOTE;
  const strip = (o) => { if (o && typeof o === "object") delete o.members; return o; };
  strip(mem.voice);
  for (const f of mem.figures || []) strip(f);
  for (const c of mem.chapters || []) {
    strip(c.voice);
    for (const k of ["figuresTop", "figures"]) for (const f of c[k] || []) strip(f);
  }
  return { publicPage: pub, membersPage: mem };
}

/** 公開版に作り方の細部（分量・温度・時間）が残っていないか。画像のパス・切り抜き・出典の日付は見ない */
const LEAK_RE = /\d+(?:\.\d+)?\s*(?:g|ｇ|グラム|kg|ml|mL|ｍｌ|cc|℃|°C|度で|度の|分焼|分間|分ほど|分くらい|時間漬|時間焼|時間ほど|時間くらい)|大さじ|小さじ|\d+\s*\/\s*\d+\s*(?:を目安|くらい|ほど)|小瓶の/;
export function recipeLeaks(publicPage) {
  const out = [];
  const walk = (o, key) => {
    if (typeof o === "string") { const m = o.match(LEAK_RE); if (m && !["url", "crop", "date", "id"].includes(key)) out.push(`「${o.slice(Math.max(0, m.index - 12), m.index + m[0].length + 8)}」`); return; }
    if (Array.isArray(o)) return o.forEach((v) => walk(v, key));
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, k);
  };
  walk(publicPage, "");
  return out;
}

/**
 * 特設一覧ページ（/report/）の中身。report/<YYYY-MM-DD>/index.html を走査して作る（台帳が無くなっても一覧は消えない）
 * pages: [{ dir:'2026-09-26', html:'<!DOCTYPE…' }]
 */
export function reportIndexItems(pages) {
  return pages
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.dir) && p.html)
    .map((p) => {
      const h1 = (p.html.match(/<h1>([\s\S]*?)<\/h1>/) || [, ""])[1].replace(/<[^>]+>/g, "").trim();
      const kind = (p.html.match(/BBQレポート｜[^<]*/) || [""])[0].replace(/^BBQレポート｜[^ ]* ?/, "").trim();
      const thumb = (p.html.match(/src="(img\/photos\/[\w.-]+\.jpg)"/) || [, ""])[1];
      return { id: p.dir, date: p.dir, title: h1, place: kind, path: `report/${p.dir}/`, thumb };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** HTMLエスケープ */
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------------------
// 開催日の検知（2026-09-27 山根さん「バーベキューをする日は分かるよね・絶対漏れないように」）
//   素材: 予定台帳 schedule-events.json ／ 山根さんのGoogleカレンダー ／ Notionの振り返りページ ／ アルバム
//   1つでも当たれば「その日にBBQがあった」とみなす。定例（ミーティング）・講座・打ち合わせは除く

const BBQ_WORD = /(BBQ|ＢＢＱ|バーベキュー|ばーべきゅー|月1|月一)/i;
const NOT_EVENT = /(定例|ミーティング|打ち合わせ|打合せ|MTG|mtg|アジェンダ|議事録|招待|講座|コース|Grillist|グリリスト|リマインド|準備)/i;

/** 予定・カレンダーの題名が「BBQをする日」か */
export function isBbqEventTitle(title) {
  const t = String(title || "");
  if (/^\s*あん ?BBQ\s*$/i.test(t)) return false; // 「あんBBQ」はうえたく主催の定例ミーティングの招待名
  return BBQ_WORD.test(t) && !NOT_EVENT.test(t);
}

/**
 * 開催日の候補をまとめる。戻り値: [{ date, sources:[...], titles:[...] }]（新しい順）
 * schedule: [{date,title}] / calendar: [{date,summary}] / notes: [{date,title}] / albums: [{eventId,label}]
 */
export function eventCandidates({ schedule = [], calendar = [], notes = [], albums = [] }, today, { days = CATCHUP_DAYS } = {}) {
  const map = new Map();
  const add = (date, source, title) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return;
    const diff = dayDiff(date, today);
    if (diff < 0 || diff > days) return;
    if (date < LOOP_START) return;
    const e = map.get(date) || { date, sources: [], titles: [] };
    if (!e.sources.includes(source)) e.sources.push(source);
    if (title && !e.titles.includes(title)) e.titles.push(title);
    map.set(date, e);
  };
  for (const e of schedule) if (isBbqEventTitle(e.title)) add(e.date, "schedule", e.title);
  for (const e of calendar) if (isBbqEventTitle(e.summary)) add(e.date, "calendar", e.summary);
  for (const n of notes) if (/(BBQ|ＢＢＱ|バーベキュー)/i.test(n.title || "") && !NOT_EVENT.test(n.title || "")) add(n.date, "notes", n.title);
  for (const a of albums) add(String(a.eventId || "").slice(0, 10), "album", a.label);
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/**
 * アルバムが無い／写真が足りない回をどうするか。
 * 戻り値: "wait"（まだ待つ）／"remind"（アルバムを作ってと知らせる）／"notes-only"（写真なしで作る）／"none"（何もしない）
 */
export function missingAlbumAction(cand, { photos = 0, hasNotes = false, entry = {} } = {}, now = new Date()) {
  if (photos >= MIN_PHOTOS) return "none"; // 通常の生成経路へ
  if (entry.status && !["reminded", "waiting"].includes(entry.status)) return "none"; // 送付済み・公開済みなど
  const diff = dayDiff(cand.date, ymdJst(now));
  if (diff < REMIND_ALBUM_AFTER_DAYS) return "wait";
  if (diff >= NOTES_ONLY_AFTER_DAYS && hasNotes) return "notes-only";
  if (!entry.remindedAt) return "remind";
  return "wait";
}
