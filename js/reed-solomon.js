/**
 * OptiStream Reed-Solomon GF(2^8) Inner FEC
 * -----------------------------------------
 * Standard systematic Reed-Solomon codec over GF(2^8) (primitive polynomial 0x11d)
 * using Berlekamp-Massey + Chien Search + Forney error magnitude recovery.
 *
 * Supports multi-block interleaving when frame capacity exceeds 255 bytes.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function gfDiv(a, b) {
  if (b === 0) throw new Error('GF division by zero');
  if (a === 0) return 0;
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

function gfPow(x, power) {
  return GF_EXP[(GF_LOG[x] * power) % 255];
}

function gfInv(x) {
  return GF_EXP[255 - GF_LOG[x]];
}

function polyScale(p, x) {
  const r = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
  return r;
}

function polyAdd(p, q) {
  const len = Math.max(p.length, q.length);
  const r = new Uint8Array(len);
  for (let i = 0; i < p.length; i++) r[i + len - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) r[i + len - q.length] ^= q[i];
  return r;
}

function polyMul(p, q) {
  const r = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) {
      r[i + j] ^= gfMul(p[i], q[j]);
    }
  }
  return r;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) {
    y = gfMul(y, x) ^ p[i];
  }
  return y;
}

const genPolyCache = new Map();
function getGeneratorPoly(nsym) {
  if (genPolyCache.has(nsym)) return genPolyCache.get(nsym);
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    g = polyMul(g, new Uint8Array([1, gfPow(2, i)]));
  }
  genPolyCache.set(nsym, g);
  return g;
}

/**
 * Encodes `data` (length k, k + nsym <= 255) into a systematic codeword [data | parity].
 */
export function rsEncodeBlock(data, nsym) {
  if (data.length + nsym > 255) {
    throw new Error('RS block length exceeds 255 bytes.');
  }
  const gen = getGeneratorPoly(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data, 0);

  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) {
        out[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  out.set(data, 0);
  return out;
}

/**
 * Decodes and repairs up to floor(nsym / 2) byte errors in a codeword [data | parity].
 * Returns repaired data slice (length = msg.length - nsym), or null if uncorrectable.
 */
export function rsDecodeBlock(msg, nsym) {
  if (msg.length > 255 || msg.length <= nsym) return null;

  // 1. Compute syndromes
  const synd = new Uint8Array(nsym + 1); // synd[0] = 0, synd[1..nsym] = S_0..S_{nsym-1}
  let hasError = false;
  for (let i = 0; i < nsym; i++) {
    const s = polyEval(msg, gfPow(2, i));
    synd[i + 1] = s;
    if (s !== 0) hasError = true;
  }

  const dataLen = msg.length - nsym;
  if (!hasError) {
    return msg.slice(0, dataLen);
  }

  // 2. Berlekamp-Massey to find error locator polynomial (reversed coefficients)
  let errLoc = new Uint8Array([1]);
  let oldLoc = new Uint8Array([1]);
  let syndShift = 0;

  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K + 1];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K + 1 - j]);
    }

    oldLoc = new Uint8Array([...oldLoc, 0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }

  // Strip leading zeros
  let lead = 0;
  while (lead < errLoc.length && errLoc[lead] === 0) lead++;
  errLoc = errLoc.subarray(lead);

  const errs = errLoc.length - 1;
  if (errs === 0 || errs * 2 > nsym) return null;

  // 3. Chien search for error positions (roots at X_k^-1 = alpha^(-p))
  const errPos = [];
  for (let p = 0; p < msg.length; p++) {
    if (polyEval(errLoc, gfPow(2, (255 - p) % 255)) === 0) {
      errPos.push(msg.length - 1 - p);
    }
  }
  if (errPos.length !== errs) return null;

  // 4. Forney algorithm to compute error magnitudes
  const syndRev = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) syndRev[i] = synd[nsym - i];
  const errEvalFull = polyMul(syndRev, errLoc);
  const errEval = errEvalFull.subarray(errEvalFull.length - nsym);

  const X = errPos.map((p) => gfPow(2, msg.length - 1 - p));
  const repaired = msg.slice();

  for (let i = 0; i < X.length; i++) {
    const XiInv = gfInv(X[i]);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) {
        errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
      }
    }
    if (errLocPrime === 0) return null;

    const y = polyEval(errEval, XiInv);
    const mag = gfDiv(y, errLocPrime);
    repaired[errPos[i]] ^= mag;
  }

  // 5. Re-verify syndromes are all zero
  for (let i = 0; i < nsym; i++) {
    if (polyEval(repaired, gfPow(2, i)) !== 0) return null;
  }

  return repaired.subarray(0, dataLen);
}

