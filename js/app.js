/**
 * OptiStream Application Controller
 * ----------------------------------
 * Manages Sender & Receiver views, adaptive requestAnimationFrame loops,
 * Systematic + LT Fountain transmission/decoding, webcam mirror mode,
 * automatic camera stop on completion, and file download.
 */

import {
  FLAG_COMPRESSED,
  FLAG_ENCRYPTED,
  FLAG_FOUNTAIN,
  FLAG_BENCHMARK,
  BENCHMARK_PROFILES,
  generateSessionId,
  createTransferPackets,
  createFountainRepairPacket,
  createBenchmarkPacket,
  decodeMetadataPayload,
  reassembleTransfer,
} from './protocol.js';
import {
  COLOR_MODE_2BIT,
  getFrameCapacity,
  renderFrame,
} from './encoder.js';
import { OptiStreamDecoder } from './decoder.js';
import { FountainDecoder } from './fountain.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ============================================================================
// DOM References
// ============================================================================
const els = {
  secureBanner: document.getElementById('secure-context-banner'),
  tabSender: document.getElementById('tab-sender'),
  tabReceiver: document.getElementById('tab-receiver'),
  viewSender: document.getElementById('view-sender'),
  viewReceiver: document.getElementById('view-receiver'),

  // Sender controls
  payloadTabFile: document.getElementById('payload-tab-file'),
  payloadTabText: document.getElementById('payload-tab-text'),
  inputPanelFile: document.getElementById('input-panel-file'),
  inputPanelText: document.getElementById('input-panel-text'),
  dropzone: document.getElementById('file-dropzone'),
  fileInput: document.getElementById('file-input'),
  selectedFileInfo: document.getElementById('selected-file-info'),
  textPayloadInput: document.getElementById('text-payload-input'),
  optCompress: document.getElementById('opt-compress'),
  optFountain: document.getElementById('opt-fountain'),
  optRsFec: document.getElementById('opt-rs-fec'),
  senderPassword: document.getElementById('sender-password'),
  toggleSenderPw: document.getElementById('toggle-sender-pw'),

  presetBtns: document.querySelectorAll('.preset-btn'),
  sliderFps: document.getElementById('slider-fps'),
  valFps: document.getElementById('val-fps'),
  sliderDensity: document.getElementById('slider-density'),
  valDensity: document.getElementById('val-density'),
  colorModeRadios: document.querySelectorAll('input[name="color-mode"]'),

  senderSizeStat: document.getElementById('sender-size-stat'),
  senderCapStat: document.getElementById('sender-cap-stat'),
  senderChunksStat: document.getElementById('sender-chunks-stat'),
  senderRateStat: document.getElementById('sender-rate-stat'),

  btnStartPause: document.getElementById('btn-start-pause'),
  btnStep: document.getElementById('btn-step'),
  btnBenchmarkSender: document.getElementById('btn-benchmark-sender'),
  btnResetSender: document.getElementById('btn-reset-sender'),
  senderError: document.getElementById('sender-error'),

  senderStageCard: document.getElementById('sender-stage-card'),
  btnFullscreen: document.getElementById('btn-fullscreen-canvas'),
  senderSessionBadge: document.getElementById('sender-session-badge'),
  senderFrameBadge: document.getElementById('sender-frame-badge'),
  senderCycleBadge: document.getElementById('sender-cycle-badge'),
  senderActualFps: document.getElementById('sender-actual-fps'),
  txCanvas: document.getElementById('tx-canvas'),

  // Receiver controls
  btnRxMirror: document.getElementById('btn-rx-mirror'),
  optRxFastRoi: document.getElementById('opt-rx-fast-roi'),
  cameraSelect: document.getElementById('camera-select'),
  btnToggleCamera: document.getElementById('btn-toggle-camera'),
  btnResetReceiver: document.getElementById('btn-reset-receiver'),
  viewfinderWrap: document.querySelector('.viewfinder-wrap'),
  rxVideo: document.getElementById('rx-video'),
  rxOverlay: document.getElementById('rx-overlay'),
  rxStatusPill: document.getElementById('rx-status-pill'),
  receiverError: document.getElementById('receiver-error'),

  rxSessionBadge: document.getElementById('rx-session-badge'),
  rxFormatBadge: document.getElementById('rx-format-badge'),
  rxSecurityBadge: document.getElementById('rx-security-badge'),
  rxSpeed: document.getElementById('rx-speed'),
  rxDropRate: document.getElementById('rx-drop-rate'),
  rxReceivedCount: document.getElementById('rx-received-count'),
  rxProgressFill: document.getElementById('rx-progress-fill'),
  rxFilePreviewMeta: document.getElementById('rx-file-preview-meta'),
  packetMatrix: document.getElementById('packet-matrix'),

  rxModalBackdrop: document.getElementById('rx-modal-backdrop'),
  rxDecryptCard: document.getElementById('rx-decrypt-card'),
  rxPasswordInput: document.getElementById('rx-password-input'),
  btnRxDecrypt: document.getElementById('btn-rx-decrypt'),
  rxDecryptError: document.getElementById('rx-decrypt-error'),

  rxCompleteCard: document.getElementById('rx-complete-card'),
  rxCompleteFilename: document.getElementById('rx-complete-filename'),
  rxCompleteDetails: document.getElementById('rx-complete-details'),
  rxCompleteStats: document.getElementById('rx-complete-stats'),
  btnDownloadFile: document.getElementById('btn-download-file'),
  btnScanAnother: document.getElementById('btn-scan-another'),
  rxBenchmarkCard: document.getElementById('rx-benchmark-card'),
  rxBenchWinner: document.getElementById('rx-bench-winner'),
  rxBenchSummary: document.getElementById('rx-bench-summary'),
  rxBenchTbody: document.getElementById('rx-bench-tbody'),
  btnBenchScanAgain: document.getElementById('btn-bench-scan-again'),
  rxTextPreviewWrap: document.getElementById('rx-text-preview-wrap'),
  rxTextPreview: document.getElementById('rx-text-preview'),
  btnCopyText: document.getElementById('btn-copy-text'),
};

