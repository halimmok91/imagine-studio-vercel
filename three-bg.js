/* ═══════════════════════════════════════════════════════════════
   IMAGINE STUDIO — NEW UI · Three.js ambient experience
   Interactive golden particle field + silk wireframe ribbons.
   Reacts to cursor, stage scroll and generation (via #btnGenerate).
   Purely additive — no app.js internals touched.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const canvas = document.getElementById('gl');
  if (!canvas || typeof THREE === 'undefined') return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMobile = window.matchMedia('(max-width: 880px)').matches;

  const THEMES = [
    { name: 'Aurum',    a: [0.86, 0.71, 0.47], b: [0.55, 0.42, 0.95], fog: 0x07070a },
    { name: 'Nocturne', a: [0.42, 0.52, 0.95], b: [0.75, 0.45, 0.95], fog: 0x05060c },
    { name: 'Ember',    a: [0.95, 0.55, 0.32], b: [0.90, 0.75, 0.40], fog: 0x0a0605 },
    { name: 'Verdant',  a: [0.45, 0.85, 0.60], b: [0.80, 0.72, 0.42], fog: 0x050907 },
  ];
  let themeIdx = 0;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (e) { canvas.remove(); return; }   // no WebGL → silently drop ambience
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.25 : 1.5));
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(THEMES[0].fog, 0.055);
  renderer.setClearColor(THEMES[0].fog, 1);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
  camera.position.set(0, 0, 11);

  /* particle field */
  const COUNT = isMobile ? 900 : 2200;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    const r = 6 + Math.random() * 12;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3]     = r * Math.sin(ph) * Math.cos(th) * 1.5;
    pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.75;
    pos[i * 3 + 2] = r * Math.cos(ph) * 0.9 - 3;
    seed[i * 4]     = Math.random() * 100;
    seed[i * 4 + 1] = 0.5 + Math.random() * 1.9;
    seed[i * 4 + 2] = Math.random();
    seed[i * 4 + 3] = 0.25 + Math.random() * 0.9;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

  const uniforms = {
    uTime:   { value: 0 },
    uMouse:  { value: new THREE.Vector3(0, 0, 0) },
    uMouseStrength: { value: 0 },
    uColorA: { value: new THREE.Vector3(...THEMES[0].a) },
    uColorB: { value: new THREE.Vector3(...THEMES[0].b) },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uPulse:  { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec4 aSeed;
      uniform float uTime, uPixelRatio, uMouseStrength, uPulse;
      uniform vec3 uMouse;
      varying float vMix, vAlpha;
      void main() {
        vec3 p = position;
        float t = uTime * aSeed.w;
        p.x += sin(t * .7 + aSeed.x) * .55;
        p.y += cos(t * .55 + aSeed.x * 1.7) * .45;
        p.z += sin(t * .4 + aSeed.x * 2.3) * .35;
        p *= 1.0 + uPulse * .06 * sin(aSeed.x * 6.2831 + uTime * 3.0);
        vec3 toM = uMouse - p;
        float d = length(toM);
        float pull = smoothstep(6.5, 0.0, d) * uMouseStrength;
        p += normalize(toM + 0.0001) * pull * 1.6;
        vMix = aSeed.z;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float twinkle = .65 + .35 * sin(uTime * (1.5 + aSeed.z) + aSeed.x * 10.0);
        vAlpha = twinkle * (0.35 + 0.65 * smoothstep(-14.0, 2.0, p.z));
        gl_PointSize = aSeed.y * uPixelRatio * (18.0 / -mv.z) * (1.0 + pull * 1.4 + uPulse * .5);
      }`,
    fragmentShader: `
      uniform vec3 uColorA, uColorB;
      varying float vMix, vAlpha;
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv);
        float glow = pow(smoothstep(0.5, 0.0, d), 2.2);
        vec3 col = mix(uColorA, uColorB, vMix);
        gl_FragColor = vec4(col, glow * vAlpha * 0.85);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  scene.add(points);

  /* silk ribbons */
  const ribbonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...THEMES[0].a), wireframe: true, transparent: true, opacity: 0.055 });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(7.5, 1.9, 140, 14, 2, 3), ribbonMat);
  knot.position.set(2.5, -1.5, -9);
  knot.rotation.x = 0.5;
  scene.add(knot);

  const haloMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...THEMES[0].b), wireframe: true, transparent: true, opacity: 0.04 });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(9.5, 0.5, 10, 90), haloMat);
  halo.position.set(-6, 3, -12);
  halo.rotation.x = 1.1;
  scene.add(halo);

  /* interaction state */
  const mouse = { x: 0, y: 0, tx: 0, ty: 0, active: 0, tActive: 0 };
  let scrollP = 0, scrollT = 0, pulse = 0;

  function onPointer(x, y, isTouch) {
    mouse.tx = (x / window.innerWidth) * 2 - 1;
    mouse.ty = -(y / window.innerHeight) * 2 + 1;
    mouse.tActive = 1;
    if (isTouch) setTimeout(() => (mouse.tActive = 0.35), 1400);
  }
  window.addEventListener('pointermove', (e) => onPointer(e.clientX, e.clientY, e.pointerType === 'touch'), { passive: true });
  window.addEventListener('pointerdown', (e) => onPointer(e.clientX, e.clientY, true), { passive: true });
  window.addEventListener('pointerleave', () => (mouse.tActive = 0));
  document.querySelector('.stage')?.addEventListener('scroll', (e) => {
    scrollT = Math.min(1, e.target.scrollTop / 600);
  }, { passive: true });

  // generation pulse: hook the real Generate button + gallery mutations
  document.getElementById('btnGenerate')?.addEventListener('click', () => (pulse = Math.min(1.5, pulse + 0.8)));
  const gallery = document.getElementById('gallery');
  if (gallery) {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList?.contains('done')) { pulse = Math.min(1.5, pulse + 1.1); return; }
        }
      }
    }).observe(gallery, { childList: true });
  }

  /* public hook (used by revamp.js) */
  let suspended = false;
  window.__revampBG = {
    pulse(s = 1) { pulse = Math.min(1.5, pulse + s); },
    setSuspended(on) { suspended = !!on; },
  };

  let visible = true;
  document.addEventListener('visibilitychange', () => (visible = !document.hidden));

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const curA = new THREE.Vector3(...THEMES[0].a);
  const curB = new THREE.Vector3(...THEMES[0].b);
  const curFog = new THREE.Color(THEMES[0].fog);
  const clock = new THREE.Clock();
  let t = 0;

  function frame() {
    requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!visible || suspended) return;   // tab hidden / mid-drag: skip the frame
    t += dt * (reduceMotion ? 0.12 : 1);

    mouse.x += (mouse.tx - mouse.x) * 0.06;
    mouse.y += (mouse.ty - mouse.y) * 0.06;
    mouse.active += (mouse.tActive - mouse.active) * 0.05;
    scrollP += (scrollT - scrollP) * 0.06;
    pulse *= Math.pow(0.92, dt * 60);

    const T = THEMES[themeIdx];
    curA.lerp(new THREE.Vector3(...T.a), 0.03);
    curB.lerp(new THREE.Vector3(...T.b), 0.03);
    curFog.lerp(new THREE.Color(T.fog), 0.03);
    uniforms.uColorA.value.copy(curA);
    uniforms.uColorB.value.copy(curB);
    scene.fog.color.copy(curFog);
    renderer.setClearColor(curFog, 1);
    ribbonMat.color.copy(curA);
    haloMat.color.copy(curB);

    uniforms.uMouse.value.set(mouse.x * 8.5, mouse.y * 5.0, 0);
    uniforms.uMouseStrength.value = 0.25 + mouse.active * 0.75;
    uniforms.uPulse.value = pulse;
    uniforms.uTime.value = t;

    camera.position.x = mouse.x * 0.9;
    camera.position.y = mouse.y * 0.55 - scrollP * 2.2;
    camera.position.z = 11 - scrollP * 1.2;
    camera.lookAt(0, -scrollP * 1.4, -2);

    points.rotation.y = t * 0.014 + mouse.x * 0.06;
    points.rotation.x = mouse.y * 0.03;
    knot.rotation.y = t * 0.05;
    knot.rotation.z = t * 0.022;
    halo.rotation.z = t * 0.03;
    halo.rotation.y = t * 0.014;

    renderer.render(scene, camera);
  }
  frame();
})();
