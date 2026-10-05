/* 日程調整: メンバーのカレンダー（iCal）を取りに行く部分。5分の控え＋一時的な失敗（429・5xx・時間切れ）の取り直し */
const _icsCache = new Map(); // url -> { at, text }
// Google がクラウドからの取得を一時的に断る（HTTP 429）ことがあるので、一時的な失敗は少し待って取り直す（2026-10-05 SRE点検）
const ICS_RETRY_WAIT_MS = [1500, 4000];
async function fetchIcsOnce(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let r;
    try { r = await fetch(url, { signal: ctl.signal, redirect: 'error' }); } catch (e) {
      throw Object.assign(new Error(ctl.signal.aborted ? '時間内に読めませんでした' : 'つながりませんでした'), { transient: true });
    }
    if (!r.ok) throw Object.assign(new Error(`カレンダーを読めませんでした（HTTP ${r.status}）`), { transient: r.status === 429 || r.status >= 500 });
    const text = await r.text();
    if (text.length > 60e6) throw new Error('カレンダーが大きすぎて読めませんでした');
    if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('カレンダーの形式（iCal）ではありませんでした');
    return text;
  } finally { clearTimeout(timer); }
}
async function fetchIcs(url, { waits = ICS_RETRY_WAIT_MS, timeoutMs = 15000 } = {}) {
  const hit = _icsCache.get(url);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.text;
  for (let i = 0; ; i++) {
    try {
      const text = await fetchIcsOnce(url, Array.isArray(timeoutMs) ? timeoutMs[Math.min(i, timeoutMs.length - 1)] : timeoutMs);
      _icsCache.set(url, { at: Date.now(), text });
      return text;
    } catch (e) {
      if (!e.transient || i >= waits.length) throw e;
      await new Promise((ok) => setTimeout(ok, waits[i]));
    }
  }
}

module.exports = { fetchIcs, fetchIcsOnce, _icsCache };
