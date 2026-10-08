/* Fit Capture: guided body capture in the phone's browser.
   Flow: height -> clothing -> sound + permissions -> phone angle -> stand in view -> one slow turn -> save file.
   Body landmarks come from MediaPipe Pose (Apache 2.0), run on the phone. Nothing is sent anywhere. */
(() => {
'use strict';
const APP_VERSION = '0.1.0';
const $ = id => document.getElementById(id);
const now = () => performance.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

/* ---------- settings the checks use ---------- */
const CFG = {
  leanMin: 12, leanMax: 28, leanGaugeMax: 45,      // degrees the phone leans back from upright
  steadyMs: 1400,
  headTopMin: 0.03, feetMax: 0.97, bodyMin: 0.42, bodyMax: 0.92, centreMin: 0.36, centreMax: 0.64,
  faceYaw: 18, armMin: 20, armMax: 78, feetRatio: 0.95,
  holdMs: 1300, turnDoneDeg: 340, turnMaxMs: 60000, saveEveryDeg: 4, saveEveryMs: 450, saveMinMs: 130, maxFrames: 150, longSide: 1280,
};

/* ---------- screens ---------- */
const screens = ['s-home', 's-clothes', 's-sound', 's-place', 's-camera', 's-review'];
let current = 's-home';
function show(id) { for (const s of screens) $(s).hidden = s !== id; current = id; window.scrollTo(0, 0); }
document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => show(b.dataset.back)));
$('ver').textContent = 'Version ' + APP_VERSION + '.';

/* ---------- voice and beeps ---------- */
const Voice = {
  ok: 'speechSynthesis' in window, lastText: '', lastAt: 0, ctx: null,
  unlock() {
    try { this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) { /* no audio */ }
  },
  say(text, opt = {}) {
    const t = now();
    if (!opt.force && text === this.lastText && t - this.lastAt < (opt.gap || 6000)) return;
    this.lastText = text; this.lastAt = t;
    log('say', text);
    if (!this.ok) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-GB'; u.rate = 0.98; u.volume = 1;
      if (opt.interrupt !== false) speechSynthesis.cancel();
      setTimeout(() => { try { speechSynthesis.speak(u); } catch (e) { /* ignore */ } }, 60);
    } catch (e) { /* ignore */ }
  },
  beep(freq = 880, ms = 160, vol = 0.5) {
    if (!this.ctx) return;
    try {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.value = freq; o.type = 'sine'; g.gain.value = vol;
      o.connect(g); g.connect(this.ctx.destination);
      const t = this.ctx.currentTime; o.start(t); g.gain.setValueAtTime(vol, t + ms / 1000 - 0.03); g.gain.linearRampToValueAtTime(0, t + ms / 1000); o.stop(t + ms / 1000 + 0.02);
    } catch (e) { /* ignore */ }
  },
};

/* ---------- session record ---------- */
const S = {
  heightCm: null, blurFace: true, stream: null, pose: null, poseReady: false, running: false, busy: false,
  ori: null, oriCount: 0, oriLog: [], events: [], frames: [], pending: [], t0: 0,
  phase: 'idle', okSince: 0, countAt: 0, lastSeen: 0, cum: 0, prevYaw: null, turnAt: 0, lastSave: { t: 0, cum: 0 }, lastMoveAt: 0, said: {},
  fps: 0, fpsN: 0, fpsT: 0, video: { w: 0, h: 0 }, zip: null, tiltAtStart: null, tiltSkipped: false, wake: null,
};
function log(kind, detail) { S.events.push({ t: Math.round(now() - (S.t0 || 0)), kind, detail }); }
window.__fit = S;      // for testing

