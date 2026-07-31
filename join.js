/* =====================================================
   YORON BBQ COMMUNITY — 入会・月1BBQ申込フォーム共通
   依存: firebase compat SDK + firebase-config.js
   ===================================================== */
(function () {
  'use strict';

  var CAPACITY = 10;

  function $(sel, root) { return (root || document).querySelector(sel); }

  function setMsg(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = 'form-msg' + (kind ? ' ' + kind : '');
    el.style.display = text ? 'block' : 'none';
  }

  // ---- 残枠表示（開催回ごとに event_stats/{eventId} を購読） ----
  var seatCache = {};

  function renderSeats() {
    document.querySelectorAll('[data-seats-for]').forEach(function (el) {
      var d = seatCache[el.getAttribute('data-seats-for')];
      if (!d) return;
      el.querySelectorAll('[data-seat-count]').forEach(function (n) { n.textContent = d.count; });
      el.querySelectorAll('[data-seat-cap]').forEach(function (n) { n.textContent = d.cap; });
      el.querySelectorAll('[data-seat-left]').forEach(function (n) { n.textContent = d.left; });
    });
  }

  function initSeatCounter() {
    if (!window.db) return;
    var ids = {};
    document.querySelectorAll('[data-seats-for]').forEach(function (el) { ids[el.getAttribute('data-seats-for')] = 1; });
    document.querySelectorAll('#eventSlot option').forEach(function (op) { ids[op.value] = 1; });
    Object.keys(ids).forEach(function (eventId) {
      window.db.doc('event_stats/' + eventId).onSnapshot(function (snap) {
        var count = (snap.exists && snap.data().count) || 0;
        var cap = (snap.exists && snap.data().capacity) || CAPACITY;
        seatCache[eventId] = { count: count, cap: cap, left: Math.max(cap - count, 0) };
        renderSeats();
        document.dispatchEvent(new CustomEvent('seats:update', { detail: Object.assign({ eventId: eventId }, seatCache[eventId]) }));
      }, function (err) { console.warn('seats:', err && err.code); });
    });
  }

  // ---- 開催回セレクト: 選択に合わせてフォームと残枠カードを切替 ----
  function initEventSlot() {
    var sel = document.getElementById('eventSlot');
    var form = document.querySelector('#eventRegForm');
    if (!sel || !form) return;
    sel.addEventListener('change', function () {
      var op = sel.options[sel.selectedIndex];
      form.setAttribute('data-event-id', op.value);
      form.setAttribute('data-event-label', op.getAttribute('data-label') || op.textContent);
      var card = document.getElementById('seatCard');
      if (card) card.setAttribute('data-seats-for', op.value);
      var lb = document.getElementById('seatEvLabel');
      if (lb) lb.textContent = op.getAttribute('data-short') || op.textContent;
      renderSeats();
      var d = seatCache[op.value];
      applyFullState(d ? d.left <= 0 : false);
    });
  }

  function applyFullState(full) {
    var form = document.querySelector('#eventRegForm');
    if (!form) return;
    var btn = form.querySelector('button[type=submit]');
    if (btn) btn.textContent = full ? 'キャンセル待ちで申し込む' : 'この回に申し込む';
    var note = document.querySelector('#regFullNote');
    if (note) note.style.display = full ? 'block' : 'none';
  }

  // ---- 満席時のフォーム表示切替（選択中の回のみ反映） ----
  document.addEventListener('seats:update', function (e) {
    var form = $('#eventRegForm');
    if (!form || form.getAttribute('data-event-id') !== e.detail.eventId) return;
    applyFullState(e.detail.left <= 0);
  });

  // ---- GA4 コンバージョン計測（gtag が無ければ何もしない） ----
  // members = 入会フォーム（index.html） / event_regs = 月1BBQ申込（event.html）
  var CONV_EVENTS = { members: 'member_join', event_regs: 'event_register', lecture_regs: 'lecture_register' };
  function trackConversion(collection) {
    var name = CONV_EVENTS[collection];
    if (!name || typeof window.gtag !== 'function') return;
    try { window.gtag('event', name); } catch (e) {}
  }

  function submitDoc(collection, data, form, msgEl, okText) {
    if (!window.db) { setMsg(msgEl, '送信の準備ができていません。時間をおいてお試しください。', 'err'); return; }
    var btn = $('button[type=submit]', form);
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '送信中…'; }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    window.db.collection(collection).add(data).then(function () {
      trackConversion(collection);
      form.reset();
      form.style.display = 'none';
      var done = form.parentElement.querySelector('.form-done');
      if (done) done.style.display = 'block'; else setMsg(msgEl, okText, 'ok');
    }).catch(function (err) {
      console.error(err);
      setMsg(msgEl, '送信に失敗しました。時間をおいてもう一度お試しください。', 'err');
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label; }
    });
  }

  // ---- 月1BBQ申込 ----
  function initEventForm() {
    var form = $('#eventRegForm');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msgEl = $('#eventRegMsg');
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      if (!name || !/.+@.+\..+/.test(email)) { setMsg(msgEl, 'お名前と正しいメールアドレスをご入力ください。', 'err'); return; }
      submitDoc('event_regs', {
        eventId: form.getAttribute('data-event-id'),
        eventLabel: form.getAttribute('data-event-label') || '',
        name: name,
        email: email,
        party: parseInt(form.party.value, 10) || 1,
        referrer: form.referrer ? (form.referrer.value || '').trim().slice(0, 100) : '',
        note: (form.note.value || '').trim().slice(0, 1000),
      }, form, msgEl, 'お申し込みを受け付けました。確認メールをお送りしています。');
    });
  }

  // ---- バーベキュー講座申込（lecture.html） ----
  function initLectureForm() {
    var form = $('#lectureRegForm');
    if (!form) return;
    var sel = document.getElementById('lectureSlot');
    if (sel) {
      sel.addEventListener('change', function () {
        var op = sel.options[sel.selectedIndex];
        form.setAttribute('data-event-id', op.value);
        form.setAttribute('data-event-label', op.getAttribute('data-label') || op.textContent);
      });
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msgEl = $('#lectureRegMsg');
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      if (!name || !/.+@.+\..+/.test(email)) { setMsg(msgEl, 'お名前と正しいメールアドレスをご入力ください。', 'err'); return; }
      submitDoc('lecture_regs', {
        eventId: form.getAttribute('data-event-id'),
        eventLabel: form.getAttribute('data-event-label') || '',
        name: name,
        email: email,
        party: parseInt(form.party.value, 10) || 1,
        note: (form.note.value || '').trim().slice(0, 1000),
      }, form, msgEl, 'お申し込みを受け付けました。確認メールをお送りしています。');
    });
  }

  // ---- コミュニティ入会 ----
  function initJoinForm() {
    var form = $('#joinForm');
    if (!form) return;
    var refSel = document.getElementById('joinReferrer');
    var refOther = document.getElementById('joinReferrerOtherWrap');
    if (refSel && refOther) {
      refSel.addEventListener('change', function () {
        refOther.style.display = refSel.value === 'その他' ? '' : 'none';
      });
    }
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msgEl = $('#joinMsg');
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      if (!name || !/.+@.+\..+/.test(email)) { setMsg(msgEl, 'お名前と正しいメールアドレスをご入力ください。', 'err'); return; }
      var referrer = form.referrer ? form.referrer.value : '';
      if (referrer === 'その他' && form.referrerOther && form.referrerOther.value.trim()) {
        referrer = 'その他: ' + form.referrerOther.value.trim().slice(0, 100);
      }
      submitDoc('members', {
        name: name,
        email: email,
        role: form.role.value || 'fan',
        referrer: referrer,
        note: (form.note.value || '').trim().slice(0, 1000),
      }, form, msgEl, 'ようこそ！確認メールをお送りしています。');
    });
  }

  // ---- 法人・団体からのご相談（contact.html） ----
  function initContactForm() {
    var form = $('#contactForm');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msgEl = $('#contactMsg');
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      var message = form.message.value.trim();
      if (!name || !/.+@.+\..+/.test(email)) { setMsg(msgEl, 'お名前と正しいメールアドレスをご入力ください。', 'err'); return; }
      if (!message) { setMsg(msgEl, 'ご相談の内容をご入力ください。', 'err'); return; }
      submitDoc('contact_messages', {
        name: name,
        email: email,
        org: (form.org.value || '').trim().slice(0, 100),
        topic: form.topic.value || 'other',
        message: message.slice(0, 3000),
      }, form, msgEl, 'ご相談を受け付けました。3営業日を目安にお返事します。');
      if (typeof gtag === 'function') gtag('event', 'contact_submit', { event_category: 'engagement' });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initSeatCounter();
    initEventSlot();
    initEventForm();
    initLectureForm();
    initJoinForm();
    initContactForm();
  });
})();
