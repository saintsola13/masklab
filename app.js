import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm";

const video = document.getElementById("cam");
const glCanvas = document.getElementById("gl");
const recCanvas = document.getElementById("rec");
const statusEl = document.getElementById("status");
const toastEl = document.getElementById("toast");
const btnCam = document.getElementById("btn-cam");
const btnDemo = document.getElementById("btn-demo");
const btnRec = document.getElementById("btn-rec");
const btnStop = document.getElementById("btn-stop");
const photoInput = document.getElementById("file-photo");
const meshInput = document.getElementById("file-3d");
const previewEl = document.getElementById("preview");
const previewImg = document.getElementById("preview-img");
const previewLabel = document.getElementById("preview-label");
const cutoutInput = document.getElementById("cutout");

const BLEND_MAP = {
  jawOpen: ["jawOpen", "mouthOpen", "MouthOpen"],
  eyeBlinkLeft: ["eyeBlinkLeft", "eyeBlink_L", "Blink_L"],
  eyeBlinkRight: ["eyeBlinkRight", "eyeBlink_R", "Blink_R"],
  mouthSmileLeft: ["mouthSmileLeft", "smileLeft"],
  mouthSmileRight: ["mouthSmileRight", "smileRight"],
  browInnerUp: ["browInnerUp", "browUp"],
};

let landmarker = null;
let stream = null;
let running = false;
let lastTs = -1;
let recorder = null;
let recChunks = [];
let previewUrl = null;
let photoSource = null;
let photoMesh = null;

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

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.1);
key.position.set(0.4, 1.2, 1.5);
scene.add(key);

const maskRoot = new THREE.Group();
scene.add(maskRoot);

const recCtx = recCanvas.getContext("2d");

function setStatus(t) {
  statusEl.textContent = t;
}
function toast(t, ms = 1800) {
  toastEl.hidden = false;
  toastEl.textContent = t;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function resize() {
  const w = stageW();
  const h = stageH();
  renderer.setSize(w, h, false);
  recCanvas.width = w;
  recCanvas.height = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function stageW() {
  return glCanvas.clientWidth || window.innerWidth;
}
function stageH() {
  return glCanvas.clientHeight || window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

function showIdlePose() {
  maskRoot.position.set(0, 0, 0);
  maskRoot.quaternion.identity();
  maskRoot.scale.setScalar(1);
  maskRoot.visible = true;
}

function setPreviewFromCanvas(canvas, label) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = canvas.toDataURL("image/png");
  previewImg.src = previewUrl;
  previewLabel.textContent = label || "Cutout ready";
  previewEl.hidden = false;
}

function hidePreview() {
  previewEl.hidden = true;
  previewImg.removeAttribute("src");
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
  const tallest = Math.max(size.y, 0.0001);
  const scale = 0.22 / tallest;
  object.scale.setScalar(scale);
}

function makeBuiltinMask() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd7c4a3,
    metalness: 0.15,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });
  const plate = new THREE.Mesh(new THREE.SphereGeometry(0.11, 32, 24, 0, Math.PI * 2, 0, Math.PI * 0.62), mat);
  plate.rotation.x = 0.15;
  plate.position.y = 0.01;
  g.add(plate);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.11, 0.008, 12, 40, Math.PI * 1.15),
    new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.6, roughness: 0.3 })
  );
  rim.rotation.x = Math.PI / 2.15;
  rim.position.y = 0.02;
  g.add(rim);

  const eyeGeo = new THREE.TorusGeometry(0.022, 0.006, 10, 24);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.4, roughness: 0.35 });
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
  const eyeR = eyeL.clone();
  eyeL.position.set(-0.035, 0.03, 0.09);
  eyeR.position.set(0.035, 0.03, 0.09);
  g.add(eyeL, eyeR);

  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(0.028, 0.004, 8, 20, Math.PI),
    eyeMat
  );
  mouth.rotation.x = Math.PI;
  mouth.position.set(0, -0.03, 0.09);
  g.add(mouth);

  g.userData.mouth = mouth;
  g.userData.eyeL = eyeL;
  g.userData.eyeR = eyeR;
  return g;
}

