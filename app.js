import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

const video = document.getElementById("cam");
const glCanvas = document.getElementById("gl");
const recCanvas = document.getElementById("rec");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const btnCam = document.getElementById("btn-cam");
const btnRec = document.getElementById("btn-rec");
const btnStop = document.getElementById("btn-stop");
const photoBtn = document.getElementById("photo-btn");
const photoInput = document.getElementById("file-photo");
const meshInput = document.getElementById("file-3d");
const previewEl = document.getElementById("preview");
const previewImg = document.getElementById("preview-img");
const previewLabel = document.getElementById("preview-label");
const cutoutInput = document.getElementById("cutout");

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let recorder = null;
let recChunks = [];
let photoSource = null;
let photoMesh = null;
let hasMask = false;

const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  alpha: true,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
camera.position.set(0, 0, 1);
scene.add(new THREE.AmbientLight(0xffffff, 0.8));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(0.4, 1.2, 1.5);
scene.add(key);
const maskRoot = new THREE.Group();
maskRoot.visible = false;
scene.add(maskRoot);
const recCtx = recCanvas.getContext("2d");

function setStatus(t) {
  statusEl.textContent = t;
}
function toast(t, ms = 2000) {
  toastEl.hidden = false;
  toastEl.textContent = t;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}
function resize() {
  const w = glCanvas.clientWidth || window.innerWidth;
  const h = glCanvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  recCanvas.width = w;
  recCanvas.height = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function unlockPhotos() {
  photoBtn.classList.remove("locked");
  photoInput.disabled = false;
}
function unlockRecord() {
  if (running && hasMask) btnRec.disabled = false;
}

function clearMask() {
  while (maskRoot.children.length) {
    const obj = maskRoot.children[0];
    obj.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => {
          if (m.map) m.map.dispose?.();
          m.dispose?.();
        });
      }
    });
    maskRoot.remove(obj);
  }
  photoMesh = null;
}

function fitObjectToFace(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  object.scale.setScalar(0.22 / Math.max(size.y, 0.0001));
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
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
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
  ctx.putImageData(img, 0, 0);
  return cropAlpha(canvas);
}

