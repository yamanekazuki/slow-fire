/* analyzeCookPhoto の入口チェック（2026-11-11 セキュリティ点検）
   - 未ログインを断る（画面は匿名ログイン済みで呼ぶ）
   - 画像の形式・大きさを検査（画面側はJPEGに圧縮済み）
   - 1人あたり・全体の1日の上限（AI課金の青天井を防ぐ）。数え台帳は _rate/（ルール未定義＝画面からは読み書き不可）
*/
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_B64_CHARS = 5 * 1024 * 1024; // base64で約5MB（元画像 約3.7MB）
const PER_USER_DAILY = 15;
const GLOBAL_DAILY = 300;

/** 入力を検査し、問題があれば { code, message } を返す。問題なければ null */
function checkCookPhotoInput(auth, data) {
  if (!auth || !auth.uid) return { code: 'unauthenticated', message: 'ログインが必要です' };
  const d = data || {};
  if (!d.image || typeof d.image !== 'string') return { code: 'invalid-argument', message: '画像データがありません' };
  if (d.image.length > MAX_B64_CHARS) return { code: 'invalid-argument', message: '画像が大きすぎます' };
  const mime = d.mime || 'image/jpeg';
  if (!ALLOWED_MIME.includes(mime)) return { code: 'invalid-argument', message: '対応していない画像形式です' };
  return null;
}

/** 日本時間の日付（台帳のキー用の表示文字列） */
function jstDay(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

/**
 * 1日の上限を数えて、超えていたら false。台帳が読めない時は閉じる側（false）に倒す。
 * db は firebase-admin の Firestore（テストでは同じ形の偽物）
 */
async function takeCookPhotoQuota(db, uid, now = new Date()) {
  const ref = db.collection('_rate').doc(`analyzeCookPhoto_${jstDay(now)}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : {};
      const total = Number(cur.total || 0);
      const users = cur.users || {};
      const mine = Number(users[uid] || 0);
      if (total >= GLOBAL_DAILY || mine >= PER_USER_DAILY) return false;
      tx.set(ref, { total: total + 1, users: { ...users, [uid]: mine + 1 }, updatedAt: now }, { merge: true });
      return true;
    });
  } catch (e) {
    console.error('analyzeCookPhoto quota check failed:', e.message);
    return false;
  }
}

module.exports = { checkCookPhotoInput, takeCookPhotoQuota, jstDay, PER_USER_DAILY, GLOBAL_DAILY, MAX_B64_CHARS };
