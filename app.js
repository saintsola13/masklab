const video = document.getElementById("cam");
const view = document.getElementById("view");
const recCanvas = document.getElementById("rec");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const btnCam = document.getElementById("btn-cam");
const btnAttach = document.getElementById("btn-attach");
const btnRec = document.getElementById("btn-rec");
const btnStop = document.getElementById("btn-stop");
const photoBtn = document.getElementById("photo-btn");
const photoInput = document.getElementById("file-photo");
const previewEl = document.getElementById("preview");
const previewImg = document.getElementById("preview-img");
const previewLabel = document.getElementById("preview-label");
const cutoutInput = document.getElementById("cutout");

const ctx = view.getContext("2d");
const recCtx = recCanvas.getContext("2d");

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let face = null;
let blends = {};
let photoSource = null;
let cutout = null;
let attached = false;
let recorder = null;
let recChunks = [];

function setStatus(t) {
  statusEl.textContent = t;
}
function toast(t, ms = 1800) {
  toastEl.hidden = false;
  toastEl.textContent = t;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function sizeCanvases() {
  const w = Math.round(window.innerWidth * Math.min(devicePixelRatio, 2));
  const h = Math.round(window.innerHeight * Math.min(devicePixelRatio, 2));
  if (view.width !== w || view.height !== h) {
    view.width = w;
    view.height = h;
    recCanvas.width = w;
    recCanvas.height = h;
  }
}
window.addEventListener("resize", sizeCanvases);
sizeCanvases();

function unlockPhotos() {
  photoBtn.classList.remove("locked");
  photoInput.disabled = false;
}

function coverRect() {
  const cw = view.width;
  const ch = view.height;
  const vw = video.videoWidth || cw;
  const vh = video.videoHeight || ch;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { cw, ch, dw, dh, ox: (cw - dw) / 2, oy: (ch - dh) / 2 };
}

function toCanvas(p) {
  const { dw, dh, ox, oy } = coverRect();
  return { x: ox + (1 - p.x) * dw, y: oy + p.y * dh };
}

function sampleBg(data, w, h) {
  const pts = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  let r = 0, g = 0, b = 0;
  for (const i of pts) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / pts.length, g / pts.length, b / pts.length];
}

function floodCutout(src, threshold) {
  const w = src.width;
  const h = src.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.drawImage(src, 0, 0);
  const img = c.getImageData(0, 0, w, h);
  const data = img.data;
  const [br, bg, bb] = sampleBg(data, w, h);
  const limit = threshold * threshold * 3;
  const close = (i) => {
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= limit;
  };
  const seen = new Uint8Array(w * h);
  const stack = [0, w - 1, (h - 1) * w, h * w - 1];
  while (stack.length) {
    const p = stack.pop();
    if (p < 0 || p >= w * h || seen[p]) continue;
    seen[p] = 1;
    if (!close(p * 4)) continue;
    data[p * 4 + 3] = 0;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }
  c.putImageData(img, 0, 0);
  return cropAlpha(canvas);
}

