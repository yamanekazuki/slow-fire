// YORON BBQ 運営メンバーのメール宛先（2026-09-27 ヨッシー加入で4人に）
//   宛先は Firestore config/bbq_admins.emails が正本（このリポジトリは公開なので、個人のアドレスをコードに書かない）。
//   Functions（申込・入会・問い合わせ・アルバム）と、scripts のメール便（BBQレポート・週報）が同じ宛先を読む。
//   読めないときは山根さんだけに送る（誰にも届かない、を避ける）。
import { gcpAccessToken } from "../../../../tools/lib/gcp-sa.mjs";

const DOC = "https://firestore.googleapis.com/v1/projects/cook-log-df240/databases/(default)/documents/config/bbq_admins";
export const FALLBACK = ["yamane@potentialight.com"];

/** Firestore のドキュメントから宛先を取り出す（重複・空・形の崩れたアドレスは除く） */
export function parseAdmins(doc) {
  const vals = doc?.fields?.emails?.arrayValue?.values || [];
  const out = [];
  for (const v of vals) {
    const e = String(v.stringValue || "").trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

export async function adminEmails() {
  try {
    const r = await fetch(DOC, { headers: { Authorization: `Bearer ${await gcpAccessToken()}` } });
    if (!r.ok) return FALLBACK;
    const list = parseAdmins(await r.json());
    return list.length ? list : FALLBACK;
  } catch { return FALLBACK; }
}
