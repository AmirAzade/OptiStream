/**
 * OptiStream Optical Matrix Encoder
 * ---------------------------------
 * Renders binary packets onto an HTML5 <canvas> using a custom optical matrix:
 *   - Quiet Zone: white margin around the matrix for clean corner detection
 *   - 4 Corner Finder Patterns (5x5 concentric squares with 1:1:1:1:1 B/W/B/W/B ratio
 *     + 1-module white separator border)
 *   - Calibration Strip (rows 0..1, cols 6..N-7): fixed reference patches for
 *     White, Black, Red, Green, and Blue, plus a 1-row white separator (row 2)
 *   - Format Tag (row 3, cols 6..13): 8-bit B/W header encoding GridSize & ColorMode
 *     with 3-bit parity so the receiver auto-adapts without manual settings
 *   - Data Region:
 *       Mode A ('1bit'): Black (1) / White (0)
 *       Mode B ('2bit'): Black (00), Cyan (01), Magenta (10), White (11)
 */

import { PACKET_OVERHEAD } from './protocol.js';
import { getRsLayout, encodeRsFrame } from './reed-solomon.js';

export const COLOR_MODE_1BIT = '1bit';
export const COLOR_MODE_2BIT = '2bit';
export const COLOR_MODE_3BIT = '3bit';

export const SUPPORTED_GRID_SIZES = [24, 28, 32, 36, 40, 44, 48];

export const CALIBRATION_PATCHES = [
  { name: 'W', css: '#FFFFFF', rgb: [255, 255, 255] },
  { name: 'K', css: '#000000', rgb: [0, 0, 0] },
  { name: 'R', css: '#FF0000', rgb: [255, 0, 0] },
  { name: 'G', css: '#00FF00', rgb: [0, 255, 0] },
  { name: 'B', css: '#0000FF', rgb: [0, 0, 255] },
  { name: 'C', css: '#00FFFF', rgb: [0, 255, 255] },
  { name: 'M', css: '#FF00FF', rgb: [255, 0, 255] },
  { name: 'Y', css: '#FFFF00', rgb: [255, 255, 0] },
];

// 3-bit RGB cube palette (natural binary = 3D Gray code: adjacent colors differ by 1 bit)
export const PALETTE_3BIT = [
  '#000000', // 000: Black
  '#0000FF', // 001: Blue
  '#00FF00', // 010: Green
  '#00FFFF', // 011: Cyan
  '#FF0000', // 100: Red
  '#FF00FF', // 101: Magenta
  '#FFFF00', // 110: Yellow
  '#FFFFFF', // 111: White
];

// 2-bit QAM-style palette: Black (00), Cyan (01), Magenta (10), White (11)
export const PALETTE_2BIT = ['#000000', '#00FFFF', '#FF00FF', '#FFFFFF'];

// 1-bit Monochrome palette: White (0), Black (1)
export const PALETTE_1BIT = ['#FFFFFF', '#000000'];

const FINDER_SIZE = 5;
const FINDER_SEP = 1; // 6x6 reserved at each corner
const CALIB_ROWS = 2; // rows 0..1 calibration, row 2 separator
const FORMAT_ROW = 3;
const FORMAT_COL_START = 6;
const FORMAT_BITS_COUNT = 10;

const COLOR_MODE_LIST = [COLOR_MODE_1BIT, COLOR_MODE_2BIT, COLOR_MODE_3BIT];

/**
 * Encodes gridSize (24..48 step 4), colorMode ('1bit'|'2bit'|'3bit'), and rsEnabled
 * into 10 bits:
 *   bits [0..2]: gridIndex (0..6)
 *   bits [3..4]: colorIndex (0..2)
 *   bit  [5]   : rsEnabled (0 or 1)
 *   bits [6..9]: 4-bit CRC/parity checksum over the 6 data bits
 */
