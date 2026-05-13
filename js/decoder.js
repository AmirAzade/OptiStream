/**
 * OptiStream Optical Matrix Decoder
 * ---------------------------------
 * Processes camera video frames (or raw ImageData) to:
 *   1. Convert RGB -> luminance and compute an O(1) adaptive binary image via Integral Image.
 *   2. Detect 4 corner 5x5 concentric finder patterns (1:1:1:1:1 B/W/B/W/B ratio).
 *   3. Orient corners via the Calibration Strip (W, K, R, G, B) and verify the 8-bit Format Tag.
 *   4. Compute a 3x3 planar perspective Homography (8-DOF) from grid coordinates to image pixels.
 *   5. Calibrate color space against the measured Calibration Strip (unmixing white-balance + RGB crosstalk).
 *   6. Sample data cells, unpack bytes, and verify magic + CRC32 via protocol.parsePacket().
 *
 * Designed for zero memory leaks in requestAnimationFrame loops by reusing internal typed buffers.
 */

import {
  COLOR_MODE_2BIT,
  COLOR_MODE_3BIT,
  SUPPORTED_GRID_SIZES,
  decodeFormatBits,
  getCalibrationLayout,
  getDataCells,
  getFrameCapacity,
} from './encoder.js';
import { parsePacket } from './protocol.js';
import { decodeRsFrame } from './reed-solomon.js';

/**
 * Solves an 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 * Used to compute the 8-DOF planar homography matrix.
 */
function solveLinear8(A, b) {
  const n = 8;
  // Augment A with b
  const M = new Float64Array(n * (n + 1));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      M[r * (n + 1) + c] = A[r * n + c];
    }
    M[r * (n + 1) + n] = b[r];
  }

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col * (n + 1) + col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r * (n + 1) + col]);
      if (val > maxVal) {
        maxVal = val;
        pivotRow = r;
      }
    }
    if (maxVal < 1e-10) return null;

    if (pivotRow !== col) {
      for (let c = col; c <= n; c++) {
        const tmp = M[col * (n + 1) + c];
        M[col * (n + 1) + c] = M[pivotRow * (n + 1) + c];
        M[pivotRow * (n + 1) + c] = tmp;
      }
    }

    const pivot = M[col * (n + 1) + col];
    for (let c = col; c <= n; c++) {
      M[col * (n + 1) + c] /= pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r * (n + 1) + col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        M[r * (n + 1) + c] -= factor * M[col * (n + 1) + c];
      }
    }
  }

  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = M[i * (n + 1) + n];
  }
  return x;
}

/**
 * Computes 3x3 homography mapping source (u, v) grid coordinates to destination (x, y) image pixels.
 * srcPts / dstPts are arrays of 4 { x, y } objects.
 * Returns [h0..h7] where h8 = 1.
 */
export function computeHomography(srcPts, dstPts) {
  const A = new Float64Array(64);
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const u = srcPts[i].x;
    const v = srcPts[i].y;
    const x = dstPts[i].x;
    const y = dstPts[i].y;

    const r1 = i * 2;
    A[r1 * 8 + 0] = u;
    A[r1 * 8 + 1] = v;
    A[r1 * 8 + 2] = 1;
    A[r1 * 8 + 6] = -u * x;
    A[r1 * 8 + 7] = -v * x;
    b[r1] = x;

    const r2 = r1 + 1;
    A[r2 * 8 + 3] = u;
    A[r2 * 8 + 4] = v;
    A[r2 * 8 + 5] = 1;
    A[r2 * 8 + 6] = -u * y;
    A[r2 * 8 + 7] = -v * y;
    b[r2] = y;
  }

  return solveLinear8(A, b);
}

/**
 * Inverts a 3x3 matrix given as 3 column vectors [c0, c1, c2].
 * Returns flat 9-element row-major Float64Array or null if singular.
 */