function useBuiltin() {
  photoSource = null;
  clearMask();
  hidePreview();
  const mask = makeBuiltinMask();
  maskRoot.add(mask);
  showIdlePose();
  setStatus("Built-in mask ready — start camera to lock it");
}

function isImageFile(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/.test(name);
}

function sampleBg(data, w, h) {
  const pts = [
    0,
    (w - 1) * 4,
    (h - 1) * w * 4,
    ((h - 1) * w + (w - 1)) * 4,
    (Math.floor(h / 2) * w) * 4,
    (Math.floor(h / 2) * w + (w - 1)) * 4,
    Math.floor(w / 2) * 4,
    ((h - 1) * w + Math.floor(w / 2)) * 4,
  ];
  let r = 0, g = 0, b = 0;
  for (const i of pts) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [r / pts.length, g / pts.length, b / pts.length];
}

function alreadyHasAlpha(data) {
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) transparent++;
  }
  return transparent / (data.length / 4) > 0.04;
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

  if (alreadyHasAlpha(data) && threshold < 8) {
    return canvas;
  }

  const [br, bg, bb] = sampleBg(data, w, h);
  const limit = threshold * threshold * 3;
  const close = (i) => {
    const dr = data[i] - br;
    const dg = data[i + 1] - bg;
    const db = data[i + 2] - bb;
    return dr * dr + dg * dg + db * db <= limit;
  };

  const seen = new Uint8Array(w * h);
  const stack = [];
  const seeds = [
    0, w - 1,
    (h - 1) * w, h * w - 1,
    Math.floor(w / 2),
    (h - 1) * w + Math.floor(w / 2),
    Math.floor(h / 2) * w,
    Math.floor(h / 2) * w + (w - 1),
  ];
  for (const s of seeds) {
    if (close(s * 4)) stack.push(s);
  }

  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!close(i)) continue;
    data[i + 3] = 0;
    const x = p % w;
    const y = (p / w) | 0;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (y > 0) stack.push(p - w);
    if (y < h - 1) stack.push(p + w);
  }

  // Soften leftover near-bg pixels and feather edges
  const copy = new Uint8ClampedArray(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const i = p * 4;
      if (copy[i + 3] === 0) continue;
      if (close(i)) {
        let n = 0;
        if (copy[(p - 1) * 4 + 3] === 0) n++;
        if (copy[(p + 1) * 4 + 3] === 0) n++;
        if (copy[(p - w) * 4 + 3] === 0) n++;
        if (copy[(p + w) * 4 + 3] === 0) n++;
        if (n) data[i + 3] = Math.max(0, 255 - n * 90);
      }
    }
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
  const aspect = cut.width / cut.height;
  const height = 0.3;
  if (photoMesh) {
    photoMesh.geometry.dispose();
    photoMesh.geometry = new THREE.PlaneGeometry(height * aspect, height, 12, 12);
    if (photoMesh.material.map) photoMesh.material.map.dispose();
    photoMesh.material.map = tex;
    photoMesh.material.needsUpdate = true;
    return photoMesh;
  }
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * aspect, height, 12, 12),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  mesh.position.z = 0.05;
  photoMesh = mesh;
  return mesh;
}

function rebuildPhotoCutout() {
  if (!photoSource) return;
  const cut = floodCutout(photoSource, Number(cutoutInput.value));
  applyPhotoTexture(cut);
  setPreviewFromCanvas(cut, "White bg removed");
}

function loadPhotoMask(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 900;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(2, Math.round(img.width * scale));
      const h = Math.max(2, Math.round(img.height * scale));
      const src = document.createElement("canvas");
      src.width = w;
      src.height = h;
      src.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      photoSource = src;
      const cut = floodCutout(src, Number(cutoutInput.value));
      const mesh = applyPhotoTexture(cut);
      resolve({ mesh, previewCanvas: cut });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load failed"));
    };
    img.src = url;
  });
}