/* ---------- height ---------- */
let unit = store.get('fit.unit') || 'cm';
function setUnit(u) {
  unit = u; store.set('fit.unit', u);
  $('u-cm').setAttribute('aria-pressed', String(u === 'cm')); $('u-ft').setAttribute('aria-pressed', String(u === 'ft'));
  $('h-cm-wrap').hidden = u !== 'cm'; $('h-ft-wrap').hidden = u !== 'ft';
}
$('u-cm').addEventListener('click', () => setUnit('cm'));
$('u-ft').addEventListener('click', () => setUnit('ft'));
setUnit(unit);
{ const h = store.get('fit.height'); if (h) { $('height-cm').value = h; const tin = Math.round(h / 2.54); $('height-ft').value = Math.floor(tin / 12); $('height-in').value = tin % 12; } }
function readHeight() {
  if (unit === 'cm') return Number($('height-cm').value);
  const ft = Number($('height-ft').value), inch = Number($('height-in').value || 0);
  return ft ? Math.round((ft * 12 + inch) * 2.54 * 10) / 10 : NaN;
}
$('go-clothes').addEventListener('click', () => {
  const h = readHeight();
  if (!(h >= 120 && h <= 230)) { $('home-err').textContent = 'Enter your height first, between 120 and 230 cm (4 ft and 7 ft 6 in).'; $('home-err').hidden = false; return; }
  $('home-err').hidden = true; S.heightCm = h; store.set('fit.height', String(Math.round(h))); S.blurFace = $('opt-face').checked;
  show('s-clothes');
});
$('go-sound').addEventListener('click', () => show('s-sound'));

/* ---------- sound + permissions ---------- */
$('test-voice').addEventListener('click', () => {
  Voice.unlock(); Voice.beep(880, 180);
  Voice.say('This is the voice that will guide you. If you can hear it clearly from across the room, you are set.', { force: true });
  $('voice-note').textContent = Voice.ok ? 'No voice? Check the phone is not on silent. You will still hear beeps and see large text.' : 'This browser has no built-in voice. You will hear beeps and see large text instead.';
});

