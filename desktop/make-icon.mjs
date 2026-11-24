// make-icon.mjs — иконки ярлыков Windows (модуль win-desktop): dispatcher.ico и dispatcher-stop.ico рисуются здесь же,
// без браузера и зависимостей, по тому же рисунку, что desktop/icon.svg и icon-stop.svg (плашка, три дорожки со
// станциями, точка состояния в углу). Кадры — PNG внутри ICO (Windows Vista+ читает их на любом размере).
//   node desktop/make-icon.mjs
// Рисунок поменялся — поменять и SVG, и фигуры ниже.
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const SS = 4 // подвыборка на сторону пикселя — сглаживание краёв

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const VARIANTS = {
  "dispatcher.ico": { from: hex("#ff7a3d"), to: hex("#e2411a"), dot: hex("#12a150") },
  "dispatcher-stop.ico": { from: hex("#8a94a3"), to: hex("#4b5563"), dot: hex("#dc2626") },
}

// Фигуры в координатах рисунка 192×192 (как viewBox SVG).
const inRoundRect = (x, y, w, h, r) => {
  if (x < 0 || y < 0 || x > w || y > h) return false
  const cx = Math.min(Math.max(x, r), w - r), cy = Math.min(Math.max(y, r), h - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
const inCapsule = (x, y, x1, x2, cy, r) => inCircle(x, y, Math.min(Math.max(x, x1), x2), cy, r)
const WHITE = [255, 255, 255]

/** Цвет точки рисунка или null (прозрачно). Поздние фигуры лежат сверху. */
function colorAt(x, y, v) {
  if (!inRoundRect(x, y, 192, 192, 44)) return null
  if (inCircle(x, y, 153, 153, 14.5)) return v.dot
  if (inCircle(x, y, 153, 153, 22)) return WHITE
  for (const [cx, cy] of [[72, 60], [116, 96], [88, 132]]) if (inCircle(x, y, cx, cy, 13)) return WHITE
  for (const cy of [60, 96, 132]) if (inCapsule(x, y, 44, 148, cy, 6)) return WHITE
  const t = Math.min(1, Math.max(0, (x + y) / 384))
  return v.from.map((c, i) => Math.round(c + (v.to[i] - c) * t))
}

/** Кадр size×size: RGBA с сглаживанием подвыборкой. */
function render(size, v) {
  const px = Buffer.alloc(size * size * 4), k = 192 / size
  for (let py = 0; py < size; py++) for (let qx = 0; qx < size; qx++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = colorAt((qx + (sx + 0.5) / SS) * k, (py + (sy + 0.5) / SS) * k, v)
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++ }
    }
    const o = (py * size + qx) * 4
    if (a) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); px[o + 3] = Math.round(255 * a / (SS * SS)) }
  }
  return px
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6 // 8 бит, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4) }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}
function ico(frames) {
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(frames.length, 4)
  const dir = Buffer.alloc(16 * frames.length); let off = 6 + dir.length
  frames.forEach(({ size, data }, i) => {
    const e = i * 16
    dir[e] = size >= 256 ? 0 : size; dir[e + 1] = size >= 256 ? 0 : size // 0 значит 256
    dir.writeUInt16LE(1, e + 4); dir.writeUInt16LE(32, e + 6); dir.writeUInt32LE(data.length, e + 8); dir.writeUInt32LE(off, e + 12)
    off += data.length
  })
  return Buffer.concat([head, dir, ...frames.map((f) => f.data)])
}

for (const [file, v] of Object.entries(VARIANTS)) {
  const out = ico(SIZES.map((size) => ({ size, data: png(size, render(size, v)) })))
  fs.writeFileSync(path.join(HERE, file), out)
  console.log(`${file}: ${SIZES.length} кадров, ${out.length} байт`)
}
