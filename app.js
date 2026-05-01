import { EyeTracker } from "./eye-tracker.js?v=9";

const debugLogEl = document.getElementById("debugLog");
const debugLogLines = [];
function dbg(msg) {
  const t = new Date().toISOString().slice(11, 19);
  debugLogLines.push(`[${t}] ${msg}`);
  if (debugLogLines.length > 40) debugLogLines.shift();
  if (debugLogEl) debugLogEl.textContent = debugLogLines.join("\n");
  console.log(msg);
}
dbg(`boot v8 — ${navigator.userAgent.slice(0, 60)}`);
dbg(`viewport ${window.innerWidth}x${window.innerHeight} secure=${window.isSecureContext}`);

window.addEventListener("pageshow", (ev) => {
  dbg(`pageshow persisted=${ev.persisted}`);
  if (ev.persisted) location.reload();
});

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const calibrateBtn = document.getElementById("calibrateBtn");
const stopBtn = document.getElementById("stopBtn");
const showOverlayChk = document.getElementById("showOverlay");
const statusEl = document.getElementById("status");
const gazeDot = document.getElementById("gazeDot");
const calibrationOverlay = document.getElementById("calibration");
const calibTarget = document.getElementById("calibTarget");
const calibText = document.getElementById("calibText");
const calibCancel = document.getElementById("calibCancel");

function moveTarget(x, y) {
  calibTarget.style.transform = `translate(${x}px, ${y}px)`;
}
const permGate = document.getElementById("permGate");
const permBtn = document.getElementById("permBtn");
const permStatus = document.getElementById("permStatus");
const permHelp = document.getElementById("permHelp");

const tracker = new EyeTracker({ smoothing: 0.78 });
const ctx = overlay.getContext("2d");

function setStatus(msg) {
  statusEl.textContent = msg;
}

function syncOverlaySize() {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  overlay.width = w;
  overlay.height = h;
}

