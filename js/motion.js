/* Ledger motion layer, built on GSAP (vendor/gsap, free Standard licence).
   Rules taken from the motion repos (Remotion skill, Motion Canvas, GSAP and anime.js docs):
   - never linear: expo/power curves for movement, back.out only for small "pops"
   - entrances move two or three properties together (fade + rise + scale) and are staggered
   - exits are quicker than entrances
   - idle things breathe gently so a screen never looks frozen
   - nothing runs while you type, and Reduce Motion switches all of it off.
   The app calls window.LM; if GSAP failed to load, every call quietly does nothing. */
(function () {
  const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const E = { out: 'expo.out', soft: 'power3.out', inout: 'power3.inOut', pop: 'back.out(1.6)', exit: 'power2.in' };
  const T = { enter: 0.55, exit: 0.22, stagger: 0.05 };
  let ok = false;
  const idle = [];
  const ready = () => ok && !RM();

  function init() {
    if (!window.gsap) return;
    try { gsap.registerPlugin(window.DrawSVGPlugin, window.MotionPathPlugin); } catch (e) { /* plugins optional */ }
    ok = true;
  }

  // Stop the breathing loops from the screen that was just replaced
  function killIdle() { while (idle.length) idle.pop().kill(); }

  /* ---------- odometer: each digit rolls from the last figure you saw ---------- */
  function odo(el, fromText, toText, done) {
    if (!ready()) { el.textContent = toText; done && done(); return; }
    const lh = parseFloat(getComputedStyle(el).lineHeight) || el.getBoundingClientRect().height || 30;
    const fd = fromText.replace(/\D/g, ''), td = toText.replace(/\D/g, '');
    let di = 0;
    el.innerHTML = [...toText].map((ch) => (/\d/.test(ch)
      ? `<span class="odo" style="height:${lh}px"><span class="odo-col">${'0123456789'.split('').map((n) => `<span style="height:${lh}px;line-height:${lh}px">${n}</span>`).join('')}</span></span>`
      : `<span class="odo-sep">${ch}</span>`)).join('');
    const cols = [...el.querySelectorAll('.odo-col')];
    const sameLen = fd.length === td.length;
    const tl = gsap.timeline({ onComplete: () => { el.textContent = toText; done && done(); } });
    cols.forEach((c, i) => {
      const to = +td[i];
      // digits line up from the right; a new leading digit starts a few places off so it visibly rolls in
      const j = fd.length - td.length + i, from = sameLen || j >= 0 ? +(fd[j] ?? (to + 5) % 10) : (to + 5) % 10;
      const steps = Math.abs(to - from);
      tl.fromTo(c, { y: -from * lh }, { y: -to * lh, duration: 0.7 + steps * 0.045, ease: E.out }, i * 0.035);
    });
  }

  /* ---------- Safe to spend ring: drains when a payment comes in, then breathes ---------- */
  let ringLast = null;
  function ring(root) {
    const svg = root.querySelector('svg.meter'); if (!svg) return;
    const arc = svg.querySelector('.meter-arc'), to = +arc.getAttribute('stroke-dashoffset');
    const from = ringLast; ringLast = to;
    if (!ready()) return;
    if (from != null && Math.abs(from - to) > 0.5) {
      svg.classList.add('gs'); // the CSS arrival animation stands down
      gsap.fromTo(arc, { attr: { 'stroke-dashoffset': from } }, { attr: { 'stroke-dashoffset': to }, duration: 1.1, ease: E.out, delay: 0.15 });
      if (to > from) gsap.fromTo(arc, { attr: { 'stroke-width': 14 } }, { attr: { 'stroke-width': 10 }, duration: 0.9, ease: E.soft, delay: 0.15 }); // a little shudder when money goes out
    }
    idle.push(gsap.to(svg, { scale: 1.025, transformOrigin: '50% 50%', duration: 2.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.3 }));
  }

  /* ---------- bars fill and the "today" marker glides to its place ---------- */
  function markers(root) {
    if (!ready()) return;
    root.querySelectorAll('.safebar b').forEach((b) => {
      const to = b.style.left;
      gsap.fromTo(b, { left: '0%', autoAlpha: 0 }, { left: to, autoAlpha: 0.55, duration: 1.2, ease: E.out, delay: 0.3 });
    });
  }

  /* ---------- charts: the net worth line draws with a dot riding its tip ---------- */
  function charts(root) {
    if (!ready()) return;
    root.querySelectorAll('.chart svg').forEach((svg) => {
      const line = svg.querySelector('path.draw'); if (!line || !window.MotionPathPlugin) return;
      const area = svg.querySelector('path[fill^="url"]');
      if (area) gsap.fromTo(area, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, ease: 'power1.out', delay: 0.5 });
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '3.2'); dot.setAttribute('fill', line.getAttribute('stroke') || 'currentColor'); dot.setAttribute('class', 'tipdot');
      svg.appendChild(dot);
      gsap.timeline({ delay: 0.05 })
        .fromTo(dot, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.15 })
        .to(dot, { duration: 0.95, ease: 'power2.inOut', motionPath: { path: line, align: line, alignOrigin: [0.5, 0.5] } }, 0)
        .to(dot, { attr: { r: 5 }, duration: 0.2, ease: E.pop })
        .to(dot, { attr: { r: 3.2 }, duration: 0.3, ease: E.soft });
    });
    // budget and category bars arrive one after another
    const bars = [...root.querySelectorAll('.bar i')].slice(0, 20);
    if (bars.length) gsap.fromTo(bars, { scaleX: 0, transformOrigin: 'left center' }, { scaleX: 1, duration: 0.7, ease: E.soft, stagger: 0.06, delay: 0.15, clearProps: 'transform' });
  }

  /* ---------- a card grows into its screen ---------- */
  function expand(rect, bg, radius) {
    if (!ready() || !rect) return false;
    const o = document.createElement('div'); o.className = 'expander';
    Object.assign(o.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', borderRadius: radius || '18px', background: bg || 'var(--card)' });
    document.body.appendChild(o);
    gsap.timeline({ onComplete: () => o.remove() })
      .to(o, { left: 0, top: 0, width: innerWidth, height: innerHeight, borderRadius: 0, duration: 0.36, ease: E.inout })
      .to(o, { autoAlpha: 0, duration: 0.22, ease: 'power1.out' });
    return true;
  }
  // ...and the new screen's cards settle in behind it
  function enter(main, delay = 0.22) {
    if (!ready()) return;
    const kids = [...main.children].slice(0, 14);
    gsap.fromTo(kids, { autoAlpha: 0, y: 18, scale: 0.985 }, { autoAlpha: 1, y: 0, scale: 1, duration: T.enter, ease: E.out, stagger: T.stagger, delay, clearProps: 'opacity,visibility,transform' });
  }

  /* ---------- a sheet opens out of the card you tapped ---------- */
  function sheetFrom(rect, sheet, bg) {
    if (!ready() || !rect) return false;
    sheet.style.transition = 'none'; sheet.style.transform = 'none';
    const r2 = sheet.getBoundingClientRect();
    sheet.style.opacity = '0';
    const o = document.createElement('div'); o.className = 'expander';
    Object.assign(o.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', borderRadius: '18px', background: bg || 'var(--card)', zIndex: 33 });
    document.body.appendChild(o);
    const kids = [...sheet.children];
    gsap.timeline({ onComplete: () => { o.remove(); sheet.style.transition = ''; sheet.style.transform = ''; } })
      .to(o, { left: r2.left, top: r2.top, width: r2.width, height: r2.height, borderRadius: '20px 20px 0 0', duration: 0.4, ease: E.inout })
      .set(sheet, { opacity: 1 })
      .fromTo(kids, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: E.soft, stagger: 0.03, clearProps: 'opacity,visibility,transform' })
      .to(o, { autoAlpha: 0, duration: 0.18, ease: 'power1.out' }, '<');
    return true;
  }

  /* ---------- month changes slide the screen in from the side you swiped ---------- */
  function slide(main, dir) {
    if (!ready()) return;
    const kids = [...main.children].slice(0, 10);
    gsap.fromTo(kids, { autoAlpha: 0, x: dir * 36 }, { autoAlpha: 1, x: 0, duration: 0.45, ease: E.out, stagger: 0.035, clearProps: 'opacity,visibility,transform' });
  }

  /* ---------- newly read SMS slide in, lit up for a moment ---------- */
  function fresh(root, ids) {
    if (!ids || !ids.size) return;
    // move the whole row (its swipe actions sit underneath the visible part)
    const rows = [...root.querySelectorAll('[data-id]')].filter((r) => ids.has(r.dataset.id) && (r.matches('.sw') || (r.matches('.item') && !r.closest('.sw'))));
    if (!rows.length) return;
    rows.forEach((r) => (r.querySelector('.item') || r).classList.add('freshrow'));
    if (!ready()) return;
    gsap.fromTo(rows, { autoAlpha: 0, x: 40 }, { autoAlpha: 1, x: 0, duration: 0.5, ease: E.out, stagger: 0.08, delay: 0.25, clearProps: 'opacity,visibility,transform' });
  }

  /* ---------- a removed row folds shut ---------- */
  function fold(el, done) {
    if (!ready() || !el) { done(); return; }
    const h = el.offsetHeight;
    gsap.timeline({ onComplete: done })
      .to(el, { x: -28, autoAlpha: 0, duration: 0.16, ease: E.exit })
      .fromTo(el, { height: h }, { height: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0, duration: 0.2, ease: 'power2.inOut' });
  }

  /* ---------- "Saved": a pill whose tick draws itself ---------- */
  let pill = null;
  function saved(msg) {
    if (!pill) {
      pill = document.createElement('div'); pill.className = 'savedpill'; pill.setAttribute('role', 'status');
      pill.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 10.5l3.2 3.2L15 7"/></svg><span></span>';
      document.body.appendChild(pill);
    }
    pill.querySelector('span').textContent = msg;
    const path = pill.querySelector('path');
    if (!ready()) { pill.style.opacity = 1; pill.style.transform = 'translateX(-50%)'; clearTimeout(pill._t); pill._t = setTimeout(() => { pill.style.opacity = 0; }, 1300); return; }
    gsap.killTweensOf([pill, path]);
    gsap.timeline()
      .fromTo(pill, { autoAlpha: 0, y: -10, scale: 0.9, xPercent: -50 }, { autoAlpha: 1, y: 0, scale: 1, xPercent: -50, duration: 0.32, ease: E.pop })
      .fromTo(path, { drawSVG: '0%' }, { drawSVG: '100%', duration: 0.35, ease: 'power2.out' }, 0.08)
      .to(pill, { autoAlpha: 0, y: -8, duration: 0.22, ease: E.exit }, 1.35);
  }

  /* ---------- milestone: sparks from a card and a short note ---------- */
  function burst(el, text) {
    if (!el) return;
    const host = el.getBoundingClientRect();
    const lab = document.createElement('div'); lab.className = 'burstnote'; lab.textContent = text;
    el.style.position ||= 'relative'; el.appendChild(lab);
    if (!ready()) { setTimeout(() => lab.remove(), 2600); return; }
    const cols = ['#e2c27f', '#7fb08f', '#8fb3e8', '#d98b5f'];
    for (let i = 0; i < 22; i++) {
      const p = document.createElement('i'); p.className = 'spark';
      p.style.left = host.width / 2 + 'px'; p.style.top = '34px'; p.style.background = cols[i % 4];
      el.appendChild(p);
      const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * 60;
      gsap.fromTo(p, { scale: 0, autoAlpha: 1 }, { x: Math.cos(a) * d, y: Math.sin(a) * d - 12, scale: 1, autoAlpha: 0, duration: 0.9 + Math.random() * 0.5, ease: 'power3.out', delay: 0.5, onComplete: () => p.remove() });
    }
    gsap.timeline({ delay: 0.55 })
      .fromTo(lab, { autoAlpha: 0, y: 8, scale: 0.9, xPercent: -50 }, { autoAlpha: 1, y: 0, scale: 1, xPercent: -50, duration: 0.4, ease: E.pop })
      .to(lab, { autoAlpha: 0, y: -6, duration: 0.3, ease: E.exit }, 2.6)
      .add(() => lab.remove());
  }

  /* ---------- once a day: the wordmark settles while today's figure rolls up ---------- */
  function intro(label, fromText, toText) {
    if (!ready()) return;
    const o = document.createElement('div'); o.className = 'intro'; o.setAttribute('aria-hidden', 'true');
    o.innerHTML = `<div class="iw">Ledger</div><svg class="il" viewBox="0 0 200 6"><path d="M2 3 H198"/></svg>
      <div class="ilab">${label}</div><div class="ival big num"></div>`;
    document.body.appendChild(o);
    const val = o.querySelector('.ival'), w = o.querySelector('.iw'), ln = o.querySelector('.il path'), lb = o.querySelector('.ilab');
    let tl;
    const close = () => { tl && tl.kill(); gsap.to(o, { autoAlpha: 0, duration: 0.3, ease: E.exit, onComplete: () => o.remove() }); };
    o.addEventListener('click', close);
    setTimeout(() => { if (o.isConnected) o.remove(); }, 4500); // never left covering the app, whatever happens to the animation
    tl = gsap.timeline({ onComplete: close });
    tl.fromTo(w, { autoAlpha: 0, y: 14, letterSpacing: '0.25em' }, { autoAlpha: 1, y: 0, letterSpacing: '0em', duration: 0.7, ease: E.out })
      .fromTo(ln, { drawSVG: '50% 50%' }, { drawSVG: '0% 100%', duration: 0.6, ease: E.inout }, 0.25)
      .fromTo([lb, val], { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: E.soft, stagger: 0.08 }, 0.45)
      .add(() => odo(val, fromText, toText), 0.5)
      .to({}, { duration: 1.1 });
  }

  /* ---------- the big title shrinks into a slim bar as you scroll ---------- */
  let raf = 0;
  function onScroll() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = document.getElementById('top'); if (!top) return;
      const k = RM() ? (scrollY > 30 ? 1 : 0) : Math.max(0, Math.min(1, scrollY / 70));
      top.style.setProperty('--k', k.toFixed(3));
      top.classList.toggle('slim', k > 0.98);
    });
  }
  addEventListener('scroll', onScroll, { passive: true });

  window.LM = { get ok() { return ready(); }, killIdle, odo, ring, markers, charts, expand, enter, sheetFrom, slide, fresh, fold, saved, burst, intro, onScroll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
