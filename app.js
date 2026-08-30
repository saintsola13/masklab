const video = document.getElementById("cam");
const view = document.getElementById("view");
const recCanvas = document.getElementById("rec");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const btnCam = document.getElementById("btn-cam");
const btnAttach = document.getElementById("btn-attach");
const btnLock = document.getElementById("btn-lock");
const btnRec = document.getElementById("btn-rec");
const btnStop = document.getElementById("btn-stop");
const btnVfx = document.getElementById("btn-vfx");
const photoBtn = document.getElementById("photo-btn");
const filePhoto = document.getElementById("file-photo");
const previewEl = document.getElementById("preview");
const previewImg = document.getElementById("preview-img");
const previewLabel = document.getElementById("preview-label");
const cutoutInput = document.getElementById("cutout");
const sizeInput = document.getElementById("size");
const nudgeInput = document.getElementById("nudge");
const slideInput = document.getElementById("slide");
const saveSheet = document.getElementById("save-sheet");
const saveVideo = document.getElementById("save-video");
const btnSavePhotos = document.getElementById("btn-save-photos");
const btnSaveClose = document.getElementById("btn-save-close");
const libraryEl = document.getElementById("library");
const vfxPanel = document.getElementById("vfx-panel");
const vfxPitchEl = document.getElementById("vfx-pitch");
const vfxPitchVal = document.getElementById("vfx-pitch-val");
const vfxRobotBtn = document.getElementById("vfx-robot");
const vfxReverbBtn = document.getElementById("vfx-reverb");

const ctx = view.getContext("2d");
const recCtx = recCanvas.getContext("2d");
const STORE = "masklab.photos";

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let face = null;
let blendshapes = null;
let photoSource = null;
let cutout = null;
let attached = false;
let locked = false;
let recorder = null;
let recChunks = [];
let lastFile = null;
let lastUrl = null;

// ── VOICE FX STATE ────────────────────────────────────────────────────────────
let audioCtx = null;
let micSource = null;
let fxDest = null;       // MediaStreamDestination — what recorder hears
let pitchNode = null;    // ScriptProcessor for pitch shift
let robotOsc = null;     // ring mod oscillator
let robotGain = null;
let reverbNode = null;
let dryGain = null;
let wetGain = null;
let vfxOn = false;
let robotOn = false;
let reverbOn = false;
let pitchSemitones = 0;

// Simple pitch shift via playback rate on a buffer — we use a phase vocoder
// approximation: resample mic through MediaRecorder detour is too complex,
// so we use a ScriptProcessor that reads mic samples and resamples in small chunks.
// For clean results we use the Web Audio API pitch shifter via detune on a buffer source.
// Best practical approach in browser: route mic → MediaStreamSource → pitchShifter chain.

// We'll implement pitch shift using a continuously running buffer trick:
// mic → ScriptProcessor (collect samples) → resample at different rate → output

const PITCH_BUFFER_SIZE = 4096;
const SEMITONE = Math.pow(2, 1/12);

