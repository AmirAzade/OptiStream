/**
 * OptiStream Binary Transport Protocol
 * -------------------------------------
 * Packet layout (Big-Endian):
 *   [0]        Magic Byte      (1 byte)  : 0xAF
 *   [1..2]     Session ID      (2 bytes) : uint16 random per transfer session
 *   [3]        Flags           (1 byte)  : bit 0 (0x01) = Deflate compressed, bit 1 (0x02) = AES-GCM encrypted
 *   [4..5]     Total Chunks    (2 bytes) : uint16 total number of packets (including metadata chunk 0)
 *   [6..7]     Chunk Index     (2 bytes) : uint16 zero-based index (0 = metadata packet, 1..N-1 = payload chunks)
 *   [8..9]     Payload Length  (2 bytes) : uint16 byte length N of payload in this frame
 *   [10..10+N) Payload         (N bytes) : raw chunk bytes
 *   [10+N..+4) CRC32           (4 bytes) : uint32 IEEE 802.3 CRC32 over bytes [0 .. 10+N)
 */

export const MAGIC_BYTE = 0xaf;
export const FLAG_COMPRESSED = 0x01;
export const FLAG_ENCRYPTED = 0x02;
export const FLAG_FOUNTAIN = 0x04;
export const FLAG_BENCHMARK = 0x08;

export const BENCHMARK_PROFILES = [
  { gridSize: 32, colorMode: '2bit', rsEnabled: true, fps: 15 },
  { gridSize: 32, colorMode: '3bit', rsEnabled: true, fps: 20 },
  { gridSize: 40, colorMode: '2bit', rsEnabled: true, fps: 20 },
  { gridSize: 40, colorMode: '3bit', rsEnabled: true, fps: 15 },
  { gridSize: 40, colorMode: '3bit', rsEnabled: true, fps: 20 },
  { gridSize: 44, colorMode: '3bit', rsEnabled: true, fps: 15 },
  { gridSize: 44, colorMode: '3bit', rsEnabled: true, fps: 20 },
  { gridSize: 48, colorMode: '3bit', rsEnabled: true, fps: 20 },
];

export const HEADER_SIZE = 10;
export const FOOTER_SIZE = 4;
export const PACKET_OVERHEAD = HEADER_SIZE + FOOTER_SIZE;

import { buildFountainPayload } from './fountain.js';
const SALT_SIZE = 16;
const IV_SIZE = 12;
const PBKDF2_ITERATIONS = 100_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Precompute IEEE 802.3 CRC32 lookup table
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Computes standard IEEE 802.3 CRC32 over a Uint8Array.
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned 32-bit integer
 */
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Reads all chunks from a ReadableStream into a single Uint8Array.
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {Promise<Uint8Array>}
 */
async function readStreamToUint8Array(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let totalLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.byteLength;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * Compresses bytes using native browser CompressionStream ('deflate').
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function compressData(data) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream API is not supported in this browser.');
  }
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  const readPromise = readStreamToUint8Array(cs.readable);
  await writer.write(data);
  await writer.close();
  return readPromise;
}

/**
 * Decompresses deflate-compressed bytes using native DecompressionStream.
 * @param {Uint8Array} data
 * @returns {Promise<Uint8Array>}
 */
export async function decompressData(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream API is not supported in this browser.');
  }
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const readPromise = readStreamToUint8Array(ds.readable);
  await writer.write(data);
  await writer.close();
  return readPromise;
}

/**
 * Derives an AES-GCM 256-bit key from a password and salt via PBKDF2-HMAC-SHA256.
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {'encrypt'|'decrypt'} usage
 * @returns {Promise<CryptoKey>}
 */
async function deriveAesKey(password, salt, usage) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Web Crypto API (crypto.subtle) requires HTTPS or localhost.');
  }
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return globalThis.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