function invert3x3Columns(c0, c1, c2) {
  const a = c0[0], b = c1[0], c = c2[0];
  const d = c0[1], e = c1[1], f = c2[1];
  const g = c0[2], h = c1[2], i = c2[2];

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;

  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-6) return null;

  const invDet = 1 / det;
  return new Float64Array([
    A * invDet, B * invDet, C * invDet,
    D * invDet, E * invDet, F * invDet,
    G * invDet, H * invDet, I * invDet,
  ]);
}

function checkFinderRatio(c0, c1, c2, c3, c4, minU, maxTotal) {
  const total = c0 + c1 + c2 + c3 + c4;
  if (total < minU * 5 || total > maxTotal) return false;
  const u = total / 5;
  const tol = u * 0.48;
  if (
    Math.abs(c0 - u) > tol ||
    Math.abs(c1 - u) > tol ||
    Math.abs(c2 - u) > tol ||
    Math.abs(c3 - u) > tol ||
    Math.abs(c4 - u) > tol
  ) {
    return false;
  }
  // Enforce left-right / top-bottom symmetry to reject bezel+quiet-zone false positives
  if (c1 > c3 * 1.65 || c3 > c1 * 1.65) return false;
  if (c0 > c4 * 1.65 || c4 > c0 * 1.65) return false;
  return true;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function nearestGridSize(est) {
  let best = SUPPORTED_GRID_SIZES[0];
  let bestDiff = Infinity;
  for (const s of SUPPORTED_GRID_SIZES) {
    const d = Math.abs(s - est);
    if (d < bestDiff) {
      bestDiff = d;
      best = s;
    }
  }
  return best;
}

export class OptiStreamDecoder {
  constructor(maxProcessDim = 760) {
    this.maxProcessDim = maxProcessDim;
    this.canvas = null;
    this.ctx = null;

    this.width = 0;
    this.height = 0;
    this.lum = null;
    this.integral = null;
    this.binary = null;
    this.byteBuffer = new Uint8Array(2048);

    this.fastRoiEnabled = true;
    this.lastCorners = null;
  }

  setFastRoi(enabled) {
    this.fastRoiEnabled = Boolean(enabled);
    if (!this.fastRoiEnabled) {
      this.lastCorners = null;
    }
  }

  _ensureBuffers(width, height) {
    if (this.width === width && this.height === height && this.lum) return;
    this.width = width;
    this.height = height;
    const size = width * height;
    this.lum = new Uint8Array(size);
    this.integral = new Uint32Array((width + 1) * (height + 1));
    this.binary = new Uint8Array(size);
  }

  _ensureCanvas(width, height) {
    if (!this.canvas && typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    }
    if (this.canvas && (this.canvas.width !== width || this.canvas.height !== height)) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Captures a frame from an HTMLVideoElement (or HTMLCanvasElement) onto the reused
   * offscreen canvas and decodes it.
   */
  decodeVideoFrame(source) {
    const srcW = source.videoWidth || source.width;
    const srcH = source.videoHeight || source.height;
    if (!srcW || !srcH) {
      return { ok: false, reason: 'no-frame', corners: null };
    }

    const scale = Math.min(1, this.maxProcessDim / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    this._ensureCanvas(w, h);
    this.ctx.drawImage(source, 0, 0, w, h);
    const imageData = this.ctx.getImageData(0, 0, w, h);
    const result = this.decodeImageData(imageData);

    // Scale corner coordinates back into source video space for overlay drawing
    if (result.corners && scale !== 1) {
      const inv = 1 / scale;
      result.corners = result.corners.map((p) => ({ x: p.x * inv, y: p.y * inv }));
    }
    result.processScale = scale;
    return result;
  }

  /**
   * Decodes a raw ImageData object directly (usable both in browser and headless tests).
   */
  decodeImageData(imageData) {
    const { width: w, height: h, data } = imageData;
    this._ensureBuffers(w, h);

    // Fast ROI path: when locked on previous frame, scan only 4 small boxes around lastCorners
    if (this.fastRoiEnabled && this.lastCorners && this.lastCorners.length === 4) {
      const roiQuad = this._findCornersInRois(data, w, h, this.lastCorners);
      if (roiQuad) {
        const roiResult = this._orientAndDecodePacket(data, w, h, roiQuad);
        if (roiResult?.ok) {
          this.lastCorners = roiResult.corners;
          return roiResult;
        }
      }
      // Fall back to full-frame scan if ROI missed
      this.lastCorners = null;
    }

    const lum = this.lum;
    const integral = this.integral;
    const binary = this.binary;
    const iw = w + 1;

    // 1. Grayscale conversion + summed-area table (Integral Image)
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const rowOffset = y * w;
      const intRow = (y + 1) * iw;
      const prevIntRow = y * iw;
      for (let x = 0; x < w; x++) {
        const pxIdx = (rowOffset + x) << 2;
        const l = (77 * data[pxIdx] + 150 * data[pxIdx + 1] + 29 * data[pxIdx + 2]) >> 8;
        lum[rowOffset + x] = l;
        rowSum += l;
        integral[intRow + x + 1] = integral[prevIntRow + x + 1] + rowSum;
      }
    }

    // 2. Adaptive local thresholding
    const radius = Math.max(8, Math.floor(Math.min(w, h) / 18));
    const bias = 6;
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - radius);
      const y2 = Math.min(h - 1, y + radius);
      const rowOffset = y * w;
      const r1 = y1 * iw;
      const r2 = (y2 + 1) * iw;
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - radius);
        const x2 = Math.min(w - 1, x + radius);
        const area = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = integral[r2 + x2 + 1] - integral[r1 + x2 + 1] - integral[r2 + x1] + integral[r1 + x1];
        binary[rowOffset + x] = lum[rowOffset + x] * area < sum - bias * area ? 1 : 0;
      }
    }

    // 3. Detect 5x5 concentric finder patterns (1:1:1:1:1)
    const candidates = this._findFinderCandidates(binary, w, h, 0, 0, w, h);
    if (candidates.length < 4) {
      return { ok: false, reason: 'corners-not-found', corners: candidates };
    }

    // 4. Select best 4-corner quadrilateral
    const quad = this._selectQuad(candidates, w, h);
    if (!quad) {
      return { ok: false, reason: 'quad-invalid', corners: candidates.slice(0, 4) };
    }

    // 5. Orient quad using Calibration Strip & verify Format Tag + RS + CRC32
    const decodedResult = this._orientAndDecodePacket(data, w, h, quad);
    if (!decodedResult) {
      return { ok: false, reason: 'crc-or-alignment-failed', corners: quad };
    }

    if (decodedResult.ok && this.fastRoiEnabled) {
      this.lastCorners = decodedResult.corners;
    }
    return decodedResult;
  }

  _findCornersInRois(data, w, h, prevCorners) {
    const lum = this.lum;
    const integral = this.integral;
    const binary = this.binary;
    const iw = w + 1;
    const found = [];

    for (const c of prevCorners) {
      const half = Math.max(42, Math.round((c.u || 12) * 4.5));
      const x0 = Math.max(0, Math.round(c.x - half));
      const y0 = Math.max(0, Math.round(c.y - half));
      const x1 = Math.min(w, Math.round(c.x + half));
      const y1 = Math.min(h, Math.round(c.y + half));
      if (x1 - x0 < 20 || y1 - y0 < 20) return null;

      // Local integral image inside [x0..x1, y0..y1]
      for (let x = x0; x <= x1; x++) integral[y0 * iw + x] = 0;
      for (let y = y0; y < y1; y++) {
        let rowSum = 0;
        const rowOffset = y * w;
        const intRow = (y + 1) * iw;
        const prevIntRow = y * iw;
        integral[intRow + x0] = 0;
        for (let x = x0; x < x1; x++) {
          const pxIdx = (rowOffset + x) << 2;
          const l = (77 * data[pxIdx] + 150 * data[pxIdx + 1] + 29 * data[pxIdx + 2]) >> 8;
          lum[rowOffset + x] = l;
          rowSum += l;
          integral[intRow + x + 1] = integral[prevIntRow + x + 1] + rowSum;
        }
      }

      const radius = Math.max(8, Math.floor((c.u || 12) * 1.8));
      const bias = 6;
      for (let y = y0; y < y1; y++) {
        const ry1 = Math.max(y0, y - radius);
        const ry2 = Math.min(y1 - 1, y + radius);
        const rowOffset = y * w;
        const r1 = ry1 * iw;
        const r2 = (ry2 + 1) * iw;
        for (let x = x0; x < x1; x++) {
          const rx1 = Math.max(x0, x - radius);
          const rx2 = Math.min(x1 - 1, x + radius);
          const area = (rx2 - rx1 + 1) * (ry2 - ry1 + 1);
          const sum = integral[r2 + rx2 + 1] - integral[r1 + rx2 + 1] - integral[r2 + rx1] + integral[r1 + rx1];
          binary[rowOffset + x] = lum[rowOffset + x] * area < sum - bias * area ? 1 : 0;
        }
      }

      const localCands = this._findFinderCandidates(binary, w, h, x0, y0, x1, y1);
      if (localCands.length === 0) return null;
      found.push(localCands[0]);
    }

    return found.length === 4 ? found : null;
  }

  _findFinderCandidates(binary, w, h, rx0 = 0, ry0 = 0, rx1 = w, ry1 = h) {
    const minDim = Math.min(w, h);
    const minU = 2.0;
    const maxTotal = minDim * 0.42;
    const stepY = (ry1 - ry0) > 540 ? 2 : 1;
    const startY = Math.max(4, ry0);
    const endY = Math.min(h - 4, ry1);
    const clusters = [];

    for (let y = startY; y < endY; y += stepY) {
      const rowOffset = y * w;
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0;
      let state = 0;

      for (let x = rx0; x < rx1; x++) {
        const bit = binary[rowOffset + x];
        if (bit === 1) {
          if (state === 0 || state === 1) {
            state = 1;
            c0++;
          } else if (state === 2) {
            state = 3;
            c2 = 1;
          } else if (state === 3) {
            c2++;
          } else if (state === 4) {
            state = 5;
            c4 = 1;
          } else if (state === 5) {
            c4++;
          }
        } else {
          if (state === 1) {
            state = 2;
            c1 = 1;
          } else if (state === 2) {
            c1++;
          } else if (state === 3) {
            state = 4;
            c3 = 1;
          } else if (state === 4) {
            c3++;
          } else if (state === 5) {
            // Finished a D-L-D-L-D run ending at x - 1
            if (checkFinderRatio(c0, c1, c2, c3, c4, minU, maxTotal)) {
              const cx = x - c4 - c3 - c2 * 0.5;
              const hTotal = c0 + c1 + c2 + c3 + c4;
              const verified = this._verifyVerticalAndRing(binary, w, h, Math.round(cx), y, hTotal);
              if (verified) {
                this._addCluster(clusters, cx, verified.cy, verified.u);
              }
            }
            // Shift left by 2 runs: old dark2 -> dark0, old light3 -> light1, old dark4 -> dark2, now in light3
            c0 = c2;
            c1 = c3;
            c2 = c4;
            c3 = 1;
            c4 = 0;
            state = 4;
          } else {
            state = 0;
          }
        }
      }
    }

    // Filter weak noise clusters when large enough to be hit multiple times
    return clusters
      .filter((cl) => cl.votes >= 2 || cl.u < 4.5)
      .sort((a, b) => b.votes - a.votes);
  }

  _verifyVerticalAndRing(binary, w, h, ix, iy, hTotal) {
    if (ix < 2 || ix >= w - 2) return null;
    if (binary[iy * w + ix] !== 1) return null;

    const maxScan = Math.ceil(hTotal * 0.9);
    // Walk up from iy through center dark -> light -> outer dark
    let up = iy;
    let c2Up = 0;
    while (up >= 0 && binary[up * w + ix] === 1 && c2Up <= maxScan) {
      c2Up++;
      up--;
    }
    let c1 = 0;
    while (up >= 0 && binary[up * w + ix] === 0 && c1 <= maxScan) {
      c1++;
      up--;
    }
    let c0 = 0;
    while (up >= 0 && binary[up * w + ix] === 1 && c0 <= maxScan) {
      c0++;
      up--;
    }
    if (c0 === 0 || c1 === 0) return null;

    // Walk down from iy + 1
    let dn = iy + 1;
    let c2Dn = 0;
    while (dn < h && binary[dn * w + ix] === 1 && c2Dn <= maxScan) {
      c2Dn++;
      dn++;
    }
    let c3 = 0;
    while (dn < h && binary[dn * w + ix] === 0 && c3 <= maxScan) {
      c3++;
      dn++;
    }
    let c4 = 0;
    while (dn < h && binary[dn * w + ix] === 1 && c4 <= maxScan) {
      c4++;
      dn++;
    }
    if (c3 === 0 || c4 === 0) return null;

    const c2 = c2Up + c2Dn;
    const vTotal = c0 + c1 + c2 + c3 + c4;
    if (vTotal < hTotal * 0.6 || vTotal > hTotal * 1.55) return null;
    if (!checkFinderRatio(c0, c1, c2, c3, c4, 2.0, Math.min(w, h) * 0.45)) return null;

    const cy = iy - c2Up + 1 + c2 * 0.5;
    const u = (hTotal + vTotal) / 10;

    // Check 4 diagonal inner-ring (light) and outer-ring (dark) points to reject stripes
    const d1 = u;
    const d2 = u * 2;
    const icy = Math.round(cy);
    if (
      ix - d2 < 0 || ix + d2 >= w ||
      icy - d2 < 0 || icy + d2 >= h
    ) {
      return null;
    }
    let ringHits = 0;
    const signs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (const [sx, sy] of signs) {
      const lx = Math.round(ix + sx * d1);
      const ly = Math.round(cy + sy * d1);
      const dx = Math.round(ix + sx * d2);
      const dy = Math.round(cy + sy * d2);
      if (binary[ly * w + lx] === 0) ringHits++;
      if (binary[dy * w + dx] === 1) ringHits++;
    }
    if (ringHits < 6) return null;

    // Check 4 cardinal white-separator / quiet-zone points at ±3u (should be light = 0)
    const d3 = u * 3;
    let sepLight = 0;
    const cardinals = [[-d3, 0], [d3, 0], [0, -d3], [0, d3]];
    for (const [dx, dy] of cardinals) {
      const sx = Math.round(ix + dx);
      const sy = Math.round(cy + dy);
      if (sx >= 0 && sx < w && sy >= 0 && sy < h && binary[sy * w + sx] === 0) {
        sepLight++;
      }
    }
    if (sepLight < 3) return null;

    return { cy, u };
  }

  _addCluster(clusters, x, y, u) {
    for (const cl of clusters) {
      const tol = Math.min(cl.u, u) * 1.5;
      const sizeCompatible = Math.max(cl.u, u) <= Math.min(cl.u, u) * 1.45;
      if (sizeCompatible && Math.abs(cl.x - x) < tol && Math.abs(cl.y - y) < tol) {
        const w1 = cl.votes;
        const w2 = w1 + 1;
        cl.x = (cl.x * w1 + x) / w2;
        cl.y = (cl.y * w1 + y) / w2;
        cl.u = (cl.u * w1 + u) / w2;
        cl.votes = w2;
        return;
      }
    }
    clusters.push({ x, y, u, votes: 1 });
  }

  _selectQuad(candidates, w, h) {
    const pool = candidates.slice(0, 8);
    const minArea = w * h * 0.025;
    let bestQuad = null;
    let bestScore = -Infinity;

    const n = pool.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          for (let l = k + 1; l < n; l++) {
            const pts = [pool[i], pool[j], pool[k], pool[l]];
            // Sort clockwise around centroid
            const mx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) * 0.25;
            const my = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) * 0.25;
            pts.sort((a, b) => Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx));

            // Check convexity via cross products
            let crossSign = 0;
            let convex = true;
            for (let m = 0; m < 4; m++) {
              const a = pts[m];
              const b = pts[(m + 1) & 3];
              const c = pts[(m + 2) & 3];
              const cp = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
              if (Math.abs(cp) < 1e-3) {
                convex = false;
                break;
              }
              const s = cp > 0 ? 1 : -1;
              if (crossSign === 0) crossSign = s;
              else if (s !== crossSign) {
                convex = false;
                break;
              }
            }
            if (!convex) continue;

            // Polygon area (Shoelace)
            const area = 0.5 * Math.abs(
              pts[0].x * pts[1].y - pts[1].x * pts[0].y +
              pts[1].x * pts[2].y - pts[2].x * pts[1].y +
              pts[2].x * pts[3].y - pts[3].x * pts[2].y +
              pts[3].x * pts[0].y - pts[0].x * pts[3].y
            );
            if (area < minArea) continue;

            // Check module size consistency across the 4 finders
            const us = pts.map((p) => p.u);
            const uMin = Math.min(...us);
            const uMax = Math.max(...us);
            if (uMax > uMin * 2.1) continue;

            // Check side length ratios (reject wildly skewed non-square shapes)
            const s0 = dist(pts[0], pts[1]);
            const s1 = dist(pts[1], pts[2]);
            const s2 = dist(pts[2], pts[3]);
            const s3 = dist(pts[3], pts[0]);
            const sMin = Math.min(s0, s1, s2, s3);
            const sMax = Math.max(s0, s1, s2, s3);
            if (sMax > sMin * 1.9) continue;

            const votesSum = pts[0].votes + pts[1].votes + pts[2].votes + pts[3].votes;
            const score = votesSum * 10 + Math.sqrt(area) * 0.05 - (uMax / uMin) * 5;
            if (score > bestScore) {
              bestScore = score;
              bestQuad = pts;
            }
          }
        }
      }
    }

    return bestQuad;
  }

  /**
   * Samples RGB at fractional image coordinate (px, py) using a 5-point cross
   * inside the cell center to suppress sensor noise without bleeding across module borders.
   */
  _sampleRgbCross(data, w, h, homography, u, v) {
    const offsets = [
      [0, 0],
      [-0.14, 0],
      [0.14, 0],
      [0, -0.14],
      [0, 0.14],
    ];
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let i = 0; i < 5; i++) {
      const gu = u + offsets[i][0];
      const gv = v + offsets[i][1];
      const denom = homography[6] * gu + homography[7] * gv + 1;
      if (Math.abs(denom) < 1e-6) continue;
      const px = Math.round((homography[0] * gu + homography[1] * gv + homography[2]) / denom);
      const py = Math.round((homography[3] * gu + homography[4] * gv + homography[5]) / denom);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      const idx = (py * w + px) << 2;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }

    if (count === 0) return [0, 0, 0];
    return [rSum / count, gSum / count, bSum / count];
  }

  _sampleCalibration(data, w, h, homography, gridSize) {
    const layout = getCalibrationLayout(gridSize);
    const measured = {};
    for (const patch of layout) {
      measured[patch.name] = this._sampleRgbCross(data, w, h, homography, patch.centerCol, patch.centerRow);
    }

    const W = measured.W;
    const K = measured.K;
    const R = measured.R;
    const G = measured.G;
    const B = measured.B;
    const C = measured.C;
    const M = measured.M;
    const Y = measured.Y;

    const lumW = 0.299 * W[0] + 0.587 * W[1] + 0.114 * W[2];
    const lumK = 0.299 * K[0] + 0.587 * K[1] + 0.114 * K[2];
    const contrast = lumW - lumK;

    // Score how cleanly W, K, R, G, B match their expected optical roles
    const rDominance = (R[0] - K[0]) - Math.max(R[1] - K[1], R[2] - K[2]);
    const gDominance = (G[1] - K[1]) - Math.max(G[0] - K[0], G[2] - K[2]);
    const bDominance = (B[2] - K[2]) - Math.max(B[0] - K[0], B[1] - K[1]);

    const score = contrast + rDominance + gDominance + bDominance;

    // Direct camera-space prototypes for 2-bit [Black, Cyan, Magenta, White]
    // and 3-bit [Black, Blue, Green, Cyan, Red, Magenta, Yellow, White]
    const prototypes2Bit = [K, C, M, W];
    const prototypes3Bit = [K, B, G, C, R, M, Y, W];

    return {
      W,
      K,
      prototypes2Bit,
      prototypes3Bit,
      lumThreshold: (lumW + lumK) * 0.5,
      contrast,
      score,
    };
  }

  _orientAndDecodePacket(data, w, h, quad) {
    // Estimate initial gridSize from edge lengths vs average finder module size
    const avgSide = (dist(quad[0], quad[1]) + dist(quad[1], quad[2]) + dist(quad[2], quad[3]) + dist(quad[3], quad[0])) * 0.25;
    const avgU = (quad[0].u + quad[1].u + quad[2].u + quad[3].u) * 0.25;
    const estN = 5 + avgSide / avgU;
    const primaryN = nearestGridSize(estN);

    // Order candidate rotations: prefer natural upright (TL has smallest x+y) first
    let uprightShift = 0;
    let minSum = Infinity;
    for (let i = 0; i < 4; i++) {
      const s = quad[i].x + quad[i].y;
      if (s < minSum) {
        minSum = s;
        uprightShift = i;
      }
    }

    const rotations = [];
    for (let i = 0; i < 4; i++) {
      const idx = (uprightShift + i) & 3;
      rotations.push([
        quad[idx],
        quad[(idx + 1) & 3],
        quad[(idx + 2) & 3],
        quad[(idx + 3) & 3],
      ]);
    }

    // Score each rotation by Calibration Strip match
    const scored = [];
    for (const rot of rotations) {
      const srcPts = [
        { x: 2.5, y: 2.5 },
        { x: primaryN - 2.5, y: 2.5 },
        { x: primaryN - 2.5, y: primaryN - 2.5 },
        { x: 2.5, y: primaryN - 2.5 },
      ];
      const H = computeHomography(srcPts, rot);
      if (!H) continue;
      const calib = this._sampleCalibration(data, w, h, H, primaryN);
      if (calib.contrast > 15) {
        scored.push({ rot, H, calib });
      }
    }
    scored.sort((a, b) => b.calib.score - a.calib.score);

    // Sort all supported grid sizes by proximity to estN
    const candidateNs = [...SUPPORTED_GRID_SIZES].sort(
      (a, b) => Math.abs(a - estN) - Math.abs(b - estN)
    );

    let lastValidFormatMatch = null;

    for (const item of scored) {
      for (const tryN of candidateNs) {
        const srcPts = [
          { x: 2.5, y: 2.5 },
          { x: tryN - 2.5, y: 2.5 },
          { x: tryN - 2.5, y: tryN - 2.5 },
          { x: 2.5, y: tryN - 2.5 },
        ];
        const H = tryN === primaryN ? item.H : computeHomography(srcPts, item.rot);
        if (!H) continue;
        const calib = tryN === primaryN ? item.calib : this._sampleCalibration(data, w, h, H, tryN);

        // Read 10-bit Format Tag at row 3, cols 6..15
        const fmtBits = new Uint8Array(10);
        for (let i = 0; i < 10; i++) {
          const rgb = this._sampleRgbCross(data, w, h, H, 6 + i + 0.5, 3.5);
          const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
          fmtBits[i] = l < calib.lumThreshold ? 1 : 0;
        }
        const decodedFmt = decodeFormatBits(fmtBits);
        if (!decodedFmt) continue;

        // Require self-consistency: the grid size encoded in the tag must match the homography grid size
        if (decodedFmt.gridSize !== tryN) continue;

        lastValidFormatMatch = {
          ok: false,
          reason: 'crc-failed',
          corners: item.rot,
          gridSize: decodedFmt.gridSize,
          colorMode: decodedFmt.colorMode,
          rsEnabled: decodedFmt.rsEnabled,
        };

        const rawBytes = this._sampleDataBytes(data, w, h, H, decodedFmt.gridSize, decodedFmt.colorMode, calib);
        const frameBytes = decodedFmt.rsEnabled ? decodeRsFrame(rawBytes, rawBytes.length) : rawBytes;
        const packet = frameBytes ? parsePacket(frameBytes) : null;
        if (packet) {
          return {
            ok: true,
            packet,
            corners: item.rot,
            gridSize: decodedFmt.gridSize,
            colorMode: decodedFmt.colorMode,
            rsEnabled: decodedFmt.rsEnabled,
          };
        }
      }
    }

    return lastValidFormatMatch;
  }

  _sampleDataBytes(data, w, h, homography, gridSize, colorMode, calib) {
    const dataCells = getDataCells(gridSize);
    const cellCount = dataCells.length / 2;
    const { totalBytes } = getFrameCapacity(gridSize, colorMode, false);

    if (this.byteBuffer.length < totalBytes) {
      this.byteBuffer = new Uint8Array(totalBytes);
    }
    const bytes = this.byteBuffer.subarray(0, totalBytes);
    bytes.fill(0);

    const is3Bit = colorMode === COLOR_MODE_3BIT;
    const is2Bit = colorMode === COLOR_MODE_2BIT;
    const prototypes = is3Bit ? calib.prototypes3Bit : calib.prototypes2Bit;
    const lumThreshold = calib.lumThreshold;

    if (is3Bit) {
      let bitPos = 0;
      const totalBits = totalBytes * 8;
      for (let c = 0; c < cellCount && bitPos < totalBits; c++) {
        const col = dataCells[c * 2];
        const row = dataCells[c * 2 + 1];
        const rgb = this._sampleRgbCross(data, w, h, homography, col + 0.5, row + 0.5);

        let bestSym = 0;
        let bestDist = Infinity;
        for (let sym = 0; sym < 8; sym++) {
          const p = prototypes[sym];
          const er = rgb[0] - p[0];
          const eg = rgb[1] - p[1];
          const eb = rgb[2] - p[2];
          const d2 = er * er + eg * eg + eb * eb;
          if (d2 < bestDist) {
            bestDist = d2;
            bestSym = sym;
          }
        }

        for (let k = 0; k < 3 && bitPos < totalBits; k++) {
          const bit = (bestSym >> (2 - k)) & 1;
          if (bit) {
            bytes[bitPos >> 3] |= 1 << (7 - (bitPos & 7));
          }
          bitPos++;
        }
      }
      return bytes;
    }

    for (let c = 0; c < cellCount; c++) {
      const col = dataCells[c * 2];
      const row = dataCells[c * 2 + 1];
      const rgb = this._sampleRgbCross(data, w, h, homography, col + 0.5, row + 0.5);

      if (!is2Bit) {
        const byteIdx = c >> 3;
        if (byteIdx >= totalBytes) break;
        const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
        if (l < lumThreshold) {
          bytes[byteIdx] |= 1 << (7 - (c & 7));
        }
      } else {
        const byteIdx = c >> 2;
        if (byteIdx >= totalBytes) break;

        let bestSym = 0;
        let bestDist = Infinity;
        for (let sym = 0; sym < 4; sym++) {
          const p = prototypes[sym];
          const er = rgb[0] - p[0];
          const eg = rgb[1] - p[1];
          const eb = rgb[2] - p[2];
          const d2 = er * er + eg * eg + eb * eb;
          if (d2 < bestDist) {
            bestDist = d2;
            bestSym = sym;
          }
        }

        bytes[byteIdx] |= bestSym << (6 - ((c & 3) << 1));
      }
    }

    return bytes;
  }
}
