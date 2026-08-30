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

function clearMask() {
  while (maskRoot.children.length) {
    const obj = maskRoot.children[0];
    obj.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) {
        const mats = Array.isArray(n.material) ? n.material : [n.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
    maskRoot.remove(obj);
  }
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
  clearMask();
  const mask = makeBuiltinMask();
  maskRoot.add(mask);
  maskRoot.visible = false;
  setStatus("Built-in mask ready");
}

function isImageFile(file) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/.test(name);
}

function loadPhotoMask(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.max(2, Math.round(img.width * scale));
      const h = Math.max(2, Math.round(img.height * scale));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const aspect = w / h;
      const height = 0.28;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(height * aspect, height, 12, 12),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          side: THREE.DoubleSide,
        })
      );
      mesh.position.z = 0.05;
      URL.revokeObjectURL(url);
      resolve(mesh);
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
    if (isImageFile(file)) {
      object = await loadPhotoMask(file);
    } else if (name.endsWith(".obj")) {
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
    clearMask();
    maskRoot.add(object);
    maskRoot.visible = false;
    setStatus("Mask loaded — look at camera");
    toast(isImageFile(file) ? "Photo locked to face" : "Mask fitted to face mesh");
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
  if (!mats?.length) {
    maskRoot.visible = false;
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
  loop();
}

function loop() {
  if (!running) return;
  const ts = performance.now();
  if (video.readyState >= 2 && landmarker && ts !== lastTs) {
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

useBuiltin();
setStatus("Tap Start camera");