async function loadUserMesh(file) {
  const url = URL.createObjectURL(file);
  const name = (file.name || "").toLowerCase();
  try {
    let object;
    let previewCanvas = null;
    if (isImageFile(file)) {
      const loaded = await loadPhotoMask(file);
      object = loaded.mesh;
      previewCanvas = loaded.previewCanvas;
    } else {
      photoSource = null;
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
        fitObjectToFace(object);
      } else {
        const gltf = await new GLTFLoader().loadAsync(url);
        object = gltf.scene;
        fitObjectToFace(object);
      }
    }
    if (!photoMesh || object !== photoMesh) {
      clearMask();
      maskRoot.add(object);
    } else if (!maskRoot.children.includes(object)) {
      clearMask();
      maskRoot.add(object);
    }
    showIdlePose();
    if (previewCanvas) {
      setPreviewFromCanvas(previewCanvas, file.name || "Cutout ready");
      toast("Background punched out — drag Cutout if needed");
    } else {
      hidePreview();
      toast("Mask fitted");
    }
    setStatus(running ? "Mask on face — look at camera" : "Cutout ready — start camera to lock it");
  } catch (err) {
    console.error(err);
    toast("Could not load that file");
    setStatus("Load failed");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function onPicked(input) {
  const f = input.files?.[0];
  if (f) loadUserMesh(f);
  input.value = "";
}

function morphTargets(root) {
  const found = [];
  root.traverse((n) => {
    if (n.morphTargetDictionary && n.morphTargetInfluences) found.push(n);
  });
  return found;
}

function applyBlendshapes(result) {
  const cats = result.faceBlendshapes?.[0]?.categories;
  if (!cats) return;
  const scores = {};
  for (const c of cats) scores[c.categoryName] = c.score;

  const meshes = morphTargets(maskRoot);
  if (meshes.length) {
    for (const mesh of meshes) {
      const dict = mesh.morphTargetDictionary;
      const inf = mesh.morphTargetInfluences;
      for (const [src, aliases] of Object.entries(BLEND_MAP)) {
        const score = scores[src] || 0;
        for (const alias of aliases) {
          if (alias in dict) inf[dict[alias]] = score;
        }
      }
    }
    return;
  }

  const mask = maskRoot.children[0];
  if (!mask?.userData?.mouth) return;
  const open = scores.jawOpen || 0;
  const blinkL = scores.eyeBlinkLeft || 0;
  const blinkR = scores.eyeBlinkRight || 0;
  mask.userData.mouth.scale.y = 1 + open * 1.8;
  mask.userData.eyeL.scale.y = 1 - blinkL * 0.85;
  mask.userData.eyeR.scale.y = 1 - blinkR * 0.85;
}

function applyPose(result) {
  const mats = result.facialTransformationMatrixes;
  if (!mats?.length) return;
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
}

async function initLandmarker() {
  setStatus("Loading face tracker…");
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  landmarker = await FaceLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
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
    setStatus("Camera permission blocked");
    toast("Allow camera access and try again");
    return;
  }
  video.srcObject = stream;
  await video.play();
  if (!landmarker) await initLandmarker();
  running = true;
  btnCam.textContent = "Camera on";
  btnRec.disabled = false;
  setStatus("Tracking face");
}

function loop() {
  const ts = performance.now();
  if (running && video.readyState >= 2 && landmarker && ts !== lastTs) {
    lastTs = ts;
    const result = landmarker.detectForVideo(video, ts);
    applyPose(result);
    applyBlendshapes(result);
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
  if (!running) return;
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
btnDemo.addEventListener("click", useBuiltin);
btnRec.addEventListener("click", startRec);
btnStop.addEventListener("click", stopRec);
photoInput.addEventListener("change", () => onPicked(photoInput));
meshInput.addEventListener("change", () => onPicked(meshInput));
cutoutInput.addEventListener("input", rebuildPhotoCutout);

useBuiltin();
loop();
setStatus("Tap Start camera or pick a photo");