function onOrientation(e) {
  if (e.beta == null) return;
  S.ori = { beta: e.beta, gamma: e.gamma, alpha: e.alpha, t: now() }; S.oriCount++;
  if (S.oriLog.length < 3000 && (S.oriLog.length === 0 || S.ori.t - S.oriLog[S.oriLog.length - 1].t > 100)) S.oriLog.push({ t: Math.round(S.ori.t), b: +e.beta.toFixed(2), g: +(e.gamma || 0).toFixed(2) });
}
async function enableSensors() {
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission(); log('sensor-permission', r);
    }
  } catch (e) { log('sensor-permission', 'error ' + e); }
  window.addEventListener('deviceorientation', onOrientation);
}
async function startCamera() {
  if (S.stream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open the camera. Try Chrome on Android or Safari on iPhone.');
  const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, resizeMode: { ideal: 'none' } } });
  S.stream = s; const v = $('video'); v.srcObject = s; await v.play().catch(() => {});
  const tr = s.getVideoTracks()[0];
  S.track = { label: tr.label, settings: tr.getSettings ? tr.getSettings() : {}, capabilities: tr.getCapabilities ? tr.getCapabilities() : {} };
}
function stopCamera() { if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; $('video').srcObject = null; } }
async function startPose() {
  if (S.pose) return;
  if (typeof Pose === 'undefined') throw new Error('The body detector did not load. Check your connection and reload the page.');
  const pose = new Pose({ locateFile: f => 'vendor/pose/' + f });
  const mc = Number(new URLSearchParams(location.search).get('model') || 1);
  pose.setOptions({ modelComplexity: mc, smoothLandmarks: true, enableSegmentation: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  pose.onResults(onPose);
  await pose.initialize();
  S.pose = pose; S.poseReady = true; S.modelComplexity = mc;
}
$('go-place').addEventListener('click', async () => {
  const b = $('go-place'); b.disabled = true; const label = b.textContent; b.textContent = 'Getting ready…'; $('cam-err').hidden = true;
  Voice.unlock(); Voice.say('Getting ready.', { force: true });      // spoken inside the tap, so the phone allows the voice later
  try {
    await enableSensors();
    await startCamera();
    await startPose();
    S.t0 = now(); log('ready', navigator.userAgent);
    show('s-place'); startTilt();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    $('cam-err').textContent = denied ? 'The camera was blocked. Allow camera access for this page in your browser settings, then try again.' : (e && e.message ? e.message : String(e));
    $('cam-err').hidden = false; log('camera-error', String(e));
  }
  b.disabled = false; b.textContent = label;
});

/* ---------- phone angle ---------- */
let tiltTimer = null, tiltGood = 0, tiltHist = [];
function startTilt() {
  const band = $('gauge-band');
  band.style.top = (CFG.leanMin / CFG.leanGaugeMax * 100) + '%'; band.style.height = ((CFG.leanMax - CFG.leanMin) / CFG.leanGaugeMax * 100) + '%';
  tiltGood = 0; tiltHist = []; const began = now();
  Voice.say('Lean the phone against a wall, on the floor, with the screen facing the room.', { force: true });
  clearInterval(tiltTimer);
  tiltTimer = setInterval(() => {
    if (current !== 's-place') { clearInterval(tiltTimer); return; }
    const o = S.ori, say = $('tilt-say'), g = $('gauge');
    if (!o || now() - o.t > 1500) {
      if (now() - began > 3500) { say.textContent = 'This device has no tilt sensor. Lean the phone back a little, then continue.'; $('skip-tilt').textContent = 'Continue'; $('tilt-note').hidden = true; }
      return;
    }
    const lean = 90 - o.beta; let msg, ok = false;
    $('tilt-num').textContent = String(Math.round(clamp(lean, -90, 90)));
    $('gauge-needle').style.top = clamp(lean / CFG.leanGaugeMax * 100, 0, 100) + '%';
    tiltHist.push({ t: now(), lean }); while (tiltHist.length && now() - tiltHist[0].t > 1200) tiltHist.shift();
    const range = Math.max(...tiltHist.map(h => h.lean)) - Math.min(...tiltHist.map(h => h.lean));
    if (o.beta < 0 || o.beta > 130) msg = 'Turn the phone the right way up, charging port down.';
    else if (lean < -3) msg = 'Turn the phone round so the screen faces the room.';
    else if (Math.abs(o.gamma || 0) > 12 && lean < 60) msg = 'Stand the phone straight, not leaning to one side.';
    else if (lean > CFG.leanMax) msg = 'Too flat. Stand it more upright.';
    else if (lean < CFG.leanMin) msg = 'Lean it back a little more.';
    else if (range > 1.5) msg = 'Good angle. Now let go and leave it still.';
    else { msg = 'Good. Hold it there…'; ok = true; }
    say.textContent = msg; say.classList.toggle('ok', ok); g.classList.toggle('ok', lean >= CFG.leanMin && lean <= CFG.leanMax);
    if (ok) { if (!tiltGood) tiltGood = now(); if (now() - tiltGood > CFG.steadyMs) { clearInterval(tiltTimer); S.tiltAtStart = { beta: o.beta, gamma: o.gamma, lean }; log('tilt-ok', lean.toFixed(1)); Voice.beep(1040, 200); beginCamera(); } }
    else tiltGood = 0;
  }, 120);
}
$('skip-tilt').addEventListener('click', () => { clearInterval(tiltTimer); S.tiltSkipped = true; S.tiltAtStart = S.ori ? { beta: S.ori.beta, gamma: S.ori.gamma, lean: 90 - S.ori.beta } : null; log('tilt-skip'); Voice.unlock(); beginCamera(); });

/* ---------- camera stage ---------- */
const video = $('video'), overlay = $('overlay'), octx = overlay.getContext('2d');
const cap = document.createElement('canvas'), cctx = cap.getContext('2d');
function fitView() {
  const vw = video.videoWidth || 720, vh = video.videoHeight || 1280, W = window.innerWidth, H = window.innerHeight;
  const k = Math.min(W / vw, H / vh), view = $('view');
  view.style.width = Math.round(vw * k) + 'px'; view.style.height = Math.round(vh * k) + 'px';
  if (overlay.width !== vw || overlay.height !== vh) { overlay.width = vw; overlay.height = vh; }
  S.video = { w: vw, h: vh };
}
window.addEventListener('resize', () => { if (current === 's-camera') fitView(); });
function banner(text, cls) { const b = $('banner'); if (b.textContent !== text) b.textContent = text; b.className = 'banner' + (cls ? ' ' + cls : ''); }
// one prompt at a time: shows the text, speaks it when it changes or after a pause
let promptKey = '', promptSince = 0;
function prompt(key, text, cls, speak) {
  banner(text, cls);
  const t = now();
  if (key !== promptKey) { promptKey = key; promptSince = t; return; }
  if (t - promptSince > 500) Voice.say(speak || text, { gap: 7000 });
}
async function requestWake() { try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch (e) { /* optional */ } }
function buildTicks() {
  const g = $('ring-ticks'); if (g.childNodes.length) return;
  for (let d = 0; d < 360; d += 15) {
    const a = (d - 90) * Math.PI / 180, r1 = 84 + 7, r2 = d % 90 === 0 ? 70 : 84 - 2;
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', (100 + r1 * Math.cos(a)).toFixed(1)); l.setAttribute('y1', (100 + r1 * Math.sin(a)).toFixed(1));
    l.setAttribute('x2', (100 + r2 * Math.cos(a)).toFixed(1)); l.setAttribute('y2', (100 + r2 * Math.sin(a)).toFixed(1));
    l.setAttribute('opacity', d % 90 === 0 ? '0.9' : '0.45'); g.appendChild(l);
  }
}
function setRing(deg) {
  const c = 2 * Math.PI * 84, f = clamp(deg / 360, 0, 1);
  $('ring-arc').setAttribute('stroke-dasharray', (c * f).toFixed(1) + ' ' + c.toFixed(1));
  $('ring-deg').textContent = Math.round(clamp(deg, 0, 360)) + '°';
}
function beginCamera() {
  show('s-camera'); fitView(); buildTicks(); requestWake();
  S.frames = []; S.pending = []; S.zip = null; S.phase = 'find'; S.okSince = 0; S.cum = 0; S.prevYaw = null; S.said = {}; S.lastSeen = now(); promptKey = '';
  $('ring').hidden = true; $('count').hidden = true; setRing(0);
  banner('Step back about 2 metres', 'go');
  Voice.say('Good. Now step back about two metres and face the phone.', { force: true });
  S.running = true; S.busy = false; S.fpsT = now(); S.fpsN = 0; pump();
}
function pump() {
  if (!S.running) return;
  if (!S.busy && video.readyState >= 2 && S.poseReady) {
    S.busy = true;
    S.pose.send({ image: video }).catch(e => log('pose-error', String(e))).then(() => { S.busy = false; });
  }
  requestAnimationFrame(pump);
}
$('cancel-cam').addEventListener('click', () => { S.running = false; S.phase = 'idle'; if (Voice.ok) speechSynthesis.cancel(); show('s-place'); startTilt(); });

/* ---------- reading the body ---------- */
const LM = { nose: 0, eyeL: 2, eyeR: 5, earL: 7, earR: 8, mouthL: 9, mouthR: 10, shL: 11, shR: 12, wrL: 15, wrR: 16, hipL: 23, hipR: 24, anL: 27, anR: 28 };
function analyse(L, W) {
  const vw = S.video.w, vh = S.video.h, P = i => ({ x: L[i].x * vw, y: L[i].y * vh });
  const shMidY = (L[LM.shL].y + L[LM.shR].y) / 2;
  const headTop = L[LM.nose].y - 0.8 * (shMidY - L[LM.nose].y);
  let feet = 0; for (let i = 27; i <= 32; i++) feet = Math.max(feet, L[i].y);
  const key = [11, 12, 23, 24, 27, 28]; let vis = 0; for (const i of key) vis += (L[i].visibility || 0); vis /= key.length;
  const arm = (s, w) => { const a = P(s), b = P(w); return Math.atan2(Math.abs(b.x - a.x), b.y - a.y) * 180 / Math.PI; };
  const hipW = Math.abs(P(LM.hipL).x - P(LM.hipR).x), anW = Math.abs(P(LM.anL).x - P(LM.anR).x);
  let yaw = 0;
  if (W) yaw = Math.atan2((W[11].z - W[12].z) + (W[23].z - W[24].z), (W[11].x - W[12].x) + (W[23].x - W[24].x)) * 180 / Math.PI;
  return { headTop, feet, body: feet - headTop, centre: (L[LM.hipL].x + L[LM.hipR].x) / 2, vis, armL: arm(LM.shL, LM.wrL), armR: arm(LM.shR, LM.wrR), feetRatio: anW / Math.max(1, hipW), yaw };
}
function standingAdvice(a) {
  if (a.vis < 0.5) return ['see', 'Step back until I can see all of you', 'adjust'];
  const cutFeet = a.feet > CFG.feetMax, cutHead = a.headTop < CFG.headTopMin;
  if (cutFeet && cutHead) return ['back', 'Step back', 'adjust'];
  if (cutFeet) return ['feet', "I can't see your feet. Step back.", 'adjust', 'I cannot see your feet. Step back a little.'];
  if (cutHead) return ['head', "I can't see your head. Step back.", 'adjust', 'I cannot see your head. Step back a little.'];
  if (a.body > CFG.bodyMax) return ['back', 'Step back', 'adjust'];
  if (a.body < CFG.bodyMin) return ['closer', 'Come a little closer', 'adjust'];
  if (a.centre < CFG.centreMin) return ['left', 'Step to your left', 'adjust'];
  if (a.centre > CFG.centreMax) return ['right', 'Step to your right', 'adjust'];
  if (Math.abs(a.yaw) > CFG.faceYaw) return ['face', 'Face the phone', 'adjust'];
  if (a.armL < CFG.armMin || a.armR < CFG.armMin) return ['arms', 'Hold your arms out from your sides', 'adjust', 'Hold your arms out from your sides, like the letter A.'];
  if (a.armL > CFG.armMax || a.armR > CFG.armMax) return ['armsdown', 'Lower your arms a little', 'adjust'];
  if (a.feetRatio < CFG.feetRatio) return ['feetapart', 'Stand with your feet apart', 'adjust', 'Stand with your feet apart, about shoulder width.'];
  return null;
}
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 31], [28, 32]];
function drawSkeleton(L, colour) {
  const w = overlay.width, h = overlay.height; octx.clearRect(0, 0, w, h);
  if (!L) return;
  octx.lineWidth = Math.max(3, w / 140); octx.strokeStyle = colour; octx.fillStyle = colour; octx.lineCap = 'round';
  octx.beginPath(); for (const [a, b] of BONES) { octx.moveTo(L[a].x * w, L[a].y * h); octx.lineTo(L[b].x * w, L[b].y * h); } octx.stroke();
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) { octx.beginPath(); octx.arc(L[i].x * w, L[i].y * h, octx.lineWidth * 1.3, 0, 7); octx.fill(); }
}