if (!window.isSecureContext) {
  els.secureBanner.classList.remove('hidden');
}

// ============================================================================
// Mode Switching
// ============================================================================
function setAppMode(mode) {
  const isSender = mode === 'sender';
  els.tabSender.classList.toggle('active', isSender);
  els.tabSender.setAttribute('aria-selected', String(isSender));
  els.tabReceiver.classList.toggle('active', !isSender);
  els.tabReceiver.setAttribute('aria-selected', String(!isSender));

  els.viewSender.classList.toggle('active', isSender);
  els.viewSender.classList.toggle('hidden', !isSender);
  els.viewReceiver.classList.toggle('active', !isSender);
  els.viewReceiver.classList.toggle('hidden', isSender);

  if (isSender) {
    stopCamera();
  } else {
    pauseTransmission();
    refreshCameraList();
  }
}

els.tabSender.addEventListener('click', () => setAppMode('sender'));
els.tabReceiver.addEventListener('click', () => setAppMode('receiver'));

// ============================================================================
// SENDER STATE & LOGIC
// ============================================================================
const txState = {
  payloadMode: 'file',
  selectedFile: null,
  targetFps: 15,
  gridSize: 32,
  colorMode: COLOR_MODE_2BIT,

  packets: null,
  paddedChunks: null,
  blockSize: 0,
  fountainSeed: 1,
  sessionId: null,
  flags: 0,
  rawSize: 0,
  preparedSize: 0,
  frameIndex: 0,
  cycleCount: 0,

  running: false,
  benchmarking: false,
  benchAligning: false,
  benchState: null,
  rafId: null,
  lastFrameTime: 0,
  fpsWindowStart: 0,
  fpsFrameCount: 0,
  dirty: true,
};

function getSelectedColorMode() {
  for (const r of els.colorModeRadios) {
    if (r.checked) return r.value;
  }
  return COLOR_MODE_2BIT;
}

function showSenderError(msg) {
  if (!msg) {
    els.senderError.classList.add('hidden');
    els.senderError.textContent = '';
  } else {
    els.senderError.textContent = msg;
    els.senderError.classList.remove('hidden');
  }
}

function updateCapacityPreview() {
  const rsEnabled = els.optRsFec?.checked ?? true;
  const { maxPayloadBytes } = getFrameCapacity(txState.gridSize, txState.colorMode, rsEnabled);
  els.senderCapStat.textContent = `${maxPayloadBytes} B/f`;
  const kbps = (maxPayloadBytes * txState.targetFps) / 1024;
  if (txState.packets) {
    const cycleSec = (txState.packets.length / txState.targetFps).toFixed(1);
    els.senderRateStat.textContent = `${cycleSec}s · ${kbps.toFixed(1)} KB/s`;
  } else {
    els.senderRateStat.textContent = `~${kbps.toFixed(1)} KB/s`;
  }
}

function clearPreparedTransfer() {
  txState.packets = null;
  txState.paddedChunks = null;
  txState.blockSize = 0;
  txState.fountainSeed = 1;
  txState.sessionId = null;
  txState.frameIndex = 0;
  txState.cycleCount = 0;
  txState.dirty = true;
  els.senderSizeStat.textContent = '—';
  els.senderChunksStat.textContent = '0 pkts';
  els.senderSessionBadge.textContent = 'Session —';
  els.senderFrameBadge.textContent = 'Idle';
  els.senderCycleBadge.classList.add('hidden');
  updateCapacityPreview();
  drawIdleSenderCanvas();
}

function drawIdleSenderCanvas() {
  const ctx = els.txCanvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, els.txCanvas.width, els.txCanvas.height);

  ctx.strokeStyle = '#d9e3f4';
  ctx.lineWidth = 3;
  ctx.strokeRect(24, 24, els.txCanvas.width - 48, els.txCanvas.height - 48);

  ctx.fillStyle = '#5d6e8a';
  ctx.font = '600 22px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Drop a file or enter text, then click Start', els.txCanvas.width / 2, els.txCanvas.height / 2);
}

async function prepareTransmission() {
  showSenderError('');

  let data, filename, mimeType, isText;
  if (txState.payloadMode === 'file') {
    if (!txState.selectedFile) {
      throw new Error('Please select or drop a file first.');
    }
    ({ data, filename, mimeType } = txState.selectedFile);
    isText = false;
  } else {
    const text = els.textPayloadInput.value;
    if (!text || text.length === 0) {
      throw new Error('Please enter text to transmit.');
    }
    data = textEncoder.encode(text);
    filename = 'message.txt';
    mimeType = 'text/plain;charset=utf-8';
    isText = true;
  }

  const rsEnabled = els.optRsFec?.checked ?? true;
  const { maxPayloadBytes } = getFrameCapacity(txState.gridSize, txState.colorMode, rsEnabled);
  const prepared = await createTransferPackets({
    data,
    filename,
    mimeType,
    isText,
    maxPayloadBytes,
    compress: els.optCompress.checked,
    password: els.senderPassword.value,
  });

  txState.packets = prepared.packets;
  txState.paddedChunks = prepared.paddedChunks;
  txState.blockSize = prepared.blockSize;
  txState.fountainSeed = 1;
  txState.sessionId = prepared.sessionId;
  txState.flags = prepared.flags;
  txState.rawSize = prepared.rawSize;
  txState.preparedSize = prepared.preparedSize;
  txState.frameIndex = 0;
  txState.cycleCount = 1;
  txState.dirty = false;

  els.senderSizeStat.textContent = `${formatBytes(prepared.rawSize)} → ${formatBytes(prepared.preparedSize)}`;
  els.senderChunksStat.textContent = `${prepared.totalChunks} pkts`;
  els.senderSessionBadge.textContent = `Session 0x${prepared.sessionId.toString(16).toUpperCase().padStart(4, '0')}`;
  els.senderCycleBadge.classList.remove('hidden');
  updateCapacityPreview();
  renderCurrentTxFrame();
}

