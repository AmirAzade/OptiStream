# OptiStream — Air-Gapped Visual Optical Data Transfer

**OptiStream** is a zero-dependency, client-side web application that transfers files and encrypted text between two air-gapped devices (for example, a laptop display to a smartphone camera) using high-speed sequential optical frames rendered on an HTML5 `<canvas>` and captured via WebRTC (`navigator.mediaDevices.getUserMedia`).

---

## 1. Architecture Overview

OptiStream is implemented in pure ES6+ Vanilla JavaScript with zero build steps or external libraries:

```text
OptiStream/
├── index.html       # High-contrast white-and-blue UI (Sender & Receiver views)
├── css/
│   └── style.css    # Responsive layout, viewfinder overlay & packet progress grid
├── js/
│   ├── protocol.js  # Binary packet framing, Deflate compression, PBKDF2+AES-GCM, CRC32
│   ├── encoder.js   # Custom optical matrix renderer (1-bit Mono & 2-bit 4-Color QAM)
│   ├── decoder.js   # Adaptive thresholding, finder detection, homography, color calibration
│   └── app.js       # UI state, requestAnimationFrame FPS loops, telemetry & file download
└── README.md        # Technical documentation
```

### Data Flow
1. **Prepare (`protocol.js`)**: Input bytes (file or UTF-8 text) are optionally compressed via the native `CompressionStream('deflate')` API, optionally encrypted with `PBKDF2-HMAC-SHA256` (100,000 iterations) + `AES-GCM-256` via `crypto.subtle`, and split into numbered binary packets (`Chunk 0` metadata + `Chunks 1..N-1` payload), each protected with an IEEE 802.3 `CRC32` checksum.
2. **Modulate (`encoder.js`)**: Each packet is mapped onto an `N × N` optical matrix (`24×24` to `48×48`) surrounded by a white quiet zone, featuring 4 corner concentric finder patterns, a 5-patch RGB/B&W calibration strip, and an 8-bit format tag.
3. **Transmit (`app.js`)**: An adaptive `requestAnimationFrame` loop cycles continuously through all packets at the configured target FPS (5–30 FPS), ensuring dropped frames are recovered automatically on subsequent cycles.
4. **Demodulate (`decoder.js`)**: The receiver samples video frames onto a reused offscreen canvas, locates the 4 finder corners via `1:1:1:1:1` scanline detection, computes a 3×3 planar perspective homography, calibrates RGB against the calibration strip, verifies `CRC32`, and stores valid chunks in a `Map<chunkIndex, Uint8Array>`.
5. **Reassemble (`protocol.js` + `app.js`)**: Once `receivedChunks.size === totalChunks`, the receiver prompts for a password (if encrypted), decrypts, decompresses, and triggers a one-click file download (or inline text preview).

---

## 2. Binary Transport Protocol (`js/protocol.js`)

All multi-byte integer fields are serialized in **Big-Endian** network byte order using `DataView`.

