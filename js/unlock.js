/* Ledger unlock sequence. Plays every time Ledger opens or unlocks: the green card floats, fans out into
   your accounts, whips back, drops into the leather sleeve, and Home fades in behind it.
   Account names come from your data on this phone. Built on GSAP; off under Reduce Motion. */
(function () {
  const CSS = `
#ux{position:fixed;inset:0;z-index:90;perspective:1100px;perspective-origin:50% 42%;touch-action:none;overflow:hidden;
  background:radial-gradient(120% 70% at 50% 18%,#15201b 0%,#0b110e 55%,#070b09 100%);color:#ece7db;font-family:var(--font)}
#ux{--g1:#d2b377;--g2:#2b6b52}
#ux .u-floor{position:absolute;left:50%;top:62%;width:420px;height:150px;margin-left:-210px;border-radius:50%;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--g1) 55%,transparent),color-mix(in srgb,var(--g2) 35%,transparent) 55%,transparent);filter:blur(18px);opacity:0}
#ux .u-floor2{position:absolute;left:50%;top:70%;width:600px;height:220px;margin-left:-300px;border-radius:50%;
  background:radial-gradient(closest-side,color-mix(in srgb,var(--g2) 28%,transparent),transparent);filter:blur(30px);opacity:0}
#ux .u-tilt,#ux .u-flo,#ux .u-rig{position:absolute;left:50%;top:44%;width:0;height:0;transform-style:preserve-3d}
#ux .u-flo,#ux .u-rig{left:0;top:0}
#ux .u-card{position:absolute;left:-150px;top:-95px;width:300px;height:190px;border-radius:16px;transform-style:preserve-3d;backface-visibility:hidden;will-change:transform}
#ux .u-face{position:absolute;inset:0;border-radius:16px;overflow:hidden;box-shadow:0 1px 0 rgba(255,255,255,.08) inset,0 0 0 1px rgba(255,255,255,.06) inset,0 30px 60px -20px rgba(0,0,0,.7)}
#ux .u-c0 .u-face{background:repeating-linear-gradient(115deg,rgba(255,255,255,.018) 0 2px,transparent 2px 5px),linear-gradient(135deg,#1c3229 0%,#0f1d17 46%,#16281f 70%,#0b1611 100%)}
#ux .u-chip{position:absolute;left:26px;top:58px;width:42px;height:32px;border-radius:7px;background:linear-gradient(135deg,#f0dcae,#c9a45e 45%,#e8cf96 60%,#a8823a);box-shadow:0 0 0 1px rgba(0,0,0,.25) inset}
#ux .u-chip::before{content:"";position:absolute;left:14px;right:14px;top:4px;bottom:4px;border-radius:3px;box-shadow:0 0 0 1px rgba(80,60,20,.35)}
#ux .u-chip::after{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:rgba(80,60,20,.35)}
#ux .u-mark{position:absolute;right:22px;top:18px;font-family:var(--serif);font-size:22px;font-weight:500;color:#d2b377;text-shadow:0 1px 0 rgba(0,0,0,.6),0 0 14px rgba(210,179,119,.25)}
#ux .u-lab{position:absolute;left:26px;bottom:20px;max-width:62%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;font-weight:650;letter-spacing:.16em;text-transform:uppercase;color:rgba(236,231,219,.85)}
#ux .u-sub{position:absolute;right:22px;bottom:20px;font-size:12px;font-weight:600;letter-spacing:.08em;color:rgba(236,231,219,.6)}
#ux .u-glint{position:absolute;top:-30%;bottom:-30%;width:38%;left:0;transform:translateX(-160%) skewX(-18deg);pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,240,210,.22),rgba(255,255,255,.34),rgba(255,240,210,.18),transparent)}
#ux .u-cf .u-lab,#ux .u-cf .u-sub{top:15px;bottom:auto;color:rgba(16,24,20,.82)}#ux .u-cf .u-lab{left:20px}#ux .u-cf .u-sub{right:20px}
#ux .u-t1 .u-face{background:linear-gradient(135deg,rgba(226,194,127,.95),rgba(168,130,58,.85))}
#ux .u-t2 .u-face{background:linear-gradient(135deg,rgba(127,212,164,.92),rgba(43,107,82,.88))}
#ux .u-t3 .u-face{background:linear-gradient(135deg,rgba(217,139,95,.95),rgba(140,70,45,.85))}
#ux .u-t4 .u-face{background:linear-gradient(135deg,rgba(236,222,190,.95),rgba(176,152,110,.85))}
#ux .u-t5 .u-face{background:linear-gradient(135deg,rgba(143,179,232,.92),rgba(42,82,120,.88))}
#ux .u-sleeve{position:absolute;left:-168px;width:336px;transform-style:preserve-3d}
#ux .u-s-back{top:-40px;height:250px;border-radius:22px;background:radial-gradient(120% 90% at 50% 0%,#1d3328,#0f1c16 70%);box-shadow:0 0 0 1px rgba(210,179,119,.12) inset}
#ux .u-s-front{top:58px;height:152px;border-radius:14px 14px 22px 22px;overflow:hidden;
  background:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1.2px) 0 0/5px 5px,radial-gradient(rgba(0,0,0,.25) 1px,transparent 1.3px) 2px 3px/6px 6px,linear-gradient(180deg,#203a2e,#142820 60%,#0f1f18);
  box-shadow:0 -1px 0 rgba(210,179,119,.35) inset,0 -18px 30px -18px rgba(0,0,0,.6) inset,0 30px 60px -20px rgba(0,0,0,.8)}
#ux .u-s-front::before{content:"";position:absolute;left:14px;right:14px;top:12px;bottom:14px;border-radius:10px;border:1.5px dashed rgba(210,179,119,.28)}
#ux .u-s-front .u-emb{position:absolute;left:0;right:0;bottom:30px;text-align:center;font-family:var(--serif);font-size:17px;color:#0b1712;text-shadow:0 1px 0 rgba(255,255,255,.08),0 -1px 0 rgba(0,0,0,.55)}
#ux .u-s-ring{position:absolute;left:-174px;width:348px;top:52px;height:164px;border-radius:24px;pointer-events:none;opacity:0}
#ux .u-cap{position:absolute;left:0;right:0;top:calc(44% + 222px);text-align:center;pointer-events:none}
#ux .u-cap .u-k{font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#9da8a2}
#ux .u-cap .u-v{font-family:var(--serif);font-size:30px;font-weight:450;margin-top:6px;min-height:1.2em}
#ux .u-lock{display:inline-block;width:16px;height:16px;vertical-align:-2px;margin-right:6px}
#ux .u-lock path{fill:none;stroke:#d2b377;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}`;

  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let running = null;

  // cards: [{ lab, sub }]: the first is the green metal card, up to five more fan out behind it
  function play({ cards, greeting, name, onDone }) {
    if (running || !window.gsap || matchMedia('(prefers-reduced-motion: reduce)').matches) { onDone && onDone(); return; }
    if (!document.getElementById('ux-css')) { const st = document.createElement('style'); st.id = 'ux-css'; st.textContent = CSS; document.head.appendChild(st); }
    const list = cards.slice(0, 6);
    while (list.length < 6) list.push(null);
    const el = document.createElement('div'); el.id = 'ux'; el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<div class="u-floor2"></div><div class="u-floor"></div>
      <div class="u-tilt"><div class="u-flo"><div class="u-rig">
        <div class="u-sleeve u-s-back"></div>
        ${list.slice(1).map((c, k) => c ? `<div class="u-card u-cf u-t${k + 1}" data-i="${k + 1}"><div class="u-face"><div class="u-lab">${esc(c.lab)}</div><div class="u-sub">${esc(c.sub)}</div></div></div>` : '').reverse().join('')}
        <div class="u-card u-c0" data-i="0"><div class="u-face"><div class="u-chip"></div><div class="u-mark">Ledger</div><div class="u-lab">${esc(list[0]?.lab || 'Ledger')}</div><div class="u-sub">${esc(list[0]?.sub || '')}</div><div class="u-glint"></div></div></div>
        <div class="u-sleeve u-s-front"><div class="u-emb">Ledger</div></div>
        <div class="u-sleeve u-s-ring"></div>
      </div></div></div>
      <div class="u-cap"><div class="u-k">${esc(greeting)}</div><div class="u-v">${esc(name)}</div></div>`;
    document.body.appendChild(el);
    const q = (s) => el.querySelector(s), qa = (s) => [...el.querySelectorAll(s)];
    const tilt = q('.u-tilt'), flo = q('.u-flo'), rig = q('.u-rig'), c0 = q('.u-c0');
    const fan = qa('.u-cf').sort((a, b) => a.dataset.i - b.dataset.i), all = [c0, ...fan];
    const back = q('.u-s-back'), front = q('.u-s-front'), ring = q('.u-s-ring'), capk = q('.u-cap .u-k'), capv = q('.u-cap .u-v');
    gsap.set(tilt, { scale: Math.min(1, (innerWidth - 40) / 320) });

    // drag to tilt; otherwise it sways on its own
    const rx = gsap.quickTo(tilt, 'rotationX', { duration: 0.6, ease: 'power3.out' }), ry = gsap.quickTo(tilt, 'rotationY', { duration: 0.6, ease: 'power3.out' });
    const gx = gsap.quickTo(q('.u-c0 .u-glint'), 'xPercent', { duration: 0.6, ease: 'power3.out' });
    let drag = false;
    const mv = (e) => { const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5; rx(-ny * 26); ry(nx * 34); gx(-160 + (nx + 0.5) * 420); };
    el.addEventListener('pointerdown', (e) => { drag = true; sway.pause(); mv(e); });
    el.addEventListener('pointermove', (e) => { if (drag) mv(e); });
    const up = () => { if (!drag) return; drag = false; rx(0); ry(0); gx(-160); sway.resume(); };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    const sway = gsap.to(tilt, { rotationY: 7, rotationX: -3, duration: 3.2, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true });
    const breathe = gsap.to(flo, { y: -9, duration: 2.1, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true });
    const caption = (k, v) => gsap.timeline().to([capk, capv], { autoAlpha: 0, y: -6, duration: 0.2, ease: 'power2.in' })
      .add(() => { capk.innerHTML = k; capv.innerHTML = v || ''; })
      .to([capk, capv], { autoAlpha: 1, y: 0, duration: 0.45, ease: 'power3.out', stagger: 0.06 });
    const spot = (i) => ({ x: (i - 2.5) * 5, y: 96 - i * 38, z: -i * 34, rotationZ: (2.5 - i) * 2.2, rotationY: 0, rotationX: 14 });

    gsap.set(fan, { autoAlpha: 0, z: -2 });
    gsap.set([back, front, ring], { y: 520 });
    gsap.set(c0, { y: 260, z: -220, rotationX: 40, autoAlpha: 0 });
    gsap.set([capk, capv], { autoAlpha: 0 });

    let finished = false;
    const finish = () => {
      if (finished) return; finished = true;
      gsap.to(el, { autoAlpha: 0, duration: 0.7, ease: 'power2.inOut', onComplete: () => { sway.kill(); breathe.kill(); el.remove(); running = null; } });
      onDone && onDone();
    };
    const safety = setTimeout(finish, 16000); // never left covering the app
    const tl = running = gsap.timeline({ defaults: { ease: 'expo.out' }, onComplete: () => { clearTimeout(safety); finish(); } });

    // 1. the card rises out of the dark and floats, light pooling under it
    tl.to(c0, { y: 0, z: 0, rotationX: 0, autoAlpha: 1, duration: 1.6 })
      .to(q('.u-floor'), { autoAlpha: 0.9, duration: 1.6 }, '<0.2')
      .to(q('.u-floor2'), { autoAlpha: 0.8, duration: 1.8 }, '<')
      .to([capk, capv], { autoAlpha: 1, y: 0, duration: 0.6, ease: 'power3.out', stagger: 0.08 }, '<0.3')
      .add(() => { breathe.play(); sway.play(); }, '-=0.8')
      .fromTo(q('.u-c0 .u-glint'), { xPercent: -160 }, { xPercent: 420, duration: 1.3, ease: 'power2.inOut' }, '-=0.9')
      .to(c0, { rotationY: -22, rotationX: 8, duration: 1.2, ease: 'sine.inOut' }, '+=0.1')
      .to(c0, { rotationY: 0, rotationX: 0, duration: 1.0, ease: 'sine.inOut' });

    // 2. it splits into a cascade of your accounts
    if (fan.length) {
      tl.add('fan', '+=0.1')
        .add(() => caption('Your accounts', ''), 'fan')
        .to(fan, { autoAlpha: 1, duration: 0.3, stagger: 0.05, ease: 'power1.out' }, 'fan')
        .to(all, { duration: 1.25, stagger: 0.07, x: (i) => spot(i).x, y: (i) => spot(i).y, z: (i) => spot(i).z, rotationZ: (i) => spot(i).rotationZ, rotationY: 0, rotationX: (i) => spot(i).rotationX }, 'fan')
        .to(el, { '--g1': '#d98b5f', '--g2': '#7fd4a4', duration: 1.6, ease: 'sine.inOut' }, 'fan')
        .to(rig, { y: -10, duration: 1.4, ease: 'sine.inOut' }, 'fan')
        .to(all, { duration: 1.6, ease: 'sine.inOut', rotationY: (i) => 6 - i * 1.5, y: (i) => spot(i).y - i * 4 }, 'fan+=1.3')
        .to(el, { '--g1': '#8fb3e8', '--g2': '#d2b377', duration: 1.4, ease: 'sine.inOut' }, 'fan+=1.4')
        .add('snap', 'fan+=3.1')
        // 3. whip back into the one card
        .to(all, { duration: 0.42, ease: 'expo.in', stagger: { each: 0.03, from: 'end' }, x: 0, y: 0, z: 0, rotationZ: 0, rotationY: 0, rotationX: 0 }, 'snap')
        .to(fan, { autoAlpha: 0, duration: 0.12 }, 'snap+=0.42')
        .to(rig, { y: 0, duration: 0.4, ease: 'power2.out' }, 'snap+=0.3');
    } else tl.add('snap', '+=0.2');
    tl.to(el, { '--g1': '#d2b377', '--g2': '#2b6b52', duration: 0.6, ease: 'power2.out' }, 'snap+=0.3')
      .fromTo(q('.u-c0 .u-glint'), { xPercent: -160 }, { xPercent: 420, duration: 0.5, ease: 'power2.out' }, 'snap+=0.42')
      .add(() => { breathe.pause(); gsap.to(flo, { y: 0, duration: 0.3 }); }, 'snap+=0.45')
      .to(c0, { y: -26, duration: 0.32, ease: 'power2.out' }, 'snap+=0.5')
      .add(() => caption('Securing', ''), 'snap+=0.5')
    // 4. the sleeve rises, the card slides in, the edges glow gold
      .to([back, front], { y: 0, duration: 0.9, stagger: 0.04 }, 'snap+=0.55')
      .to(c0, { y: 70, duration: 0.95, ease: 'power3.inOut' }, 'snap+=0.85')
      .to(q('.u-floor'), { autoAlpha: 1, duration: 0.6 }, 'snap+=1.5')
      .set(ring, { y: 0 }, 'snap+=1.7')
      .fromTo(ring, { autoAlpha: 0, boxShadow: '0 0 0 1.5px rgba(210,179,119,0), 0 0 0px rgba(210,179,119,0)' },
        { autoAlpha: 1, boxShadow: '0 0 0 1.5px rgba(210,179,119,.95), 0 0 34px rgba(210,179,119,.55)', duration: 0.5, ease: 'power2.out' }, 'snap+=1.75')
      .to(ring, { boxShadow: '0 0 0 1.5px rgba(210,179,119,.55), 0 0 14px rgba(210,179,119,.25)', duration: 0.7, ease: 'sine.inOut', yoyo: true, repeat: 2 }, '>')
      .add(() => caption('<svg class="u-lock" viewBox="0 0 24 24"><path d="M6 11h12v9H6z"/><path d="M8.5 11V8a3.5 3.5 0 0 1 7 0v3"/></svg>Unlocked', 'Welcome back'), 'snap+=1.8')
      .to(tilt, { rotationX: 0, rotationY: 0, duration: 0.8, ease: 'power3.out' }, 'snap+=1.6')
      .add(() => sway.pause(), 'snap+=1.6')
      .to({}, { duration: 0.6 });
  }
  window.LedgerUnlock = { play, get playing() { return !!running; } };
})();