export function encodeFormatBits(gridSize, colorMode, rsEnabled = true) {
  const gridIdx = Math.max(0, Math.min(6, SUPPORTED_GRID_SIZES.indexOf(gridSize)));
  const colorIdx = Math.max(0, COLOR_MODE_LIST.indexOf(colorMode));
  const rsBit = rsEnabled ? 1 : 0;
  const val6 = ((gridIdx & 0x07) << 3) | ((colorIdx & 0x03) << 1) | rsBit;

  // 4-bit mixing checksum
  const p0 = ((val6 >> 0) ^ (val6 >> 2) ^ (val6 >> 4)) & 1;
  const p1 = ((val6 >> 1) ^ (val6 >> 3) ^ (val6 >> 5) ^ 1) & 1;
  const p2 = ((val6 >> 0) ^ (val6 >> 1) ^ (val6 >> 4) ^ (val6 >> 5) ^ 1) & 1;
  const p3 = ((val6 >> 2) ^ (val6 >> 3) ^ (val6 >> 5) ^ p0) & 1;

  const bits = new Uint8Array(FORMAT_BITS_COUNT);
  for (let i = 0; i < 6; i++) {
    bits[i] = (val6 >> (5 - i)) & 1;
  }
  bits[6] = p0;
  bits[7] = p1;
  bits[8] = p2;
  bits[9] = p3;
  return bits;
}

/**
 * Decodes and validates the 10-bit format tag.
 * Returns { gridSize, colorMode, rsEnabled } or null if parity fails.
 */
export function decodeFormatBits(bits) {
  if (!bits || bits.length < FORMAT_BITS_COUNT) return null;
  let val6 = 0;
  for (let i = 0; i < 6; i++) {
    val6 = (val6 << 1) | (bits[i] & 1);
  }

  const p0 = ((val6 >> 0) ^ (val6 >> 2) ^ (val6 >> 4)) & 1;
  const p1 = ((val6 >> 1) ^ (val6 >> 3) ^ (val6 >> 5) ^ 1) & 1;
  const p2 = ((val6 >> 0) ^ (val6 >> 1) ^ (val6 >> 4) ^ (val6 >> 5) ^ 1) & 1;
  const p3 = ((val6 >> 2) ^ (val6 >> 3) ^ (val6 >> 5) ^ p0) & 1;

  if (
    (bits[6] & 1) !== p0 ||
    (bits[7] & 1) !== p1 ||
    (bits[8] & 1) !== p2 ||
    (bits[9] & 1) !== p3
  ) {
    return null;
  }

  const gridIdx = (val6 >> 3) & 0x07;
  const colorIdx = (val6 >> 1) & 0x03;
  const rsEnabled = (val6 & 1) === 1;

  if (gridIdx >= SUPPORTED_GRID_SIZES.length || colorIdx >= COLOR_MODE_LIST.length) {
    return null;
  }
  return {
    gridSize: SUPPORTED_GRID_SIZES[gridIdx],
    colorMode: COLOR_MODE_LIST[colorIdx],
    rsEnabled,
  };
}

/**
 * Computes calibration patch geometry for a given gridSize.
 * Returns array of { name, css, rgb, colStart, colEnd, centerCol, centerRow }.
 */
export function getCalibrationLayout(gridSize) {
  const colStart = FINDER_SIZE + FINDER_SEP; // 6
  const colEnd = gridSize - (FINDER_SIZE + FINDER_SEP) - 1; // N - 7
  const stripWidth = colEnd - colStart + 1;
  const numPatches = CALIBRATION_PATCHES.length;

  const patches = [];
  for (let i = 0; i < numPatches; i++) {
    const pStart = colStart + Math.floor((i * stripWidth) / numPatches);
    const pEnd = colStart + Math.floor(((i + 1) * stripWidth) / numPatches) - 1;
    patches.push({
      ...CALIBRATION_PATCHES[i],
      colStart: pStart,
      colEnd: pEnd,
      centerCol: (pStart + pEnd + 1) / 2,
      centerRow: CALIB_ROWS / 2, // 1.0 (midpoint of rows 0..1)
    });
  }
  return patches;
}

/**
 * Checks whether grid cell (col, row) is reserved (finder, separator, calibration, or format tag).
 */