function cropAlpha(src) {
  const w = src.width;
  const h = src.height;
  const c = src.getContext("2d", { willReadFrequently: true });
  const { data } = c.getImageData(0, 0, w, h);
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return src;
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function rebuildCutout() {
  if (!photoSource) return;
  cutout = floodCutout(photoSource, Number(cutoutInput.value));
  previewImg.src = cutout.toDataURL("image/png");
}

function drawSource(imgLike) {
  const width = imgLike.width || 2;
  const height = imgLike.height || 2;
  const scale = Math.min(1, 720 / Math.max(width, height));
  const src = document.createElement("canvas");
  src.width = Math.max(2, Math.round(width * scale));
  src.height = Math.max(2, Math.round(height * scale));
  src.getContext("2d").drawImage(imgLike, 0, 0, src.width, src.height);
  return src;
}

async function decodePhoto(file) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch (_) {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function faceFit(landmarks) {
  const forehead = toCanvas(landmarks[10]);
  const chin = toCanvas(landmarks[152]);
  const a = toCanvas(landmarks[234]);
  const b = toCanvas(landmarks[454]);
  const nose = toCanvas(landmarks[1]);
  const left = a.x < b.x ? a : b;
  const right = a.x < b.x ? b : a;
  const width = Math.hypot(right.x - left.x, right.y - left.y) * 2.2;
  const height = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) * 1.55;
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return {
    cx: nose.x,
    cy: forehead.y * 0.32 + chin.y * 0.68,
    width,
    height,
    angle,
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
  const box = faceFit(face);
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 3;
  ctx.strokeRect(-box.width / 2, -box.height / 2, box.width, box.height);
  ctx.restore();
}

function drawBand(img, dx, dy, dw, dh, sy0, sy1, destY, destH) {
  const sh = img.height;
  const srcY = sy0 * sh;
  const srcH = Math.max(1, (sy1 - sy0) * sh);
  ctx.drawImage(img, 0, srcY, img.width, srcH, dx, destY, dw, destH);
}

function drawMask() {
  if (!attached || !cutout || !face) return;
  const box = faceFit(face);
  const aspect = cutout.width / Math.max(cutout.height, 1);
  let dw = box.width;
  let dh = dw / aspect;
  if (dh < box.height) {
    dh = box.height;
    dw = dh * aspect;
  }
  const jaw = Math.min(1, blends.jawOpen || 0);
  const blinkL = Math.min(1, blends.eyeBlinkLeft || 0);
  const blinkR = Math.min(1, blends.eyeBlinkRight || 0);
  const blink = Math.max(blinkL, blinkR);

  const dx = -dw / 2;
  const dy = -dh / 2;
  const eyeStart = 0.28;
  const eyeEnd = 0.48;
  const mouthStart = 0.58;

  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);

  const topH = dh * eyeStart;
  drawBand(cutout, dx, dy, dw, dh, 0, eyeStart, dy, topH);

  const eyeH = dh * (eyeEnd - eyeStart);
  const eyeSquash = 1 - blink * 0.78;
  const eyeDrawH = eyeH * eyeSquash;
  const eyeY = dy + topH + (eyeH - eyeDrawH) * 0.55;
  drawBand(cutout, dx, dy, dw, dh, eyeStart, eyeEnd, eyeY, eyeDrawH);

  const midH = dh * (mouthStart - eyeEnd);
  drawBand(cutout, dx, dy, dw, dh, eyeEnd, mouthStart, dy + topH + eyeH, midH);

  const mouthH = dh * (1 - mouthStart);
  const mouthStretch = 1 + jaw * 0.55;
  drawBand(cutout, dx, dy, dw, dh, mouthStart, 1, dy + topH + eyeH + midH, mouthH * mouthStretch);

  ctx.restore();
}

function compositeTo(target) {
  target.drawImage(view, 0, 0);
}

function readBlend(result) {
  blends = {};
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) return;
  for (const c of cats) blends[c.categoryName] = c.score;
}

async function initTracker() {
  setStatus("Loading face map…");
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
  const fileset = await mod.FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  });
}

async function startCamera() {
  if (running) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    setStatus("Allow camera access");
    toast("Camera permission blocked");
    return;
  }
  video.srcObject = stream;
  await video.play();
  if (!landmarker) await initTracker();
  running = true;
  btnCam.textContent = "Camera on";
  unlockPhotos();
  setStatus("Face mapping — look at camera, then pick a photo");
  toast("Face map on — pick a photo");
}

function attach() {
  if (!cutout) {
    toast("Pick a photo first");
    return;
  }
  if (!face) {
    toast("Look at the camera so the face map locks");
    return;
  }
  attached = true;
  btnRec.disabled = false;
  setStatus("Attached — move, talk, blink, then Record");
  toast("Mask attached");
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
      readBlend(result);
    }
    if (attached) drawMask();
    else if (face) drawMap();
    if (recorder && recorder.state === "recording") compositeTo(recCtx);
  }
  requestAnimationFrame(loop);
}

function pickRecorder() {
  const types = ["video/mp4", "video/webm;codecs=vp9", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const streamOut = recCanvas.captureStream(30);
  return mime ? new MediaRecorder(streamOut, { mimeType: mime }) : new MediaRecorder(streamOut);
}

function startRec() {
  if (!attached || !running) return;
  recChunks = [];
  compositeTo(recCtx);
  recorder = pickRecorder();
  recorder.ondataavailable = (e) => {
    if (e.data.size) recChunks.push(e.data);
  };
  recorder.onstop = saveRec;
  recorder.start();
  btnRec.hidden = true;
  btnStop.hidden = false;
  setStatus("Recording…");
}

function stopRec() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
  btnRec.hidden = false;
  btnStop.hidden = true;
}

function saveRec() {
  const type = recorder.mimeType || "video/webm";
  const blob = new Blob(recChunks, { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `masklab-${Date.now()}.${type.includes("mp4") ? "mp4" : "webm"}`;
  a.click();
  setStatus("Saved recording");
  toast("Video downloaded");
}

btnCam.addEventListener("click", startCamera);
btnAttach.addEventListener("click", attach);
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
    previewEl.hidden = false;
    previewLabel.textContent = "Cutout ready — Attach";
    btnAttach.disabled = false;
    attached = false;
    setStatus(face ? "Tap Attach" : "Look at camera, then Attach");
    toast("Photo cut out — tap Attach");
  } catch (err) {
    console.error(err);
    toast("Could not read that photo — try a screenshot");
  }
});
cutoutInput.addEventListener("input", rebuildCutout);

loop();
setStatus("1 / 5 — Start camera");
