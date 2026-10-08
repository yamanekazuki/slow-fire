// request-loop の「作業前の作業ツリー判定」だけを切り出した純関数（2026-10-09）
// 背景: 他ループ（agenda / todo / minutes-act）が scripts/*-ledger.json を未コミットで残すと、
//   scripts/ は自動修正禁止パスなので回収できず、request-loop が10分おきに
//   「Opusで依頼判定 → 未コミットありで中止」を無限に繰り返して従量APIを浪費した。
// 対策: ①他ループの台帳は回収してよい ②回収できない変更があるときは LLM を呼ぶ前に止める
export const FORBIDDEN = [
  "functions/", "firebase.json", "firestore.rules", "firestore.indexes.json",
  "storage.rules", ".firebaserc", ".github/", ".env", "firebase-config.js",
  "scripts/", ".gitignore",
];
export const FORBIDDEN_EXT = [".plist", ".pem", ".key", ".json.enc"];
const LOOP_LEDGER_RE = /^scripts\/[\w.-]+-ledger\.json$/;

// 実装結果に含まれてはいけないパス（実装後チェック用・台帳も含めて禁止のまま）
export function isForbidden(f) {
  return FORBIDDEN.some((p) => f === p || f.startsWith(p)) || FORBIDDEN_EXT.some((e) => f.endsWith(e));
}
// 作業前に「他ループの成果」として回収してよいか
export function isCollectable(f) {
  return !isForbidden(f) || LOOP_LEDGER_RE.test(f);
}
// 回収できず実装を止める原因になるファイル（空なら作業してよい）
export function blockingFiles(changed) {
  return changed.filter((f) => !isCollectable(f));
}
