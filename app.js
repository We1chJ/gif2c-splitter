/* =============================================================================
   GIF → C Array Splitter  |  app.js
   Fully browser-side: decodes GIF frames, converts to RGB565, generates .h files.
   Supports ImageDecoder API (Chrome/Edge 94+) with a manual GIF89a parser fallback.
   ============================================================================= */

"use strict";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone       = document.getElementById("drop-zone");
const fileInput      = document.getElementById("file-input");
const outWidthEl     = document.getElementById("out-width");
const outHeightEl    = document.getElementById("out-height");
const byteSwapEl     = document.getElementById("byte-swap");
const progmemEl      = document.getElementById("progmem");

const settingsCard   = document.getElementById("settings-card");
const dropCard       = document.getElementById("drop-card");
const statusCard     = document.getElementById("status-card");
const statusText     = document.getElementById("status-text");
const statusBadge    = document.getElementById("status-badge");
const progressBar    = document.getElementById("progress-bar");
const metaRow        = document.getElementById("meta-row");

const previewCard    = document.getElementById("preview-card");
const previewCanvas  = document.getElementById("preview-canvas");
const playBtn        = document.getElementById("play-btn");
const frameCounter   = document.getElementById("frame-counter");

const downloadCard   = document.getElementById("download-card");
const downloadInfo   = document.getElementById("download-info");
const rangeStart     = document.getElementById("range-start");
const rangeEnd       = document.getElementById("range-end");
const rangeCount     = document.getElementById("range-count");
const dlBtn          = document.getElementById("dl-btn");

const resetRow       = document.getElementById("reset-row");
const resetBtn       = document.getElementById("reset-btn");

// ── State ─────────────────────────────────────────────────────────────────────
let frames      = [];   // [{ name, content }]
let delays      = [];   // per-frame delay in ms
let imgDataList = [];   // raw ImageData objects (for preview)
let previewCtx  = null;
let playTimer   = null;
let curFrame    = 0;
let playing     = false;

// ── Drag & Drop ───────────────────────────────────────────────────────────────
dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", ()  => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

// ── Reset ─────────────────────────────────────────────────────────────────────
resetBtn.addEventListener("click", () => {
  stopPreview();
  frames = []; delays = []; imgDataList = []; curFrame = 0; playing = false;
  hide(statusCard); hide(previewCard); hide(downloadCard); hide(resetRow);
  show(settingsCard); show(dropCard);
  fileInput.value = "";
  setProgress(0);
});

// ── Main handler ──────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith(".gif") && file.type !== "image/gif") {
    alert("Please select a GIF file (.gif)."); return;
  }

  const outW      = Math.max(1, parseInt(outWidthEl.value)  || 240);
  const outH      = Math.max(1, parseInt(outHeightEl.value) || 240);
  const doSwap    = byteSwapEl.checked;
  const doProgmem = progmemEl.checked;

  hide(settingsCard); hide(dropCard);
  show(statusCard);
  setStatus("Reading GIF\u2026", "info"); setProgress(0);
  metaRow.textContent = "";

  try {
    const buf = await readFileAsArrayBuffer(file);
    setStatus("Decoding frames\u2026", "info");

    const { imageDataList, delayList, gifWidth, gifHeight } = await decodeGIF(buf);
    const total = imageDataList.length;

    metaRow.innerHTML =
      `<span>Source: <b>${gifWidth}\u00d7${gifHeight}</b></span>` +
      `<span>Frames: <b>${total}</b></span>` +
      `<span>Output: <b>${outW}\u00d7${outH}</b></span>`;

    setStatus(`Converting ${total} frames to RGB565\u2026`, "info");

    // Off-screen canvas for rescaling
    const offCanvas = Object.assign(document.createElement("canvas"), { width: outW, height: outH });
    const offCtx    = offCanvas.getContext("2d");
    const srcCanvas = Object.assign(document.createElement("canvas"), { width: gifWidth, height: gifHeight });
    const srcCtx    = srcCanvas.getContext("2d");

    frames      = [];
    delays      = delayList;
    imgDataList = imageDataList;

    for (let i = 0; i < total; i++) {
      srcCtx.putImageData(imageDataList[i], 0, 0);
      offCtx.clearRect(0, 0, outW, outH);
      offCtx.drawImage(srcCanvas, 0, 0, outW, outH);

      const { data } = offCtx.getImageData(0, 0, outW, outH);
      frames.push({
        name:    `frame_${pad(i)}.h`,
        content: buildHFile(data, outW, outH, i, doSwap, doProgmem)
      });

      setProgress(((i + 1) / total) * 100);
      if (i % 5 === 0) await yieldToUI();
    }

    setStatus(`Done! ${total} frames converted.`, "success");

    setupPreview(imageDataList, delayList, gifWidth, gifHeight);

    rangeStart.min = 0; rangeStart.max = total - 1; rangeStart.value = 0;
    rangeEnd.min   = 0; rangeEnd.max   = total - 1; rangeEnd.value   = total - 1;
    updateRangeCount();
    downloadInfo.innerHTML =
      `<b>${total} frames</b> decoded — ${outW}\u00d7${outH} RGB565. ` +
      `Select a range below, then download as a single <code>gif_frames.h</code>.`;

    show(previewCard); show(downloadCard); show(resetRow);

  } catch (err) {
    setStatus("Error: " + err.message, "error");
    console.error(err);
  }
}