function renderCurrentTxFrame() {
  if (!txState.packets || txState.packets.length === 0) return;
  const rsEnabled = els.optRsFec?.checked ?? true;

  const useFountain = els.optFountain.checked && txState.cycleCount >= 2 && txState.paddedChunks;
  if (useFountain) {
    const seed = txState.fountainSeed;
    txState.fountainSeed = (seed % 65535) + 1;
    const pkt = createFountainRepairPacket({
      paddedChunks: txState.paddedChunks,
      blockSize: txState.blockSize,
      sessionId: txState.sessionId,
      flags: txState.flags,
      seed,
    });
    renderFrame(els.txCanvas, pkt, {
      gridSize: txState.gridSize,
      colorMode: txState.colorMode,
      rsEnabled,
    });
    els.senderFrameBadge.textContent = `Fountain XOR #${seed}`;
    els.senderCycleBadge.textContent = `Repair (Pass ${txState.cycleCount})`;
  } else {
    const pkt = txState.packets[txState.frameIndex];
    renderFrame(els.txCanvas, pkt, {
      gridSize: txState.gridSize,
      colorMode: txState.colorMode,
      rsEnabled,
    });
    els.senderFrameBadge.textContent = `Frame ${txState.frameIndex + 1} / ${txState.packets.length}`;
    els.senderCycleBadge.textContent = `Cycle ${txState.cycleCount}`;
  }
}

function advanceTxFrame() {
  if (!txState.packets || txState.packets.length === 0) return;
  renderCurrentTxFrame();
  txState.frameIndex++;
  if (txState.frameIndex >= txState.packets.length) {
    txState.frameIndex = 0;
    txState.cycleCount++;
  }
}

function txLoop(now) {
  if (!txState.running) return;
  const interval = 1000 / txState.targetFps;

  if (!txState.lastFrameTime) {
    txState.lastFrameTime = now;
    txState.fpsWindowStart = now;
    txState.fpsFrameCount = 0;
  }

  const elapsed = now - txState.lastFrameTime;
  if (elapsed >= interval) {
    txState.lastFrameTime = now - (elapsed % interval);
    advanceTxFrame();
    txState.fpsFrameCount++;

    const windowElapsed = now - txState.fpsWindowStart;
    if (windowElapsed >= 500) {
      const actualFps = (txState.fpsFrameCount * 1000) / windowElapsed;
      els.senderActualFps.textContent = `${actualFps.toFixed(1)} FPS`;
      txState.fpsWindowStart = now;
      txState.fpsFrameCount = 0;
    }
  }

  txState.rafId = requestAnimationFrame(txLoop);
}

async function startTransmission() {
  try {
    if (txState.dirty || !txState.packets) {
      await prepareTransmission();
    }
    txState.running = true;
    txState.lastFrameTime = 0;
    els.btnStartPause.textContent = 'Pause';
    txState.rafId = requestAnimationFrame(txLoop);
  } catch (err) {
    showSenderError(err.message || String(err));
  }
}

function pauseTransmission() {
  txState.running = false;
  txState.benchmarking = false;
  txState.benchAligning = false;
  txState.benchState = null;
  if (txState.rafId !== null) {
    cancelAnimationFrame(txState.rafId);
    txState.rafId = null;
  }
  els.btnStartPause.textContent = txState.packets ? 'Resume' : 'Start';
  if (els.btnBenchmarkSender) els.btnBenchmarkSender.textContent = 'Benchmark';
  els.senderActualFps.textContent = '0 FPS';
}

function prepareBenchmarkAlignment() {
  pauseTransmission();
  showSenderError('');
  const sessionId = generateSessionId();
  txState.benchAligning = true;
  txState.benchState = {
    sessionId,
    profileIdx: 0,
    seqIdx: 0,
    doneSeq: 0,
    lastFrameTime: 0,
    fpsWindowStart: 0,
    fpsFrameCount: 0,
  };

  // Render static alignment frame (40x40 3-bit + RS) so user can position phone until green lock
  const alignProf = { gridSize: 40, colorMode: '3bit', rsEnabled: true, fps: 15 };
  const { maxPayloadBytes } = getFrameCapacity(alignProf.gridSize, alignProf.colorMode, alignProf.rsEnabled);
  const pkt = createBenchmarkPacket({
    sessionId,
    profileIndex: 254, // ALIGN frame
    totalProfiles: BENCHMARK_PROFILES.length,
    targetFps: alignProf.fps,
    expectedFrames: 1,
    seqIndex: 0,
    maxPayloadBytes,
  });
  renderFrame(els.txCanvas, pkt, alignProf);

  els.senderSessionBadge.textContent = `Bench 0x${sessionId.toString(16).toUpperCase().padStart(4, '0')}`;
  els.senderFrameBadge.textContent = 'Aim phone until green, then press Start';
  els.senderCycleBadge.textContent = 'Aligning';
  els.senderCycleBadge.classList.remove('hidden');
  els.btnStartPause.textContent = 'Start Benchmark';
  els.btnBenchmarkSender.textContent = 'Cancel Bench';
}

function startBenchmarkSweep() {
  if (!txState.benchState) {
    prepareBenchmarkAlignment();
  }
  txState.benchAligning = false;
  txState.benchmarking = true;
  txState.benchState.lastFrameTime = 0;
  els.btnStartPause.textContent = 'Start';
  els.btnBenchmarkSender.textContent = 'Stop Bench';
  txState.rafId = requestAnimationFrame(benchLoop);
}