/**
 * Encrypts bytes with PBKDF2 + AES-GCM (256-bit).
 * Output format: [16-byte salt | 12-byte IV | ciphertext + 16-byte GCM tag]
 * @param {Uint8Array} plaintext
 * @param {string} password
 * @returns {Promise<Uint8Array>}
 */
export async function encryptData(plaintext, password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const key = await deriveAesKey(password, salt, 'encrypt');
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  const ciphertext = new Uint8Array(cipherBuf);
  const out = new Uint8Array(SALT_SIZE + IV_SIZE + ciphertext.byteLength);
  out.set(salt, 0);
  out.set(iv, SALT_SIZE);
  out.set(ciphertext, SALT_SIZE + IV_SIZE);
  return out;
}

/**
 * Decrypts bytes encrypted by encryptData().
 * @param {Uint8Array} encrypted
 * @param {string} password
 * @returns {Promise<Uint8Array>}
 */
export async function decryptData(encrypted, password) {
  if (encrypted.byteLength < SALT_SIZE + IV_SIZE + 16) {
    throw new Error('Encrypted payload is truncated or malformed.');
  }
  const salt = encrypted.subarray(0, SALT_SIZE);
  const iv = encrypted.subarray(SALT_SIZE, SALT_SIZE + IV_SIZE);
  const ciphertext = encrypted.subarray(SALT_SIZE + IV_SIZE);
  const key = await deriveAesKey(password, salt, 'decrypt');
  const plainBuf = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new Uint8Array(plainBuf);
}

const COMMON_MIME_TYPES = [
  null, // 0 = custom UTF-8 MIME string follows
  'application/octet-stream',
  'text/plain;charset=utf-8',
  'text/plain',
  'application/json',
  'image/png',
  'image/jpeg',
  'application/pdf',
  'text/html',
  'application/zip',
];

/**
 * Encodes Chunk 0 metadata header payload (compact schema v3):
 *   [0]      flags (bits 4..7 = version 3, bit 0 = isText)
 *   [1..4]   originalSize (uint32)
 *   [5..8]   preparedSize (uint32 - exact byte length of chunks 1..K-1)
 *   [9]      mimeCode (1..9 = COMMON_MIME_TYPES index, 0 = custom [1B len + UTF8])
 *   [+1]     filenameLength (uint8, up to 255 bytes)
 *   [..]     filenameUTF8
 */
export function encodeMetadataPayload({
  filename = 'optistream.bin',
  mimeType = 'application/octet-stream',
  originalSize = 0,
  preparedSize = 0,
  isText = false,
}) {
  let nameBytes = textEncoder.encode(filename);
  if (nameBytes.length > 255) {
    nameBytes = nameBytes.subarray(0, 255);
  }

  const mimeIdx = COMMON_MIME_TYPES.indexOf(mimeType);
  const customMimeBytes = mimeIdx > 0 ? null : textEncoder.encode(mimeType).subarray(0, 255);
  const mimeFieldLen = customMimeBytes ? 1 + customMimeBytes.length : 0;

  const totalLen = 1 + 4 + 4 + 1 + mimeFieldLen + 1 + nameBytes.length;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);

  let offset = 0;
  view.setUint8(offset, (3 << 4) | (isText ? 1 : 0));
  offset += 1;
  view.setUint32(offset, originalSize >>> 0, false);
  offset += 4;
  view.setUint32(offset, preparedSize >>> 0, false);
  offset += 4;

  if (customMimeBytes) {
    view.setUint8(offset, 0);
    offset += 1;
    view.setUint8(offset, customMimeBytes.length);
    offset += 1;
    buf.set(customMimeBytes, offset);
    offset += customMimeBytes.length;
  } else {
    view.setUint8(offset, mimeIdx);
    offset += 1;
  }

  view.setUint8(offset, nameBytes.length);
  offset += 1;
  buf.set(nameBytes, offset);

  return buf;
}

/**
 * Decodes Chunk 0 metadata header payload.
 * @param {Uint8Array} bytes
 */