function buildAudioGraph() {
  if (!stream || !stream.getAudioTracks().length) return false;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // CRITICAL: source from mic stream only — never connect anything to audioCtx.destination
  // All output goes ONLY to fxDest (MediaStreamDestination) so nothing plays through speakers
  micSource = audioCtx.createMediaStreamSource(stream);
  fxDest    = audioCtx.createMediaStreamDestination();

  // ── Pitch shift (circular buffer resampler) ──
  pitchNode = audioCtx.createScriptProcessor(PITCH_BUFFER_SIZE, 1, 1);
  const pitchBuffer = new Float32Array(PITCH_BUFFER_SIZE * 8);
  let writePos = 0;
  let readPos  = 0;

  pitchNode.onaudioprocess = (e) => {
    const input  = e.inputBuffer.getChannelData(0);
    const output = e.outputBuffer.getChannelData(0);
    const rate   = Math.pow(SEMITONE, pitchSemitones);
    const BUF    = pitchBuffer.length;

    for (let i = 0; i < input.length; i++) {
      pitchBuffer[writePos % BUF] = input[i];
      writePos++;
    }
    for (let i = 0; i < output.length; i++) {
      const pos  = readPos % BUF;
      const p0   = Math.floor(pos) % BUF;
      const p1   = (p0 + 1) % BUF;
      const frac = pos - Math.floor(pos);
      output[i]  = pitchBuffer[p0] * (1 - frac) + pitchBuffer[p1] * frac;
      readPos   += rate;
    }
    // Drift correction — keep read within one buffer of write
    const lag = writePos - readPos;
    if (lag > PITCH_BUFFER_SIZE * 6) readPos += PITCH_BUFFER_SIZE;
    if (lag < PITCH_BUFFER_SIZE)     readPos -= PITCH_BUFFER_SIZE;
  };

  // ── Ring modulator (TRUE robot effect) ──
  // mic signal multiplied by oscillator — NOT added, MULTIPLIED.
  // ringModGain.gain is driven by the oscillator so it oscillates between -1 and +1
  // This chops the signal at the osc frequency = classic robot voice.
  // The oscillator connects to the GAIN PARAM only — never into the signal path.
  // Zero feedback risk.
  robotOsc = audioCtx.createOscillator();
  robotOsc.type = "sine";
  robotOsc.frequency.value = 80; // 80Hz ring = robotic, tweak in toggleRobot

  const oscGain = audioCtx.createGain();
  oscGain.gain.value = 1.0; // full modulation depth

  // ringModGain starts at 0 gain (robot off) — driven by oscGain when on
  robotGain = audioCtx.createGain();
  robotGain.gain.value = 1; // when robot off, pass signal through at unity

  robotOsc.connect(oscGain);
  // oscGain drives robotGain.gain AudioParam — this is the ring mod
  // We'll connect/disconnect oscGain → robotGain.gain on toggle

  robotOsc.start();
  vfxPanel._oscGain = oscGain;

  // ── Reverb (convolver + synthetic impulse response) ──
  reverbNode = audioCtx.createConvolver();
  reverbNode.buffer = buildImpulseResponse(audioCtx, 2.5, 3.2, false);
  const reverbWet = audioCtx.createGain();
  const reverbDry = audioCtx.createGain();
  reverbWet.gain.value = 0;
  reverbDry.gain.value = 1;

  // ── Graph (nothing touches audioCtx.destination) ──
  //
  //  mic → pitchNode → robotGain → reverbDry → fxDest
  //                             ↘ reverbNode → reverbWet → fxDest
  //
  //  oscGain → robotGain.gain  (modulates gain param, not signal — ring mod)
  //
  micSource.connect(pitchNode);
  pitchNode.connect(robotGain);
  robotGain.connect(reverbDry);
  robotGain.connect(reverbNode);
  reverbDry.connect(fxDest);
  reverbNode.connect(reverbWet);
  reverbWet.connect(fxDest);
  // ← audioCtx.destination never connected

  vfxPanel._reverbWet = reverbWet;
  vfxPanel._reverbDry = reverbDry;

  return true;
}

function buildImpulseResponse(ctx, duration, decay, reverse) {
  const rate = ctx.sampleRate;
  const length = Math.round(rate * duration);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const ch = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) {
      const n = reverse ? length - i : i;
      ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    }
  }
  return impulse;
}

function toggleVfxPanel() {
  if (!running) { toast("Start camera first"); return; }
  if (!stream?.getAudioTracks().length) { toast("No mic — voice FX needs mic access"); return; }

  vfxOn = !vfxOn;
  vfxPanel.hidden = !vfxOn;
  btnVfx.textContent = vfxOn ? "🎙 FX ON" : "🎙 FX";
  btnVfx.classList.toggle("fx-active", vfxOn);

  if (vfxOn && !audioCtx) {
    const ok = buildAudioGraph();
    if (!ok) { toast("No mic for voice FX"); vfxOn = false; vfxPanel.hidden = true; return; }
    toast("Voice FX ready");
  }
}

