// =====================================================
// COOK LOG — Firebase 設定（スタンドアロン）
// =====================================================
// 未設定のままでも localStorage の「個人記録モード」で動作します。
// みんなで共有する／AI写真解析を使うには、ここに実際のキーを入れて
// firebase deploy してください（手順は SETUP.md）。
//
// セットアップ:
// 1. https://console.firebase.google.com でプロジェクト作成
// 2. 「ウェブアプリを追加」→ firebaseConfig をコピーして下記に貼付
// 3. Authentication → ログイン方法 → 「匿名」を有効化
// 4. Firestore Database を作成（本番モード / asia-northeast1）
// 5. Storage を作成（asia-northeast1）
// =====================================================

const COOK_CONFIG = {
  firebase: {
    apiKey:            "AIzaSyA7ViT1AKO2mutYMRprbs1h2YukBM1rdjM",
    authDomain:        "cook-log-df240.firebaseapp.com",
    projectId:         "cook-log-df240",
    storageBucket:     "cook-log-df240.firebasestorage.app",
    messagingSenderId: "1031052377042",
    appId:             "1:1031052377042:web:cdfe8ec0123bcdafeb260b",
    measurementId:     "G-HD1Q3L6BNX"
  },
  functionsRegion: "asia-northeast1",
};

// ----- 初期化（変更不要） -----
let db = null, sfAuth = null, sfStorage = null, sfFunctions = null;
const FIREBASE_READY = (() => {
  try {
    if (COOK_CONFIG.firebase.apiKey.startsWith("YOUR_")) {
      console.warn('[COOK LOG] ⚠ Firebase未設定 — 個人記録モード（localStorage）で動作します。');
      return false;
    }
    if (typeof firebase === 'undefined') {
      console.warn('[COOK LOG] Firebase SDK が読み込まれていません');
      return false;
    }
    if (!firebase.apps.length) firebase.initializeApp(COOK_CONFIG.firebase);
    db     = firebase.firestore();
    sfAuth = firebase.auth();
    if (firebase.storage)   sfStorage   = firebase.storage();
    if (firebase.functions) sfFunctions = firebase.functions(COOK_CONFIG.functionsRegion || 'asia-northeast1');
    window.db = db;
    window.sfAuth = sfAuth;
    window.sfStorage = sfStorage;
    window.sfFunctions = sfFunctions;
    window.FIREBASE_READY = true;
    console.log('[COOK LOG] Firebase 初期化完了');
    return true;
  } catch (e) {
    console.error('[COOK LOG] 初期化エラー:', e);
    window.FIREBASE_READY = false;
    return false;
  }
})();
window.FIREBASE_READY = FIREBASE_READY;