/* ---------- saving pictures ---------- */
function blurFace(ctx, L, w, h, yaw) {
  if ((L[LM.nose].visibility || 0) < 0.5 || Math.abs(yaw) > 80) return;
  const X = i => L[i].x * w, Y = i => L[i].y * h;
  // a block inside the face (brow to chin, cheek to cheek) so the head's outline is left untouched
  const half = Math.max(Math.abs(X(LM.earL) - X(LM.earR)) * 0.4, Math.abs(X(LM.eyeL) - X(LM.eyeR)) * 1.15, 5);
  const eyeY = (Y(LM.eyeL) + Y(LM.eyeR)) / 2, mouthY = (Y(LM.mouthL) + Y(LM.mouthR)) / 2, cx = X(LM.nose), gap = Math.max(mouthY - eyeY, half * 0.8);
  const x0 = Math.round(cx - half), y0 = Math.round(eyeY - gap * 0.75), bw = Math.round(half * 2), bh = Math.round(gap * 2.3);
  if (bw < 4 || bh < 4) return;
  const t = document.createElement('canvas'); t.width = 5; t.height = 6; const tc = t.getContext('2d');
  tc.drawImage(ctx.canvas, x0, y0, bw, bh, 0, 0, 5, 6);
  const sm = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false; ctx.drawImage(t, 0, 0, 5, 6, x0, y0, bw, bh); ctx.imageSmoothingEnabled = sm;
}
function grab(r, tag, a) {
  if (S.frames.length >= CFG.maxFrames) return;
  let src = r.image, sw = src && src.width, sh = src && src.height;
  if (!sw || !sh) { src = video; sw = video.videoWidth; sh = video.videoHeight; }
  const k = Math.min(1, CFG.longSide / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
  if (cap.width !== w || cap.height !== h) { cap.width = w; cap.height = h; }
  try { cctx.drawImage(src, 0, 0, w, h); } catch (e) { cctx.drawImage(video, 0, 0, w, h); }
  const L = r.poseLandmarks, W = r.poseWorldLandmarks;
  if (S.blurFace && L) blurFace(cctx, L, w, h, a ? a.yaw : 0);
  const rec = { i: S.frames.length, t: Math.round(now() - S.t0), tag, w, h, yaw: a ? +a.yaw.toFixed(1) : null, turned: +S.cum.toFixed(1),
    beta: S.ori ? +S.ori.beta.toFixed(2) : null, gamma: S.ori ? +(S.ori.gamma || 0).toFixed(2) : null,
    lm: L ? L.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4), +(p.visibility || 0).toFixed(2)]) : null,
    world: W ? W.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +p.z.toFixed(4)]) : null };
  S.frames.push(rec);
  S.pending.push(new Promise(res => cap.toBlob(b => { rec.blob = b; res(); }, 'image/jpeg', 0.85)));
  S.lastSave = { t: now(), cum: S.cum };
}