// =============================================================================
//  GIF DECODING
// =============================================================================

async function decodeGIF(arrayBuffer) {
  if (typeof ImageDecoder !== "undefined") {
    try { return await decodeViaImageDecoder(arrayBuffer); } catch (_) { /* fall through */ }
  }
  return decodeViaManualParser(arrayBuffer);
}

// ── Path A: ImageDecoder API (Chrome/Edge 94+) ────────────────────────────────
async function decodeViaImageDecoder(arrayBuffer) {
  const decoder = new ImageDecoder({
    data: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(arrayBuffer)); c.close(); } }),
    type: "image/gif"
  });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  const total = track.frameCount;

  const first   = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
  const gifWidth  = first.image.displayWidth;
  const gifHeight = first.image.displayHeight;
  first.image.close();

  const canvas = Object.assign(document.createElement("canvas"), { width: gifWidth, height: gifHeight });
  const ctx    = canvas.getContext("2d");
  const imageDataList = [], delayList = [];

  for (let i = 0; i < total; i++) {
    const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
    ctx.drawImage(image, 0, 0);
    imageDataList.push(ctx.getImageData(0, 0, gifWidth, gifHeight));
    delayList.push((image.duration ?? 100000) / 1000); // microseconds -> ms
    image.close();
  }
  decoder.close();
  return { imageDataList, delayList, gifWidth, gifHeight };
}

// ── Path B: Manual GIF89a parser (Firefox / Safari / fallback) ───────────────
function decodeViaManualParser(arrayBuffer) {
  const d   = new Uint8Array(arrayBuffer);
  let   pos = 0;

  const r8  = () => d[pos++];
  const r16 = () => { const v = d[pos] | (d[pos+1]<<8); pos+=2; return v; };

  if (String.fromCharCode(d[0], d[1], d[2]) !== "GIF")
    throw new Error("Not a valid GIF file.");
  pos = 6;

  const gifW  = r16(), gifH = r16();
  const gpk   = r8();
  const hasGCT = (gpk>>7)&1;
  const gctSz  = 2**((gpk&7)+1);
  pos += 2; // bg color + aspect ratio

  let globalPalette = null;
  if (hasGCT) { globalPalette = readPalette(d, pos, gctSz); pos += gctSz*3; }

  const canvas = Object.assign(document.createElement("canvas"), { width: gifW, height: gifH });
  const ctx    = canvas.getContext("2d");

  const imageDataList = [], delayList = [];
  let gcDelay = 100, gcTransp = -1;

  const skipBlocks = () => { let sz; while ((sz = d[pos++]) !== 0) pos += sz; };
  const readBlocks = () => {
    const out = []; let sz;
    while ((sz = d[pos++]) !== 0) { for (let i = 0; i < sz; i++) out.push(d[pos++]); }
    return new Uint8Array(out);
  };

  while (pos < d.length) {
    const block = r8();
    if (block === 0x3B) break;        // GIF Trailer

    if (block === 0x21) {             // Extension Introducer
      const ext = r8();
      if (ext === 0xF9) {             // Graphic Control Extension
        r8();                         // block size (always 4)
        const ep = r8();
        gcDelay  = r16() * 10;        // centiseconds -> milliseconds
        gcTransp = (ep & 1) ? r8() : (r8(), -1);
        r8();                         // block terminator
      } else {
        skipBlocks();
      }
      continue;
    }

    if (block === 0x2C) {             // Image Descriptor
      const imgL = r16(), imgT = r16(), imgW = r16(), imgH = r16();
      const ipk  = r8();
      const hasLCT  = (ipk>>7)&1;
      const intlcd  = (ipk>>6)&1;
      const lctSz   = 2**((ipk&7)+1);

      let palette = globalPalette;
      if (hasLCT) { palette = readPalette(d, pos, lctSz); pos += lctSz*3; }

      const minCode    = r8();
      const compressed = readBlocks();
      let   indices    = lzwDecode(minCode, compressed);
      if (intlcd) indices = deinterlace(indices, imgW, imgH);

      // Composite this frame on top of the previous one
      const prev      = ctx.getImageData(0, 0, gifW, gifH);
      const frameData = new ImageData(new Uint8ClampedArray(prev.data), gifW, gifH);

      for (let row = 0; row < imgH; row++) {
        for (let col = 0; col < imgW; col++) {
          const ci = indices[row * imgW + col];
          if (ci === gcTransp) continue;                         // transparent pixel
          const di = ((imgT + row) * gifW + (imgL + col)) * 4;
          const [r, g, b] = palette[ci] || [0, 0, 0];
          frameData.data[di]   = r;
          frameData.data[di+1] = g;
          frameData.data[di+2] = b;
          frameData.data[di+3] = 255;
        }
      }

      ctx.putImageData(frameData, 0, 0);
      imageDataList.push(ctx.getImageData(0, 0, gifW, gifH));
      delayList.push(gcDelay || 100);
      gcDelay = 100; gcTransp = -1;
      continue;
    }

    skipBlocks(); // unknown block — skip
  }

  if (!imageDataList.length) throw new Error("No frames found in GIF.");
  return { imageDataList, delayList, gifWidth: gifW, gifHeight: gifH };
}

