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
const photoBtn = document.getElementById("photo-btn");
const photoInput = document.getElementById("file-photo");
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

// ── Blendshape helpers ────────────────────────────────────────────────────────
function getBlend(name) {
  if (!blendshapes) return 0;
  const cat = blendshapes.find(c => c.categoryName === name);
  return cat ? cat.score : 0;
}

// Landmark indices for eye/mouth regions (MediaPipe 478-point model)
// Left eye (from face's left = screen right in mirrored view)
const LEFT_EYE_LM  = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
const RIGHT_EYE_LM = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];
const MOUTH_LM     = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];

function landmarkBounds(indices) {
  if (!face) return null;
  const { dw, dh, ox, oy } = coverRect();
  const cw = view.width;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of indices) {
    const p = face[i];
    if (!p) continue;
    const x = ox + (1 - p.x) * dw;
    const y = oy + p.y * dh;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY,
           cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

// ── Draw animated mask with blendshape deformation ───────────────────────────
function drawMaskAnimated() {
  if (!attached || !cutout || !face) return;

  const box = maskRect(face);

  // Base blendshape values
  const mouthOpen   = Math.min(1, getBlend("jawOpen") * 2.2);
  const blinkLeft   = Math.min(1, getBlend("eyeBlinkLeft")  * 1.4);
  const blinkRight  = Math.min(1, getBlend("eyeBlinkRight") * 1.4);

  // Where the full mask will land on screen
  const mW = box.dw;
  const mH = box.dh;
  const mX = box.cx - mW / 2;
  const mY = box.cy - mH / 2;

  // Eye bounds in screen space → convert to mask-local UV (0–1)
  const lEye = landmarkBounds(LEFT_EYE_LM);
  const rEye = landmarkBounds(RIGHT_EYE_LM);
  const mouth = landmarkBounds(MOUTH_LM);

  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.translate(-box.cx, -box.cy);

  if (!locked || (!mouthOpen && !blinkLeft && !blinkRight)) {
    // No animation needed — plain draw
    ctx.drawImage(cutout, mX, mY, mW, mH);
  } else {
    // ── Draw mask in sections so we can deform mouth/eyes independently ──

    // We'll use clipping to paint the mask in 3 passes:
    // 1. Full mask (base)
    // 2. Eye regions squished vertically (blink)
    // 3. Mouth region stretched vertically (jaw open)

    // --- 1. Full base mask ---
    ctx.drawImage(cutout, mX, mY, mW, mH);

    // --- 2. Eye blink: cover eye region with squished copy ---
    for (const [eyeBounds, blinkVal] of [[lEye, blinkLeft], [rEye, blinkRight]]) {
      if (!eyeBounds || blinkVal < 0.05) continue;

      // Eye region in mask-local coords
      const eyePad = eyeBounds.h * 0.5;
      const ex = eyeBounds.x - eyePad;
      const ey = eyeBounds.y - eyePad;
      const ew = eyeBounds.w + eyePad * 2;
      const eh = eyeBounds.h + eyePad * 2;

      // Source rect in cutout image coords
      const sx = ((ex - mX) / mW) * cutout.width;
      const sy = ((ey - mY) / mH) * cutout.height;
      const sw = (ew / mW) * cutout.width;
      const sh = (eh / mH) * cutout.height;

      // Squish: scale height toward 0 as blink increases
      const squish = 1 - blinkVal;
      const drawH = eh * squish;
      const drawY = ey + (eh - drawH) / 2;

      ctx.save();
      ctx.beginPath();
      ctx.rect(ex, ey, ew, eh);
      ctx.clip();
      // Redraw base first (clear the un-squished eye)
      ctx.drawImage(cutout, mX, mY, mW, mH);
      // Draw squished eye strip
      ctx.drawImage(cutout, sx, sy, sw, sh, ex, drawY, ew, drawH);
      ctx.restore();
    }

    // --- 3. Mouth open: stretch lower half of mouth region downward ---
    if (mouth && mouthOpen > 0.05) {
      const mPadX = mouth.w * 0.25;
      const mPadY = mouth.h * 0.3;
      const mx = mouth.x - mPadX;
      const my = mouth.y - mPadY;
      const mw = mouth.w + mPadX * 2;
      const mh = mouth.h + mPadY * 2;

      // Split at mouth midpoint: top half stays, bottom half stretches down
      const splitY = mouth.cy;
      const topH   = splitY - my;
      const botH   = (my + mh) - splitY;
      const stretch = 1 + mouthOpen * 0.55; // max ~55% taller
      const newBotH = botH * stretch;

      // Source coords in cutout
      const srcX  = ((mx - mX) / mW) * cutout.width;
      const srcMidY = ((splitY - mY) / mH) * cutout.height;
      const srcBotH = (botH / mH) * cutout.height;
      const srcW   = (mw / mW)  * cutout.width;
      const srcTopH = (topH / mH) * cutout.height;
      const srcY  = ((my - mY) / mH) * cutout.height;

      ctx.save();
      ctx.beginPath();
      ctx.rect(mx, my, mw, topH + newBotH + mPadY);
      ctx.clip();
      // Clear region with base
      ctx.drawImage(cutout, mX, mY, mW, mH);
      // Top half of mouth: unchanged
      ctx.drawImage(cutout, srcX, srcY, srcW, srcTopH, mx, my, mw, topH);
      // Bottom half: stretched
      ctx.drawImage(cutout, srcX, srcMidY, srcW, srcBotH, mx, splitY, mw, newBotH);
      ctx.restore();
    }
  }

  ctx.restore();
}

function setStatus(t) { statusEl.textContent = t; }
function toast(t, ms = 1800) {
  toastEl.hidden = false;
  toastEl.textContent = t;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function loadStore() {
  try { const raw = localStorage.getItem(STORE); return raw ? JSON.parse(raw) : []; }
  catch { return []; }
}
function writeStore(items) {
  const next = items.slice(0, 8);
  try { localStorage.setItem(STORE, JSON.stringify(next)); return true; }
  catch { if (next.length > 1) return writeStore(next.slice(0, next.length - 1)); return false; }
}
function persistPhoto() {
  if (!photoSource) return;
  const dataUrl = photoSource.toDataURL("image/jpeg", 0.7);
  const items = loadStore().filter(x => x.dataUrl !== dataUrl);
  items.unshift({ id: Date.now(), dataUrl });
  writeStore(items);
  renderLibrary();
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
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = item.dataUrl; });
  photoSource = drawSource(img);
  rebuildCutout();
  previewEl.hidden = false;
  previewLabel.textContent = "Saved mask — Attach";
  btnAttach.disabled = false;
  attached = false; locked = false;
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
    view.width = w; view.height = h;
    recCanvas.width = w; recCanvas.height = h;
  }
}
window.addEventListener("resize", sizeCanvases);
sizeCanvases();