/* ---------- the guided sequence ---------- */
function onPose(r) {
  if (!S.running) return;
  const t = now(); S.fpsN++; if (t - S.fpsT > 1000) { S.fps = S.fpsN * 1000 / (t - S.fpsT); S.fpsN = 0; S.fpsT = t; }
  const L = r.poseLandmarks, W = r.poseWorldLandmarks, a = L ? analyse(L, W) : null;
  if (L) S.lastSeen = t;
  $('debug').textContent = S.fps.toFixed(0) + ' fps' + (S.ori ? ' · lean ' + Math.round(90 - S.ori.beta) + '°' : '') + (a ? ' · facing ' + Math.round(a.yaw) + '°' : '') + ' · ' + S.frames.length + ' pics';

  if (S.phase === 'find' || S.phase === 'hold') {
    const adv = a ? standingAdvice(a) : (t - S.lastSeen > 1500 ? ['none', 'Step back until I can see all of you', 'adjust'] : null);
    drawSkeleton(L, adv ? '#f4c430' : '#46c794');
    if (adv) { S.phase = 'find'; S.okSince = 0; prompt(adv[0], adv[1], adv[2], adv[3]); return; }
    if (!a) return;
    if (!S.okSince) { S.okSince = t; S.phase = 'hold'; }
    prompt('hold', 'Good. Hold still.', 'good', 'Good.');
    if (t - S.okSince > CFG.holdMs) { S.phase = 'count'; S.countAt = t; S.countShown = 0; log('countdown'); Voice.say('Hold still.', { force: true }); }
    return;
  }
  if (S.phase === 'count') {
    drawSkeleton(L, '#46c794');
    if (t - S.lastSeen > 1200 || (a && (a.vis < 0.4 || a.feet > 0.995 || a.headTop < 0))) { S.phase = 'find'; S.okSince = 0; $('count').hidden = true; log('countdown-abort'); return; }
    const n = 3 - Math.floor((t - S.countAt - 700) / 1000);
    if (t - S.countAt < 700) return;
    if (n >= 1) { if (S.countShown !== n) { S.countShown = n; $('count').hidden = false; $('count').textContent = String(n); banner('Hold still', 'good'); Voice.beep(660, 140); } return; }
    // go
    $('count').hidden = true; Voice.beep(1320, 320);
    if (a) grab(r, 'front', a);
    S.phase = 'turn'; S.turnAt = t; S.cum = 0; S.prevYaw = a ? a.yaw : 0; S.lastMoveAt = t; S.said = {}; S.speed = [];
    $('ring').hidden = false; setRing(0); banner('Turn slowly, all the way round', 'go'); log('turn-start');
    Voice.say('Now turn slowly to your left, all the way round. Keep your arms out.', { force: true });
    return;
  }
  if (S.phase === 'turn') {
    drawSkeleton(null);
    if (a) {
      const d = wrap180(a.yaw - S.prevYaw);
      if (Math.abs(d) < 75) { S.cum += d; S.prevYaw = a.yaw; }
      else if (t - S.lastSeen < 400) S.prevYaw = a.yaw;         // a jump: re-anchor without counting it
      const turned = Math.abs(S.cum);
      S.speed.push({ t, turned }); while (S.speed.length > 2 && t - S.speed[0].t > 1800) S.speed.shift();
      const rate = S.speed.length > 1 ? (turned - S.speed[0].turned) / Math.max(0.2, (t - S.speed[0].t) / 1000) : 0;
      if (rate > 2) S.lastMoveAt = t;
      setRing(turned);
      const dueAngle = Math.abs(S.cum - S.lastSave.cum) >= CFG.saveEveryDeg, dueTime = t - S.lastSave.t >= CFG.saveEveryMs;
      if ((dueAngle || dueTime) && t - S.lastSave.t >= CFG.saveMinMs) grab(r, 'turn', a);
      const el = t - S.turnAt;
      if (el > 3500) {
        if (rate > 55) { banner('Slower', 'adjust'); Voice.say('Slower.', { gap: 5000 }); }
        else if (t - S.lastMoveAt > 4500 && turned < CFG.turnDoneDeg) { banner('Keep turning', 'adjust'); Voice.say('Keep turning, all the way round.', { gap: 6000 }); }
        else banner(turned < 180 ? 'Keep turning' : (turned < 300 ? 'Halfway. Keep going.' : 'Almost there'), 'go');
      }
      for (const [deg, text] of [[170, 'Halfway. Keep going.'], [285, 'Almost there.']]) if (turned >= deg && !S.said[deg]) { S.said[deg] = 1; Voice.say(text, { force: true }); }
      if ((turned >= CFG.turnDoneDeg && Math.abs(a.yaw) < 22) || turned >= 385) { if (t - S.lastSave.t > 150) grab(r, 'end', a); return finish(true); }
    } else if (t - S.lastSeen > 3000) { banner('Step back into view', 'adjust'); Voice.say('I lost you. Step back into view.', { gap: 6000 }); }
    if (t - S.turnAt > CFG.turnMaxMs) return finish(Math.abs(S.cum) >= 300);
  }
}