function benchLoop(now) {
  if (!txState.benchmarking || !txState.benchState) return;
  const st = txState.benchState;
  const totalProfiles = BENCHMARK_PROFILES.length;
  const isDonePhase = st.profileIdx >= totalProfiles;
  const prof = isDonePhase
    ? { gridSize: 32, colorMode: '1bit', rsEnabled: true, fps: 12 }
    : BENCHMARK_PROFILES[st.profileIdx];
  const expectedFrames = isDonePhase ? 10 : Math.round(prof.fps * 2.0);
  const interval = 1000 / prof.fps;

  if (!st.lastFrameTime) {
    st.lastFrameTime = now;
    st.fpsWindowStart = now;
    st.fpsFrameCount = 0;
  }

  const elapsed = now - st.lastFrameTime;
  if (elapsed >= interval) {
    st.lastFrameTime = now - (elapsed % interval);
    const { maxPayloadBytes } = getFrameCapacity(prof.gridSize, prof.colorMode, prof.rsEnabled);

    const pkt = createBenchmarkPacket({
      sessionId: st.sessionId,
      profileIndex: isDonePhase ? 255 : st.profileIdx,
      totalProfiles,
      targetFps: prof.fps,
      expectedFrames,
      seqIndex: isDonePhase ? st.doneSeq : st.seqIdx,
      maxPayloadBytes,
    });

    renderFrame(els.txCanvas, pkt, {
      gridSize: prof.gridSize,
      colorMode: prof.colorMode,
      rsEnabled: prof.rsEnabled,
    });

    if (isDonePhase) {
      els.senderFrameBadge.textContent = 'Finishing Benchmark...';
      els.senderCycleBadge.textContent = 'DONE';
      st.doneSeq++;
      if (st.doneSeq >= expectedFrames) {
        pauseTransmission();
        els.senderFrameBadge.textContent = 'Benchmark Complete';
        return;
      }
    } else {
      els.senderFrameBadge.textContent = `Bench ${st.profileIdx + 1}/${totalProfiles} · ${prof.gridSize}×${prof.gridSize} ${prof.colorMode}`;
      els.senderCycleBadge.textContent = `${prof.fps} FPS (${st.seqIdx + 1}/${expectedFrames})`;
      st.seqIdx++;
      if (st.seqIdx >= expectedFrames) {
        st.profileIdx++;
        st.seqIdx = 0;
      }
    }

    st.fpsFrameCount++;
    const winElapsed = now - st.fpsWindowStart;
    if (winElapsed >= 500) {
      els.senderActualFps.textContent = `${((st.fpsFrameCount * 1000) / winElapsed).toFixed(1)} FPS`;
      st.fpsWindowStart = now;
      st.fpsFrameCount = 0;
    }
  }

  txState.rafId = requestAnimationFrame(benchLoop);
}

// Payload tabs
els.payloadTabFile.addEventListener('click', () => {
  txState.payloadMode = 'file';
  els.payloadTabFile.classList.add('active');
  els.payloadTabText.classList.remove('active');
  els.inputPanelFile.classList.remove('hidden');
  els.inputPanelText.classList.add('hidden');
  pauseTransmission();
  clearPreparedTransfer();
});

els.payloadTabText.addEventListener('click', () => {
  txState.payloadMode = 'text';
  els.payloadTabText.classList.add('active');
  els.payloadTabFile.classList.remove('active');
  els.inputPanelText.classList.remove('hidden');
  els.inputPanelFile.classList.add('hidden');
  pauseTransmission();
  clearPreparedTransfer();
});

async function loadSelectedFile(file) {
  if (!file) return;
  const buf = await file.arrayBuffer();
  txState.selectedFile = {
    data: new Uint8Array(buf),
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
  };
  els.selectedFileInfo.textContent = `${file.name} (${formatBytes(file.size)})`;
  pauseTransmission();
  txState.dirty = true;
  showSenderError('');
  prepareTransmission().catch((err) => showSenderError(err.message || String(err)));
}

els.fileInput.addEventListener('change', (e) => {
  if (e.target.files?.[0]) loadSelectedFile(e.target.files[0]);
});

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('drag-over');
});
els.dropzone.addEventListener('dragleave', () => els.dropzone.classList.remove('drag-over'));
els.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('drag-over');
  if (e.dataTransfer?.files?.[0]) loadSelectedFile(e.dataTransfer.files[0]);
});

els.textPayloadInput.addEventListener('input', () => { txState.dirty = true; });
els.optCompress.addEventListener('change', () => { txState.dirty = true; });
els.senderPassword.addEventListener('input', () => { txState.dirty = true; });

els.toggleSenderPw.addEventListener('click', () => {
  const isPw = els.senderPassword.type === 'password';
  els.senderPassword.type = isPw ? 'text' : 'password';
  els.toggleSenderPw.textContent = isPw ? 'Hide' : 'Show';
});

els.sliderFps.addEventListener('input', () => {
  txState.targetFps = Number(els.sliderFps.value);
  els.valFps.textContent = `${txState.targetFps} FPS`;
  updateCapacityPreview();
});

async function handleGeometryChange() {
  txState.gridSize = Number(els.sliderDensity.value);
  txState.colorMode = getSelectedColorMode();
  els.valDensity.innerHTML = `${txState.gridSize} &times; ${txState.gridSize}`;
  updateCapacityPreview();

  if (txState.packets) {
    try {
      await prepareTransmission();
    } catch (err) {
      pauseTransmission();
      showSenderError(err.message || String(err));
    }
  }
}

els.sliderDensity.addEventListener('input', handleGeometryChange);
els.optRsFec?.addEventListener('change', handleGeometryChange);
for (const radio of els.colorModeRadios) {
  radio.addEventListener('change', handleGeometryChange);
}

for (const btn of els.presetBtns) {
  btn.addEventListener('click', () => {
    for (const b of els.presetBtns) b.classList.remove('active');
    btn.classList.add('active');
    els.sliderFps.value = btn.dataset.fps;
    els.sliderDensity.value = btn.dataset.density;
    for (const r of els.colorModeRadios) {
      r.checked = r.value === btn.dataset.color;
    }
    txState.targetFps = Number(btn.dataset.fps);
    els.valFps.textContent = `${txState.targetFps} FPS`;
    handleGeometryChange();
  });
}

els.btnStartPause.addEventListener('click', () => {
  if (txState.benchAligning) {
    startBenchmarkSweep();
    return;
  }
  if (txState.running || txState.benchmarking) pauseTransmission();
  else startTransmission();
});

els.btnStep.addEventListener('click', async () => {
  pauseTransmission();
  try {
    if (txState.dirty || !txState.packets) {
      await prepareTransmission();
    } else {
      advanceTxFrame();
    }
  } catch (err) {
    showSenderError(err.message || String(err));
  }
});

