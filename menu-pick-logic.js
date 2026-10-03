/* メニュー相談（menu-pick.html）の並べ方と「やりたい」の付け外し（2026-10-03 山根さん）
   画面は3段で固定する: 確定（毎回これはやる）→ やりたい（誰かが押した料理・誰がやりたいか付き）→ 選択肢（まだ誰も押していない料理）
   「やりたい」をもう一度押すと外れて選択肢に戻る。買い物リストの料理（dishes）は 確定＋やりたい に毎回そろえる。
   node のテスト（scripts/test/menu-pick-logic.test.mjs）からも読む */
(function (root) {
  function has(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  // dishes: レシピの料理一覧（[{name,...}]）/ data: shoplists/{l} / people: ['やまちゃん','うえたく'] / me: 今の自分
  function group(dishes, data, people, me) {
    var fixed = (data && data.menuFixed) || {}, wants = (data && data.wants) || {};
    var st = function (name) {
      return {
        fixed: has(fixed, name) ? fixed[name] : undefined,
        who: people.filter(function (p) { return (wants[p] || []).indexOf(name) >= 0; }),
        mine: !!me && (wants[me] || []).indexOf(name) >= 0
      };
    };
    var F = [], W = [], O = [];
    dishes.forEach(function (d) {
      var s = st(d.name);
      if (s.fixed !== undefined) F.push(d); else if (s.who.length) W.push(d); else O.push(d);
    });
    // やりたい枠の中は「2人とも」を先に。同じ人数ならレシピの順のまま（押すたびに並びが入れ替わらない）
    var idx = {}; dishes.forEach(function (d, i) { idx[d.name] = i; });
    W.sort(function (a, b) { return (st(b.name).who.length - st(a.name).who.length) || (idx[a.name] - idx[b.name]); });
    var both = W.filter(function (d) { return st(d.name).who.length === people.length; }).length;
    var mine = W.filter(function (d) { return st(d.name).mine; }).length;
    // 買い物リストに入る料理の数＝確定＋やりたい＋買い物リスト側で直接足した料理
    var shop = {}; ((data && data.dishes) || []).concat(F.map(function (d) { return d.name; }), W.map(function (d) { return d.name; })).forEach(function (n) { shop[n] = 1; });
    return { st: st, fixed: F, wanted: W, options: O, counts: { fixed: F.length, want: W.length, both: both, mine: mine, shop: Object.keys(shop).length } };
  }

  // 「やりたい」を押した／外したときの次の状態。cur は shoplists/{l} の今の中身
  function toggle(cur, me, name) {
    cur = cur || {};
    var wants = {}; Object.keys(cur.wants || {}).forEach(function (k) { wants[k] = (cur.wants[k] || []).slice(); });
    var mineList = wants[me] || [];
    var on = mineList.indexOf(name) < 0;
    wants[me] = on ? mineList.concat([name]) : mineList.filter(function (x) { return x !== name; });
    var fixed = cur.menuFixed || {};
    var anyone = Object.keys(wants).some(function (k) { return (wants[k] || []).indexOf(name) >= 0; });
    var dishes = (cur.dishes || []).slice();
    if (on && dishes.indexOf(name) < 0) dishes.push(name);
    // 最後の「やりたい」が外れたら買い物リストからも外す（確定の料理は外さない）
    if (!on && !anyone && !has(fixed, name)) dishes = dishes.filter(function (x) { return x !== name; });
    // 確定の料理が買い物リストから抜けていたら戻す
    Object.keys(fixed).forEach(function (k) { if (dishes.indexOf(k) < 0) dishes.push(k); });
    return { on: on, wants: wants, dishes: dishes };
  }

  var api = { group: group, toggle: toggle };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MenuPick = api;
})(this);
