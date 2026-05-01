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

  async init(onProgress) {
    onProgress?.("WASM 로딩 중");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    onProgress?.("모델 로딩 중 (GPU)");
    try {
      this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      });
    } catch (e) {
      onProgress?.("GPU 실패, CPU로 재시도");
      this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      });
    }
  }

  async start(video, onProgress) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("이 브라우저는 카메라 API를 지원하지 않습니다");
    }
    if (!this.faceLandmarker) await this.init(onProgress);
    this.video = video;
    onProgress?.("카메라 권한 요청 중");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });
    onProgress?.("비디오 시작 중");
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
  /**
   * Sample current iris features, averaged over a few frames.
   * Caller drives the sequence (e.g. tap-to-advance), so no awaits/timers here
   * beyond a small frame-averaging loop. Throws if no face is detected.
   */
  async sampleAt(point, frames = 16) {
    const collected = [];
    const start = performance.now();
    while (collected.length < frames && performance.now() - start < 2500) {
      await new Promise((r) => requestAnimationFrame(r));
      if (this.lastLandmarks) {
        collected.push(this._extractFeatures(this.lastLandmarks));
      }
    }
    if (collected.length < 4) {
      throw new Error("얼굴이 감지되지 않습니다");
    }
    const xs = collected.map((c) => c.x);
    const ys = collected.map((c) => c.y);
    return {
      fx: trimmedMean(xs),
      fy: trimmedMean(ys),
      sx: point.x,
      sy: point.y,
    };
  }

  fitFromSamples(dataset) {
    if (dataset.length < 4) throw new Error("샘플이 부족합니다 (4개 이상 필요)");
    this.calibration = fitCalibration(dataset);
    this.smoothed = null;
    return this.calibration;
  }

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
      const phi = featureBasis(features.x, features.y);
      target = {
        x: dot(ax, phi),
        y: dot(ay, phi),
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

// Drop the outermost 25% of samples on each side, average the rest.
// Robust to brief MediaPipe iris jitter (blink frames, lost-track flickers).
function trimmedMean(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.25);
  const slice = sorted.slice(trim, sorted.length - trim);
  return mean(slice.length ? slice : sorted);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Bilinear feature basis: [1, fx, fy, fx*fy].
// Captures linear gain plus a multiplicative cross term so the
// mapping can correct for screen-corner stretch when the head
// isn't perfectly centered. With ≥4 samples the system is
// well-determined; with 9 samples it averages noise.
function featureBasis(fx, fy) {
  return [1, fx, fy, fx * fy];
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function fitCalibration(samples) {
  const X = samples.map((s) => featureBasis(s.fx, s.fy));
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
  return solveLinear(XtX, Xty);
}

function solveLinear(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(M[j][i]) > Math.abs(M[pivot][i])) pivot = j;
    }
    [M[i], M[pivot]] = [M[pivot], M[i]];
    if (Math.abs(M[i][i]) < 1e-10) return Array(n).fill(0);
    for (let j = i + 1; j < n; j++) {
      const f = M[j][i] / M[i][i];
      for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k];
    }
  }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