function unlockPhotos() {
  photoBtn.classList.remove("locked");
  photoInput.disabled = false;
}

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
  const pts = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  let r = 0, g = 0, b = 0;
  for (const i of pts) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return [r / pts.length, g / pts.length, b / pts.length];
}

function floodCutout(src, threshold) {
  const w = src.width, h = src.height;
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.drawImage(src, 0, 0);
  const img = c.getImageData(0, 0, w, h);
  const data = img.data;
  const [br, bg, bb] = sampleBg(data, w, h);
  const limit = threshold * threshold * 3;
  const close = i => { const dr = data[i]-br, dg = data[i+1]-bg, db = data[i+2]-bb; return dr*dr+dg*dg+db*db <= limit; };
  const seen = new Uint8Array(w * h);
  const stack = [0, w - 1, (h - 1) * w, h * w - 1];
  while (stack.length) {
    const p = stack.pop();
    if (p < 0 || p >= w * h || seen[p]) continue;
    seen[p] = 1;
    if (!close(p * 4)) continue;
    data[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  c.putImageData(img, 0, 0);
  return cropAlpha(canvas);
}

function cropAlpha(src) {
  const w = src.width, h = src.height;
  const c = src.getContext("2d", { willReadFrequently: true });
  const { data } = c.getImageData(0, 0, w, h);
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) return src;
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function rebuildCutout() {
  if (!photoSource) return;
  cutout = floodCutout(photoSource, Number(cutoutInput.value));
  previewImg.src = cutout.toDataURL("image/png");
}

function drawSource(imgLike) {
  const width = imgLike.width || 2, height = imgLike.height || 2;
  const scale = Math.min(1, 720 / Math.max(width, height));
  const src = document.createElement("canvas");
  src.width = Math.max(2, Math.round(width * scale));
  src.height = Math.max(2, Math.round(height * scale));
  src.getContext("2d").drawImage(imgLike, 0, 0, src.width, src.height);
  return src;
}

async function decodePhoto(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file); } catch (_) {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
    return img;
  } finally { URL.revokeObjectURL(url); }
}

