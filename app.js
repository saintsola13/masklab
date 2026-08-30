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

// ── Blendshape helper ─────────────────────────────────────────────────────────
function getBlend(name) {
  if (!blendshapes) return 0;
  const cat = blendshapes.find(c => c.categoryName === name);
  return cat ? cat.score : 0;
}

// ── Animated mask draw ────────────────────────────────────────────────────────
// Strategy: draw the full mask onto an offscreen canvas at natural size,
// then warp it onto screen using drawImage with per-row slice scaling.
// Eyes: compress rows in eye band vertically (blink)
// Mouth: expand rows in mouth band vertically (jaw open)
// No clipping, no region splits — just slice-based vertical warp.

// Landmark indices
const L_EYE_TOP = 386, L_EYE_BOT = 374;  // left eye vertical span
const R_EYE_TOP = 159, R_EYE_BOT = 145;  // right eye vertical span
const L_EYE_CX  = 468;                    // left eye center (with iris)
const R_EYE_CX  = 473;                    // right eye center (with iris)
const MOUTH_TOP = 13,  MOUTH_BOT = 14;   // inner lips top/bottom

function lmY(idx) {
  if (!face || !face[idx]) return null;
  const { dh, oy } = coverRect();
  return oy + face[idx].y * dh;
}
function lmX(idx) {
  if (!face || !face[idx]) return null;
  const { dw, ox } = coverRect();
  return ox + (1 - face[idx].x) * dw;
}

// Build a warped version of the cutout image using horizontal slice rendering.
// Each "band" between control points can be stretched or squished.
function buildWarpedMask(box) {
  const W = cutout.width;
  const H = cutout.height;

  // Map screen Y positions of key landmarks into cutout UV space
  const maskTop = box.cy - box.dh / 2;
  const maskBot = box.cy + box.dh / 2;
  const maskH   = box.dh;

  function screenToU(screenY) {
    return (screenY - maskTop) / maskH; // 0..1 in mask space
  }

  // Get screen Y for landmarks
  const rEyeTopY = lmY(R_EYE_TOP);
  const rEyeBotY = lmY(R_EYE_BOT);
  const lEyeTopY = lmY(L_EYE_TOP);
  const lEyeBotY = lmY(L_EYE_BOT);
  const mouthTopY = lmY(MOUTH_TOP);
  const mouthBotY = lmY(MOUTH_BOT);

  if (!rEyeTopY || !lEyeTopY || !mouthTopY) return cutout;

  // Use the higher (lower Y value) eye top and lower eye bottom across both eyes
  const eyeTopY = Math.min(rEyeTopY, lEyeTopY) - (rEyeBotY - rEyeTopY) * 0.4;
  const eyeBotY = Math.max(rEyeBotY, lEyeBotY) + (rEyeBotY - rEyeTopY) * 0.4;
  const mTopY   = mouthTopY - (mouthBotY - mouthTopY) * 0.5;
  const mBotY   = mouthBotY + (mouthBotY - mouthTopY) * 0.8;

  const blinkL = Math.min(1, getBlend("eyeBlinkLeft")  * 1.5);
  const blinkR = Math.min(1, getBlend("eyeBlinkRight") * 1.5);
  const blink  = Math.max(blinkL, blinkR); // drive both eyes together for cleanliness
  const jaw    = Math.min(1, getBlend("jawOpen") * 1.8);

  // If nothing is happening, skip warp
  if (blink < 0.04 && jaw < 0.04) return cutout;

  // Build warped offscreen canvas same size as cutout
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const oc = out.getContext("2d");

  // UV positions of control points in cutout
  const eyeTopU  = Math.max(0.05, screenToU(eyeTopY));
  const eyeBotU  = Math.min(0.95, screenToU(eyeBotY));
  const mTopU    = Math.max(0.05, screenToU(mTopY));
  const mBotU    = Math.min(0.95, screenToU(mBotY));

  // Eye band height in cutout pixels
  const eyeTopPx = eyeTopU * H;
  const eyeBotPx = eyeBotU * H;
  const eyeBandH = eyeBotPx - eyeTopPx;

  // Mouth band height in cutout pixels
  const mTopPx   = mTopU * H;
  const mBotPx   = mBotU * H;
  const mBandH   = mBotPx - mTopPx;

  // Squish factor for eyes (blink=1 → height near 0)
  const eyeSquish = 1 - blink * 0.92;
  // Stretch factor for mouth (jaw=1 → 60% taller)
  const mStretch  = 1 + jaw * 0.6;

  // We'll render 5 bands: top, eye, mid, mouth, bottom
  // Each band maps src rows → dst rows with possible scale

  const bands = [
    { sy: 0,        sh: eyeTopPx,           dy: 0,        dh: eyeTopPx },
    { sy: eyeTopPx, sh: eyeBandH,           dy: eyeTopPx, dh: eyeBandH * eyeSquish },
    { sy: eyeBotPx, sh: mTopPx - eyeBotPx,  dy: eyeTopPx + eyeBandH * eyeSquish, dh: mTopPx - eyeBotPx },
    { sy: mTopPx,   sh: mBandH,             dy: 0, dh: mBandH * mStretch }, // dy set below
    { sy: mBotPx,   sh: H - mBotPx,         dy: 0, dh: H - mBotPx },        // dy set below
  ];

  // Fix dy for bands after the eye squish shift
  const eyeShift = eyeBandH * eyeSquish - eyeBandH; // negative (squished)
  bands[2].dy = eyeBotPx + eyeShift;
  bands[3].dy = bands[2].dy + bands[2].dh;
  bands[4].dy = bands[3].dy + bands[3].dh;

  for (const b of bands) {
    if (b.sh <= 0 || b.dh <= 0) continue;
    oc.drawImage(cutout, 0, b.sy, W, b.sh, 0, b.dy, W, b.dh);
  }

  return out;
}

