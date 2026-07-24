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

  // ---- 残枠表示（event_stats/{eventId} を購読） ----
  function initSeatCounter() {
    var els = document.querySelectorAll('[data-seats-for]');
    if (!els.length || !window.db) return;
    els.forEach(function (el) {
      var eventId = el.getAttribute('data-seats-for');
      window.db.doc('event_stats/' + eventId).onSnapshot(function (snap) {
        var count = (snap.exists && snap.data().count) || 0;
        var cap = (snap.exists && snap.data().capacity) || CAPACITY;
        var left = Math.max(cap - count, 0);
        el.querySelectorAll('[data-seat-count]').forEach(function (n) { n.textContent = count; });
        el.querySelectorAll('[data-seat-cap]').forEach(function (n) { n.textContent = cap; });
        el.querySelectorAll('[data-seat-left]').forEach(function (n) { n.textContent = left; });
        document.dispatchEvent(new CustomEvent('seats:update', { detail: { eventId: eventId, count: count, cap: cap, left: left } }));
      }, function (err) { console.warn('seats:', err && err.code); });
    });
  }

  // ---- 満席時のフォーム表示切替 ----
  document.addEventListener('seats:update', function (e) {
    var d = e.detail;
    var form = $('#eventRegForm');
    if (!form || form.getAttribute('data-event-id') !== d.eventId) return;
    var btn = $('button[type=submit]', form);
    var full = d.left <= 0;
    if (btn) btn.textContent = full ? 'キャンセル待ちで申し込む' : 'この回に申し込む';
    var note = $('#regFullNote');
    if (note) note.style.display = full ? 'block' : 'none';
  });

  function submitDoc(collection, data, form, msgEl, okText) {
    if (!window.db) { setMsg(msgEl, '送信の準備ができていません。時間をおいてお試しください。', 'err'); return; }
    var btn = $('button[type=submit]', form);
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '送信中…'; }
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    window.db.collection(collection).add(data).then(function () {
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
        note: (form.note.value || '').trim().slice(0, 1000),
      }, form, msgEl, 'お申し込みを受け付けました。確認メールをお送りしています。');
    });
  }

  // ---- コミュニティ入会 ----
  function initJoinForm() {
    var form = $('#joinForm');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var msgEl = $('#joinMsg');
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      if (!name || !/.+@.+\..+/.test(email)) { setMsg(msgEl, 'お名前と正しいメールアドレスをご入力ください。', 'err'); return; }
      submitDoc('members', {
        name: name,
        email: email,
        role: form.role.value || 'fan',
        note: (form.note.value || '').trim().slice(0, 1000),
      }, form, msgEl, 'ようこそ！確認メールをお送りしています。');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initSeatCounter();
    initEventForm();
    initJoinForm();
  });
})();