function faceAnchor(landmarks) {
  const forehead = toCanvas(landmarks[10]);
  const chin     = toCanvas(landmarks[152]);
  const a = toCanvas(landmarks[234]), b = toCanvas(landmarks[454]);
  const left  = a.x < b.x ? a : b;
  const right = a.x < b.x ? b : a;
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle >  Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const userScale = (Number(sizeInput?.value) || 118) / 100;
  return {
    forehead, chin, left, right,
    cx: (left.x + right.x) * 0.5,
    faceW: Math.hypot(right.x - left.x, right.y - left.y) * 1.62 * userScale,
    faceH: Math.hypot(chin.x - forehead.x, chin.y - forehead.y) * 1.12 * userScale,
    angle,
  };
}

function maskRect(landmarks) {
  const a = faceAnchor(landmarks);
  const aspect = cutout.width / Math.max(cutout.height, 1);
  const faceFrac = 0.58;
  let dh = a.faceH / faceFrac;
  let dw = dh * aspect;
  if (dw < a.faceW) { dw = a.faceW; dh = dw / aspect; }
  const nudge = (Number(nudgeInput?.value) || 38) / 100;
  const slide = (Number(slideInput?.value) || 0) / 100;
  return {
    cx: a.cx + dw * slide,
    cy: a.chin.y - dh * 0.48 + dh * nudge,
    dw, dh, angle: a.angle,
  };
}

function drawVideo() {
  const { cw, dw, dh, ox, oy } = coverRect();
  ctx.save();
  ctx.translate(cw, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, cw - ox - dw, oy, dw, dh);
  ctx.restore();
}

function drawMap() {
  if (!face) return;
  ctx.fillStyle = "rgba(80,220,255,0.95)";
  for (let i = 0; i < face.length; i += 4) {
    const p = toCanvas(face[i]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function compositeTo(target) { target.drawImage(view, 0, 0); }

async function initTracker() {
  setStatus("Loading face map…");
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
  const fileset = await mod.FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,   // ← enabled for animation
    outputFacialTransformationMatrixes: false,
  });
}

async function startCamera() {
  if (running) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      toast("Mic blocked — video only");
    } catch (err2) {
      setStatus("Allow camera access");
      toast("Camera permission blocked");
      return;
    }
  }
  video.srcObject = stream;
  await video.play();
  if (!landmarker) await initTracker();
  running = true;
  btnCam.textContent = "Camera on";
  unlockPhotos();
  setStatus("Face mapping — look at camera, then pick a photo");
  toast(stream.getAudioTracks().length ? "Camera + mic on" : "Camera on");
}

function attach() {
  if (!cutout) { toast("Pick a photo first"); return; }
  if (!face)   { toast("Look at the camera so the face map locks"); return; }
  attached = true; locked = false;
  btnLock.disabled = false; btnRec.disabled = true;
  setStatus("Slide / Size / Nudge, then Lock");
  toast("Attached — line it up, then Lock");
}

function lockFit() {
  if (!attached) { toast("Attach first"); return; }
  locked = true;
  btnRec.disabled = false;
  btnLock.textContent = "Locked ✦";
  setStatus("Locked — mouth + eyes live. Record when ready");
  toast("Fit locked — face animation on");
}