function toggleRobot() {
  robotOn = !robotOn;
  vfxRobotBtn.textContent = robotOn ? "ON" : "OFF";
  vfxRobotBtn.style.color = robotOn ? "#ff2a3a" : "";
  vfxRobotBtn.style.borderColor = robotOn ? "rgba(255,42,58,0.7)" : "";

  if (robotOsc && vfxPanel._oscGain && robotGain) {
    if (robotOn) {
      // Ring mod ON:
      // Set robotGain.gain to 0 — oscGain will drive it between -1 and +1
      robotGain.gain.setValueAtTime(0, audioCtx.currentTime);
      // Connect oscillator to gain AudioParam (ring modulation)
      vfxPanel._oscGain.connect(robotGain.gain);
      robotOsc.frequency.value = 80;
      // Auto-darken pitch for robot feel
      if (pitchSemitones === 0) {
        pitchSemitones = -4;
        vfxPitchEl.value = -4;
        vfxPitchVal.textContent = "-4";
      }
    } else {
      // Ring mod OFF: disconnect osc from gain param, restore unity gain
      try { vfxPanel._oscGain.disconnect(robotGain.gain); } catch(_) {}
      robotGain.gain.setValueAtTime(1, audioCtx.currentTime);
    }
  }
  toast(robotOn ? "Robot on" : "Robot off");
}

function toggleReverb() {
  reverbOn = !reverbOn;
  vfxReverbBtn.textContent = reverbOn ? "ON" : "OFF";
  vfxReverbBtn.style.color = reverbOn ? "#ff2a3a" : "";
  vfxReverbBtn.style.borderColor = reverbOn ? "rgba(255,42,58,0.7)" : "";
  if (vfxPanel._reverbWet) {
    vfxPanel._reverbWet.gain.setTargetAtTime(reverbOn ? 0.65 : 0, audioCtx.currentTime, 0.05);
    vfxPanel._reverbDry.gain.setTargetAtTime(reverbOn ? 0.45 : 1, audioCtx.currentTime, 0.05);
  }
  toast(reverbOn ? "Reverb on" : "Reverb off");
}

vfxPitchEl.addEventListener("input", () => {
  pitchSemitones = Number(vfxPitchEl.value);
  vfxPitchVal.textContent = pitchSemitones > 0 ? `+${pitchSemitones}` : String(pitchSemitones);
});
vfxRobotBtn.addEventListener("click", toggleRobot);
vfxReverbBtn.addEventListener("click", toggleReverb);
btnVfx.addEventListener("click", toggleVfxPanel);

// ── Pick audio source for recorder: FX chain if active, raw mic otherwise ──
function getAudioTracks() {
  if (vfxOn && fxDest) return fxDest.stream.getAudioTracks();
  if (stream) return stream.getAudioTracks();
  return [];
}

// ── Blendshape helper ─────────────────────────────────────────────────────────
function getBlend(name) {
  if (!blendshapes) return 0;
  const cat = blendshapes.find(c => c.categoryName === name);
  return cat ? cat.score : 0;
}

