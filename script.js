/* ============================================
   SLOW FIRE — Scripts v2
   ============================================ */

// ======================== NAV ========================
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 60);
}, { passive: true });

// ======================== FIRE PARTICLE SYSTEM ========================
const canvas = document.getElementById('fireCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas, { passive: true });

const FIRE_PALETTE = [
  [249, 115, 22],   // orange
  [217, 119, 6],    // amber
  [220, 38,  38],   // red
  [253, 186, 116],  // light orange
  [251, 191, 36],   // yellow
  [194, 65,  12],   // dark fire
];

const SMOKE_PALETTE = [
  [60, 45, 30],
  [80, 62, 42],
  [50, 38, 25],
];

class FireParticle {
  constructor(spread = false) {
    this.reset(spread);
  }

  reset(spread = false) {
    const w = canvas.width;
    const h = canvas.height;
    const zone = w * 0.55;
    const offset = (w - zone) / 2;

    this.x = offset + Math.random() * zone;
    this.y = spread ? Math.random() * h : h + Math.random() * 60;

    this.baseSize = Math.random() * 4.5 + 0.8;
    this.size = this.baseSize;
    this.speedX = (Math.random() - 0.5) * 0.65;
    this.speedY = -(Math.random() * 2.4 + 0.5);
    this.wobble = Math.random() * Math.PI * 2;
    this.wobbleSpeed = Math.random() * 0.035 + 0.008;
    this.life = 1;
    this.decay = Math.random() * 0.012 + 0.004;
    this.col = FIRE_PALETTE[Math.floor(Math.random() * FIRE_PALETTE.length)];
  }

  update() {
    this.wobble += this.wobbleSpeed;
    this.x += this.speedX + Math.sin(this.wobble) * 0.55;
    this.y += this.speedY;
    this.life -= this.decay;
    this.size = this.baseSize * this.life;
  }

  draw() {
    const [r, g, b] = this.col;
    const alpha = Math.max(0, this.life * 0.72);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowBlur = 20;
    ctx.shadowColor = `rgb(${r},${g},${b})`;

    const grad = ctx.createRadialGradient(
      this.x, this.y, 0,
      this.x, this.y, this.size * 2.4
    );
    grad.addColorStop(0,   `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.38)`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  isDead() {
    return this.life <= 0 || this.y < -40;
  }
}

class SmokeParticle {
  constructor() {
    this.reset();
  }

  reset() {
    const w = canvas.width;
    const h = canvas.height;
    const zone = w * 0.4;
    const offset = (w - zone) / 2;

    this.x = offset + Math.random() * zone;
    this.y = h * 0.3 + Math.random() * h * 0.4;

    this.size = Math.random() * 60 + 30;
    this.speedX = (Math.random() - 0.5) * 0.3;
    this.speedY = -(Math.random() * 0.4 + 0.1);
    this.wobble = Math.random() * Math.PI * 2;
    this.wobbleSpeed = Math.random() * 0.008 + 0.003;
    this.life = Math.random() * 0.3 + 0.05;
    this.decay = Math.random() * 0.0015 + 0.0005;
    this.col = SMOKE_PALETTE[Math.floor(Math.random() * SMOKE_PALETTE.length)];
  }

  update() {
    this.wobble += this.wobbleSpeed;
    this.x += this.speedX + Math.sin(this.wobble) * 0.4;
    this.y += this.speedY;
    this.life -= this.decay;
    this.size += 0.25;
  }

  draw() {
    const [r, g, b] = this.col;
    const alpha = Math.max(0, this.life * 0.55);

    ctx.save();
    ctx.globalAlpha = alpha;

    const grad = ctx.createRadialGradient(
      this.x, this.y, 0,
      this.x, this.y, this.size
    );
    grad.addColorStop(0,   `rgba(${r},${g},${b},0.5)`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},0.15)`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  isDead() {
    return this.life <= 0 || this.y < -80;
  }
}

const FIRE_COUNT  = 150;
const SMOKE_COUNT = 20;

const fireParticles  = Array.from({ length: FIRE_COUNT  }, () => new FireParticle(true));
const smokeParticles = Array.from({ length: SMOKE_COUNT }, () => new SmokeParticle());

function renderParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const p of smokeParticles) {
    p.update();
    p.draw();
    if (p.isDead()) p.reset();
  }

  for (const p of fireParticles) {
    p.update();
    p.draw();
    if (p.isDead()) p.reset();
  }

  requestAnimationFrame(renderParticles);
}
renderParticles();

// ======================== SCROLL REVEAL ========================
const revealEls = document.querySelectorAll('.reveal');

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, {
  threshold: 0.08,
  rootMargin: '0px 0px -40px 0px'
});

revealEls.forEach(el => revealObserver.observe(el));

// ======================== SMOOTH SCROLL ========================
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const href = anchor.getAttribute('href');
    if (href === '#') return;
    e.preventDefault();
    const target = document.querySelector(href);
    if (!target) return;
    const top = target.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top, behavior: 'smooth' });
  });
});

// ======================== MENU DRAG SCROLL ========================
const menuWrap  = document.getElementById('menuScrollWrap');
const menuTrack = document.getElementById('menuTrack');

if (menuWrap && menuTrack) {
  let isDown    = false;
  let startX    = 0;
  let scrollLeft = 0;

  menuWrap.addEventListener('mousedown', (e) => {
    isDown = true;
    startX = e.pageX - menuWrap.offsetLeft;
    scrollLeft = menuWrap.scrollLeft;
    menuWrap.style.userSelect = 'none';
  });

  menuWrap.addEventListener('mouseleave', () => { isDown = false; });
  menuWrap.addEventListener('mouseup',    () => { isDown = false; menuWrap.style.userSelect = ''; });

  menuWrap.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x    = e.pageX - menuWrap.offsetLeft;
    const walk = (x - startX) * 1.8;
    menuWrap.scrollLeft = scrollLeft - walk;
  });

  // Touch swipe
  let touchStartX = 0;
  let touchScrollLeft = 0;

  menuWrap.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].pageX;
    touchScrollLeft = menuWrap.scrollLeft;
  }, { passive: true });

  menuWrap.addEventListener('touchmove', (e) => {
    const x = e.touches[0].pageX;
    const walk = (touchStartX - x) * 1.5;
    menuWrap.scrollLeft = touchScrollLeft + walk;
  }, { passive: true });
}

// ======================== CONTACT FORM ========================
const form = document.querySelector('.contact-form');
if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const original = btn.textContent;

    btn.textContent = '送信完了！ありがとうございます。';
    btn.style.background = '#16a34a';
    btn.style.boxShadow = '0 8px 24px rgba(22,163,74,0.28)';
    btn.disabled = true;

    setTimeout(() => {
      btn.textContent = original;
      btn.style.background = '';
      btn.style.boxShadow = '';
      btn.disabled = false;
      form.reset();
    }, 4000);
  });
}

// ======================== NAV HAMBURGER (mobile menu overlay) ========================
const hamburger  = document.querySelector('.nav-hamburger');
const mobileMenu = document.getElementById('mobileMenu');

function setMenu(open) {
  if (!hamburger || !mobileMenu) return;
  hamburger.classList.toggle('is-open', open);
  hamburger.setAttribute('aria-expanded', String(open));
  mobileMenu.classList.toggle('is-open', open);
  mobileMenu.setAttribute('aria-hidden', String(!open));
  document.body.classList.toggle('menu-open', open);
}

if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => {
    setMenu(!mobileMenu.classList.contains('is-open'));
  });
  mobileMenu.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => setMenu(false))
  );
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mobileMenu.classList.contains('is-open')) setMenu(false);
  });
  // Close on viewport resize back to desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768 && mobileMenu.classList.contains('is-open')) setMenu(false);
  });
}

// ======================== PILLAR CARD HOVER GLOW ========================
document.querySelectorAll('.pillar-card').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width)  * 100;
    const y = ((e.clientY - rect.top)  / rect.height) * 100;
    card.style.background = `radial-gradient(circle at ${x}% ${y}%, rgba(249,115,22,0.08) 0%, rgba(255,255,255,0.018) 60%)`;
  });
  card.addEventListener('mouseleave', () => {
    card.style.background = '';
  });
});

// ======================== SERVICE CARD GLOW ========================
document.querySelectorAll('.svc-card').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width)  * 100;
    const y = ((e.clientY - rect.top)  / rect.height) * 100;
    if (!card.classList.contains('svc-card--featured')) {
      card.style.background = `radial-gradient(circle at ${x}% ${y}%, rgba(249,115,22,0.055) 0%, rgba(255,255,255,0.018) 60%)`;
    }
  });
  card.addEventListener('mouseleave', () => {
    if (!card.classList.contains('svc-card--featured')) {
      card.style.background = '';
    }
  });
});