export function isReservedCell(col, row, gridSize) {
  const cornerSpan = FINDER_SIZE + FINDER_SEP; // 6
  // 4 corners (5x5 finder + 1-cell separator)
  if (col < cornerSpan && row < cornerSpan) return true;
  if (col >= gridSize - cornerSpan && row < cornerSpan) return true;
  if (col < cornerSpan && row >= gridSize - cornerSpan) return true;
  if (col >= gridSize - cornerSpan && row >= gridSize - cornerSpan) return true;

  // Calibration strip (rows 0..1) + white separator (row 2)
  if (row <= CALIB_ROWS && col >= cornerSpan && col < gridSize - cornerSpan) return true;

  // 8-bit format tag at row 3, cols 6..13
  if (row === FORMAT_ROW && col >= FORMAT_COL_START && col < FORMAT_COL_START + FORMAT_BITS_COUNT) {
    return true;
  }

  return false;
}

/**
 * Builds and caches the ordered list of data cell coordinates [col, row, ...] as a flat Int16Array
 * for fast frame rendering and decoding.
 */
const dataCellCache = new Map();
export function getDataCells(gridSize) {
  if (dataCellCache.has(gridSize)) {
    return dataCellCache.get(gridSize);
  }
  const coords = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      if (!isReservedCell(col, row, gridSize)) {
        coords.push(col, row);
      }
    }
  }
  const typed = new Int16Array(coords);
  dataCellCache.set(gridSize, typed);
  return typed;
}

/**
 * Calculates total frame byte capacity and maximum chunk payload bytes for a given grid, mode & FEC.
 */
export function getFrameCapacity(gridSize, colorMode, rsEnabled = true) {
  const dataCellCount = getDataCells(gridSize).length / 2;
  const bitsPerCell = colorMode === COLOR_MODE_3BIT ? 3 : (colorMode === COLOR_MODE_2BIT ? 2 : 1);
  const totalBytes = Math.floor((dataCellCount * bitsPerCell) / 8);
  const totalDataBytes = rsEnabled ? getRsLayout(totalBytes).totalDataBytes : totalBytes;
  const maxPayloadBytes = Math.max(0, totalDataBytes - PACKET_OVERHEAD);
  return {
    dataCellCount,
    bitsPerCell,
    totalBytes,
    totalDataBytes,
    maxPayloadBytes,
  };
}

/**
 * Draws a 5x5 concentric finder pattern at module origin (col0, row0).
 * Cross-section through center has exact 1:1:1:1:1 B:W:B:W:B ratio.
 */
function drawFinderPattern(ctx, originX, originY, modulePx, col0, row0) {
  const x = originX + col0 * modulePx;
  const y = originY + row0 * modulePx;

  // Outer 5x5 black square
  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, 5 * modulePx, 5 * modulePx);

  // Middle 3x3 white square
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(x + modulePx, y + modulePx, 3 * modulePx, 3 * modulePx);

  // Inner 1x1 black square
  ctx.fillStyle = '#000000';
  ctx.fillRect(x + 2 * modulePx, y + 2 * modulePx, modulePx, modulePx);
}

/**
 * Renders a binary packet onto the target HTML5 <canvas>.
 * Uses integer module pixel sizes when possible for razor-sharp edges.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Uint8Array} packetBytes
 * @param {{ gridSize?: number, colorMode?: '1bit'|'2bit', quietZoneModules?: number }} options
 */
