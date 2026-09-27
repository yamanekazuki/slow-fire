// BBQレポート便の判定ロジック（本番に触らない純関数だけ。report-loop.mjs とテストが共用）
//
// 流れ（2026-09-27 山根さん依頼）:
//   開催日の夜 → 写真・振り返り・LINEからレポートを自動生成 → 確認用URL(noindex)に置く
//   → 山根さんへメール＋運営LINEへ投稿 → やまちゃんがLINEで「レポートOK」→ /report/<日付>/ に公開
import { ymdJst } from "../../../../tools/lib/jst.mjs";

export const MIN_PHOTOS = 5;          // これ未満のアルバムは「まだ写真が集まっていない」とみなす
export const GENERATE_FROM_HOUR = 21; // 開催当日は21時(JST)以降に作る（写真が出そろうのを待つ）
export const CATCHUP_DAYS = 3;        // 開催から3日以内なら取りこぼしを拾う
export const MAX_GENERATIONS = 2;     // 初回＋「振り返りが後から書かれた」ときの更新1回まで
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
    if (diff === 0 && hour < GENERATE_FROM_HOUR) continue;  // 当日は夜まで待つ
    if ((a.photos || 0) < MIN_PHOTOS) continue;
    const e = ledger[a.eventId];
    if (!e) { out.push({ album: a, reason: "new" }); continue; }
    if (["approved", "published", "built"].includes(e.status)) continue; // built は main が送信だけやり直す
    if (e.status === "failed") { if ((e.failures || 0) < MAX_FAILURES) out.push({ album: a, reason: "retry" }); continue; }
    // 送った後に写真が大きく増えた／振り返りが後から書かれた → 1回だけ作り直す
    if (e.status === "sent" && (e.generations || 1) < MAX_GENERATIONS && (e.failures || 0) < MAX_FAILURES) {
      const morePhotos = (a.photos || 0) >= (e.photos || 0) + 10;
      const newNotes = a.notesEditedAt && e.notesEditedAt !== a.notesEditedAt && a.notesEditedAt > (e.sentAt || "");
      if (morePhotos || newNotes) out.push({ album: a, reason: morePhotos ? "more-photos" : "new-notes" });
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
export function sanitizePage(page, { photoNames = [] } = {}) {
  const p = JSON.parse(JSON.stringify(page));
  const errors = [];
  // BBQレポートに要らないビジネス資料の部品（要点・Q&A・次にやること・注意書き）は外す（2026-09-27 山根さんFB）
  for (const k of ["qa", "qaTitle", "qaSub", "next", "nextSub", "nextVoice", "todoPages", "todo", "feedback", "keypoints", "keypointsSub", "disclaimer"]) delete p[k];
  p.lite = false;
  const okVoice = (v) => v && typeof v.text === "string" && KNOWN_LABELS.includes(String(v.label || "").split(/\s/)[0]);
  if (p.voice && !okVoice(p.voice)) delete p.voice;
  const okPhoto = (f) => f.kind !== "image" || photoNames.includes(String(f.url || "").replace(/^img\/photos\//, ""));
  for (const c of p.chapters || []) {
    if (c.voice && !okVoice(c.voice)) delete c.voice;
    delete c.do; delete c.dont;
    for (const k of ["figuresTop", "figures"]) if (Array.isArray(c[k])) c[k] = c[k].filter(okPhoto);
  }
  if (Array.isArray(p.figures)) p.figures = p.figures.filter(okPhoto);
  if (!p.title) errors.push("title がない");
  if (!Array.isArray(p.chapters) || p.chapters.length < 2) errors.push("章が2つ未満");
  return { page: p, errors };
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