function readPalette(d, offset, size) {
  const t = [];
  for (let i = 0; i < size; i++)
    t.push([d[offset + i*3], d[offset + i*3 + 1], d[offset + i*3 + 2]]);
  return t;
}

// ── LZW Decoder ───────────────────────────────────────────────────────────────
function lzwDecode(minCodeSize, data) {
  const clearCode = 1 << minCodeSize;
  const eofCode   = clearCode + 1;
  let   codeSize  = minCodeSize + 1;
  let   codeMask  = (1 << codeSize) - 1;
  let   nextCode  = eofCode + 1;

  const initTable = () => {
    const t = [];
    for (let i = 0; i < clearCode; i++) t[i] = [i];
    t[clearCode] = t[eofCode] = [];
    return t;
  };

  let table    = initTable();
  const output = [];
  let bits = 0, bitsLeft = 0, dataPos = 0, prevCode = null;

  const readCode = () => {
    while (bitsLeft < codeSize) {
      if (dataPos >= data.length) return eofCode;
      bits |= data[dataPos++] << bitsLeft;
      bitsLeft += 8;
    }
    const code = bits & codeMask;
    bits >>= codeSize; bitsLeft -= codeSize;
    return code;
  };

  while (true) {
    const code = readCode();
    if (code === eofCode) break;

    if (code === clearCode) {
      table    = initTable();
      codeSize = minCodeSize + 1;
      codeMask = (1 << codeSize) - 1;
      nextCode = eofCode + 1;
      prevCode = null;
      continue;
    }

    let entry;
    if (code < nextCode)
      entry = table[code];
    else if (code === nextCode && prevCode !== null)
      entry = [...table[prevCode], table[prevCode][0]];
    else
      break; // corrupted stream

    for (const v of entry) output.push(v);

    if (prevCode !== null && nextCode < 4096) {
      table[nextCode++] = [...table[prevCode], entry[0]];
      if (nextCode > codeMask && codeSize < 12) {
        codeSize++; codeMask = (1 << codeSize) - 1;
      }
    }
    prevCode = code;
  }
  return output;
}

function deinterlace(pixels, w, h) {
  const out = new Array(w * h);
  let src = 0;
  for (const { start, step } of [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 },
  ]) {
    for (let row = start; row < h; row += step)
      for (let col = 0; col < w; col++)
        out[row * w + col] = pixels[src++];
  }
  return out;
}

// =============================================================================
//  C HEADER GENERATION
// =============================================================================

function buildHFile(rgba, width, height, index, doSwap, doProgmem) {
  const name  = `frame_${pad(index)}`;
  const attr  = doProgmem ? " PROGMEM" : "";
  const lines = [`const uint16_t ${name}[]${attr} = {`];

  const rgb565 = new Uint16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i*4], g = rgba[i*4+1], b = rgba[i*4+2];
    let c = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
    if (doSwap) c = ((c & 0xFF) << 8) | ((c >> 8) & 0xFF);
    rgb565[i] = c;
  }

  for (let i = 0; i < rgb565.length; i += 16) {
    const chunk = Array.from(rgb565.subarray(i, i + 16));
    lines.push(chunk.map(c => `0x${c.toString(16).toUpperCase().padStart(4, "0")}`).join(",") + ",");
  }
  lines.push("};");
  return lines.join("\n");
}