export function renderFrame(canvas, packetBytes, options = {}) {
  const gridSize = options.gridSize ?? 32;
  const colorMode = options.colorMode ?? COLOR_MODE_2BIT;
  const rsEnabled = options.rsEnabled ?? true;
  const quietModules = options.quietZoneModules ?? 2;

  const totalModules = gridSize + quietModules * 2;
  const minDim = Math.min(canvas.width, canvas.height);
  const modulePx = Math.floor(minDim / totalModules) || 1;
  const matrixPx = gridSize * modulePx;
  const originX = Math.floor((canvas.width - matrixPx) / 2);
  const originY = Math.floor((canvas.height - matrixPx) / 2);

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingEnabled = false;

  // Fill entire canvas with crisp white quiet zone
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 1. Draw 4 Corner Finder Patterns (5x5 concentric)
  drawFinderPattern(ctx, originX, originY, modulePx, 0, 0);
  drawFinderPattern(ctx, originX, originY, modulePx, gridSize - FINDER_SIZE, 0);
  drawFinderPattern(ctx, originX, originY, modulePx, 0, gridSize - FINDER_SIZE);
  drawFinderPattern(ctx, originX, originY, modulePx, gridSize - FINDER_SIZE, gridSize - FINDER_SIZE);

  // 2. Draw Calibration Strip (rows 0..1, cols 6..N-7)
  const calibPatches = getCalibrationLayout(gridSize);
  for (const patch of calibPatches) {
    ctx.fillStyle = patch.css;
    const x = originX + patch.colStart * modulePx;
    const w = (patch.colEnd - patch.colStart + 1) * modulePx;
    ctx.fillRect(x, originY, w, CALIB_ROWS * modulePx);
  }

  // 3. Draw 10-bit Format Tag (row 3, cols 6..15) in strict 1-bit B/W
  const formatBits = encodeFormatBits(gridSize, colorMode, rsEnabled);
  for (let i = 0; i < FORMAT_BITS_COUNT; i++) {
    ctx.fillStyle = formatBits[i] === 1 ? '#000000' : '#FFFFFF';
    ctx.fillRect(
      originX + (FORMAT_COL_START + i) * modulePx,
      originY + FORMAT_ROW * modulePx,
      modulePx,
      modulePx
    );
  }

  // 4. Encode packet bytes (with optional Reed-Solomon FEC) into data cells
  const dataCells = getDataCells(gridSize);
  const cellCount = dataCells.length / 2;
  const palette = colorMode === COLOR_MODE_3BIT
    ? PALETTE_3BIT
    : (colorMode === COLOR_MODE_2BIT ? PALETTE_2BIT : PALETTE_1BIT);
  const { totalBytes } = getFrameCapacity(gridSize, colorMode, rsEnabled);
  const encodedFrame = rsEnabled ? encodeRsFrame(packetBytes, totalBytes) : packetBytes;

  // Batch fills by color symbol to minimize ctx.fillStyle switches
  const buckets = Array.from({ length: palette.length }, () => []);

  if (colorMode === COLOR_MODE_3BIT) {
    let bitPos = 0;
    const totalBits = encodedFrame.length * 8;
    for (let c = 0; c < cellCount; c++) {
      let symbol = 0;
      if (bitPos < totalBits) {
        for (let k = 0; k < 3; k++) {
          const bIdx = bitPos >> 3;
          const bit = bIdx < encodedFrame.length
            ? (encodedFrame[bIdx] >> (7 - (bitPos & 7))) & 1
            : 0;
          symbol = (symbol << 1) | bit;
          bitPos++;
        }
      } else {
        symbol = (c ^ (c >> 2)) & 0x07;
      }
      buckets[symbol].push(c);
    }
  } else {
    const is2Bit = colorMode === COLOR_MODE_2BIT;
    for (let c = 0; c < cellCount; c++) {
      let symbol;
      if (is2Bit) {
        const byteIdx = c >> 2;
        if (byteIdx < encodedFrame.length) {
          const shift = 6 - ((c & 3) << 1);
          symbol = (encodedFrame[byteIdx] >> shift) & 0x03;
        } else {
          symbol = (c ^ (c >> 2)) & 0x03;
        }
      } else {
        const byteIdx = c >> 3;
        if (byteIdx < encodedFrame.length) {
          const shift = 7 - (c & 7);
          symbol = (encodedFrame[byteIdx] >> shift) & 0x01;
        } else {
          symbol = (c ^ (c >> 1)) & 0x01;
        }
      }
      buckets[symbol].push(c);
    }
  }

  for (let sym = 0; sym < buckets.length; sym++) {
    // Skip pure white cells since background is already #FFFFFF
    if (palette[sym] === '#FFFFFF') continue;
    const list = buckets[sym];
    if (list.length === 0) continue;

    ctx.fillStyle = palette[sym];
    for (let i = 0; i < list.length; i++) {
      const cellIdx = list[i];
      const col = dataCells[cellIdx * 2];
      const row = dataCells[cellIdx * 2 + 1];
      ctx.fillRect(
        originX + col * modulePx,
        originY + row * modulePx,
        modulePx,
        modulePx
      );
    }
  }
}
