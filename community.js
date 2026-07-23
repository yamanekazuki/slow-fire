// YORON BBQ COMMUNITY — shared page interactions (index/academy/event)
(function () {
  'use strict';

  // nav scroll state
  var nav = document.getElementById('nav');
  var onScroll = function () {
    nav.classList.toggle('scrolled', window.scrollY > 24);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // mobile menu
  var burger = document.querySelector('.nav-hamburger');
  var menu = document.getElementById('mobileMenu');
  if (burger && menu) {
    burger.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      burger.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-hidden', String(!open));
      document.body.style.overflow = open ? 'hidden' : '';
    });
    menu.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () {
        menu.classList.remove('open');
        burger.setAttribute('aria-expanded', 'false');
        menu.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
      });
    });
  }

  // reveal on scroll
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var targets = document.querySelectorAll('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('visible'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    targets.forEach(function (el) { io.observe(el); });
  }

  // count-up numbers ([data-count])
  var counters = document.querySelectorAll('[data-count]');
  var runCount = function (el) {
    var target = parseInt(el.getAttribute('data-count'), 10) || 0;
    var t0 = null;
    var dur = 1600;
    var step = function (ts) {
      if (!t0) t0 = ts;
      var p = Math.min((ts - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString('ja-JP');
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  if (counters.length) {
    if (reduced || !('IntersectionObserver' in window)) {
      counters.forEach(function (el) {
        el.textContent = (parseInt(el.getAttribute('data-count'), 10) || 0).toLocaleString('ja-JP');
      });
    } else {
      var cio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            runCount(e.target);
            cio.unobserve(e.target);
          }
        });
      }, { threshold: 0.4 });
      counters.forEach(function (el) { cio.observe(el); });
    }
  }

  // news: refresh list from blog/posts.json (static fallback markup stays if fetch fails)
  var newsList = document.getElementById('newsList');
  if (newsList && location.protocol !== 'file:') {
    fetch('blog/posts.json')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (posts) {
        if (!Array.isArray(posts) || !posts.length) return;
        posts.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
        var esc = function (t) {
          return String(t).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
          });
        };
        newsList.innerHTML = posts.slice(0, 5).map(function (p) {
          return '<a class="news-item" href="blog/' + esc(encodeURI(p.file)) + '">' +
            '<span class="news-date">' + esc((p.date || '').replace(/-/g, '.')) + '</span>' +
            '<span class="news-cat">' + esc(p.category || 'コラム') + '</span>' +
            '<span class="news-title">' + esc(p.title) + '</span></a>';
        }).join('');
      })
      .catch(function () { /* keep static fallback */ });
  }

  // contact form (no backend yet — mailto fallback removed; show gentle notice)
  var form = document.querySelector('.contact-wrap');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      btn.textContent = '受付を準備中です。Instagram（@afro_anri）のDMからご連絡ください';
      btn.disabled = true;
      if (typeof gtag === 'function') {
        gtag('event', 'contact_submit', { event_category: 'engagement' });
      }
    });
  }
})();