// ── Warp cutout in its own pixel space (no rotation glitch) ──────────────────
function warpCutoutImage(box) {
  const W = cutout.width;
  const H = cutout.height;

  const blink = Math.min(1, Math.max(getBlend("eyeBlinkLeft"), getBlend("eyeBlinkRight")) * 1.6);
  const jaw   = Math.min(1, getBlend("jawOpen") * 2.0);

  if (blink < 0.03 && jaw < 0.03) return cutout;

  const maskTop = box.cy - box.dh / 2;
  const maskH   = box.dh;

  function lmUV(idx) {
    if (!face?.[idx]) return null;
    const { dh, oy } = coverRect();
    return (oy + face[idx].y * dh - maskTop) / maskH;
  }

  const eyeUVs = [lmUV(159), lmUV(145), lmUV(386), lmUV(374)].filter(v => v !== null);
  const eyeTopUV = eyeUVs.length ? Math.max(0.05, Math.min(...eyeUVs) - 0.03) : 0.22;
  const eyeBotUV = eyeUVs.length ? Math.min(0.95, Math.max(...eyeUVs) + 0.03) : 0.36;

  const mTopUV = lmUV(13) !== null ? Math.max(0.05, lmUV(13) - 0.04) : 0.60;
  const mBotUV = lmUV(14) !== null ? Math.min(0.95, lmUV(14) + 0.06) : 0.74;

  const eyeTopPx = eyeTopUV * H, eyeBotPx = eyeBotUV * H;
  const mTopPx   = mTopUV   * H, mBotPx   = mBotUV   * H;
  const eyeBandH = Math.max(1, eyeBotPx - eyeTopPx);
  const mBandH   = Math.max(1, mBotPx   - mTopPx);

  const eyeSquish = 1 - blink * 0.90;
  const mStretch  = 1 + jaw   * 0.55;

  const eyeDelta = eyeBandH * eyeSquish - eyeBandH;
  const mDelta   = mBandH   * mStretch  - mBandH;
  const newH     = Math.max(1, Math.round(H + eyeDelta + mDelta));

  const out = document.createElement("canvas");
  out.width = W; out.height = newH;
  const oc = out.getContext("2d");

  let destY = 0;
  function blitBand(srcY, srcH, dstH) {
    if (srcH <= 0 || dstH <= 0) return;
    oc.drawImage(cutout, 0, srcY, W, srcH, 0, destY, W, dstH);
    destY += dstH;
  }

  blitBand(0,        eyeTopPx,             eyeTopPx);
  blitBand(eyeTopPx, eyeBandH,             eyeBandH * eyeSquish);
  blitBand(eyeBotPx, mTopPx - eyeBotPx,   mTopPx - eyeBotPx);
  blitBand(mTopPx,   mBandH,              mBandH  * mStretch);
  blitBand(mBotPx,   H - mBotPx,          H - mBotPx);

  return out;
}

function drawMaskAnimated() {
  if (!attached || !cutout || !face) return;
  const box = maskRect(face);
  const src = locked ? warpCutoutImage(box) : cutout;
  const mX = box.cx - box.dw / 2, mY = box.cy - box.dh / 2;
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.translate(-box.cx, -box.cy);
  ctx.drawImage(src, mX, mY, box.dw, box.dh);
  ctx.restore();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function setStatus(t) { statusEl.textContent = t; }
function toast(t, ms = 1800) {
  toastEl.hidden = false; toastEl.textContent = t;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function loadStore() {
  try { return JSON.parse(localStorage.getItem(STORE) || "[]"); } catch { return []; }
}
function writeStore(items) {
  const next = items.slice(0, 8);
  try { localStorage.setItem(STORE, JSON.stringify(next)); return true; }
  catch { return next.length > 1 ? writeStore(next.slice(0, -1)) : false; }
}
function persistPhoto() {
  if (!photoSource) return;
  const dataUrl = photoSource.toDataURL("image/jpeg", 0.7);
  const items = loadStore().filter(x => x.dataUrl !== dataUrl);
  items.unshift({ id: Date.now(), dataUrl });
  writeStore(items); renderLibrary();
}
function deleteSaved(id) {
  writeStore(loadStore().filter(x => String(x.id) !== String(id)));
  renderLibrary();
}
function renderLibrary() {
  const items = loadStore();
  if (!items.length) { libraryEl.hidden = true; libraryEl.innerHTML = ""; return; }
  libraryEl.hidden = false;
  libraryEl.innerHTML = items.map(item =>
    `<div class="lib-item" data-id="${item.id}"><img alt="" src="${item.dataUrl}"><button type="button" data-del="${item.id}">×</button></div>`
  ).join("");
}
async function useSaved(id) {
  const item = loadStore().find(x => String(x.id) === String(id));
  if (!item) return;
  const img = new Image();
  await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = item.dataUrl; });
  photoSource = drawSource(img); rebuildCutout();
  previewEl.hidden = false; previewLabel.textContent = "Saved mask — Attach";
  btnAttach.disabled = false; attached = false; locked = false;
  btnLock.disabled = true; btnLock.textContent = "4. Lock"; btnRec.disabled = true;
  setStatus(face ? "Tap Attach" : "Start camera, then Attach");
  toast("Loaded saved photo");
}
libraryEl.addEventListener("click", e => {
  const del = e.target.closest("[data-del]");
  if (del) { e.stopPropagation(); deleteSaved(del.getAttribute("data-del")); return; }
  const item = e.target.closest(".lib-item");
  if (item) useSaved(item.getAttribute("data-id"));
});

