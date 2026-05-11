/**
 * OptiStream Systematic + Rateless GF(2) Fountain Code (RLNC / Gaussian Elimination)
 * ----------------------------------------------------------------------------------
 * Eliminates tail-stall completely:
 *   - Pass 1 (Systematic): sends original chunks 0 .. K-1 directly.
 *   - Pass 2+ (Dense GF(2) Repair): generates pseudo-random ~50%-density XOR
 *     combinations keyed by a 16-bit seed (Random Linear Fountain Code over GF(2)).
 *   - Receiver Incremental GF(2) Gaussian Elimination: maintains a row-echelon
 *     pivot table so ANY M missing chunks are solved in ~M + 2 repair frames
 *     (near information-theoretic optimum) via instant back-substitution.
 */

/**
 * Fast deterministic 32-bit PRNG (Mulberry32).
 */
function createPrng(seed32) {
  let a = seed32 >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministically derives the chunk indices XORed for a given (seed, totalChunks, sessionId).
 * Uses ~50% density GF(2) random linear combinations so every repair frame has maximum
 * probability of being linearly independent, eliminating tail stalls on the last few chunks.
 */
export function getFountainIndices(seed, totalChunks, sessionId) {
  if (totalChunks <= 1) return [0];
  const mixedSeed = (((sessionId & 0xffff) << 16) | (seed & 0xffff)) ^ 0x9e3779b9;
  const rand = createPrng(mixedSeed);

  const indices = [];
  for (let i = 0; i < totalChunks; i++) {
    if (rand() < 0.5) {
      indices.push(i);
    }
  }
  // Ensure at least one index is selected
  if (indices.length === 0) {
    indices.push(Math.floor(rand() * totalChunks));
  }
  return indices;
}

/**
 * Fast XOR of src into dst in-place (32-bit word aligned fast path + byte tail).
 */
function xorInto(dst, src) {
  const len = Math.min(dst.length, src.length);
  let i = 0;
  if ((dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const words = len >> 2;
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words);
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words);
    for (let w = 0; w < words; w++) {
      d32[w] ^= s32[w];
    }
    i = words << 2;
  }
  for (; i < len; i++) {
    dst[i] ^= src[i];
  }
}

/**
 * Builds a single GF(2) Fountain XOR repair payload of length `blockSize`.
 */
export function buildFountainPayload(paddedChunks, seed, sessionId, blockSize) {
  const indices = getFountainIndices(seed, paddedChunks.length, sessionId);
  const out = new Uint8Array(blockSize);
  for (let i = 0; i < indices.length; i++) {
    xorInto(out, paddedChunks[indices[i]]);
  }
  return out;
}

/**
 * Incremental GF(2) Gaussian Elimination Decoder for Systematic + Fountain packets.
 */
export class FountainDecoder {
  constructor(totalChunks, sessionId, onChunkSolved) {
    this.totalChunks = totalChunks;
    this.sessionId = sessionId;
    this.onChunkSolved = onChunkSolved;

    this.solvedChunks = new Map(); // chunkIndex -> Uint8Array
    this.pivots = new Map();       // minIdx -> { indices: Set<number>, data: Uint8Array }
    this.blockSize = 0;
  }

  get solvedCount() {
    return this.solvedChunks.size;
  }

  get bufferedCount() {
    return this.pivots.size;
  }

  hasChunk(idx) {
    return this.solvedChunks.has(idx);
  }

  /**
   * Adds a systematic (degree-1) chunk.
   */
  addSystematicChunk(chunkIndex, payload) {
    if (this.solvedChunks.has(chunkIndex)) return false;
    if (payload.length > this.blockSize) this.blockSize = payload.length;

    const existingPivot = this.pivots.get(chunkIndex);
    if (existingPivot) {
      this.pivots.delete(chunkIndex);
    }

    this._markSolvedAndReducePivots(chunkIndex, payload);

    if (existingPivot) {
      this._insertEquation(existingPivot.indices, existingPivot.data);
    }
    this._checkFullRank();
    return true;
  }

  /**
   * Adds a GF(2) Fountain XOR repair packet (seed in chunkIndex field).
   */
  addFountainPacket(seed, payload) {
    if (this.solvedChunks.size >= this.totalChunks) return false;
    if (payload.length > this.blockSize) this.blockSize = payload.length;

    const indicesList = getFountainIndices(seed, this.totalChunks, this.sessionId);
    const data = payload.slice();
    const indices = new Set(indicesList);

    const added = this._insertEquation(indices, data);
    if (added) {
      this._checkFullRank();
    }
    return added;
  }

  _minIndex(set) {
    let min = Infinity;
    for (const v of set) {
      if (v < min) min = v;
    }
    return min;
  }

  _insertEquation(indices, data) {
    // 1. Substitute all already-solved chunks
    for (const idx of Array.from(indices)) {
      const known = this.solvedChunks.get(idx);
      if (known) {
        xorInto(data, known);
        indices.delete(idx);
      }
    }

    // 2. Reduce against existing upper-triangular pivot rows
    while (indices.size > 0) {
      const p = this._minIndex(indices);
      const piv = this.pivots.get(p);
      if (!piv) {
        if (indices.size === 1) {
          this._markSolvedAndReducePivots(p, data);
        } else {
          this.pivots.set(p, { indices, data });
        }
        return true;
      }

      xorInto(data, piv.data);
      for (const idx of piv.indices) {
        if (indices.has(idx)) indices.delete(idx);
        else indices.add(idx);
      }
    }

    return false; // Linearly dependent (redundant)
  }

  _markSolvedAndReducePivots(chunkIndex, data) {
    if (this.solvedChunks.has(chunkIndex)) return;
    this.solvedChunks.set(chunkIndex, data);
    this.onChunkSolved?.(chunkIndex, data);

    // Substitute this newly solved chunk into any pivot row that references it
    const toReinsert = [];
    for (const [p, row] of this.pivots) {
      if (row.indices.has(chunkIndex)) {
        xorInto(row.data, data);
        row.indices.delete(chunkIndex);
        if (p === chunkIndex || row.indices.size <= 1) {
          this.pivots.delete(p);
          if (row.indices.size > 0) {
            toReinsert.push(row);
          }
        }
      }
    }

    for (const row of toReinsert) {
      this._insertEquation(row.indices, row.data);
    }
  }

  /**
   * When solvedChunks + pivots reaches totalChunks, the upper-triangular system has full rank.
   * Back-substitute from highest pivot down to lowest to solve ALL remaining chunks at once!
   */
  _checkFullRank() {
    if (this.solvedChunks.size >= this.totalChunks) return;
    if (this.solvedChunks.size + this.pivots.size < this.totalChunks) return;

    const pivotKeys = Array.from(this.pivots.keys()).sort((a, b) => b - a);
    for (const p of pivotKeys) {
      const row = this.pivots.get(p);
      if (!row) continue;
      this.pivots.delete(p);

      for (const idx of Array.from(row.indices)) {
        if (idx === p) continue;
        const known = this.solvedChunks.get(idx);
        if (known) {
          xorInto(row.data, known);
          row.indices.delete(idx);
        }
      }

      if (row.indices.size === 1 && row.indices.has(p)) {
        if (!this.solvedChunks.has(p)) {
          this.solvedChunks.set(p, row.data);
          this.onChunkSolved?.(p, row.data);
        }
      }
    }
  }
}