function cropAlpha(src) {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
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

function applyPhotoTexture(cut) {
  const tex = new THREE.CanvasTexture(cut);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const aspect = cut.width / Math.max(cut.height, 1);
  const height = 0.28;
  if (photoMesh) {
    photoMesh.geometry.dispose();
    photoMesh.geometry = new THREE.PlaneGeometry(height * aspect, height, 8, 8);
    if (photoMesh.material.map) photoMesh.material.map.dispose();
    photoMesh.material.map = tex;
    photoMesh.material.needsUpdate = true;
    return photoMesh;
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * aspect, height, 8, 8),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.z = 0.06;
  photoMesh = mesh;
  return mesh;
}

function rebuildPhotoCutout() {
  if (!photoSource) return;
  const cut = floodCutout(photoSource, Number(cutoutInput.value));
  applyPhotoTexture(cut);
  previewImg.src = cut.toDataURL("image/png");
}

function drawSource(imgLike) {
  const width = imgLike.width || 2;
  const height = imgLike.height || 2;
  const scale = Math.min(1, 720 / Math.max(width, height));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  src.getContext("2d").drawImage(imgLike, 0, 0, w, h);
  return src;
}

async function decodePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    if (typeof createImageBitmap === "function") {
      try {
        return await createImageBitmap(file);
      } catch (_) {}
    }
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

async function loadPhotoFile(file) {
  setStatus("Cutting photo out…");
  toast("Cutting background");
  const decoded = await decodePhoto(file);
  const src = drawSource(decoded);
  if (decoded.close) decoded.close();
  photoSource = src;
  const cut = floodCutout(src, Number(cutoutInput.value));
  const mesh = applyPhotoTexture(cut);
  if (!maskRoot.children.includes(mesh)) {
    clearMask();
    photoMesh = mesh;
    maskRoot.add(mesh);
  }
  hasMask = true;
  previewImg.src = cut.toDataURL("image/png");
  previewLabel.textContent = "Cutout on face";
  previewEl.hidden = false;
  unlockRecord();
  setStatus(running ? "Look at camera — mask attaching" : "Start camera to attach");
  toast("Mask ready — look at the camera");
}

async function loadModelFile(file) {
  const url = URL.createObjectURL(file);
  const name = (file.name || "").toLowerCase();
  try {
    photoSource = null;
    let object;
    if (name.endsWith(".obj")) {
      object = await new OBJLoader().loadAsync(url);
      object.traverse((n) => {
        if (n.isMesh) {
          n.material = new THREE.MeshStandardMaterial({
            color: 0xc9b79a,
            metalness: 0.2,
            roughness: 0.5,
            side: THREE.DoubleSide,
          });
        }
      });
    } else {
      object = (await new GLTFLoader().loadAsync(url)).scene;
    }
    fitObjectToFace(object);
    clearMask();
    maskRoot.add(object);
    hasMask = true;
    previewEl.hidden = true;
    unlockRecord();
    setStatus("Look at camera — mask attaching");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function applyPose(result) {
  const mats = result.facialTransformationMatrixes;
  if (!mats?.length || !hasMask) {
    if (hasMask) setStatus("No face — look at camera");
    return;
  }
  const m = new THREE.Matrix4().fromArray(mats[0].data);
  const s = new THREE.Vector3();
  const r = new THREE.Quaternion();
  const t = new THREE.Vector3();
  m.decompose(t, r, s);
  t.x *= -1;
  r.y *= -1;
  r.z *= -1;
  maskRoot.position.copy(t).multiplyScalar(0.55);
  maskRoot.quaternion.copy(r);
  maskRoot.scale.setScalar(0.55);
  maskRoot.visible = true;
  setStatus("Mask locked — Record when ready");
}

async function initLandmarker() {
  setStatus("Loading face tracker…");
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
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: true,
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
    setStatus("Camera blocked — allow access");
    toast("Allow camera and try again");
    return;
  }
  video.srcObject = stream;
  await video.play();
  if (!landmarker) await initLandmarker();
  running = true;
  btnCam.textContent = "Camera on";
  unlockPhotos();
  unlockRecord();
  setStatus(hasMask ? "Look at camera — mask attaching" : "2 / 4 — Pick a photo");
  toast("Camera on — pick a photo");
}

function loop() {
  const ts = performance.now();
  if (running && video.readyState >= 2 && landmarker && ts !== lastTs) {
    lastTs = ts;
    applyPose(landmarker.detectForVideo(video, ts));
  }
  renderer.render(scene, camera);
  if (recorder && recorder.state === "recording") compositeFrame();
  requestAnimationFrame(loop);
}

function compositeFrame() {
  const w = recCanvas.width;
  const h = recCanvas.height;
  recCtx.save();
  recCtx.translate(w, 0);
  recCtx.scale(-1, 1);
  recCtx.drawImage(video, 0, 0, w, h);
  recCtx.restore();
  recCtx.drawImage(glCanvas, 0, 0, w, h);
}

function startRec() {
  if (!running || !hasMask) return;
  recChunks = [];
  compositeFrame();
  const out = recCanvas.captureStream(30);
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : MediaRecorder.isTypeSupported("video/webm")
    ? "video/webm"
    : "";
  recorder = mime ? new MediaRecorder(out, { mimeType: mime }) : new MediaRecorder(out);
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
  const blob = new Blob(recChunks, { type: recorder.mimeType || "video/webm" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `masklab-${Date.now()}.webm`;
  a.click();
  setStatus("Saved recording");
  toast("Video downloaded");
}

btnCam.addEventListener("click", startCamera);
btnRec.addEventListener("click", startRec);
btnStop.addEventListener("click", stopRec);
photoInput.addEventListener("change", async () => {
  const f = photoInput.files?.[0];
  if (!f) return;
  try {
    await loadPhotoFile(f);
  } catch (err) {
    console.error(err);
    toast("Could not read that photo — try a screenshot");
  }
});
meshInput.addEventListener("change", async () => {
  const f = meshInput.files?.[0];
  if (!f) return;
  try {
    await loadModelFile(f);
  } catch (err) {
    toast("Could not load that 3D file");
  }
});
cutoutInput.addEventListener("input", rebuildPhotoCutout);

loop();
setStatus("1 / 4 — Start camera");