els.btnResetSender.addEventListener('click', () => {
  pauseTransmission();
  clearPreparedTransfer();
  showSenderError('');
});

els.btnBenchmarkSender?.addEventListener('click', () => {
  if (txState.benchmarking || txState.benchAligning) pauseTransmission();
  else prepareBenchmarkAlignment();
});

els.btnFullscreen.addEventListener('click', async () => {
  if (!document.fullscreenElement) {
    await els.senderStageCard.requestFullscreen?.();
  } else {
    await document.exitFullscreen?.();
  }
});

// ============================================================================
// RECEIVER STATE & LOGIC
// ============================================================================
const decoder = new OptiStreamDecoder(760);

const rxState = {
  stream: null,
  scanning: false,
  rafId: null,
  mirrorUserOverride: null,

  sessionId: null,
  totalChunks: 0,
  flags: 0,
  chunksMap: new Map(),
  fountain: null,
  cellNodes: [],
  latestCellEl: null,

  framesProcessed: 0,
  framesFailed: 0,
  speedSamples: [],
  activeDetectMs: 0,
  lastLoopTime: 0,
  totalUniqueBytes: 0,
  startTime: 0,
  completed: false,
  benchmark: null,
  assembledResult: null,
  downloadUrl: null,
};

function applyMirrorState(shouldMirror) {
  els.btnRxMirror.setAttribute('aria-pressed', String(shouldMirror));
  els.btnRxMirror.classList.toggle('btn-toggle-active', shouldMirror);
  els.viewfinderWrap.classList.toggle('mirrored', shouldMirror);
}

function detectAutoMirror(stream) {
  if (rxState.mirrorUserOverride !== null) return rxState.mirrorUserOverride;
  const track = stream.getVideoTracks?.()[0];
  if (!track) return false;
  const settings = track.getSettings?.() || {};
  if (settings.facingMode === 'environment') return false;
  if (settings.facingMode === 'user') return true;
  const label = (track.label || '').toLowerCase();
  if (/back|rear|environment/.test(label)) return false;
  if (/front|user|webcam|integrated|facetime|hd camera|usb/.test(label)) return true;
  // On desktop/laptop without facingMode, default to mirrored like a natural webcam
  return !('ontouchstart' in window);
}

els.btnRxMirror.addEventListener('click', () => {
  const next = els.btnRxMirror.getAttribute('aria-pressed') !== 'true';
  rxState.mirrorUserOverride = next;
  applyMirrorState(next);
});

els.optRxFastRoi?.addEventListener('change', () => {
  decoder.setFastRoi(els.optRxFastRoi.checked);
});

