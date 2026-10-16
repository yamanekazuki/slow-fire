/* =============================================
   与論島の宿の予約・問い合わせ（yoron-bbq.web.app の予約フォーム）2026-10-16
   - 山根さん「あんちゃん・うえたく・ヨッシーにも届けて」→ 運営名簿（config/bbq_admins）の全員へ届ける
   - フォームは stay_inquiries に保存するだけ。メールの中身はここで組み立てる（本番に触らない部分）
   - test: true の送信は山根さんだけに届く（4人に試験メールを送らない）
   ============================================= */

const FIELD_MAX = { name: 100, email: 200, date: 100, party: 100, interest: 100, message: 5000, page: 500 };

/** 保存された1件を、メールに使う形に整える（長すぎる・文字列でない値は切り詰め・空にする） */
function normalizeInquiry(d) {
  const out = {};
  for (const [k, max] of Object.entries(FIELD_MAX)) out[k] = typeof d?.[k] === 'string' ? d[k].trim().slice(0, max) : '';
  out.test = d?.test === true;
  return out;
}

/** 件名（誰が・いつ来たいか、が受信箱で一目でわかるように） */
function inquirySubject(d) {
  return `${d.test ? '【テスト】' : ''}【与論の宿 問い合わせ】${d.name}さん／${d.date || '日程未定'}${d.party ? '・' + d.party : ''}`;
}

/** メール本文の表（見出し, 値）。値は呼び出し側でエスケープする */
function inquiryRows(d) {
  return [
    ['お名前', d.name],
    ['メール', d.email],
    ['希望日', d.date || '—'],
    ['人数', d.party || '—'],
    ['ご興味', d.interest || '—'],
    ['メッセージ', d.message || '—'],
    ['送信元', d.page || '—'],
  ];
}

module.exports = { FIELD_MAX, normalizeInquiry, inquirySubject, inquiryRows };