function drawMaskAnimated() {
  if (!attached || !cutout || !face) return;

  const box = maskRect(face);
  const mX = box.cx - box.dw / 2;
  const mY = box.cy - box.dh / 2;

  ctx.save();
  ctx.translate(box.cx, box.cy);
  ctx.rotate(box.angle);
  ctx.translate(-box.cx, -box.cy);

  const src = locked ? buildWarpedMask(box) : cutout;
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

function unlockPhotos() { photoBtn.classList.remove("locked"); photoInput.disabled = false; }

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
function rebuildCutout() { if (!photoSource) return; cutout=floodCutout(photoSource,Number(cutoutInput.value)); previewImg.src=cutout.toDataURL("image/png"); }
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
    stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user",width:{ideal:1280},height:{ideal:720}},audio:{echoCancellation:true,noiseSuppression:true}});
  } catch(err) {
    try { stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false}); toast("Mic blocked — video only"); }
    catch(err2) { setStatus("Allow camera access"); toast("Camera permission blocked"); return; }
  }
  video.srcObject=stream; await video.play();
  if (!landmarker) await initTracker();
  running=true; btnCam.textContent="Camera on"; unlockPhotos();
  setStatus("Face mapping — look at camera, then pick a photo");
  toast(stream.getAudioTracks().length?"Camera + mic on":"Camera on");
}

function attach() {
  if (!cutout) { toast("Pick a photo first"); return; }
  if (!face)   { toast("Look at the camera so the face map locks"); return; }
  attached=true; locked=false; btnLock.disabled=false; btnRec.disabled=true;
  setStatus("Slide / Size / Nudge, then Lock"); toast("Attached — line it up, then Lock");
}
function lockFit() {
  if (!attached) { toast("Attach first"); return; }
  locked=true; btnRec.disabled=false;
  btnLock.textContent="Locked ✦";
  setStatus("Locked — mouth + eyes animating. Record when ready");
  toast("Fit locked — animation on");
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
  const tracks=[...canvasStream.getVideoTracks()];
  if (stream) tracks.push(...stream.getAudioTracks());
  const mixed=new MediaStream(tracks);
  return mime?new MediaRecorder(mixed,{mimeType:mime}):new MediaRecorder(mixed);
}
function startRec() {
  if (!attached||!running||!locked) { toast("Lock the fit first"); return; }
  recChunks=[]; compositeTo(recCtx); recorder=pickRecorder();
  recorder.ondataavailable=e=>{ if(e.data&&e.data.size) recChunks.push(e.data); };
  recorder.start(200); btnRec.hidden=true; btnStop.hidden=false;
  btnStop.textContent="Stop & save to Photos"; setStatus("Recording…");
}
function makeFile() {
  const raw=recorder?.mimeType||recChunks[0]?.type||"video/mp4";
  const isMp4=raw.includes("mp4");
  const type=isMp4?"video/mp4":"video/webm"; const ext=isMp4?"mp4":"webm";
  const blob=new Blob(recChunks,{type});
  return new File([blob],`masklab-${Date.now()}.${ext}`,{type});
}
function showSaveSheet(file) {
  if (lastUrl) URL.revokeObjectURL(lastUrl);
  lastFile=file; lastUrl=URL.createObjectURL(file);
  saveVideo.src=lastUrl; saveSheet.hidden=false; setStatus("Save to Photos");
}
async function shareToPhotos(file) {
  if (!file) return false;
  try {
    if (navigator.canShare&&navigator.canShare({files:[file]})) { await navigator.share({files:[file],title:"MASKLAB"}); toast("Pick Save Video"); return true; }
    if (navigator.share) { await navigator.share({files:[file],title:"MASKLAB"}); toast("Pick Save Video"); return true; }
  } catch(err) { if(err&&err.name==="AbortError") return true; }
  return false;
}
async function stopRec() {
  if (!recorder||recorder.state==="inactive") return;
  const done=new Promise(resolve=>{ recorder.addEventListener("stop",resolve,{once:true}); });
  recorder.stop(); await done;
  btnRec.hidden=false; btnStop.hidden=true;
  const file=makeFile(); showSaveSheet(file); await shareToPhotos(file);
}

btnSavePhotos.addEventListener("click",async()=>{ if(!lastFile) return; const ok=await shareToPhotos(lastFile); if(!ok) toast("Hold the video → Save Video"); });
btnSaveClose.addEventListener("click",()=>{ saveSheet.hidden=true; setStatus("Locked — Record when ready"); });
btnCam.addEventListener("click",startCamera);
btnAttach.addEventListener("click",attach);
btnLock.addEventListener("click",lockFit);
btnRec.addEventListener("click",startRec);
btnStop.addEventListener("click",stopRec);
photoInput.addEventListener("change",async()=>{
  const file=photoInput.files?.[0]; if(!file) return;
  try {
    setStatus("Cutting photo…");
    const decoded=await decodePhoto(file); photoSource=drawSource(decoded);
    if(decoded.close) decoded.close();
    rebuildCutout(); persistPhoto();
    previewEl.hidden=false; previewLabel.textContent="Cutout ready — Attach";
    btnAttach.disabled=false; attached=false; locked=false;
    btnLock.disabled=true; btnLock.textContent="4. Lock"; btnRec.disabled=true;
    setStatus(face?"Tap Attach":"Look at camera, then Attach");
    toast("Saved locally — tap Attach");
  } catch(err) { console.error(err); toast("Could not read that photo — try a screenshot"); }
});
cutoutInput.addEventListener("input",rebuildCutout);
renderLibrary();
loop();
setStatus("1 / 5 — Start camera");