function showReceiverError(msg) {
  if (!msg) {
    els.receiverError.classList.add('hidden');
    els.receiverError.textContent = '';
  } else {
    els.receiverError.textContent = msg;
    els.receiverError.classList.remove('hidden');
  }
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const prev = els.cameraSelect.value;
    els.cameraSelect.innerHTML = '<option value="">Default Camera</option>';
    cams.forEach((cam, idx) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${idx + 1}`;
      els.cameraSelect.appendChild(opt);
    });
    if (prev) els.cameraSelect.value = prev;
  } catch {
    // Ignore enumerate errors before permission
  }
}

async function startCamera() {
  showReceiverError('');
  if (!navigator.mediaDevices?.getUserMedia) {
    showReceiverError('Camera API unavailable. Ensure HTTPS or localhost.');
    return;
  }

  stopCamera();

  const deviceId = els.cameraSelect.value;
  const videoConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    rxState.stream = stream;
    els.rxVideo.srcObject = stream;
    await els.rxVideo.play();
    await refreshCameraList();

    applyMirrorState(detectAutoMirror(stream));

    rxState.scanning = true;
    rxState.lastLoopTime = performance.now();
    els.btnToggleCamera.textContent = 'Stop Camera';
    els.rxStatusPill.textContent = 'Scanning for OptiStream matrix...';
    rxState.rafId = requestAnimationFrame(rxLoop);
  } catch (err) {
    showReceiverError(`Unable to access camera: ${err.message || err.name}`);
  }
}

function stopCamera() {
  rxState.scanning = false;
  if (rxState.rafId !== null) {
    cancelAnimationFrame(rxState.rafId);
    rxState.rafId = null;
  }
  if (rxState.stream) {
    for (const track of rxState.stream.getTracks()) {
      track.stop();
    }
    rxState.stream = null;
  }
  els.rxVideo.srcObject = null;
  els.btnToggleCamera.textContent = 'Start Camera';
  if (!rxState.completed) {
    els.rxStatusPill.textContent = 'Camera Idle';
  }
  clearOverlay();
}

function resetReceiverSession() {
  if (rxState.downloadUrl) {
    URL.revokeObjectURL(rxState.downloadUrl);
    rxState.downloadUrl = null;
  }
  rxState.sessionId = null;
  rxState.totalChunks = 0;
  rxState.flags = 0;
  rxState.chunksMap.clear();
  rxState.fountain = null;
  rxState.cellNodes = [];
  rxState.latestCellEl = null;
  rxState.framesProcessed = 0;
  rxState.framesFailed = 0;
  rxState.speedSamples = [];
  rxState.activeDetectMs = 0;
  rxState.lastLoopTime = 0;
  rxState.totalUniqueBytes = 0;
  rxState.startTime = 0;
  rxState.completed = false;
  rxState.benchmark = null;
  rxState.assembledResult = null;

  els.rxSessionBadge.textContent = 'Session —';
  els.rxFormatBadge.textContent = 'Auto';
  els.rxSecurityBadge.classList.add('hidden');
  els.rxSpeed.textContent = '0.0 KB/s';
  els.rxDropRate.textContent = '0.0%';
  els.rxReceivedCount.textContent = '0 / 0';
  els.rxProgressFill.style.width = '0%';
  els.rxFilePreviewMeta.textContent = 'Waiting for lock...';
  els.packetMatrix.innerHTML = '<p class="muted-xs">Packets appear here once decoded.</p>';

  els.rxDecryptCard.classList.add('hidden');
  els.rxDecryptError.classList.add('hidden');
  els.rxPasswordInput.value = '';
  els.rxCompleteCard.classList.add('hidden');
  els.rxBenchmarkCard?.classList.add('hidden');
  els.rxModalBackdrop.classList.add('hidden');
  els.rxTextPreviewWrap.classList.add('hidden');
  els.rxStatusPill.textContent = rxState.scanning ? 'Scanning for OptiStream matrix...' : 'Tap Start Camera to scan';
}

function buildPacketGrid(totalChunks) {
  els.packetMatrix.innerHTML = '';
  const frag = document.createDocumentFragment();
  const compact = totalChunks > 250;
  rxState.cellNodes = new Array(totalChunks);

  for (let i = 0; i < totalChunks; i++) {
    const cell = document.createElement('div');
    cell.className = compact ? 'pkt-cell compact' : 'pkt-cell';
    cell.title = i === 0 ? 'Packet 0 (Metadata)' : `Packet ${i}`;
    rxState.cellNodes[i] = cell;
    frag.appendChild(cell);
  }
  els.packetMatrix.appendChild(frag);
}

function clearOverlay() {
  const canvas = els.rxOverlay;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawOverlay(result) {
  const video = els.rxVideo;
  const canvas = els.rxOverlay;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(1, Math.round(rect.width * dpr));
  const ch = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, ch);

  const guideSize = Math.min(cw, ch) * 0.72;
  const gx = (cw - guideSize) / 2;
  const gy = (ch - guideSize) / 2;
  ctx.save();
  ctx.strokeStyle = result?.ok ? 'rgba(23, 178, 106, 0.75)' : 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 2 * dpr;
  ctx.setLineDash([10 * dpr, 8 * dpr]);
  ctx.strokeRect(gx, gy, guideSize, guideSize);
  ctx.restore();

  if (!result?.corners || result.corners.length === 0 || !video.videoWidth || !video.videoHeight) {
    return;
  }

  const scale = Math.min(cw / video.videoWidth, ch / video.videoHeight);
  const offsetX = (cw - video.videoWidth * scale) / 2;
  const offsetY = (ch - video.videoHeight * scale) / 2;

  const pts = result.corners.map((p) => ({
    x: offsetX + p.x * scale,
    y: offsetY + p.y * scale,
  }));

  if (pts.length === 4) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.strokeStyle = result.ok ? '#17b26a' : '#3b82f6';
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
    ctx.restore();
  }

  for (const pt of pts) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 6 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = result.ok ? '#17b26a' : '#60a5fa';
    ctx.fill();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
}

function updateReceiverTelemetry(now) {
  const cutoff = now - 3000;
  while (rxState.speedSamples.length > 0 && rxState.speedSamples[0].time < cutoff) {
    rxState.speedSamples.shift();
  }
  let recentBytes = 0;
  for (const s of rxState.speedSamples) recentBytes += s.bytes;
  const windowSec = rxState.speedSamples.length > 1
    ? Math.max(0.5, (now - rxState.speedSamples[0].time) / 1000)
    : 1;
  const speedKbps = recentBytes / 1024 / windowSec;

  const dropPct = rxState.framesProcessed > 0
    ? (rxState.framesFailed / rxState.framesProcessed) * 100
    : 0;

  const buffered = rxState.fountain && !rxState.completed ? rxState.fountain.bufferedCount : 0;
  const effectiveCount = Math.min(rxState.totalChunks, rxState.chunksMap.size + buffered);

  els.rxSpeed.textContent = `${speedKbps.toFixed(1)} KB/s`;
  els.rxDropRate.textContent = `${dropPct.toFixed(1)}%`;
  els.rxReceivedCount.textContent = buffered > 0
    ? `${rxState.chunksMap.size}+${buffered} / ${rxState.totalChunks}`
    : `${rxState.chunksMap.size} / ${rxState.totalChunks}`;

  const pct = rxState.totalChunks > 0
    ? Math.round((effectiveCount / rxState.totalChunks) * 100)
    : 0;
  els.rxProgressFill.style.width = `${pct}%`;
}

async function finalizeTransfer(password = '') {
  try {
    const result = await reassembleTransfer({
      chunksMap: rxState.chunksMap,
      totalChunks: rxState.totalChunks,
      flags: rxState.flags,
      password,
    });

    rxState.assembledResult = result;
    els.rxDecryptCard.classList.add('hidden');
    els.rxDecryptError.classList.add('hidden');

    if (rxState.downloadUrl) {
      URL.revokeObjectURL(rxState.downloadUrl);
    }
    const blob = new Blob([result.data], { type: result.mimeType || 'application/octet-stream' });
    rxState.downloadUrl = URL.createObjectURL(blob);

    const activeSec = Math.max(0.1, rxState.activeDetectMs / 1000);
    const avgSpeedKbps = (rxState.totalUniqueBytes / 1024) / activeSec;
    const avgDropPct = rxState.framesProcessed > 0
      ? (rxState.framesFailed / rxState.framesProcessed) * 100
      : 0;

    els.rxCompleteFilename.textContent = result.filename;
    els.rxCompleteDetails.textContent =
      `${formatBytes(result.data.byteLength)} · ${result.mimeType}`;
    els.rxCompleteStats.innerHTML = `
      <div class="complete-stat"><strong>${avgSpeedKbps.toFixed(1)} KB/s</strong><span>Avg Speed</span></div>
      <div class="complete-stat"><strong>${avgDropPct.toFixed(1)}%</strong><span>Avg Drop Rate</span></div>
      <div class="complete-stat"><strong>${activeSec.toFixed(1)}s</strong><span>Active Time</span></div>
    `;
    els.rxCompleteCard.classList.remove('hidden');
    els.rxModalBackdrop.classList.remove('hidden');

    if (result.isText) {
      els.rxTextPreview.textContent = textDecoder.decode(result.data);
      els.rxTextPreviewWrap.classList.remove('hidden');
    } else {
      els.rxTextPreviewWrap.classList.add('hidden');
    }
  } catch (err) {
    if (err.message === 'PASSWORD_REQUIRED') {
      els.rxDecryptCard.classList.remove('hidden');
      els.rxModalBackdrop.classList.remove('hidden');
      els.rxPasswordInput.focus();
    } else {
      els.rxDecryptCard.classList.remove('hidden');
      els.rxModalBackdrop.classList.remove('hidden');
      els.rxDecryptError.textContent = 'Incorrect password or corrupted payload.';
      els.rxDecryptError.classList.remove('hidden');
    }
  }
}

function finishBenchmarkReport() {
  const b = rxState.benchmark;
  if (!b || b.finished) return;
  b.finished = true;
  rxState.completed = true;
  stopCamera();
  els.rxStatusPill.textContent = 'Benchmark Complete · Camera Closed';

  const rows = [];
  for (let i = 0; i < BENCHMARK_PROFILES.length; i++) {
    const def = BENCHMARK_PROFILES[i];
    const measured = b.profiles.get(i);
    const expectedFrames = measured?.expectedFrames || Math.round(def.fps * 2.0);
    const payloadBytes = measured?.payloadBytes || getFrameCapacity(def.gridSize, def.colorMode, def.rsEnabled).maxPayloadBytes;
    const received = measured ? measured.receivedSeqs.size : 0;
    const durationSec = Math.max(0.1, expectedFrames / def.fps);
    const effectiveKbps = (received * payloadBytes) / 1024 / durationSec;
    const dropPct = Math.max(0, Math.min(100, (1 - received / expectedFrames) * 100));
    rows.push({
      label: `${def.gridSize}×${def.gridSize} · ${def.colorMode} · ${def.fps} FPS`,
      effectiveKbps,
      dropPct,
      received,
      expectedFrames,
    });
  }

  rows.sort((a, bRow) => bRow.effectiveKbps - a.effectiveKbps);
  const best = rows[0];

  els.rxBenchWinner.textContent = best && best.effectiveKbps > 0
    ? `${best.label}`
    : 'No frames decoded';
  els.rxBenchSummary.textContent = best && best.effectiveKbps > 0
    ? `Recommended fastest stable setting: ${best.effectiveKbps.toFixed(1)} KB/s (${best.dropPct.toFixed(0)}% drop)`
    : 'Try moving closer or adjusting screen brightness and run Benchmark again.';

  els.rxBenchTbody.innerHTML = rows.map((r, idx) => `
    <tr class="${idx === 0 && r.effectiveKbps > 0 ? 'bench-best' : ''}">
      <td>${idx === 0 && r.effectiveKbps > 0 ? '★ ' : ''}${r.label}</td>
      <td>${r.effectiveKbps.toFixed(1)} KB/s</td>
      <td>${r.dropPct.toFixed(0)}%</td>
    </tr>
  `).join('');

  els.rxCompleteCard.classList.add('hidden');
  els.rxDecryptCard.classList.add('hidden');
  els.rxBenchmarkCard.classList.remove('hidden');
  els.rxModalBackdrop.classList.remove('hidden');
}

function handleBenchmarkFrame(result, now) {
  const pkt = result.packet;
  const profileIdx = pkt.payload[0];
  const totalProfiles = pkt.payload[1] || BENCHMARK_PROFILES.length;
  const targetFps = pkt.payload[2] || 15;
  const expectedFrames = pkt.payload[3] || 30;

  if (!rxState.benchmark || rxState.benchmark.sessionId !== pkt.sessionId) {
    rxState.benchmark = {
      sessionId: pkt.sessionId,
      totalProfiles,
      profiles: new Map(),
      finished: false,
    };
    els.rxSessionBadge.textContent = `Bench 0x${pkt.sessionId.toString(16).toUpperCase().padStart(4, '0')}`;
    els.rxSecurityBadge.textContent = 'Benchmark';
    els.rxSecurityBadge.className = 'chip chip-blue';
    els.rxSecurityBadge.classList.remove('hidden');
    els.rxFilePreviewMeta.textContent = 'Running multi-profile optical sweep...';
  }

  if (profileIdx === 254) {
    els.rxFormatBadge.textContent = `${result.gridSize}×${result.gridSize} · ${result.colorMode}${result.rsEnabled ? ' + RS' : ''}`;
    els.rxStatusPill.textContent = 'Aligned & Ready — Press Start Benchmark!';
    return;
  }

  if (profileIdx === 255) {
    finishBenchmarkReport();
    return;
  }

  let entry = rxState.benchmark.profiles.get(profileIdx);
  if (!entry) {
    entry = {
      gridSize: result.gridSize,
      colorMode: result.colorMode,
      rsEnabled: result.rsEnabled,
      targetFps,
      expectedFrames,
      payloadBytes: pkt.payloadLength,
      receivedSeqs: new Set(),
    };
    rxState.benchmark.profiles.set(profileIdx, entry);
  }
  entry.receivedSeqs.add(pkt.chunkIndex);

  const curDuration = Math.max(0.1, (pkt.chunkIndex + 1) / targetFps);
  const liveKbps = (entry.receivedSeqs.size * entry.payloadBytes) / 1024 / curDuration;
  const overallPct = Math.min(99, Math.round(((profileIdx + (pkt.chunkIndex + 1) / expectedFrames) / totalProfiles) * 100));

  els.rxFormatBadge.textContent = `${result.gridSize}×${result.gridSize} · ${result.colorMode}${result.rsEnabled ? ' + RS' : ''}`;
  els.rxStatusPill.textContent = `Benchmark ${profileIdx + 1}/${totalProfiles} · ${result.gridSize}×${result.gridSize} ${result.colorMode} @ ${targetFps} FPS`;
  els.rxSpeed.textContent = `${liveKbps.toFixed(1)} KB/s`;
  els.rxReceivedCount.textContent = `P${profileIdx + 1}: ${entry.receivedSeqs.size}/${expectedFrames}`;
  els.rxProgressFill.style.width = `${overallPct}%`;
}

function handleDecodedFrame(result, now, dtMs = 0) {
  const matrixInView = result.ok || result.corners?.length === 4;
  if (matrixInView && rxState.sessionId !== null) {
    rxState.activeDetectMs += dtMs;
  }

  if (!result.ok) {
    if (matrixInView) {
      rxState.framesProcessed++;
      rxState.framesFailed++;
    }
    els.rxStatusPill.textContent = result.corners?.length === 4
      ? 'Aligned — verifying CRC32...'
      : `Searching (${result.corners?.length || 0}/4 corners)`;
    updateReceiverTelemetry(now);
    return;
  }

  const pkt = result.packet;
  if (pkt.flags & FLAG_BENCHMARK) {
    handleBenchmarkFrame(result, now);
    return;
  }

  rxState.framesProcessed++;

  if (rxState.completed) {
    return;
  }

  if (rxState.sessionId !== pkt.sessionId) {
    rxState.sessionId = pkt.sessionId;
    rxState.totalChunks = pkt.totalChunks;
    rxState.flags = pkt.flags & ~FLAG_FOUNTAIN;
    rxState.chunksMap.clear();
    rxState.speedSamples = [];
    rxState.activeDetectMs = dtMs;
    rxState.totalUniqueBytes = 0;
    rxState.framesProcessed = 1;
    rxState.framesFailed = 0;
    rxState.startTime = now;
    buildPacketGrid(pkt.totalChunks);

    rxState.fountain = new FountainDecoder(pkt.totalChunks, pkt.sessionId, (solvedIdx, solvedData) => {
      rxState.chunksMap.set(solvedIdx, solvedData);
      rxState.totalUniqueBytes += solvedData.byteLength;
      rxState.speedSamples.push({ time: performance.now(), bytes: solvedData.byteLength });

      const cell = rxState.cellNodes[solvedIdx];
      if (cell) {
        if (rxState.latestCellEl) rxState.latestCellEl.classList.remove('latest');
        cell.classList.add('received', 'latest');
        rxState.latestCellEl = cell;
      }

      if (solvedIdx === 0) {
        try {
          const meta = decodeMetadataPayload(solvedData);
          els.rxFilePreviewMeta.textContent = `${meta.filename} (${formatBytes(meta.originalSize)})`;
        } catch {
          // Ignore malformed preview
        }
      }
    });

    els.rxSessionBadge.textContent = `Session 0x${pkt.sessionId.toString(16).toUpperCase().padStart(4, '0')}`;
    const badges = [];
    if (rxState.flags & FLAG_COMPRESSED) badges.push('Deflate');
    if (rxState.flags & FLAG_ENCRYPTED) badges.push('AES-GCM');
    if (pkt.flags & FLAG_FOUNTAIN) badges.push('Fountain LT');
    if (badges.length > 0) {
      els.rxSecurityBadge.textContent = badges.join(' + ');
      els.rxSecurityBadge.className = rxState.flags & FLAG_ENCRYPTED ? 'chip' : 'chip chip-blue';
      els.rxSecurityBadge.classList.remove('hidden');
    } else {
      els.rxSecurityBadge.classList.add('hidden');
    }
  }

  const isFountainPkt = (pkt.flags & FLAG_FOUNTAIN) !== 0;
  els.rxFormatBadge.textContent = `${result.gridSize}×${result.gridSize} · ${result.colorMode}${result.rsEnabled ? ' + RS' : ''}`;

  if (isFountainPkt) {
    rxState.fountain.addFountainPacket(pkt.chunkIndex, pkt.payload);
    els.rxStatusPill.textContent = `Fountain XOR #${pkt.chunkIndex} (${rxState.fountain.bufferedCount} buffered)`;
  } else {
    rxState.fountain.addSystematicChunk(pkt.chunkIndex, pkt.payload);
    els.rxStatusPill.textContent = `Locked · Packet #${pkt.chunkIndex + 1}/${pkt.totalChunks}`;
  }

  if (rxState.chunksMap.size === rxState.totalChunks && !rxState.completed) {
    rxState.completed = true;
    stopCamera();
    els.rxStatusPill.textContent = 'Transfer Complete · Camera Closed';
    finalizeTransfer();
  }

  updateReceiverTelemetry(now);
}

