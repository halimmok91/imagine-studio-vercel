/* ═══════════════════════════════════════════════════════════════
   IMAGINE STUDIO — NEW UI · additive UX layer
   Boot sequence, reveal choreography, prompt glow, mobile drawer.
   Loads AFTER app.js and only
   touches elements app.js doesn't manage. Zero app logic changes.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* ── boot sequence + reveal ── */
  function boot() {
    const b = $('#boot');
    if (!b) return;
    setTimeout(() => {
      b.classList.add('done');
      document.body.classList.add('is-in');
      $$('[data-reveal]').forEach((el, i) => el.style.setProperty('--ri', i));
    }, 850);
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
  // safety: never trap the user behind the boot screen
  setTimeout(() => { $('#boot')?.classList.add('done'); document.body.classList.add('is-in'); }, 3500);

  /* ── prompt shell glow follows cursor ── */
  const shell = $('#promptShell');
  if (shell) {
    shell.addEventListener('pointermove', (e) => {
      const r = shell.getBoundingClientRect();
      shell.style.setProperty('--gx', ((e.clientX - r.left) / r.width) * 100 + '%');
      shell.style.setProperty('--gy', ((e.clientY - r.top) / r.height) * 100 + '%');
    });
  }

  /* ── mobile composer drawer ── */
  const composer = $('#composer'), scrim = $('#scrim');
  const isMobile = () => matchMedia('(max-width: 880px)').matches;
  function openComposer() {
    if (!isMobile() || !composer) return;
    composer.classList.add('open');
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
  }
  function closeComposer() {
    if (!composer) return;
    composer.classList.remove('open');
    scrim.classList.remove('show');
    setTimeout(() => (scrim.hidden = true), 400);
  }
  $('#fabComposer')?.addEventListener('click', openComposer);
  $('#composerClose')?.addEventListener('click', closeComposer);
  scrim?.addEventListener('click', closeComposer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeComposer(); });

  // swipe-to-close
  let touchX = null;
  composer?.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
  composer?.addEventListener('touchmove', (e) => {
    if (touchX === null) return;
    if (e.touches[0].clientX - touchX < -60) { closeComposer(); touchX = null; }
  }, { passive: true });

  // auto-close drawer when generation starts on mobile
  $('#btnGenerate')?.addEventListener('click', () => { if (isMobile()) closeComposer(); });

  /* ── smooth sidebar resize: freeze the WebGL canvas while dragging ──
     The ambient canvas re-rendering during every drag mousemove is what
     makes the resizer feel laggy. app.js toggles .dragging on #resizer —
     we observe that and pause the GL loop for the duration of the drag. */
  const resizer = $('#resizer');
  if (resizer && window.__revampBG) {
    new MutationObserver(() => {
      const dragging = resizer.classList.contains('dragging');
      window.__revampBG.setSuspended(dragging);
      document.body.classList.toggle('resizing', dragging);
    }).observe(resizer, { attributes: true, attributeFilter: ['class'] });
  }

  /* Queue stagger is fixed at 5000ms in app.js; not user-editable. */

  /* ── lightbox prev/next slide animation ──
     app.js swaps #lightboxImg.src inside renderLightbox(). We intercept the
     nav clicks to slide the frame out first, then slide it back in on src change. */
  const lbFrame = $('.lb-frame');
  const lbImg = $('#lightboxImg');
  if (lbFrame && lbImg) {
    /* app.js swaps #lightboxImg.src synchronously on nav. Animating an "out"
       phase first causes the new image to flash, then hide, then re-enter — the
       blink. Instead: the instant the src changes we snap the frame to a hidden
       offset (no transition), then on the next frame play ONLY the slide-in. */
    let navDir = 0;   // +1 = next (enter from right), -1 = prev (enter from left)
    const arm = (d) => { navDir = d; };
    $('.lb-next')?.addEventListener('click', () => arm(1), true);
    $('.lb-prev')?.addEventListener('click', () => arm(-1), true);
    document.addEventListener('keydown', (e) => {
      if ($('#lightbox')?.hidden) return;
      if (e.key === 'ArrowRight') arm(1);
      else if (e.key === 'ArrowLeft') arm(-1);
    }, true);

    new MutationObserver(() => {
      if (!navDir) return;                 // open/close, not a nav swap
      const dir = navDir; navDir = 0;
      const off = (dir > 0 ? 64 : -64) + 'px';
      // 1) snap hidden & offset WITHOUT transition (kills the flash)
      lbFrame.style.transition = 'none';
      lbFrame.style.opacity = '0';
      lbFrame.style.transform = `translateX(${off}) scale(.98)`;
      // 2) reveal as soon as the new image can actually paint — no dead gap.
      //    data-URL / blob sources decode same-frame; remote URLs wait for load.
      const reveal = () => requestAnimationFrame(() => requestAnimationFrame(() => {
        lbFrame.style.transition = '';
        lbFrame.style.opacity = '';
        lbFrame.style.transform = '';
      }));
      const src = lbImg.currentSrc || lbImg.src || '';
      const instant = src.startsWith('data:') || src.startsWith('blob:');
      if (instant || (lbImg.complete && lbImg.naturalWidth)) reveal();
      else {
        let done = false;
        const go = () => { if (!done) { done = true; reveal(); } };
        lbImg.addEventListener('load', go, { once: true });
        lbImg.addEventListener('error', go, { once: true });
        setTimeout(go, 350);               // never leave the frame hidden
      }
    }).observe(lbImg, { attributes: true, attributeFilter: ['src'] });
  }

  /* ── UI sounds (WebAudio, no assets; subtle, mutable) ── */
  const SFX = (() => {
    let ctx = null, master = null;
    let enabled = true;
    try { enabled = localStorage.getItem('imagine.sfx') !== '0'; } catch (e) {}
    function ac() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone({ f = 440, f2 = null, t = 0.12, type = 'sine', v = 0.5, attack = 0.004, curve = 'exp' }) {
      if (!enabled) return;
      const c = ac(); if (!c) return;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      const now = c.currentTime;
      o.frequency.setValueAtTime(f, now);
      if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), now + t);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(v, now + attack);
      if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, now + t);
      else g.gain.linearRampToValueAtTime(0.0001, now + t);
      o.connect(g); g.connect(master);
      o.start(now); o.stop(now + t + 0.05);
    }
    return {
      get enabled() { return enabled; },
      toggle() {
        enabled = !enabled;
        try { localStorage.setItem('imagine.sfx', enabled ? '1' : '0'); } catch (e) {}
        return enabled;
      },
      // warm gold chime when a render lands
      success() { tone({ f: 660, f2: 990, t: 0.22, v: 0.28 }); setTimeout(() => tone({ f: 990, f2: 1320, t: 0.3, v: 0.2 }), 90); },
      // low ignition thump on generate
      ignite()  { tone({ f: 140, f2: 70, t: 0.28, type: 'triangle', v: 0.4 }); tone({ f: 880, f2: 1760, t: 0.14, v: 0.06 }); },
      // soft tick for chips / selects
      tick()    { tone({ f: 1200, f2: 900, t: 0.05, type: 'square', v: 0.05 }); },
      // airy whoosh for lightbox nav
      whoosh(d = 1) { tone({ f: 300 * d, f2: 900 * d, t: 0.18, type: 'sine', v: 0.12 }); },
      // modal open/close
      pop()     { tone({ f: 520, f2: 780, t: 0.1, v: 0.14 }); },
      // error buzz
      err()     { tone({ f: 220, f2: 110, t: 0.25, type: 'sawtooth', v: 0.12 }); },
      unlock()  { ac(); },
    };
  })();
  // browsers require a gesture before audio — unlock on first interaction
  window.addEventListener('pointerdown', () => SFX.unlock(), { once: true, passive: true });
  window.addEventListener('keydown', () => SFX.unlock(), { once: true });
  window.__revampSFX = SFX;

  /* mute toggle in the topbar */
  const sfxBtn = $('#btnSfx');
  function syncSfxBtn() {
    if (!sfxBtn) return;
    sfxBtn.classList.toggle('is-muted', !SFX.enabled);
    sfxBtn.querySelector('.sfx-on').style.display = SFX.enabled ? '' : 'none';
    sfxBtn.querySelector('.sfx-off').style.display = SFX.enabled ? 'none' : '';
    sfxBtn.title = SFX.enabled ? 'Mute interface sounds' : 'Unmute interface sounds';
  }
  sfxBtn?.addEventListener('click', () => { SFX.toggle(); syncSfxBtn(); if (SFX.enabled) SFX.pop(); });
  syncSfxBtn();

  /* ── prompt ideas ── */
  // meigen.ai cannot be embedded: it is behind a Cloudflare bot challenge and
  // sends x-frame-options: SAMEORIGIN, so an iframe renders the challenge and
  // a server-side proxy would just fetch the same challenge page. Open it in
  // a new tab instead and let the user copy a prompt back into the composer.
  $('#btnIdeas')?.addEventListener('click', () => {
    SFX.pop();
    window.open('https://www.meigen.ai/', '_blank', 'noopener');
  });

  /* ── creator Threads link (topbar + settings) ── */
  const THREADS_URL = 'https://www.threads.com/@halimmok.exe';
  $('#btnThreads')?.addEventListener('click', () => { SFX.pop(); window.open(THREADS_URL, '_blank', 'noopener'); });

  /* sound triggers — hooked to real app events via DOM observation */
  $('#btnGenerate')?.addEventListener('click', () => SFX.ignite());
  // render completion: gallery gains a .card.done
  const gal = $('#gallery');
  if (gal) {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes)
        if (n.nodeType === 1 && n.classList?.contains('done')) { SFX.success(); return; }
    }).observe(gal, { childList: true });
  }
  // error cards
  if (gal) {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes)
        if (n.nodeType === 1 && n.classList?.contains('err')) { SFX.err(); return; }
    }).observe(gal, { childList: true });
  }
  // lightbox open/nav
  new MutationObserver(() => {
    if (!$('#lightbox')?.hidden) SFX.pop();
  }).observe($('#lightbox'), { attributes: true, attributeFilter: ['hidden'] });
  $('.lb-next')?.addEventListener('click', () => SFX.whoosh(1));
  $('.lb-prev')?.addEventListener('click', () => SFX.whoosh(0.8));
  // settings modal open/close
  new MutationObserver(() => SFX.pop())
    .observe($('#settingsOverlay'), { attributes: true, attributeFilter: ['hidden'] });
  // chips + selects + toggles
  document.addEventListener('click', (e) => {
    if (e.target.closest('.chip, .mode-pill, .model-card, .ratio-chip')) SFX.tick();
  }, true);
})();
