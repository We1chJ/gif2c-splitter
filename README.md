# 🎞️ GIF → C Array Splitter

A **fully static, zero-dependency** web tool that converts an animated GIF into per-frame C header files (`.h`) containing RGB565 arrays — ready to use on Adafruit displays and other embedded systems.

No server. No upload. Everything runs in your browser.

**[🚀 Live demo →](https://we1chj.github.io/gif2c-splitter/)**

---

## Features

- **Drag & drop** a GIF or browse for one
- Configurable **output width & height** (default 240×240)
- Byte-swapped RGB565 output for **Adafruit / big-endian SPI displays** (toggle on/off)
- Optional `PROGMEM` attribute for **Arduino / AVR** targets
- **Live frame preview** with play/pause
- Download individual frames or **all frames + `frames_index.h` as a ZIP**
- Works in Chrome, Edge, Firefox, Safari — no install required

---

## Output format

Each `frame_NNN.h` file contains:

```c
const uint16_t frame_000[] PROGMEM = {
0xF800,0x07E0,0x001F,...,
...
};
```

The `frames_index.h` file `#include`s every frame and provides:

```c
#define FRAME_COUNT  42
#define FRAME_WIDTH  240
#define FRAME_HEIGHT 240

const uint16_t* const frames[FRAME_COUNT] PROGMEM = {
  frame_000, frame_001, ...
};
```

---

## Host on GitHub Pages

1. Fork / push this repo to GitHub.
2. Go to **Settings → Pages → Source** and select the `main` branch, root folder.
3. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/`.

The site is 100% static (`index.html` + `app.js` + `style.css`) — no build step needed.

---

## How it works

| Browser | GIF decoding path |
|---------|-------------------|
| Chrome / Edge 94+ | `ImageDecoder` API (fast, native) |
| Firefox / Safari | Built-in manual GIF89a + LZW parser |

Pixels are read via the Canvas 2D API, rescaled with `drawImage`, then packed into RGB565 words. JSZip (CDN) is used for in-browser ZIP creation.

---

## License

MIT