function sizeCanvases() {
  const w = Math.round(window.innerWidth  * Math.min(devicePixelRatio, 2));
  const h = Math.round(window.innerHeight * Math.min(devicePixelRatio, 2));
  if (view.width !== w || view.height !== h) {
    view.width = w; view.height = h; recCanvas.width = w; recCanvas.height = h;
  }
}
window.addEventListener("resize", sizeCanvases);
sizeCanvases();

function unlockPhotos() { photoBtn.classList.remove("locked"); filePhoto.disabled = false; }

function coverRect() {
  const cw = view.width, ch = view.height;
  const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  return { cw, ch, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2 };
}
function toCanvas(p) {
  const { dw, dh, ox, oy } = coverRect();
  return { x: ox + (1 - p.x) * dw, y: oy + p.y * dh };
}

function sampleBg(data, w, h) {
  const pts = [0, (w-1)*4, (h-1)*w*4, ((h-1)*w+(w-1))*4];
  let r=0,g=0,b=0;
  for (const i of pts) { r+=data[i]; g+=data[i+1]; b+=data[i+2]; }
  return [r/pts.length, g/pts.length, b/pts.length];
}
function floodCutout(src, threshold) {
  const w = src.width, h = src.height;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.drawImage(src, 0, 0);
  const img = c.getImageData(0, 0, w, h); const data = img.data;
  const [br,bg,bb] = sampleBg(data, w, h);
  const limit = threshold*threshold*3;
  const close = i => { const dr=data[i]-br,dg=data[i+1]-bg,db=data[i+2]-bb; return dr*dr+dg*dg+db*db<=limit; };
  const seen = new Uint8Array(w*h);
  const stack = [0, w-1, (h-1)*w, h*w-1];
  while (stack.length) {
    const p = stack.pop();
    if (p<0||p>=w*h||seen[p]) continue; seen[p]=1;
    if (!close(p*4)) continue; data[p*4+3]=0;
    const x=p%w, y=(p/w)|0;
    if (x>0) stack.push(p-1); if (x<w-1) stack.push(p+1);
    if (y>0) stack.push(p-w); if (y<h-1) stack.push(p+w);
  }
  c.putImageData(img,0,0); return cropAlpha(canvas);
}
function cropAlpha(src) {
  const w=src.width, h=src.height;
  const c=src.getContext("2d",{willReadFrequently:true});
  const {data}=c.getImageData(0,0,w,h);
  let minX=w,minY=h,maxX=0,maxY=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) {
    if (data[(y*w+x)*4+3]>8) { if(x<minX)minX=x;if(y<minY)minY=y;if(x>maxX)maxX=x;if(y>maxY)maxY=y; }
  }
  if (maxX<=minX||maxY<=minY) return src;
  const pad=4;
  minX=Math.max(0,minX-pad); minY=Math.max(0,minY-pad);
  maxX=Math.min(w-1,maxX+pad); maxY=Math.min(h-1,maxY+pad);
  const out=document.createElement("canvas");
  out.width=maxX-minX+1; out.height=maxY-minY+1;
  out.getContext("2d").drawImage(src,minX,minY,out.width,out.height,0,0,out.width,out.height);
  return out;
}
function rebuildCutout() {
  if (!photoSource) return;
  cutout = floodCutout(photoSource, Number(cutoutInput.value));
  previewImg.src = cutout.toDataURL("image/png");
}
function drawSource(imgLike) {
  const width=imgLike.width||2, height=imgLike.height||2;
  const scale=Math.min(1,720/Math.max(width,height));
  const src=document.createElement("canvas");
  src.width=Math.max(2,Math.round(width*scale)); src.height=Math.max(2,Math.round(height*scale));
  src.getContext("2d").drawImage(imgLike,0,0,src.width,src.height); return src;
}
async function decodePhoto(file) {
  if (typeof createImageBitmap==="function") { try { return await createImageBitmap(file); } catch(_){} }
  const url=URL.createObjectURL(file);
  try { const img=new Image(); await new Promise((r,j)=>{img.onload=r;img.onerror=j;img.src=url;}); return img; }
  finally { URL.revokeObjectURL(url); }
}

