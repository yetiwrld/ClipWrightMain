#!/usr/bin/env node
/**
 * Generate application icons from the supplied logo.
 *
 * The logo is used as-is (scaled only, never redrawn or recoloured). Outputs:
 *   build/icon.png          1024×1024 source for electron-builder (NSIS + portable)
 *   build/icon.ico          multi-size Windows icon (16→256)
 *   src/renderer/public/brand/icon-{size}.png   in-app mark for the title bar
 *
 * PNG decoding/resizing/ICO packing are implemented here with node's zlib so the
 * build has no native image dependencies.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'ClipWright Icon.png')

/* --------------------------------- PNG I/O -------------------------------- */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colourType = 6
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colourType = data[9]
      if (data[12] !== 0) throw new Error('Interlaced PNGs are not supported')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth ${bitDepth}`)
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : colourType === 0 ? 1 : 0
  if (!channels) throw new Error(`Unsupported colour type ${colourType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = previous[x]
      const c = x >= channels ? previous[x - channels] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[x] = (line[x] + a) & 0xff
          break
        case 2:
          line[x] = (line[x] + b) & 0xff
          break
        case 3:
          line[x] = (line[x] + ((a + b) >> 1)) & 0xff
          break
        case 4: {
          const pa = Math.abs(b - c)
          const pb = Math.abs(a - c)
          const pc = Math.abs(a + b - 2 * c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          line[x] = (line[x] + pred) & 0xff
          break
        }
        default:
          throw new Error(`Unknown PNG filter ${filter}`)
      }
    }
    previous = line
    for (let x = 0; x < width; x++) {
      const src = x * channels
      const dst = (y * width + x) * 4
      if (channels === 4) {
        pixels[dst] = line[src]
        pixels[dst + 1] = line[src + 1]
        pixels[dst + 2] = line[src + 2]
        pixels[dst + 3] = line[src + 3]
      } else if (channels === 3) {
        pixels[dst] = line[src]
        pixels[dst + 1] = line[src + 1]
        pixels[dst + 2] = line[src + 2]
        pixels[dst + 3] = 255
      } else {
        pixels[dst] = pixels[dst + 1] = pixels[dst + 2] = line[src]
        pixels[dst + 3] = 255
      }
    }
  }
  return { width, height, pixels }
}

function encodePng(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunks = []
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4, 'ascii')
    data.copy(out, 8)
    const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data])
    out.writeUInt32BE(crc32(crcInput) >>> 0, 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', idat))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

let crcTable = null
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** High-quality box-filter downscale (averages the covered source pixels). */
function resize(source, targetWidth, targetHeight) {
  const { width, height, pixels } = source
  const out = Buffer.alloc(targetWidth * targetHeight * 4)
  const scaleX = width / targetWidth
  const scaleY = height / targetHeight
  for (let y = 0; y < targetHeight; y++) {
    const y0 = Math.floor(y * scaleY)
    const y1 = Math.min(height, Math.ceil((y + 1) * scaleY))
    for (let x = 0; x < targetWidth; x++) {
      const x0 = Math.floor(x * scaleX)
      const x1 = Math.min(width, Math.ceil((x + 1) * scaleX))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * width + sx) * 4
          const alpha = pixels[i + 3] / 255
          r += pixels[i] * alpha
          g += pixels[i + 1] * alpha
          b += pixels[i + 2] * alpha
          a += alpha
          count++
        }
      }
      const dst = (y * targetWidth + x) * 4
      if (a > 0) {
        out[dst] = Math.round(r / a)
        out[dst + 1] = Math.round(g / a)
        out[dst + 2] = Math.round(b / a)
        out[dst + 3] = Math.round((a / count) * 255)
      }
    }
  }
  return { width: targetWidth, height: targetHeight, pixels: out }
}

/* ---------------------------------- ICO ---------------------------------- */

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = []
  let offset = 6 + images.length * 16
  for (const image of images) {
    const entry = Buffer.alloc(16)
    entry[0] = image.width >= 256 ? 0 : image.width
    entry[1] = image.height >= 256 ? 0 : image.height
    entry[2] = 0
    entry[3] = 0
    entry.writeUInt16LE(1, 4) // colour planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32BE(0, 8)
    entry.writeUInt32LE(image.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += image.png.length
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)])
}

/* ---------------------------------- main --------------------------------- */

const logo = decodePng(fs.readFileSync(source))
console.log(`Source logo: ${logo.width}×${logo.height}`)
if (logo.width !== logo.height) throw new Error('The logo must be square for icon generation')

const buildDir = path.join(root, 'build')
const brandDir = path.join(root, 'src/renderer/src/assets/brand')
fs.mkdirSync(buildDir, { recursive: true })
fs.mkdirSync(brandDir, { recursive: true })

const master = logo.width >= 1024 ? resize(logo, 1024, 1024) : logo
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePng(master.width, master.height, master.pixels))
console.log('wrote build/icon.png (1024×1024)')

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoImages = icoSizes.map((size) => {
  const scaled = resize(master, size, size)
  return { width: size, height: size, png: encodePng(size, size, scaled.pixels) }
})
fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(icoImages))
console.log(`wrote build/icon.ico (${icoSizes.join(', ')})`)

for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  const scaled = resize(master, size, size)
  fs.writeFileSync(path.join(brandDir, `icon-${size}.png`), encodePng(size, size, scaled.pixels))
}
console.log('wrote src/renderer/src/assets/brand/icon-*.png')