function rxLoop(now) {
  if (!rxState.scanning) return;
  const dtMs = rxState.lastLoopTime > 0 ? Math.min(250, Math.max(0, now - rxState.lastLoopTime)) : 0;
  rxState.lastLoopTime = now;

  const video = els.rxVideo;
  if (video.readyState >= 2 && video.videoWidth > 0) {
    const result = decoder.decodeVideoFrame(video);
    drawOverlay(result);
    handleDecodedFrame(result, now, dtMs);
  }
  rxState.rafId = requestAnimationFrame(rxLoop);
}

els.btnToggleCamera.addEventListener('click', () => {
  if (rxState.scanning) stopCamera();
  else startCamera();
});

els.cameraSelect.addEventListener('change', () => {
  rxState.mirrorUserOverride = null;
  if (rxState.scanning) startCamera();
});

els.btnResetReceiver.addEventListener('click', () => resetReceiverSession());
els.btnScanAnother.addEventListener('click', () => {
  resetReceiverSession();
  startCamera();
});

els.btnBenchScanAgain?.addEventListener('click', () => {
  resetReceiverSession();
  startCamera();
});

els.btnRxDecrypt.addEventListener('click', () => finalizeTransfer(els.rxPasswordInput.value));
els.rxPasswordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') finalizeTransfer(els.rxPasswordInput.value);
});

els.btnDownloadFile.addEventListener('click', () => {
  if (!rxState.downloadUrl || !rxState.assembledResult) return;
  const a = document.createElement('a');
  a.href = rxState.downloadUrl;
  a.download = rxState.assembledResult.filename || 'optistream.bin';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

els.btnCopyText.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.rxTextPreview.textContent);
    els.btnCopyText.textContent = 'Copied!';
    setTimeout(() => {
      els.btnCopyText.textContent = 'Copy';
    }, 1500);
  } catch {
    // Clipboard unavailable
  }
});

// Initialize default view
updateCapacityPreview();
drawIdleSenderCanvas();