function faceAnchor(landmarks) {
  const forehead=toCanvas(landmarks[10]), chin=toCanvas(landmarks[152]);
  const a=toCanvas(landmarks[234]), b=toCanvas(landmarks[454]);
  const left=a.x<b.x?a:b, right=a.x<b.x?b:a;
  let angle=Math.atan2(right.y-left.y,right.x-left.x);
  if (angle>Math.PI/2) angle-=Math.PI; if (angle<-Math.PI/2) angle+=Math.PI;
  const userScale=(Number(sizeInput?.value)||118)/100;
  return { forehead, chin, left, right,
    cx:(left.x+right.x)*0.5,
    faceW:Math.hypot(right.x-left.x,right.y-left.y)*1.62*userScale,
    faceH:Math.hypot(chin.x-forehead.x,chin.y-forehead.y)*1.12*userScale,
    angle };
}
function maskRect(landmarks) {
  const a=faceAnchor(landmarks);
  const aspect=cutout.width/Math.max(cutout.height,1);
  const faceFrac=0.58;
  let dh=a.faceH/faceFrac, dw=dh*aspect;
  if (dw<a.faceW) { dw=a.faceW; dh=dw/aspect; }
  const nudge=(Number(nudgeInput?.value)||38)/100;
  const slide=(Number(slideInput?.value)||0)/100;
  return { cx:a.cx+dw*slide, cy:a.chin.y-dh*0.48+dh*nudge, dw, dh, angle:a.angle };
}

function drawVideo() {
  const {cw,dw,dh,ox,oy}=coverRect();
  ctx.save(); ctx.translate(cw,0); ctx.scale(-1,1);
  ctx.drawImage(video,cw-ox-dw,oy,dw,dh); ctx.restore();
}
function drawMap() {
  if (!face) return;
  ctx.fillStyle="rgba(80,220,255,0.95)";
  for (let i=0;i<face.length;i+=4) {
    const p=toCanvas(face[i]);
    ctx.beginPath(); ctx.arc(p.x,p.y,2.4,0,Math.PI*2); ctx.fill();
  }
}
function compositeTo(target) { target.drawImage(view,0,0); }

async function initTracker() {
  setStatus("Loading face map…");
  const mod=await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
  const fileset=await mod.FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  landmarker=await mod.FaceLandmarker.createFromOptions(fileset,{
    baseOptions:{
      modelAssetPath:"https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate:"GPU",
    },
    runningMode:"VIDEO", numFaces:1,
    outputFaceBlendshapes:true,
    outputFacialTransformationMatrixes:false,
  });
}

async function startCamera() {
  if (running) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:"user", width:{ideal:1280}, height:{ideal:720} },
      audio: { echoCancellation:true, noiseSuppression:true },
    });
  } catch(_) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"user" }, audio:false }); }
    catch(err2) { setStatus("Allow camera access"); return; }
  }
  video.srcObject = stream;
  await video.play();
  if (!landmarker) await initTracker();
  running = true;
  btnCam.textContent = "Camera on";
  unlockPhotos();
  btnVfx.disabled = false;
  setStatus("Face mapping — look at camera, then pick a photo");
  toast("Camera on");
}

function attach() {
  if (!cutout) { toast("Pick a photo first"); return; }
  if (!face)   { toast("Look at the camera first"); return; }
  attached=true; locked=false; btnLock.disabled=false; btnRec.disabled=true;
  setStatus("Line it up, then Lock"); toast("Attached — adjust then Lock");
}
function lockFit() {
  if (!attached) { toast("Attach first"); return; }
  locked=true; btnRec.disabled=false;
  btnLock.textContent="Locked ✦";
  setStatus("Locked — Record when ready");
  toast("Fit locked");
}

function loop() {
  sizeCanvases();
  if (running && video.readyState>=2) {
    drawVideo();
    const ts=performance.now();
    if (landmarker && ts!==lastTs) {
      lastTs=ts;
      const result=landmarker.detectForVideo(video,ts);
      face=result.faceLandmarks?.[0]||null;
      blendshapes=result.faceBlendshapes?.[0]?.categories||null;
    }
    if (attached) drawMaskAnimated();
    else if (face) drawMap();
    if (recorder&&recorder.state==="recording") compositeTo(recCtx);
  }
  requestAnimationFrame(loop);
}