export function decodeMetadataPayload(bytes) {
  if (bytes.length < 11) {
    throw new Error('Metadata packet is too short.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const header = view.getUint8(offset);
  offset += 1;
  const version = header >> 4;
  if (version !== 3) {
    throw new Error(`Unsupported metadata version: ${version}`);
  }
  const isText = (header & 1) === 1;
  const originalSize = view.getUint32(offset, false);
  offset += 4;
  const preparedSize = view.getUint32(offset, false);
  offset += 4;

  const mimeCode = view.getUint8(offset);
  offset += 1;
  let mimeType;
  if (mimeCode === 0) {
    if (offset >= bytes.length) throw new Error('Malformed metadata MIME length.');
    const mimeLen = view.getUint8(offset);
    offset += 1;
    if (offset + mimeLen > bytes.length) throw new Error('Malformed metadata MIME field.');
    mimeType = textDecoder.decode(bytes.subarray(offset, offset + mimeLen));
    offset += mimeLen;
  } else {
    mimeType = COMMON_MIME_TYPES[mimeCode] || 'application/octet-stream';
  }

  if (offset >= bytes.length) throw new Error('Malformed metadata filename length.');
  const nameLen = view.getUint8(offset);
  offset += 1;
  if (offset + nameLen > bytes.length) {
    throw new Error('Malformed metadata filename field.');
  }
  const filename = textDecoder.decode(bytes.subarray(offset, offset + nameLen));

  return { filename, mimeType, originalSize, preparedSize, isText };
}

/**
 * Serializes a single binary OptiStream packet with header + CRC32 footer.
 */
export function serializePacket({ sessionId, flags, totalChunks, chunkIndex, payload }) {
  const packetLen = HEADER_SIZE + payload.byteLength + FOOTER_SIZE;
  const buf = new Uint8Array(packetLen);
  const view = new DataView(buf.buffer);

  view.setUint8(0, MAGIC_BYTE);
  view.setUint16(1, sessionId & 0xffff, false);
  view.setUint8(3, flags & 0xff);
  view.setUint16(4, totalChunks & 0xffff, false);
  view.setUint16(6, chunkIndex & 0xffff, false);
  view.setUint16(8, payload.byteLength & 0xffff, false);
  buf.set(payload, HEADER_SIZE);

  const checksum = crc32(buf.subarray(0, HEADER_SIZE + payload.byteLength));
  view.setUint32(HEADER_SIZE + payload.byteLength, checksum, false);

  return buf;
}

/**
 * Parses and CRC32-verifies a raw byte buffer (which may contain trailing frame padding).
 * Returns null if magic, bounds, or CRC32 validation fails.
 * @param {Uint8Array} bytes
 */
export function parsePacket(bytes) {
  if (!bytes || bytes.byteLength < PACKET_OVERHEAD) return null;
  if (bytes[0] !== MAGIC_BYTE) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sessionId = view.getUint16(1, false);
  const flags = view.getUint8(3);
  const totalChunks = view.getUint16(4, false);
  const chunkIndex = view.getUint16(6, false);
  const payloadLength = view.getUint16(8, false);

  const isFountain = (flags & FLAG_FOUNTAIN) !== 0;
  const isBenchmark = (flags & FLAG_BENCHMARK) !== 0;
  if (totalChunks === 0 || (!isFountain && !isBenchmark && chunkIndex >= totalChunks)) return null;
  const packetEnd = HEADER_SIZE + payloadLength;
  if (packetEnd + FOOTER_SIZE > bytes.byteLength) return null;

  const expectedCrc = crc32(bytes.subarray(0, packetEnd));
  const actualCrc = view.getUint32(packetEnd, false);
  if (expectedCrc !== actualCrc) return null;

  // Copy payload slice out so caller's working buffer can be safely reused
  const payload = bytes.slice(HEADER_SIZE, packetEnd);
  return {
    magic: MAGIC_BYTE,
    sessionId,
    flags,
    totalChunks,
    chunkIndex,
    payloadLength,
    payload,
    crc32: actualCrc,
  };
}

/**
 * Generates a random uint16 Session ID.
 * @returns {number}
 */
export function generateSessionId() {
  if (globalThis.crypto?.getRandomValues) {
    const arr = new Uint16Array(1);
    globalThis.crypto.getRandomValues(arr);
    return arr[0] || 1;
  }
  return Math.floor(Math.random() * 65534) + 1;
}

/**
 * Prepares a complete transfer (optional compression, optional AES-GCM encryption,
 * metadata Chunk 0, and chunked payload packets 1..N-1).
 */
export async function createTransferPackets({
  data,
  filename = 'message.txt',
  mimeType = 'text/plain;charset=utf-8',
  isText = false,
  maxPayloadBytes = 189,
  compress = true,
  password = '',
  sessionId = generateSessionId(),
}) {
  if (!(data instanceof Uint8Array)) {
    throw new Error('Transfer data must be a Uint8Array.');
  }
  if (maxPayloadBytes < 20) {
    throw new Error('maxPayloadBytes must be at least 20 bytes to hold metadata.');
  }

  let flags = 0;
  let processed = data;

  // 1. Optional Deflate compression (only applied if it actually shrinks payload)
  if (compress && data.byteLength > 0 && typeof CompressionStream !== 'undefined') {
    const compressed = await compressData(data);
    if (compressed.byteLength < data.byteLength) {
      processed = compressed;
      flags |= FLAG_COMPRESSED;
    }
  }

  // 2. Optional PBKDF2 + AES-GCM encryption
  if (password && password.length > 0) {
    processed = await encryptData(processed, password);
    flags |= FLAG_ENCRYPTED;
  }

  // 3. Build Chunk 0 metadata packet
  const metaPayload = encodeMetadataPayload({
    filename,
    mimeType,
    originalSize: data.byteLength,
    preparedSize: processed.byteLength,
    isText,
  });

  if (metaPayload.byteLength > maxPayloadBytes) {
    throw new Error(
      `Filename/MIME metadata (${metaPayload.byteLength}B) exceeds frame capacity (${maxPayloadBytes}B). Increase grid density or shorten filename.`
    );
  }

  // 4. Split processed stream into chunks 1..K
  const dataChunks = [];
  if (processed.byteLength === 0) {
    // Include one empty chunk so receiver always sees consistent structure
    dataChunks.push(new Uint8Array(0));
  } else {
    for (let offset = 0; offset < processed.byteLength; offset += maxPayloadBytes) {
      dataChunks.push(processed.subarray(offset, offset + maxPayloadBytes));
    }
  }

  const totalChunks = 1 + dataChunks.length;
  if (totalChunks > 0xffff) {
    throw new Error(
      `File requires ${totalChunks} packets, exceeding the protocol maximum of 65,535. Increase grid density or switch to 2-bit Color mode.`
    );
  }

  const packets = new Array(totalChunks);
  packets[0] = serializePacket({
    sessionId,
    flags,
    totalChunks,
    chunkIndex: 0,
    payload: metaPayload,
  });

  for (let i = 0; i < dataChunks.length; i++) {
    packets[i + 1] = serializePacket({
      sessionId,
      flags,
      totalChunks,
      chunkIndex: i + 1,
      payload: dataChunks[i],
    });
  }

  // Build uniform blockSize-padded chunks for LT Fountain XOR repair
  const paddedChunks = new Array(totalChunks);
  for (let i = 0; i < totalChunks; i++) {
    const raw = i === 0 ? metaPayload : dataChunks[i - 1];
    const padded = new Uint8Array(maxPayloadBytes);
    padded.set(raw, 0);
    paddedChunks[i] = padded;
  }

  return {
    sessionId,
    flags,
    packets,
    paddedChunks,
    blockSize: maxPayloadBytes,
    totalChunks,
    rawSize: data.byteLength,
    preparedSize: processed.byteLength,
  };
}

/**
 * Generates a single LT Fountain XOR repair packet with FLAG_FOUNTAIN set.
 */
export function createFountainRepairPacket({ paddedChunks, blockSize, sessionId, flags, seed }) {
  const payload = buildFountainPayload(paddedChunks, seed, sessionId, blockSize);
  return serializePacket({
    sessionId,
    flags: (flags | FLAG_FOUNTAIN) & 0xff,
    totalChunks: paddedChunks.length,
    chunkIndex: seed & 0xffff,
    payload,
  });
}

/**
 * Generates a Benchmark test packet with FLAG_BENCHMARK set.
 * Payload[0..3]: [profileIndex (255=DONE), totalProfiles, targetFps, expectedFrames]
 */
export function createBenchmarkPacket({
  sessionId,
  profileIndex,
  totalProfiles,
  targetFps,
  expectedFrames,
  seqIndex,
  maxPayloadBytes,
}) {
  const len = Math.max(4, maxPayloadBytes);
  const payload = new Uint8Array(len);
  payload[0] = profileIndex & 0xff;
  payload[1] = totalProfiles & 0xff;
  payload[2] = targetFps & 0xff;
  payload[3] = expectedFrames & 0xff;
  // Deterministic high-entropy filler so optical modulation is realistic
  let s = ((sessionId << 16) ^ (profileIndex << 8) ^ seqIndex ^ 0x5bd1e995) >>> 0;
  for (let i = 4; i < len; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    payload[i] = (s >>> 24) & 0xff;
  }
  return serializePacket({
    sessionId,
    flags: FLAG_BENCHMARK,
    totalChunks: Math.max(1, expectedFrames),
    chunkIndex: seqIndex & 0xffff,
    payload,
  });
}

/**
 * Reassembles a completed Map<chunkIndex, Uint8Array>, optionally decrypts and decompresses,
 * and returns the reconstructed file bytes and metadata.
 */
export async function reassembleTransfer({ chunksMap, totalChunks, flags, password = '' }) {
  if (chunksMap.size < totalChunks) {
    throw new Error(`Transfer incomplete: ${chunksMap.size}/${totalChunks} chunks received.`);
  }
  const metaBytes = chunksMap.get(0);
  if (!metaBytes) {
    throw new Error('Metadata packet (chunk 0) is missing.');
  }
  const metadata = decodeMetadataPayload(metaBytes);

  // Concatenate data chunks 1 .. totalChunks - 1
  let totalPayloadLen = 0;
  for (let i = 1; i < totalChunks; i++) {
    const chunk = chunksMap.get(i);
    if (!chunk) {
      throw new Error(`Data chunk ${i} is missing.`);
    }
    totalPayloadLen += chunk.byteLength;
  }

  let assembled = new Uint8Array(totalPayloadLen);
  let offset = 0;
  for (let i = 1; i < totalChunks; i++) {
    const chunk = chunksMap.get(i);
    assembled.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Trim any zero-padding added by Fountain XOR recovery on the final chunk
  if (metadata.preparedSize < assembled.byteLength) {
    assembled = assembled.subarray(0, metadata.preparedSize);
  }

  // Decrypt if FLAG_ENCRYPTED is set
  if (flags & FLAG_ENCRYPTED) {
    if (!password) {
      throw new Error('PASSWORD_REQUIRED');
    }
    assembled = await decryptData(assembled, password);
  }

  // Decompress if FLAG_COMPRESSED is set
  if (flags & FLAG_COMPRESSED) {
    assembled = await decompressData(assembled);
  }

  return {
    data: assembled,
    filename: metadata.filename,
    mimeType: metadata.mimeType,
    originalSize: metadata.originalSize,
    isText: metadata.isText,
  };
}
