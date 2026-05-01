import {
  FaceLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/vision_bundle.mjs";

const RIGHT_IRIS = [469, 470, 471, 472];
const LEFT_IRIS = [474, 475, 476, 477];
const R_EYE_OUTER = 33;
const R_EYE_INNER = 133;
const R_EYE_TOP = 159;
const R_EYE_BOTTOM = 145;
const L_EYE_INNER = 362;
const L_EYE_OUTER = 263;
const L_EYE_TOP = 386;
const L_EYE_BOTTOM = 374;

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.9/wasm";

export class EyeTracker extends EventTarget {
  constructor({ smoothing = 0.75 } = {}) {
    super();
    this.smoothing = smoothing;
    this.faceLandmarker = null;
    this.video = null;
    this.stream = null;
    this.running = false;
    this.calibration = null;
    this.smoothed = null;
    this.lastLandmarks = null;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
    });
  }

  async start(video) {
    if (!this.faceLandmarker) await this.init();
    this.video = video;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    video.srcObject = this.stream;
    await new Promise((res) => {
      if (video.readyState >= 2) res();
      else video.addEventListener("loadeddata", res, { once: true });
    });
    await video.play();
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  _loop() {
    if (!this.running) return;
    const ts = performance.now();
    let result = null;
    try {
      result = this.faceLandmarker.detectForVideo(this.video, ts);
    } catch (e) {
      this.dispatchEvent(new CustomEvent("error", { detail: e }));
    }
    if (result?.faceLandmarks?.[0]) {
      const lm = result.faceLandmarks[0];
      this.lastLandmarks = lm;
      const features = this._extractFeatures(lm);
      const gaze = this._estimateGaze(features);
      this.dispatchEvent(
        new CustomEvent("gaze", { detail: { landmarks: lm, features, gaze } })
      );
    } else {
      this.lastLandmarks = null;
      this.dispatchEvent(new CustomEvent("lost"));
    }
    requestAnimationFrame(() => this._loop());
  }

  _extractFeatures(lm) {
    const irisR = avg(RIGHT_IRIS.map((i) => lm[i]));
    const irisL = avg(LEFT_IRIS.map((i) => lm[i]));
    const r = normalizeIris(
      irisR,
      lm[R_EYE_OUTER],
      lm[R_EYE_INNER],
      lm[R_EYE_TOP],
      lm[R_EYE_BOTTOM]
    );
    const l = normalizeIris(
      irisL,
      lm[L_EYE_INNER],
      lm[L_EYE_OUTER],
      lm[L_EYE_TOP],
      lm[L_EYE_BOTTOM]
    );
    return { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2, r, l };
  }

  /**
   * Run the calibration sequence.
   * @param {Array<{x:number,y:number}>} points screen-space targets in CSS pixels
   * @param {(point, index) => Promise<void>} onShow called when a target appears (UI hook)
   * @param {(point, index) => Promise<void>} onSample called right before sampling starts
   * @param {{samples?: number, dwell?: number}} opts
   */
  async calibrate(points, onShow, onSample, opts = {}) {
    const { samples = 20, dwell = 600 } = opts;
    const dataset = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      await onShow?.(p, i);
      await wait(dwell);
      await onSample?.(p, i);
      const collected = [];
      const start = performance.now();
      while (collected.length < samples && performance.now() - start < 2000) {
        await wait(30);
        if (this.lastLandmarks) {
          const f = this._extractFeatures(this.lastLandmarks);
          collected.push(f);
        }
      }
      if (collected.length === 0) continue;
      const fx = mean(collected.map((c) => c.x));
      const fy = mean(collected.map((c) => c.y));
      dataset.push({ fx, fy, sx: p.x, sy: p.y });
    }
    if (dataset.length < 3) throw new Error("캘리브레이션 샘플이 부족합니다");
    this.calibration = fitCalibration(dataset);
    this.smoothed = null;
    return this.calibration;
  }

  _estimateGaze(features) {
    let target;
    if (this.calibration) {
      const { ax, ay } = this.calibration;
      target = {
        x: ax[0] + ax[1] * features.x + ax[2] * features.y,
        y: ay[0] + ay[1] * features.x + ay[2] * features.y,
        calibrated: true,
      };
    } else {
      target = {
        x: features.x * window.innerWidth,
        y: features.y * window.innerHeight,
        calibrated: false,
      };
    }
    if (!this.smoothed) {
      this.smoothed = { x: target.x, y: target.y };
    } else {
      const a = this.smoothing;
      this.smoothed = {
        x: this.smoothed.x * a + target.x * (1 - a),
        y: this.smoothed.y * a + target.y * (1 - a),
      };
    }
    return { ...this.smoothed, calibrated: target.calibrated };
  }
}

function avg(points) {
  let x = 0, y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

function normalizeIris(iris, left, right, top, bottom) {
  const w = right.x - left.x;
  const h = bottom.y - top.y;
  return {
    x: w !== 0 ? (iris.x - left.x) / w : 0.5,
    y: h !== 0 ? (iris.y - top.y) / h : 0.5,
  };
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fitCalibration(samples) {
  const X = samples.map((s) => [1, s.fx, s.fy]);
  const yX = samples.map((s) => s.sx);
  const yY = samples.map((s) => s.sy);
  return { ax: leastSquares(X, yX), ay: leastSquares(X, yY) };
}

function leastSquares(X, y) {
  const m = X[0].length;
  const XtX = Array.from({ length: m }, () => Array(m).fill(0));
  const Xty = Array(m).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < m; r++) {
      Xty[r] += X[i][r] * y[i];
      for (let c = 0; c < m; c++) XtX[r][c] += X[i][r] * X[i][c];
    }
  }
  return solve3x3(XtX, Xty);
}

function solve3x3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < 3; i++) {
    let pivot = i;
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(M[j][i]) > Math.abs(M[pivot][i])) pivot = j;
    }
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-10) return [0, 0, 0];
    for (let j = i + 1; j < 3; j++) {
      const f = M[j][i] / M[i][i];
      for (let k = i; k < 4; k++) M[j][k] -= f * M[i][k];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = M[i][3];
    for (let j = i + 1; j < 3; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