```text
 0               1               2               3
 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7 0 1 2 3 4 5 6 7
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  Magic (0xAF) |          Session ID           |     Flags     |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|         Total Chunks          |          Chunk Index          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|        Payload Length         |                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+                               +
|                         Payload (N bytes)                     |
+                               +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                               |         CRC32 (4 bytes)       |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| Field | Size | Type | Description |
| :--- | :--- | :--- | :--- |
| **Magic Byte** | 1 byte | `uint8` | Fixed `0xAF` frame identifier |
| **Session ID** | 2 bytes | `uint16` | Random per-transfer ID preventing cross-session collisions |
| **Flags** | 1 byte | `uint8` | Bit `0` (`0x01`): Deflate compressed · Bit `1` (`0x02`): AES-GCM encrypted |
| **Total Chunks** | 2 bytes | `uint16` | Total packet count (`1..65535`, including Chunk 0) |
| **Chunk Index** | 2 bytes | `uint16` | Zero-based index (`0` = metadata header, `1..N-1` = data chunks) |
| **Payload Length** | 2 bytes | `uint16` | Exact byte count `N` of `Payload` in this packet |
| **Payload** | `N` bytes | `bytes` | Metadata or slice of prepared byte stream |
| **CRC32** | 4 bytes | `uint32` | IEEE 802.3 CRC32 computed over bytes `[0 .. 10 + N)` |

### Metadata Packet (`Chunk Index = 0`)
Carries schema version (`1`), `isText` flag, `originalSize` (`uint32`), UTF-8 `mimeType`, and UTF-8 `filename`.

### Encryption Payload Layout (`Flags & 0x02`)
When a password is provided, the compressed (or raw) payload stream is encrypted prior to chunking as:
- `[0..16)`: Random 128-bit PBKDF2 salt
- `[16..28)`: Random 96-bit AES-GCM IV
- `[28..)`: AES-GCM-256 ciphertext + 128-bit authentication tag

---

## 3. Optical Matrix & Calibration (`js/encoder.js` & `js/decoder.js`)

### Matrix Layout (`N × N`, `N ∈ {24, 28, 32, 36, 40, 44, 48}`)
- **Corner Finder Patterns**: Four `5×5` concentric Black/White/Black squares (`1:1:1:1:1` cross-section ratio) in all four corners, each isolated by a 1-module white separator (`6×6` corner reservation).
- **Calibration Strip** (`rows 0..1`, `cols 6..N-7`): Five fixed reference patches in order — **White** (`#FFFFFF`), **Black** (`#000000`), **Red** (`#FF0000`), **Green** (`#00FF00`), and **Blue** (`#0000FF`) — separated from data cells by a white row (`row 2`).
- **Format Tag** (`row 3`, `cols 6..13`): An 8-bit 1-bit B/W header encoding `gridSize`, `colorMode`, and a 3-bit parity checksum so the receiver automatically adapts to sender density and color changes.
- **Encoding Modes**:
  - **Mode A (1-bit Monochrome)**: White (`0`), Black (`1`) — maximum resilience under glare or low light.
  - **Mode B (2-bit Color QAM)**: Black (`00`), Cyan (`01`), Magenta (`10`), White (`11`) — doubles throughput per cell.

### Optical Calibration & Perspective Pipeline
1. **Integral Image Thresholding**: An $O(1)$-per-pixel summed-area table computes local mean luminance to binarize the camera frame cleanly even under uneven screen glare or vignetting.
2. **Finder & Orientation Lock**: Horizontal and vertical scanlines detect `1:1:1:1:1` candidates validated by diagonal ring checks. The 4 corners are oriented in 360° by scoring the Calibration Strip along each candidate top edge and verifying the 8-bit Format Tag parity.
3. **8-DOF Homography**: An 8×8 Gaussian-eliminated projective transform maps fractional grid coordinates `(col + 0.5, row + 0.5)` directly into sub-pixel camera coordinates, sampling a 5-point cross per cell.
4. **3×3 Color Crosstalk Unmixing**: Using the measured `W, K, R, G, B` patches, the decoder solves a 3×3 color unmixing matrix anchored to `K → (0,0,0)` and `W → (1,1,1)` (with per-channel normalization fallback), compensating for ambient color temperature and display-to-camera channel crosstalk.

---

## 4. Usage Instructions

### Running Locally
Because ES6 modules, `getUserMedia`, and `crypto.subtle` require an HTTP/HTTPS origin (and camera/crypto require a **Secure Context** such as `https://` or `http://localhost`), serve the directory with any static HTTP server:

```bash
# Using Python 3
python -m http.server 8080

# Or using Node.js
npx serve .
```

Then open `http://localhost:8080` in a desktop browser (Sender) and connect a mobile device over HTTPS (e.g., via GitHub Pages, local TLS proxy, or port forwarding) for the Receiver.

### Transferring Data
1. On the **Sender (Transmitter)** device:
   - Drop a file or switch to **Text** and enter your message.
   - Optionally enable/disable Deflate compression and set an AES-GCM password.
   - Tune **FPS** (`5–30`), **Grid Density** (`24×24` to `48×48`), and **Color Mode** (`1-bit` vs `2-bit`).
   - Click **Start Transmission** (and optionally **Fullscreen**).
2. On the **Receiver (Scanner)** device:
   - Switch to **Receiver (Scanner)** and click **Start Camera**.
   - Frame the entire white-bordered matrix inside the viewfinder guide.
   - Watch the **Live Packet Progress Grid** turn green as CRC32-verified packets arrive.
   - Once all packets reach 100%, enter the password (if encrypted) and click **Download File**.
