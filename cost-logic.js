/* BBQ食材の見積もり（cost.html）の計算（2026-10-10 山根さん「料理を選んだらいくらになるかを予測したい」）
   料理と材料は data/shopping-items.json、値段は data/price-ledger.json が正本。
   買い方は2つ: usual=いつもの店（shopping-items の購入場所どおり）／lopia=ロピアに値段があればロピア、なければいつもの店
   いつもの店に値段がなければ「近所のスーパー」の値段で代わりに数え、それも無ければ「値段なし」として合計から外して一覧に出す。
   node のテスト（scripts/test/cost-logic.test.mjs）からも読む */
(function (root) {
  // "3個" "800g〜1kg" "1.5kg" "10〜12尾" "適量" → {n, unit}（範囲は小さい方・kgはgへ）
  function parseQty(s) {
    var t = String(s || '').replace(/\s/g, '');
    var m = t.match(/^([\d.]+)\s*(kg|g|ml|cc)?/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    var u = (m[2] || '').toLowerCase();
    if (!u) { var w = t.replace(/^[\d.]+/, '').replace(/^〜[\d.]+/, ''); u = w; }
    if (u === 'kg') { n = n * 1000; u = 'g'; }
    if (!(n > 0)) return null;
    return { n: n, unit: u };
  }

  function canon(ledger, name) { return (ledger.alias && ledger.alias[name]) || name; }

  function priceOf(ledger, item, store) {
    var ps = ledger.prices || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].item === item && ps[i].store === store) return ps[i];
    return null;
  }

  // 必要量 need（{n,unit} か null=適量）をその値段で買うといくらか。単位が合わなければ null
  function costFor(p, need) {
    if (!need) return { cost: p.price, packs: 1 };
    if (need.unit !== p.unit) return null;
    if (p.loose) return { cost: Math.round(p.price * need.n / p.size), packs: need.n / p.size };
    var packs = Math.max(1, Math.ceil(need.n / p.size - 1e-9));
    return { cost: packs * p.price, packs: packs };
  }

  // 人数に合わせた必要量。perPerson があればそれ、なければ基準人数からの比例（個数は切り上げ）
  function needFor(ledger, item, qtyText, people) {
    var pp = ledger.perPerson && ledger.perPerson[item];
    if (pp) return { n: pp.n * people, unit: pp.unit };
    var q = parseQty(qtyText);
    if (!q) return null;
    var n = q.n * people / (ledger.baseline || 8);
    if (q.unit !== 'g' && q.unit !== 'ml' && q.unit !== 'cc') n = Math.max(1, Math.ceil(n - 1e-9));
    return { n: n, unit: q.unit };
  }

  function pick(ledger, item, need, plan, usual) {
    var order = plan === 'lopia' ? ['lopia', usual, 'super'] : [usual, 'super'];
    for (var i = 0; i < order.length; i++) {
      var p = priceOf(ledger, item, order[i]);
      if (!p) continue;
      var c = costFor(p, need);
      if (c) return { p: p, cost: c.cost, packs: c.packs };
    }
    return null;
  }

  // shopping: shopping-items.json / dishNames: 選んだ料理 / people: 人数 / plan: 'usual'|'lopia'
  function estimate(ledger, shopping, dishNames, people, plan) {
    var sel = {}; (dishNames || []).forEach(function (n) { sel[n] = true; });
    var rows = [];
    (shopping.dishes || []).forEach(function (d) {
      if (!sel[d.name]) return;
      d.items.forEach(function (it) { rows.push({ dish: d.name, name: it[0], qty: it[1], where: it[2] }); });
    });
    (shopping.seasonings || []).forEach(function (it) { rows.push({ dish: '共通', name: it[0], qty: it[1], where: it[2] }); });
    var lines = [], bring = [], missing = [], total = 0;
    rows.forEach(function (r) {
      var usual = (ledger.usualStore && ledger.usualStore[r.where]) || 'super';
      if (usual === 'bring') { bring.push(r); return; }
      var item = canon(ledger, r.name);
      var need = needFor(ledger, item, r.qty, people);
      var hit = pick(ledger, item, need, plan, usual);
      if (!hit) { missing.push({ dish: r.dish, name: r.name, usual: usual }); return; }
      total += hit.cost;
      lines.push({ dish: r.dish, name: r.name, item: item, need: need, store: hit.p.store, cost: hit.cost, packs: hit.packs, src: hit.p.src, date: hit.p.date, stock: hit.p.stock || '', usual: usual, swapped: hit.p.store !== usual && hit.p.store !== 'lopia' });
    });
    return { total: total, perPerson: people > 0 ? Math.round(total / people) : 0, lines: lines, bring: bring, missing: missing };
  }

  // ある食材を店ごとに比べる（同じ必要量で）。安い順
  function compareItem(ledger, item, people) {
    var pp = ledger.perPerson && ledger.perPerson[item];
    var need = pp ? { n: pp.n * people, unit: pp.unit } : null;
    return (ledger.prices || []).filter(function (p) { return p.item === item; }).map(function (p) {
      var c = costFor(p, need) || { cost: p.price, packs: 1 };
      var unitPrice = p.unit === 'g' ? Math.round(p.price / p.size * 100) : p.price;
      return { store: p.store, cost: c.cost, packs: c.packs, unitPrice: unitPrice, unit: p.unit === 'g' ? '100g' : p.unit, p: p };
    }).sort(function (a, b) { return a.cost - b.cost; });
  }

  var api = { parseQty: parseQty, needFor: needFor, costFor: costFor, estimate: estimate, compareItem: compareItem };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BbqCost = api;
})(this);
