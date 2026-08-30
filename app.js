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

const KEYS = [10, 127, 234, 93, 132, 58, 172, 136, 150, 176, 152, 400, 377, 379, 365, 397, 288, 361, 323, 454, 356,
  168, 1, 4,
  33, 133, 159, 145,
  263, 362, 386, 374,
  61, 291, 13, 14, 17, 0];

const TRI = [
  [0, 1, 24], [0, 24, 26], [0, 26, 25], [0, 25, 21], [0, 21, 29], [0, 29, 30], [0, 30, 28], [0, 28, 20],
  [1, 2, 24], [20, 28, 19],
  [2, 3, 32], [19, 18, 33],
  [21, 25, 22], [21, 29, 22],
  [24, 26, 27], [25, 26, 27], [28, 30, 31], [29, 30, 31],
  [22, 25, 34], [22, 29, 34], [22, 34, 37],
  [32, 34, 37], [33, 34, 37], [32, 35, 36], [33, 35, 36], [32, 34, 35], [33, 34, 35],
  [32, 36, 8], [33, 36, 12], [8, 10, 36], [12, 10, 36],
  [2, 32, 5], [5, 32, 8], [5, 8, 10], [19, 33, 16], [16, 33, 12], [16, 12, 10],
  [1, 2, 5], [20, 19, 16], [5, 6, 10], [16, 15, 10],
];

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let face = null;
let blends = {};
let photoSource = null;
let cutout = null;
let attached = false;
let restUV = null;
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
  if (attached && face) captureRest(face);
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
  const width = Math.hypot(right.x - left.x, right.y - left.y) * 2.15;
  const height = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) * 1.48;
  let angle = Math.atan2(right.y - left.y, right.x - left.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return { cx: nose.x, cy: forehead.y * 0.28 + chin.y * 0.72, width, height, angle };
}

function keyPoints(landmarks) {
  return KEYS.map((i) => toCanvas(landmarks[i]));
}

function captureRest(landmarks) {
  const box = faceFit(landmarks);
  const pts = keyPoints(landmarks);
  const cos = Math.cos(-box.angle);
  const sin = Math.sin(-box.angle);
  restUV = pts.map((p) => {
    const lx = p.x - box.cx;
    const ly = p.y - box.cy;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    return {
      u: rx / box.width + 0.5,
      v: ry / box.height + 0.5,
    };
  });
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

function affineDraw(img, s0, s1, s2, d0, d1, d2) {
  const denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(denom) < 1e-4) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  const m11 = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
  const m12 = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
  const m13 = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denom;
  const m21 = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
  const m22 = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
  const m23 = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denom;
  ctx.setTransform(m11, m21, m12, m22, m13, m23);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function drawWarped() {
  const dest = keyPoints(face);
  const w = cutout.width;
  const h = cutout.height;
  const src = restUV.map((p) => ({ x: p.u * w, y: p.v * h }));
  ctx.imageSmoothingEnabled = true;
  for (const t of TRI) {
    if (t[0] >= dest.length || t[1] >= dest.length || t[2] >= dest.length) continue;
    affineDraw(cutout, src[t[0]], src[t[1]], src[t[2]], dest[t[0]], dest[t[1]], dest[t[2]]);
  }
}

function drawFallback() {
  const box = faceFit(face);
  const aspect = cutout.width / Math.max(cutout.height, 1);
  let dw = box.width;
  let dh = dw / aspect;
  if (dh < box.height) {
    dh = box.height;
    dw = dh * aspect;
  }
  const blink = Math.max(blends.eyeBlinkLeft || 0, blends.eyeBlinkRight || 0);
  const jaw = blends.jawOpen || 0;
  dh *= 1 + jaw * 0.22;
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.drawImage(cutout, -dw / 2, -dh / 2, dw, dh);
  if (blink > 0.35) {
    ctx.fillStyle = `rgba(20,10,10,${Math.min(0.85, blink)})`;
    const eyeY = -dh * 0.12;
    ctx.fillRect(-dw * 0.28, eyeY - 4, dw * 0.2, 8 + blink * 10);
    ctx.fillRect(dw * 0.08, eyeY - 4, dw * 0.2, 8 + blink * 10);
  }
  ctx.restore();
}

function drawMask() {
  if (!attached || !cutout || !face) return;
  if (restUV) drawWarped();
  else drawFallback();
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
  captureRest(face);
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
    restUV = null;
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
