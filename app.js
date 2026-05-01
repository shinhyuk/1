import { EyeTracker } from "./eye-tracker.js?v=17";

window.addEventListener("pageshow", (ev) => {
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

let gazeDotInitialized = false;

tracker.addEventListener("gaze", (ev) => {
  const { landmarks, gaze } = ev.detail;
  drawLandmarks(landmarks);
  if (!gaze.calibrated || !calibrationOverlay.hidden) return;
  if (!gazeDotInitialized) {
    // Place the dot directly at the corrected gaze, suppressing the
    // CSS transition for one frame so it doesn't slide in from origin.
    gazeDot.style.transition = "none";
    gazeDot.style.transform = `translate(${gaze.x}px, ${gaze.y}px)`;
    gazeDot.hidden = false;
    void gazeDot.offsetHeight;
    gazeDot.style.transition = "";
    gazeDotInitialized = true;
    return;
  }
  gazeDot.style.transform = `translate(${gaze.x}px, ${gaze.y}px)`;
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
    await tracker.start(video, (msg) => setPermStatus(msg));
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

let calibAbort = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function renderBar(progress) {
  const total = 10;
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * total);
  return "▮".repeat(filled) + "▯".repeat(total - filled);
}

calibrateBtn.addEventListener("click", async () => {
  calibrateBtn.disabled = true;
  stopBtn.disabled = true;
  gazeDot.hidden = true;
  gazeDot.style.transform = "";
  gazeDotInitialized = false;

  if (!tracker.lastLandmarks) {
    setStatus("얼굴이 검출되지 않습니다. 카메라에 얼굴이 보이는지 확인하세요.");
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
    return;
  }

  const margin = 0.08;
  const vv = window.visualViewport;
  const W = vv?.width ?? window.innerWidth;
  const H = vv?.height ?? window.innerHeight;
  const xs = [margin, 0.5, 1 - margin];
  // Five vertical rows (top, upper-mid, mid, lower-mid, bottom) gives the
  // model enough Y data to fit the quadratic vertical terms.
  const ys = [margin, 0.275, 0.5, 0.725, 1 - margin];
  const points = [];
  for (const fy of ys) for (const fx of xs) points.push({ x: W * fx, y: H * fy });

  calibAbort = { aborted: false };
  const myAbort = calibAbort;
  calibrationOverlay.hidden = false;

  try {
    const dataset = [];
    moveTarget(W / 2, H / 2);
    calibTarget.classList.remove("sampling");
    calibText.textContent = "잠시 후 시작합니다...";
    await sleep(700);

    for (let i = 0; i < points.length; i++) {
      if (myAbort.aborted) throw new Error("취소됨");
      const p = points[i];
      calibTarget.classList.remove("sampling");
      moveTarget(p.x, p.y);
      calibText.textContent = `${i + 1} / ${points.length} — 점을 응시하세요`;
      await sleep(450);
      if (myAbort.aborted) throw new Error("취소됨");
      const sample = await tracker.sampleWhenStable(
        p,
        { W, H },
        (progress, isStable, reason) => {
          if (myAbort.aborted) return;
          if (isStable) calibTarget.classList.add("sampling");
          else calibTarget.classList.remove("sampling");
          const pct = Math.round(progress * 100);
          const bars = renderBar(progress);
          calibText.textContent = `${i + 1} / ${points.length} — ${bars} ${pct}% (${reason})`;
        }
      );
      if (myAbort.aborted) throw new Error("취소됨");
      dataset.push(sample);
      calibText.textContent = `${i + 1} / ${points.length} ✓`;
      await sleep(180);
    }

    const fit = tracker.fitFromSamples(dataset);
    const rms = Math.round(Math.hypot(fit.rmsX, fit.rmsY));

    const center = { x: W / 2, y: H / 2 };
    moveTarget(center.x, center.y);
    calibTarget.classList.remove("sampling");
    calibText.textContent = "마지막 — 중앙 점을 응시하면 영점 보정";
    await sleep(400);
    if (myAbort.aborted) throw new Error("취소됨");
    const bias = await tracker.finalizeBias(
      center,
      { W, H },
      (progress, isStable, reason) => {
        if (myAbort.aborted) return;
        if (isStable) calibTarget.classList.add("sampling");
        else calibTarget.classList.remove("sampling");
        const pct = Math.round(progress * 100);
        const bars = renderBar(progress);
        calibText.textContent = `영점 보정 — ${bars} ${pct}% (${reason})`;
      }
    );
    const dy = Math.round(bias.y);
    setStatus(`캘리브레이션 완료 (적합 ±${rms}px, 영점 보정 Δy=${dy >= 0 ? "+" : ""}${dy}px)`);
  } catch (e) {
    console.error(e);
    setStatus("캘리브레이션 실패: " + (e?.message ?? e));
  } finally {
    calibrationOverlay.hidden = true;
    calibrateBtn.disabled = false;
    stopBtn.disabled = false;
    calibAbort = null;
  }
});

calibCancel.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (calibAbort) calibAbort.aborted = true;
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
