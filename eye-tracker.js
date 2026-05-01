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
    const opts = {
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    };
    try {
      this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...opts,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
    } catch (e) {
      onProgress?.("GPU 실패, CPU로 재시도");
      this.faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        ...opts,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
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
      const blends = result.faceBlendshapes?.[0]?.categories ?? null;
      const matrix = result.facialTransformationMatrixes?.[0]?.data ?? null;
      this.lastLandmarks = lm;
      this.lastBlendshapes = blends;
      this.lastMatrix = matrix;
      const features = this._extractFeatures(lm, blends, matrix);
      const gaze = this._estimateGaze(features);
      this.dispatchEvent(
        new CustomEvent("gaze", { detail: { landmarks: lm, features, gaze } })
      );
    } else {
      this.lastLandmarks = null;
      this.lastBlendshapes = null;
      this.lastMatrix = null;
      this.dispatchEvent(new CustomEvent("lost"));
    }
    requestAnimationFrame(() => this._loop());
  }

  _extractFeatures(lm, blends, matrix) {
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
    const irisX = (r.x + l.x) / 2;
    const irisY = (r.y + l.y) / 2;

    let bx = 0, by = 0;
    if (blends) {
      const inL = blendshape(blends, "eyeLookInLeft");
      const outL = blendshape(blends, "eyeLookOutLeft");
      const inR = blendshape(blends, "eyeLookInRight");
      const outR = blendshape(blends, "eyeLookOutRight");
      const upL = blendshape(blends, "eyeLookUpLeft");
      const upR = blendshape(blends, "eyeLookUpRight");
      const dnL = blendshape(blends, "eyeLookDownLeft");
      const dnR = blendshape(blends, "eyeLookDownRight");
      bx = (outR + inL - outL - inR) / 2;
      by = (upL + upR - dnL - dnR) / 2;
    }

    let hx = 0, hy = 0;
    if (matrix && matrix.length >= 16) {
      hx = matrix[8];
      hy = matrix[9];
    }

    return { x: irisX, y: irisY, bx, by, hx, hy, r, l };
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
  /**
   * Wait until iris + blendshape features stay within the variance
   * threshold for `stableNeeded` consecutive frames, then return the
   * sliding window of those frames as the sample. Callback fires
   * every frame with the [0..1] stability progress so the UI can
   * show a "tuning" indicator.
   */
  async sampleWhenStable(point, onProgress) {
    const WINDOW = 12;
    const STABLE_NEEDED = 28;
    const IRIS_VAR = 0.0008;
    const BLEND_VAR = 0.0004;
    const TIMEOUT_MS = 12000;

    const buf = [];
    let stable = 0;
    const t0 = performance.now();

    while (performance.now() - t0 < TIMEOUT_MS) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!this.lastLandmarks) continue;
      const f = this._extractFeatures(
        this.lastLandmarks,
        this.lastBlendshapes,
        this.lastMatrix
      );
      buf.push(f);
      if (buf.length > WINDOW) buf.shift();
      if (buf.length < WINDOW) {
        onProgress?.(0, false);
        continue;
      }

      const vIx = variance(buf.map((b) => b.x));
      const vIy = variance(buf.map((b) => b.y));
      const vBx = variance(buf.map((b) => b.bx));
      const vBy = variance(buf.map((b) => b.by));
      const ok = vIx < IRIS_VAR && vIy < IRIS_VAR && vBx < BLEND_VAR && vBy < BLEND_VAR;
      if (ok) stable++;
      else stable = Math.max(0, stable - 2);

      onProgress?.(Math.min(stable / STABLE_NEEDED, 1), ok);

      if (stable >= STABLE_NEEDED) {
        return {
          ix: trimmedMean(buf.map((b) => b.x)),
          iy: trimmedMean(buf.map((b) => b.y)),
          bx: trimmedMean(buf.map((b) => b.bx)),
          by: trimmedMean(buf.map((b) => b.by)),
          hx: trimmedMean(buf.map((b) => b.hx)),
          hy: trimmedMean(buf.map((b) => b.hy)),
          sx: point.x,
          sy: point.y,
        };
      }
    }
    throw new Error("응시가 안정되지 않습니다 — 점을 고정해서 응시하세요");
  }

  async sampleAt(point, frames = 16) {
    const collected = [];
    const start = performance.now();
    while (collected.length < frames && performance.now() - start < 2500) {
      await new Promise((r) => requestAnimationFrame(r));
      if (this.lastLandmarks) {
        collected.push(
          this._extractFeatures(this.lastLandmarks, this.lastBlendshapes, this.lastMatrix)
        );
      }
    }
    if (collected.length < 4) {
      throw new Error("얼굴이 감지되지 않습니다");
    }
    return {
      ix: trimmedMean(collected.map((c) => c.x)),
      iy: trimmedMean(collected.map((c) => c.y)),
      bx: trimmedMean(collected.map((c) => c.bx)),
      by: trimmedMean(collected.map((c) => c.by)),
      hx: trimmedMean(collected.map((c) => c.hx)),
      hy: trimmedMean(collected.map((c) => c.hy)),
      sx: point.x,
      sy: point.y,
    };
  }

  fitFromSamples(dataset) {
    if (dataset.length < 6) throw new Error("샘플이 부족합니다 (6개 이상 필요)");
    this.calibration = fitCalibration(dataset);
    this.smoothed = null;
    let sx2 = 0, sy2 = 0;
    for (const s of dataset) {
      const phi = featureBasis(s);
      sx2 += (dot(this.calibration.ax, phi) - s.sx) ** 2;
      sy2 += (dot(this.calibration.ay, phi) - s.sy) ** 2;
    }
    return {
      ...this.calibration,
      rmsX: Math.sqrt(sx2 / dataset.length),
      rmsY: Math.sqrt(sy2 / dataset.length),
    };
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
      const phi = featureBasis({
        ix: features.x,
        iy: features.y,
        bx: features.bx,
        by: features.by,
        hx: features.hx,
        hy: features.hy,
      });
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

function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return s / (arr.length - 1);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Combined feature basis: iris-corner ratio (ix, iy), MediaPipe gaze
// blendshapes (bx, by) and head-forward direction (hx, hy from the
// facial transformation matrix), plus bilinear cross terms for the
// two strongest signals. 8 parameters; 9 calibration samples keep it
// over-determined so noise averages out.
function featureBasis(s) {
  return [1, s.ix, s.iy, s.bx, s.by, s.hx, s.hy, s.bx * s.by];
}

function blendshape(blends, name) {
  for (const c of blends) if (c.categoryName === name) return c.score;
  return 0;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function fitCalibration(samples) {
  const X = samples.map(featureBasis);
  const yX = samples.map((s) => s.sx);
  const yY = samples.map((s) => s.sy);
  return { ax: leastSquares(X, yX), ay: leastSquares(X, yY) };
}

function leastSquares(X, y, lambda = 1e-3) {
  const m = X[0].length;
  const XtX = Array.from({ length: m }, () => Array(m).fill(0));
  const Xty = Array(m).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let r = 0; r < m; r++) {
      Xty[r] += X[i][r] * y[i];
      for (let c = 0; c < m; c++) XtX[r][c] += X[i][r] * X[i][c];
    }
  }
  for (let r = 1; r < m; r++) XtX[r][r] += lambda;
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
