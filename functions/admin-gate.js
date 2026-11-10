/* 管理画面APIの合言葉チェック（2026-11-11 セキュリティ点検）
   - 合言葉の総当たりを防ぐため、失敗を1時間単位で数え、接続元ごと・全体の上限を超えたらその時間は止める
   - 数え台帳は _rate/（ルール未定義＝画面からは読み書き不可）。台帳が読めない時は通さない
*/
const crypto = require('crypto');

const PER_IP_FAILS_PER_HOUR = 10;
const GLOBAL_FAILS_PER_HOUR = 30;

/** 長さが違っても落ちない、時間一定の比較 */
function samePass(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** 日本時間の「日付T時」（台帳のキー用の表示文字列） */
function jstHour(now = new Date()) {
  const s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(now);
  return s.replace(' ', 'T');
}

const ipKey = (ip) => String(ip || 'unknown').replace(/[^A-Za-z0-9]/g, '_').slice(0, 64);

/**
 * 合言葉を確かめる。返り値 { ok: true } / { ok: false, reason: 'locked' | 'bad' | 'unavailable' }
 * db は firebase-admin の Firestore（テストでは同じ形の偽物）
 */
async function checkAdminPass(db, { pass, expected, ip, now = new Date() }) {
  const ref = db.collection('_rate').doc(`adminFail_${jstHour(now)}`);
  const key = ipKey(ip);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const cur = snap.exists ? snap.data() : {};
      const total = Number(cur.total || 0);
      const ips = cur.ips || {};
      const mine = Number(ips[key] || 0);
      if (total >= GLOBAL_FAILS_PER_HOUR || mine >= PER_IP_FAILS_PER_HOUR) return { ok: false, reason: 'locked' };
      if (expected && pass && samePass(pass, expected)) return { ok: true };
      tx.set(ref, { total: total + 1, ips: { ...ips, [key]: mine + 1 }, updatedAt: now }, { merge: true });
      return { ok: false, reason: 'bad' };
    });
  } catch (e) {
    console.error('admin gate ledger failed:', e.message);
    return { ok: false, reason: 'unavailable' };
  }
}

module.exports = { checkAdminPass, samePass, jstHour, PER_IP_FAILS_PER_HOUR, GLOBAL_FAILS_PER_HOUR };