/**
 * Computes deterministic multi-block interleaved RS layout for any frame byte capacity.
 */
export function getRsLayout(totalFrameBytes) {
  const numBlocks = Math.ceil(totalFrameBytes / 255);
  const blocks = [];
  let totalDataBytes = 0;
  let totalParityBytes = 0;

  for (let b = 0; b < numBlocks; b++) {
    const blockBytes = Math.floor(totalFrameBytes / numBlocks) + (b < (totalFrameBytes % numBlocks) ? 1 : 0);
    let nsym;
    if (blockBytes <= 60) {
      nsym = 4;
    } else {
      nsym = Math.min(32, Math.max(6, Math.round(blockBytes * 0.12) & ~1));
    }
    const dataBytes = blockBytes - nsym;
    blocks.push({ blockBytes, dataBytes, nsym });
    totalDataBytes += dataBytes;
    totalParityBytes += nsym;
  }

  return { numBlocks, blocks, totalDataBytes, totalParityBytes, totalFrameBytes };
}

/**
 * Encodes a packet (padded to layout.totalDataBytes) into an interleaved RS frame buffer.
 */
export function encodeRsFrame(packetBytes, totalFrameBytes) {
  const layout = getRsLayout(totalFrameBytes);
  const padded = new Uint8Array(layout.totalDataBytes);
  padded.set(packetBytes.subarray(0, Math.min(packetBytes.length, layout.totalDataBytes)), 0);

  const encodedBlocks = [];
  let offset = 0;
  for (const b of layout.blocks) {
    const slice = padded.subarray(offset, offset + b.dataBytes);
    encodedBlocks.push(rsEncodeBlock(slice, b.nsym));
    offset += b.dataBytes;
  }

  if (layout.numBlocks === 1) {
    return encodedBlocks[0];
  }

  // Interleave across blocks for burst-glare resilience
  const out = new Uint8Array(totalFrameBytes);
  let outIdx = 0;
  const maxBlockLen = layout.blocks[0].blockBytes;
  for (let pos = 0; pos < maxBlockLen; pos++) {
    for (let b = 0; b < layout.numBlocks; b++) {
      if (pos < encodedBlocks[b].length) {
        out[outIdx++] = encodedBlocks[b][pos];
      }
    }
  }
  return out;
}

/**
 * De-interleaves and RS-repairs a received frame buffer of length `totalFrameBytes`.
 * Returns repaired data bytes (length = totalDataBytes) or null if any block is uncorrectable.
 */
export function decodeRsFrame(rawFrameBytes, totalFrameBytes) {
  const layout = getRsLayout(totalFrameBytes);
  if (rawFrameBytes.length < totalFrameBytes) return null;

  let rawBlocks;
  if (layout.numBlocks === 1) {
    rawBlocks = [rawFrameBytes.subarray(0, totalFrameBytes)];
  } else {
    rawBlocks = layout.blocks.map((b) => new Uint8Array(b.blockBytes));
    let inIdx = 0;
    const maxBlockLen = layout.blocks[0].blockBytes;
    for (let pos = 0; pos < maxBlockLen; pos++) {
      for (let b = 0; b < layout.numBlocks; b++) {
        if (pos < rawBlocks[b].length) {
          rawBlocks[b][pos] = rawFrameBytes[inIdx++];
        }
      }
    }
  }

  const out = new Uint8Array(layout.totalDataBytes);
  let outOffset = 0;
  for (let b = 0; b < layout.numBlocks; b++) {
    const repaired = rsDecodeBlock(rawBlocks[b], layout.blocks[b].nsym);
    if (!repaired) return null;
    out.set(repaired, outOffset);
    outOffset += repaired.length;
  }
  return out;
}
