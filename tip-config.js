// チップ（応援）設定 — 2026-08-28 定例で決定（あんちゃん提案・うえたく試算）
// PAYPAY_LINK: 山根さんのPayPay送金リンク（PayPayアプリ→送る→「リンクで送る/受け取る」→自分のマイコードURL）
// 空のままだと tip.html は「準備中」表示・album.html のカードは非表示になる
window.TIP_CONFIG = {
  PAYPAY_LINK: "",
  SUGGEST: [500, 1000, 3000],
  PURPOSE: "与論の拠点づくり（宿・東屋の改修）と、月1BBQの機材に使います。",
  LEDGER_NOTE: "受け取った額は data/tip-ledger.json に台帳化して、定例で共有します。"
};
