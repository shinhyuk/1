import { EyeTracker } from "./eye-tracker.js";

const video = document.getElementById("video");
const overlay = document.getElementById("overlay");
const startBtn = document.getElementById("startBtn");
const calibrateBtn = document.getElementById("calibrateBtn");
const stopBtn = document.getElementById("stopBtn");
const showOverlayChk = document.getElementById("showOverlay");
const statusEl = document.getElementById("status");
const gazeDot = document.getElementById("gazeDot");
const calibrationOverlay = document.getElementById("calibration");
const calibTarget = document.getElementById("calibTarget");
const calibText = document.getElementById("calibText");

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

tracker.addEventListener("gaze", (ev) => {
  const { landmarks, gaze } = ev.detail;
  drawLandmarks(landmarks);
  if (gaze.calibrated) {
    gazeDot.hidden = false;
    gazeDot.style.transform = `translate(${gaze.x}px, ${gaze.y}px)`;
  }
});

tracker.addEventListener("lost", () => {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
});

tracker.addEventListener("error", (ev) => {
  console.error(ev.detail);
  setStatus("오류: " + (ev.detail?.message ?? "알 수 없음"));
});

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  setStatus("모델 로딩 중...");
  try {
    await tracker.start(video);
    setStatus("추적 중. 캘리브레이션을 진행하세요.");
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("시작 실패: " + e.message);
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener("click", () => {
  tracker.stop();
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  gazeDot.hidden = true;
  setStatus("정지됨");
  startBtn.disabled = false;
  calibrateBtn.disabled = true;
  stopBtn.disabled = true;
});

calibrateBtn.addEventListener("click", async () => {
  calibrateBtn.disabled = true;
  stopBtn.disabled = true;
  gazeDot.hidden = true;

  const margin = 0.1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const points = [
    { x: W * margin, y: H * margin },
    { x: W * (1 - margin), y: H * margin },
    { x: W / 2, y: H / 2 },
    { x: W * margin, y: H * (1 - margin) },
    { x: W * (1 - margin), y: H * (1 - margin) },
  ];

  calibrationOverlay.hidden = false;

  try {
    await tracker.calibrate(
      points,
      async (p) => {
        calibTarget.classList.remove("sampling");
        calibTarget.style.left = p.x + "px";
        calibTarget.style.top = p.y + "px";
        calibText.textContent = "점을 응시하세요";
      },
      async () => {
        calibTarget.classList.add("sampling");
        calibText.textContent = "샘플링 중... 점을 계속 응시하세요";
      }
    );
    setStatus("캘리브레이션 완료");
  } catch (e) {
    setStatus("캘리브레이션 실패: " + e.message);
  } finally {
    calibrationOverlay.hidden = true;
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
  }
});

window.addEventListener("resize", () => {
  if (tracker.calibration) {
    tracker.calibration = null;
    setStatus("화면 크기 변경됨. 다시 캘리브레이션해 주세요.");
    gazeDot.hidden = true;
  }
});
