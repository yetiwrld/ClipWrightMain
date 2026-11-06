#!/usr/bin/env node
/**
 * Build exact font metrics for the bundled fonts.
 *
 * Both the preview monitor and the FFmpeg export renderer lay text out with the
 * same metrics (advance widths parsed from the TTF `hmtx` table), so caption
 * line breaks and word positions are identical on screen and in the exported
 * file. Run with `npm run fonts:metrics`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fontsDir = path.join(__dirname, '..', 'resources', 'fonts')
const outFile = path.join(__dirname, '..', 'src', 'shared', 'font-metrics.json')

function u16(b, o) { return b.readUInt16BE(o) }
function i16(b, o) { return b.readInt16BE(o) }
function u32(b, o) { return b.readUInt32BE(o) }

function parseTables(buf) {
  const numTables = u16(buf, 4)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = buf.toString('ascii', rec, rec + 4)
    tables[tag] = { offset: u32(buf, rec + 8), length: u32(buf, rec + 12) }
  }
  return tables
}

function parseMetrics(file) {
  const buf = fs.readFileSync(file)
  const tables = parseTables(buf)
  const head = tables.head.offset
  const unitsPerEm = u16(buf, head + 18)
  const indexToLocFormat = i16(buf, head + 50)
  const hhea = tables.hhea.offset
  const ascender = i16(buf, hhea + 4)
  const descender = i16(buf, hhea + 6)
  const lineGap = i16(buf, hhea + 8)
  const numberOfHMetrics = u16(buf, hhea + 34)

  const hmtx = tables.hmtx.offset
  const advance = []
  let last = 0
  for (let i = 0; i < numberOfHMetrics; i++) {
    last = u16(buf, hmtx + i * 4)
    advance.push(last)
  }
  const numGlyphs = (() => {
    if (!tables.maxp) return advance.length
    return u16(buf, tables.maxp.offset + 4)
  })()

  // Unicode -> glyph id from the cmap (format 4 and format 12 subtables).
  const cmap = {}
  if (tables.cmap) {
    const cmapOff = tables.cmap.offset
    const numSub = u16(buf, cmapOff + 2)
    let best = null
    let fallback4 = null
    for (let i = 0; i < numSub; i++) {
      const rec = cmapOff + 4 + i * 8
      const platform = u16(buf, rec)
      const encoding = u16(buf, rec + 2)
      const offset = cmapOff + u32(buf, rec + 4)
      const format = u16(buf, offset)
      const score =
        (format === 12 ? 3 : format === 4 ? 2 : 0) +
        (platform === 3 && encoding === 10 ? 2 : platform === 3 && encoding === 1 ? 1 : 0)
      if (format === 4) {
        if (!fallback4 || score > fallback4.score) fallback4 = { offset, format, score }
      }
      if (format === 12 || format === 4) {
        if (!best || score > best.score) best = { offset, format, score }
      }
    }
    if (best && best.format === 12) {
      const off = best.offset
      const nGroups = u32(buf, off + 12)
      for (let g = 0; g < nGroups; g++) {
        const rec = off + 16 + g * 12
        const startC = u32(buf, rec)
        const endC = u32(buf, rec + 4)
        const startGid = u32(buf, rec + 8)
        for (let c = startC; c <= endC; c++) {
          const gid = startGid + (c - startC)
          if (gid !== 0) cmap[c] = gid
        }
      }
    }
    if (best && best.format === 12) best = null
    if (!best && fallback4) best = fallback4
    if (best && best.format === 4) {
      const off = best.offset
      const segX2 = u16(buf, off + 6)
      const segCount = segX2 / 2
      const endOff = off + 14
      const startOff = endOff + segX2 + 2
      const deltaOff = startOff + segX2
      const rangeOff = deltaOff + segX2
      for (let s = 0; s < segCount; s++) {
        const endC = u16(buf, endOff + s * 2)
        const startC = u16(buf, startOff + s * 2)
        const delta = i16(buf, deltaOff + s * 2)
        const rangeOffset = u16(buf, rangeOff + s * 2)
        for (let c = startC; c <= endC && c !== 0xffff; c++) {
          let gid
          if (rangeOffset === 0) gid = (c + delta) & 0xffff
          else {
            const glyphIndexOff = rangeOff + s * 2 + rangeOffset + (c - startC) * 2
            if (glyphIndexOff + 1 >= buf.length) continue
            gid = u16(buf, glyphIndexOff)
            if (gid !== 0) gid = (gid + delta) & 0xffff
          }
          if (gid !== 0) cmap[c] = gid
        }
      }
    }
  }

  const widths = {}
  for (const [code, gid] of Object.entries(cmap)) {
    const index = Math.min(Number(gid), numGlyphs - 1)
    const w = index < numberOfHMetrics ? advance[index] : advance[advance.length - 1]
    widths[code] = w
  }
  // Space / control defaults.
  const defaultAdvance = widths['32'] ?? Math.round(unitsPerEm * 0.25)
  const missing = []
  return {
    unitsPerEm,
    ascender,
    descender,
    lineGap,
    defaultAdvance,
    widths,
    hasKerning: Boolean(tables.kern || tables.GPOS),
    indexToLocFormat,
    missing
  }
}

const files = fs.readdirSync(fontsDir).filter((f) => f.toLowerCase().endsWith('.ttf'))
const out = {}
for (const file of files.sort()) {
  const id = path.basename(file, '.ttf')
  try {
    out[id] = parseMetrics(path.join(fontsDir, file))
    process.stdout.write(`  ${id}: ${Object.keys(out[id].widths).length} glyph widths\n`)
  } catch (error) {
    process.stderr.write(`  ${id}: FAILED ${error.message}\n`)
  }
}
fs.writeFileSync(outFile, JSON.stringify(out))
const size = fs.statSync(outFile).size
process.stdout.write(`Wrote ${outFile} (${(size / 1024).toFixed(0)} KB)\n`)