function loop() {
  sizeCanvases();
  if (running && video.readyState >= 2) {
    drawVideo();
    const ts = performance.now();
    if (landmarker && ts !== lastTs) {
      lastTs = ts;
      const result = landmarker.detectForVideo(video, ts);
      face = result.faceLandmarks?.[0] || null;
      blendshapes = result.faceBlendshapes?.[0]?.categories || null;
    }
    if (attached) drawMaskAnimated();
    else if (face) drawMap();
    if (recorder && recorder.state === "recording") compositeTo(recCtx);
  }
  requestAnimationFrame(loop);
}

function pickMime() {
  const types = ["video/mp4","video/mp4;codecs=avc1.42001E,mp4a.40.2","video/webm;codecs=vp8,opus","video/webm"];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function pickRecorder() {
  const mime = pickMime();
  const canvasStream = recCanvas.captureStream(30);
  const tracks = [...canvasStream.getVideoTracks()];
  if (stream) tracks.push(...stream.getAudioTracks());
  const mixed = new MediaStream(tracks);
  return mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed);
}

function startRec() {
  if (!attached || !running || !locked) { toast("Lock the fit first"); return; }
  recChunks = [];
  compositeTo(recCtx);
  recorder = pickRecorder();
  recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.start(200);
  btnRec.hidden = true; btnStop.hidden = false;
  btnStop.textContent = "Stop & save to Photos";
  setStatus("Recording…");
}

function makeFile() {
  const raw = recorder?.mimeType || recChunks[0]?.type || "video/mp4";
  const isMp4 = raw.includes("mp4");
  const type = isMp4 ? "video/mp4" : "video/webm";
  const ext  = isMp4 ? "mp4" : "webm";
  const blob = new Blob(recChunks, { type });
  return new File([blob], `masklab-${Date.now()}.${ext}`, { type });
}

function showSaveSheet(file) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastFile = file; lastUrl = URL.createObjectURL(file);
  saveVideo.src = lastUrl;
  saveSheet.hidden = false;
  setStatus("Save to Photos");
}

async function shareToPhotos(file) {
  if (!file) return false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "MASKLAB" });
      toast("Pick Save Video"); return true;
    }
    if (navigator.share) {
      await navigator.share({ files: [file], title: "MASKLAB" });
      toast("Pick Save Video"); return true;
    }
  } catch (err) { if (err && err.name === "AbortError") return true; }
  return false;
}

async function stopRec() {
  if (!recorder || recorder.state === "inactive") return;
  const done = new Promise(resolve => { recorder.addEventListener("stop", resolve, { once: true }); });
  recorder.stop();
  await done;
  btnRec.hidden = false; btnStop.hidden = true;
  const file = makeFile();
  showSaveSheet(file);
  await shareToPhotos(file);
}

btnSavePhotos.addEventListener("click", async () => { if (!lastFile) return; const ok = await shareToPhotos(lastFile); if (!ok) toast("Hold the video → Save Video"); });
btnSaveClose.addEventListener("click", () => { saveSheet.hidden = true; setStatus("Locked — Record when ready"); });

btnCam.addEventListener("click", startCamera);
btnAttach.addEventListener("click", attach);
btnLock.addEventListener("click", lockFit);
btnRec.addEventListener("click", startRec);
btnStop.addEventListener("click", stopRec);

photoInput.addEventListener("change", async () => {
  const file = photoInput.files?.[0];
  if (!file) return;
  try {
    setStatus("Cutting photo…");
    const decoded = await decodePhoto(file);
    photoSource = drawSource(decoded);
    if (decoded.close) decoded.close();
    rebuildCutout();
    persistPhoto();
    previewEl.hidden = false;
    previewLabel.textContent = "Cutout ready — Attach";
    btnAttach.disabled = false;
    attached = false; locked = false;
    btnLock.disabled = true; btnLock.textContent = "4. Lock"; btnRec.disabled = true;
    setStatus(face ? "Tap Attach" : "Look at camera, then Attach");
    toast("Saved locally — tap Attach");
  } catch (err) {
    console.error(err);
    toast("Could not read that photo — try a screenshot");
  }
});

cutoutInput.addEventListener("input", rebuildCutout);
renderLibrary();
loop();
setStatus("1 / 5 — Start camera");