function pickMime() {
  const types=["video/mp4","video/mp4;codecs=avc1.42001E,mp4a.40.2","video/webm;codecs=vp8,opus","video/webm"];
  return types.find(t=>MediaRecorder.isTypeSupported(t))||"";
}
function pickRecorder() {
  const mime=pickMime();
  const canvasStream=recCanvas.captureStream(30);
  const audioTracks = getAudioTracks();
  const tracks=[...canvasStream.getVideoTracks(), ...audioTracks];
  const mixed=new MediaStream(tracks);
  return mime?new MediaRecorder(mixed,{mimeType:mime}):new MediaRecorder(mixed);
}
function startRec() {
  if (!attached||!running||!locked) { toast("Lock the fit first"); return; }
  // Resume AudioContext if suspended (mobile autoplay policy)
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  recChunks=[]; compositeTo(recCtx); recorder=pickRecorder();
  recorder.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
  recorder.start(200); btnRec.hidden=true; btnStop.hidden=false;
  btnStop.textContent="Stop & save";
  setStatus(vfxOn ? "Recording w/ Voice FX…" : "Recording…");
}
function makeFile() {
  const raw=recorder?.mimeType||recChunks[0]?.type||"video/mp4";
  const isMp4=raw.includes("mp4");
  const type=isMp4?"video/mp4":"video/webm"; const ext=isMp4?"mp4":"webm";
  return new File([new Blob(recChunks,{type})],`masklab-${Date.now()}.${ext}`,{type});
}
function showSaveSheet(file) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastFile=file; lastUrl=URL.createObjectURL(file);
  saveVideo.src=lastUrl; saveSheet.hidden=false; setStatus("Save to Photos");
}
async function shareToPhotos(file) {
  if (!file) return false;
  try {
    if (navigator.canShare?.({files:[file]})) { await navigator.share({files:[file],title:"MASKLAB"}); toast("Pick Save Video"); return true; }
    if (navigator.share) { await navigator.share({files:[file],title:"MASKLAB"}); toast("Pick Save Video"); return true; }
  } catch(err) { if(err?.name==="AbortError") return true; }
  return false;
}
async function stopRec() {
  if (!recorder||recorder.state==="inactive") return;
  const done=new Promise(r=>recorder.addEventListener("stop",r,{once:true}));
  recorder.stop(); await done;
  btnRec.hidden=false; btnStop.hidden=true;
  const file=makeFile(); showSaveSheet(file); await shareToPhotos(file);
}

btnSavePhotos.addEventListener("click",async()=>{ if(!lastFile) return; const ok=await shareToPhotos(lastFile); if(!ok) toast("Hold the video → Save Video"); });
btnSaveClose.addEventListener("click",()=>{ saveSheet.hidden=true; setStatus("Locked — Record when ready"); });
btnCam.addEventListener("click", startCamera);
btnAttach.addEventListener("click", attach);
btnLock.addEventListener("click", lockFit);
btnRec.addEventListener("click", startRec);
btnStop.addEventListener("click", stopRec);

filePhoto.addEventListener("change", async () => {
  const file=filePhoto.files?.[0]; if(!file) return;
  try {
    setStatus("Cutting photo…");
    const decoded=await decodePhoto(file); photoSource=drawSource(decoded);
    if(decoded.close) decoded.close();
    rebuildCutout(); persistPhoto();
    previewEl.hidden=false; previewLabel.textContent="Cutout ready — Attach";
    btnAttach.disabled=false; attached=false; locked=false;
    btnLock.disabled=true; btnLock.textContent="4. Lock"; btnRec.disabled=true;
    setStatus(face?"Tap Attach":"Look at camera, then Attach");
    toast("Saved — tap Attach");
  } catch(err) { console.error(err); toast("Could not read photo — try a screenshot"); }
});

cutoutInput.addEventListener("input", rebuildCutout);
renderLibrary();
loop();
setStatus("1 / 5 — Start camera");
