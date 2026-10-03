/* メニュー相談＋買い物リスト（shoplists）を管理ページから作るための純粋関数（2026-10-01 山根さん「管理ページからやりたい」）
   mini の当日案内便（scripts/guest-guide-loop.mjs の ensureShoplist）と同じ形のドキュメントを作る。
   回ごとの対応は menu_picks/{開催日} に残し、管理ページと mini の便で二重に作らない */
const OWNERS = ['やまちゃん', 'うえたく'];

function normalizeMenuPickInput(data) {
  const eventId = String(data?.eventId || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventId)) throw new Error('開催日を選んでください');
  const raw = data?.fixed && typeof data.fixed === 'object' ? data.fixed : {};
  const fixed = {};
  for (const [k, v] of Object.entries(raw).slice(0, 12)) {
    const name = String(k).trim().slice(0, 60);
    if (name) fixed[name] = String(v == null ? '' : v).trim().slice(0, 60);
  }
  const shortTitle = String(data?.shortTitle || '月1BBQ').trim().slice(0, 30) || '月1BBQ';
  return { eventId, fixed, shortTitle };
}

function shoplistDoc({ eventId, fixed, shortTitle }, nowIso) {
  return {
    title: `${eventId.replace(/-/g, '')} ${shortTitle}`,
    owners: [...OWNERS], members: [...OWNERS],
    who: {}, checks: {}, skips: {}, wants: {},
    menuPickEventId: eventId, wantsByEvent: { [eventId]: {} },
    dishes: Object.keys(fixed), menuFixed: { ...fixed },
    createdAt: nowIso, updatedAt: nowIso,
  };
}

function normalizeWantList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((v) => String(v || '').trim()).filter(Boolean))]
    : [];
}

function currentWantsForEvent(data, eventId, owners = OWNERS) {
  const scoped = data?.wantsByEvent && typeof data.wantsByEvent === 'object'
    ? data.wantsByEvent[eventId]
    : null;
  const source = scoped && typeof scoped === 'object'
    ? scoped
    : (data?.menuPickEventId === eventId ? data?.wants : null);
  const wants = {};
  for (const person of owners) wants[person] = normalizeWantList(source?.[person]);
  return wants;
}

function legacyUnscopedWants(data, eventId, owners = OWNERS) {
  const scoped = data?.wantsByEvent && typeof data.wantsByEvent === 'object'
    ? data.wantsByEvent[eventId]
    : null;
  if (scoped || data?.menuPickEventId) return {};
  const wants = {};
  for (const person of owners) wants[person] = normalizeWantList(data?.wants?.[person]);
  return Object.values(wants).some((list) => list.length) ? wants : {};
}

function withParticipantWants(data, eventId, person, list) {
  return {
    ...(data || {}),
    menuPickEventId: eventId,
    wantsByEvent: {
      ...((data && data.wantsByEvent) || {}),
      [eventId]: {
        ...(((data && data.wantsByEvent) || {})[eventId] || {}),
        [person]: normalizeWantList(list),
      },
    },
  };
}

function menuPickUrls(shoplist) {
  return {
    pickUrl: `https://yoron-bbq.com/menu-pick.html?l=${shoplist}`,
    shopUrl: `https://yoron-bbq.com/shopping.html?l=${shoplist}`,
  };
}

module.exports = { OWNERS, normalizeMenuPickInput, shoplistDoc, menuPickUrls, currentWantsForEvent, legacyUnscopedWants, withParticipantWants };
