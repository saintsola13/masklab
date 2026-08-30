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
let jaw = 0;
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
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
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

function pt(landmarks, i, w, h) {
  const p = landmarks[i];
  return { x: (1 - p.x) * w, y: p.y * h };
}

function faceBox(landmarks, w, h) {
  const forehead = pt(landmarks, 10, w, h);
  const chin = pt(landmarks, 152, w, h);
  const left = pt(landmarks, 234, w, h);
  const right = pt(landmarks, 454, w, h);
  const cx = (left.x + right.x) * 0.5;
  const cy = (forehead.y + chin.y) * 0.5;
  const width = Math.hypot(right.x - left.x, right.y - left.y) * 1.35;
  const height = Math.hypot(chin.x - forehead.x, chin.y - forehead.y) * 1.25;
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  return { cx, cy, width, height, angle };
}

function drawVideo() {
  const w = view.width;
  const h = view.height;
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawMap() {
  if (!face) return;
  const w = view.width;
  const h = view.height;
  ctx.fillStyle = "rgba(80,220,255,0.9)";
  for (let i = 0; i < face.length; i += 3) {
    const p = pt(face, i, w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  const box = faceBox(face, w, h);
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 3;
  ctx.strokeRect(-box.width / 2, -box.height / 2, box.width, box.height);
  ctx.restore();
}

function drawMask() {
  if (!attached || !cutout || !face) return;
  const w = view.width;
  const h = view.height;
  const box = faceBox(face, w, h);
  const talk = 1 + jaw * 0.18;
  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  const aspect = cutout.width / Math.max(cutout.height, 1);
  let mw = box.width;
  let mh = mw / aspect;
  if (mh < box.height) {
    mh = box.height * talk;
    mw = mh * aspect;
  } else {
    mh *= talk;
  }
  ctx.drawImage(cutout, -mw / 2, -mh / 2, mw, mh);
  ctx.restore();
}

function compositeTo(target) {
  target.drawImage(view, 0, 0);
}

function readBlend(result) {
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) {
    jaw = 0;
    return;
  }
  const hit = cats.find((c) => c.categoryName === "jawOpen");
  jaw = hit ? hit.score : 0;
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
  setStatus("Attached — move and talk, then Record");
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
  const types = [
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ];
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
    setStatus(face ? "3 / 5 — Tap Attach" : "Look at camera, then Attach");
    toast("Photo cut out — tap Attach");
  } catch (err) {
    console.error(err);
    toast("Could not read that photo — try a screenshot");
  }
});
cutoutInput.addEventListener("input", rebuildCutout);

loop();
setStatus("1 / 5 — Start camera");