async function finish(complete) {
  S.running = false; S.phase = 'done'; log('turn-end', (complete ? 'complete ' : 'incomplete ') + S.cum.toFixed(0));
  Voice.beep(1320, 180); setTimeout(() => Voice.beep(1760, 320), 200);
  if (!complete && S.frames.length < 12) {
    banner("Let's try that again", 'adjust'); Voice.say('That did not work. Let us try again. Face the phone.', { force: true });
    setTimeout(() => { if (current === 's-camera') beginCamera(); }, 2500); return;
  }
  banner('Done. You can relax.', 'good'); Voice.say('Done. You can relax and pick up the phone.', { force: true });
  await Promise.all(S.pending);
  try { if (S.wake) { await S.wake.release(); S.wake = null; } } catch (e) { /* ignore */ }
  buildReview(complete);
}

/* ---------- capture file (zip, stored without compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let offset = 0;
  const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + n;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

/* ---------- review ---------- */
function mark(ok) { return '<span class="mark ' + (ok ? 'yes' : 'no') + '" aria-hidden="true">' + (ok ? '✓' : '!') + '</span>'; }
async function buildReview(complete) {
  const frames = S.frames.filter(f => f.blob), turned = Math.abs(S.cum), seen = frames.filter(f => f.lm).length;
  const cut = frames.filter(f => f.lm && (Math.max(...f.lm.slice(27, 33).map(p => p[1])) > 0.99 || f.lm[0][1] < 0.02)).length;
  const betas = frames.map(f => f.beta).filter(b => b != null), moved = betas.length ? Math.max(...betas) - Math.min(...betas) : null;
  const checks = [
    [complete && turned >= CFG.turnDoneDeg, complete ? 'Full turn seen (' + Math.round(turned) + '°).' : 'The turn looked incomplete (' + Math.round(turned) + '°). You can still save it, or measure again.'],
    [frames.length >= 30, frames.length + ' pictures saved' + (frames.length < 30 ? '. That is few; a slower turn gives more.' : '.')],
    [cut <= frames.length * 0.1, cut ? 'Head or feet were out of the picture in ' + cut + ' pictures.' : 'Head and feet stayed in the picture.'],
    [moved == null || moved < 2, moved == null ? 'No tilt sensor reading on this device.' : (moved < 2 ? 'The phone stayed still.' : 'The phone moved during the turn (' + moved.toFixed(1) + '°).')],
  ];
  $('rev-title').textContent = checks.every(c => c[0]) ? 'Capture complete' : 'Capture saved, with warnings';
  $('rev-checks').innerHTML = checks.map(c => '<li>' + mark(c[0]) + '<span>' + c[1] + '</span></li>').join('');
  const th = $('thumbs'); th.innerHTML = '';
  for (let k = 0; k < 8; k++) {
    const target = k * 45; let best = null;
    for (const f of frames) if (!best || Math.abs(Math.abs(f.turned) - target) < Math.abs(Math.abs(best.turned) - target)) best = f;
    if (best) { const im = new Image(); im.src = URL.createObjectURL(best.blob); im.alt = 'About ' + target + ' degrees round'; th.appendChild(im); }
  }
  const meta = {
    app: 'fit-capture', version: APP_VERSION, created: new Date().toISOString(), height_cm: S.heightCm, face_blurred: S.blurFace, complete, turned_deg: +S.cum.toFixed(1),
    user_agent: navigator.userAgent, screen: { w: screen.width, h: screen.height, dpr: window.devicePixelRatio }, video: S.video, track: S.track, model_complexity: S.modelComplexity,
    mirrored: false, camera: 'front', tilt_at_start: S.tiltAtStart, tilt_skipped: S.tiltSkipped, orientation_samples: S.oriLog.slice(-1500), events: S.events,
    frames: frames.map((f, n) => ({ file: 'frames/f' + String(n).padStart(3, '0') + '.jpg', t_ms: f.t, tag: f.tag, w: f.w, h: f.h, facing_deg: f.yaw, turned_deg: f.turned, beta: f.beta, gamma: f.gamma, landmarks: f.lm, world: f.world })),
  };
  const files = [{ name: 'capture.json', data: new TextEncoder().encode(JSON.stringify(meta)) }];
  for (let n = 0; n < frames.length; n++) files.push({ name: meta.frames[n].file, data: new Uint8Array(await frames[n].blob.arrayBuffer()) });
  S.zip = makeZip(files); S.meta = meta;
  const d = new Date(), p = v => String(v).padStart(2, '0');
  S.zipName = 'fit-capture-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.zip';
  $('rev-count').textContent = String(frames.length); $('rev-size').textContent = (S.zip.size / 1048576).toFixed(1);
  stopCamera(); show('s-review'); log('review');
}
$('save').addEventListener('click', async () => {
  if (!S.zip) return;
  const file = new File([S.zip], S.zipName, { type: 'application/zip' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Fit capture' }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = $('save-link'); a.href = URL.createObjectURL(S.zip); a.download = S.zipName; a.hidden = false; a.click(); a.hidden = true;
  $('save').textContent = 'Saved to Downloads. Save again';
});
$('again').addEventListener('click', async () => {
  $('save').textContent = 'Save capture file';
  try { await startCamera(); show('s-place'); startTilt(); } catch (e) { show('s-sound'); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && current === 's-camera') requestWake(); });
})();