function buildCombinedHeader(frameList, width, height, doProgmem) {
  const attr = doProgmem ? " PROGMEM" : "";
  const ls = [
    `// gif_frames.h \u2014 auto-generated by GIF\u2192C Array Splitter`,
    `// ${frameList.length} frames, each ${width}\u00d7${height} RGB565 pixels`,
    `// Drop this single file into your project and #include "gif_frames.h"`,
    ``,
    `#pragma once`,
    ``,
    `#define FRAME_COUNT  ${frameList.length}`,
    `#define FRAME_WIDTH  ${width}`,
    `#define FRAME_HEIGHT ${height}`,
    ``,
  ];
  // Inline every frame array
  for (const { content } of frameList) {
    ls.push(content);
    ls.push(``);
  }
  // Pointer array
  ls.push(`// Pointer array for easy iteration`);
  ls.push(`const uint16_t* const frames[FRAME_COUNT]${attr} = {`);
  for (let i = 0; i < frameList.length; i++) ls.push(`  frame_${pad(i)},`);
  ls.push(`};`);
  return ls.join("\n");
}

// =============================================================================
//  PREVIEW
// =============================================================================

function setupPreview(imageDataList, delayList, gifW, gifH) {
  previewCanvas.width  = gifW;
  previewCanvas.height = gifH;
  previewCtx = previewCanvas.getContext("2d");
  curFrame   = 0;
  drawFrame(imageDataList, 0);
  playBtn.onclick = () => playing
    ? stopPreview()
    : startPreview(imageDataList, delayList);
}

function drawFrame(list, idx) {
  previewCtx.putImageData(list[idx], 0, 0);
  frameCounter.textContent = `Frame ${idx + 1} / ${list.length}`;
}

function startPreview(list, delayList) {
  playing = true;
  playBtn.textContent = "\u23f8 Pause";
  const tick = () => {
    drawFrame(list, curFrame);
    playTimer = setTimeout(tick, delayList[curFrame] || 100);
    curFrame  = (curFrame + 1) % list.length;
  };
  tick();
}

function stopPreview() {
  playing = false;
  playBtn.textContent = "\u25b6 Play";
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
}

// =============================================================================
//  DOWNLOADS
// =============================================================================

function updateRangeCount() {
  const s = parseInt(rangeStart.value);
  const e = parseInt(rangeEnd.value);
  if (!isNaN(s) && !isNaN(e) && e >= s) {
    rangeCount.textContent = `(${e - s + 1} frame${e - s + 1 === 1 ? "" : "s"})`;
  } else {
    rangeCount.textContent = "";
  }
}

rangeStart.addEventListener("input", updateRangeCount);
rangeEnd.addEventListener("input",   updateRangeCount);

dlBtn.addEventListener("click", () => {
  if (!frames.length) return;

  let s = parseInt(rangeStart.value);
  let e = parseInt(rangeEnd.value);
  if (isNaN(s)) s = 0;
  if (isNaN(e)) e = frames.length - 1;
  s = Math.max(0, Math.min(s, frames.length - 1));
  e = Math.max(s, Math.min(e, frames.length - 1));

  const outW = parseInt(outWidthEl.value)  || 240;
  const outH = parseInt(outHeightEl.value) || 240;

  // Re-index selected frames so arrays start at frame_000
  const selected = frames.slice(s, e + 1).map((f, i) => {
    const newName = `frame_${pad(i)}`;
    return {
      name:    `${newName}.h`,
      content: f.content.replace(/frame_\d{3}/g, newName)
    };
  });

  const combined = buildCombinedHeader(selected, outW, outH, progmemEl.checked);
  triggerDownload(
    new Blob([combined], { type: "text/plain" }),
    "gif_frames.h"
  );
});

function triggerDownload(blob, filename) {
  const a   = document.createElement("a");
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}

// =============================================================================
//  UTILITIES
// =============================================================================

const pad        = n  => String(n).padStart(3, "0");
const show       = el => el.classList.remove("hidden");
const hide       = el => el.classList.add("hidden");
const yieldToUI  = () => new Promise(r => setTimeout(r, 0));

function setStatus(msg, type) {
  statusText.textContent  = msg;
  statusBadge.className   = `badge badge-${type}`;
  statusBadge.textContent = { success: "done", error: "error", info: "working" }[type] ?? type;
}

function setProgress(pct) {
  progressBar.style.width = `${Math.min(100, pct).toFixed(1)}%`;
}

function readFileAsArrayBuffer(file) {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => res(reader.result);
    reader.onerror = () => rej(new Error("Could not read file."));
    reader.readAsArrayBuffer(file);
  });
}