function drawLandmarks(landmarks) {
  if (!showOverlayChk.checked) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    return;
  }
  syncOverlaySize();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const w = overlay.width;
  const h = overlay.height;
  const eyeIdx = [
    33, 133, 159, 145, 362, 263, 386, 374,
    469, 470, 471, 472, 474, 475, 476, 477,
  ];
  ctx.fillStyle = "#4ea1ff";
  for (const i of eyeIdx) {
    const p = landmarks[i];
    if (!p) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

let gazeFrameCount = 0;
tracker.addEventListener("gaze", (ev) => {
  const { landmarks, gaze } = ev.detail;
  drawLandmarks(landmarks);
  if (gaze.calibrated) {
    gazeDot.hidden = false;
    gazeDot.style.transform = `translate(${gaze.x}px, ${gaze.y}px)`;
  }
  gazeFrameCount++;
  if (gazeFrameCount === 1 || gazeFrameCount % 60 === 0) {
    dbg(`gaze frames=${gazeFrameCount}`);
  }
});

tracker.addEventListener("lost", () => {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
});

tracker.addEventListener("error", (ev) => {
  console.error(ev.detail);
  setStatus("오류: " + (ev.detail?.message ?? "알 수 없음"));
});

function setPermStatus(msg, isError = false) {
  permStatus.textContent = msg;
  permStatus.classList.toggle("error", isError);
}

permBtn.addEventListener("click", async () => {
  dbg("permBtn click");
  permBtn.disabled = true;
  permHelp.hidden = true;
  setPermStatus("준비 중...");

  if (!window.isSecureContext) {
    setPermStatus("HTTPS 필요. 현재 페이지가 보안 컨텍스트가 아닙니다.", true);
    permBtn.disabled = false;
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setPermStatus("이 브라우저는 카메라 API를 지원하지 않습니다.", true);
    permHelp.hidden = false;
    permBtn.disabled = false;
    return;
  }

  try {
    await tracker.start(video, (msg) => { dbg("start: " + msg); setPermStatus(msg); });
    dbg("tracker started");
    permGate.hidden = true;
    setStatus("추적 중. 캘리브레이션을 진행하세요.");
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
  } catch (e) {
    console.error(e);
    const name = e?.name ?? "Error";
    const msg = e?.message ?? String(e);
    let hint = "";
    if (name === "NotAllowedError") hint = "카메라 권한이 거부되었습니다.";
    else if (name === "NotFoundError") hint = "카메라 장치를 찾을 수 없습니다.";
    else if (name === "NotReadableError") hint = "다른 앱이 카메라를 사용 중입니다.";
    else if (name === "OverconstrainedError") hint = "카메라 설정 호환 안 됨.";
    else if (msg.includes("getUserMedia")) hint = "HTTPS 또는 권한 문제.";
    else hint = `${name}: ${msg}`;
    setPermStatus(hint, true);
    permHelp.hidden = false;
    permBtn.disabled = false;
    permBtn.textContent = "다시 시도";
  }
});

stopBtn.addEventListener("click", () => {
  tracker.stop();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  gazeDot.hidden = true;
  setStatus("정지됨. 다시 시작하려면 새로고침하세요.");
  calibrateBtn.disabled = true;
  stopBtn.disabled = true;
});

let calibState = null;

calibrateBtn.addEventListener("click", async () => {
  dbg("calibrateBtn click");
  calibrateBtn.disabled = true;
  stopBtn.disabled = true;
  gazeDot.hidden = true;

  if (!tracker.lastLandmarks) {
    dbg("no face — abort");
    setStatus("얼굴이 검출되지 않습니다. 카메라에 얼굴이 보이는지 확인하세요.");
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
    return;
  }

  const margin = 0.12;
  const W = window.innerWidth;
  const H = window.innerHeight;
  dbg(`viewport at calib ${W}x${H}`);
  const points = [
    { x: W * margin, y: H * margin },
    { x: W * (1 - margin), y: H * margin },
    { x: W / 2, y: H / 2 },
    { x: W * margin, y: H * (1 - margin) },
    { x: W * (1 - margin), y: H * (1 - margin) },
  ];
  dbg(`points[0]=(${points[0].x.toFixed(0)},${points[0].y.toFixed(0)})`);

  calibState = { points, index: 0, dataset: [], busy: false };
  try {
    showCalibStep();
    dbg("showCalibStep done");
  } catch (e) {
    dbg("showCalibStep ERR " + (e?.message ?? e));
  }
  calibrationOverlay.hidden = false;
  dbg("overlay shown");
});

function showCalibStep() {
  if (!calibState) return;
  const { points, index } = calibState;
  const p = points[index];
  if (!p) {
    dbg(`step ${index}: point is missing (points.length=${points.length})`);
    return;
  }
  calibTarget.classList.remove("sampling");
  moveTarget(p.x, p.y);
  calibText.textContent = `${index + 1} / ${points.length} — 점을 응시 후 화면 탭`;
  dbg(`step ${index + 1}/${points.length} at (${p.x.toFixed(0)},${p.y.toFixed(0)})`);
}

calibrationOverlay.addEventListener("click", async (ev) => {
  dbg(`overlay click target=${ev.target.id || ev.target.tagName}`);
  if (ev.target === calibCancel) return;
  if (!calibState) { dbg("no calibState"); return; }
  if (calibState.busy) { dbg("busy, ignored"); return; }
  calibState.busy = true;
  const { points, index } = calibState;
  const p = points[index];
  calibTarget.classList.add("sampling");
  calibText.textContent = `${index + 1} / ${points.length} — 샘플링 중...`;
  try {
    const sample = await tracker.sampleAt(p);
    calibState.dataset.push(sample);
    if (index + 1 < points.length) {
      calibState.index += 1;
      calibState.busy = false;
      showCalibStep();
      return;
    }
    tracker.fitFromSamples(calibState.dataset);
    setStatus("캘리브레이션 완료");
    dbg("calibration complete");
  } catch (e) {
    console.error(e);
    dbg("calibration ERR " + (e?.message ?? e));
    setStatus("캘리브레이션 실패: " + (e?.message ?? e));
  }
  calibrationOverlay.hidden = true;
  calibrateBtn.disabled = false;
  stopBtn.disabled = false;
  calibState = null;
});

calibCancel.addEventListener("click", (ev) => {
  ev.stopPropagation();
  calibrationOverlay.hidden = true;
  calibrateBtn.disabled = false;
  stopBtn.disabled = false;
  calibState = null;
  setStatus("캘리브레이션 취소됨");
});

window.addEventListener("error", (ev) => {
  setStatus("JS 오류: " + (ev.error?.message ?? ev.message));
});
window.addEventListener("unhandledrejection", (ev) => {
  setStatus("Promise 오류: " + (ev.reason?.message ?? ev.reason));
});

window.addEventListener("resize", () => {
  if (tracker.calibration) {
    tracker.calibration = null;
    setStatus("화면 크기 변경됨. 다시 캘리브레이션해 주세요.");
    gazeDot.hidden = true;
  }
});
