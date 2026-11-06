/** Escaping helpers for building ffmpeg filter graphs safely. */

/**
 * Escape a string for use as a filter *option value* inside a filtergraph.
 *
 * The number of backslashes is not a style choice — it is what ffmpeg's three
 * unescaping layers happen to require, and it was measured against the bundled
 * ffmpeg by rendering each character class and comparing pixels with a
 * `textfile=` reference (see tests/ffmpeg-escaping.test.ts):
 *
 *   `:`  → `\\:`   the filtergraph parser splits options on a single-colon
 *                    escape, so the option layer needs a second backslash.
 *   `,` `;` `[` `]`
 *        → `\,`    only the graph layer splits on these; one escape is enough.
 *   `\`  → `\\\`   three layers each consume one.
 *   `'`  → `\\\'` three escaped backslashes, then a quote the text layer will
 *                    not treat as a terminator.
 *
 * The old implementation emitted `\'` and `\\` and wrapped the value in single
 * quotes, which is why any caption containing an apostrophe ("it's 50% off")
 * terminated the graph and failed the whole export.
 */
export function escapeFilterValue(value: string): string {
  return graphEscape(value)
}

function graphEscape(value: string): string {
  let out = ''
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\\\'
        break
      case "'":
        out += "\\\\\\'"
        break
      case ':':
        out += '\\\\:'
        break
      case ',':
      case ';':
      case '[':
      case ']':
        out += `\\${ch}`
        break
      default:
        out += ch
    }
  }
  return out
}

/** Windows paths inside filtergraphs need forward slashes plus drive colon escaping. */
export function filterPath(p: string): string {
  return escapeFilterValue(p.replace(/\\/g, '/'))
}

/**
 * Plain text option value for `drawtext text=`.
 *
 * drawtext runs a *second* unescaping pass over its option value on top of the
 * filtergraph's, so the graph escape is applied first and then the text layer's
 * own escapes are layered on top of the result:
 *
 *   • backslash → 3, then a trailing backslash is doubled again so it cannot
 *     swallow the closing quote;
 *   • quote     → the graph escape's 3 backslashes plus one for text;
 *   • colon     → 2 backslashes (graph) and none for text;
 *   • newline   → `\n`, which drawtext turns into a line break (a raw newline in
 *     an option value ends the filter).
 *
 * `expansion=none` is emitted alongside (see makeDrawText) so `%` and `{}` are
 * literal — without it ffmpeg prints "Stray %" and can drop the text.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      let out = ''
      for (const ch of line) {
        switch (ch) {
          case '\\':
            out += '\\\\\\'
            break
          case "'":
            out += "\\\\\\'"
            break
          case ':':
            out += '\\\\:'
            break
          case ',':
          case ';':
          case '[':
          case ']':
            out += `\\${ch}`
            break
          default:
            out += ch
        }
      }
      // A trailing backslash would escape the closing quote of the option.
      if (out.endsWith('\\')) out += '\\\\'
      return out
    })
    .join('\\n')
}

/** Number formatting that never emits exponent notation (ffmpeg rejects it in filters). */
export function num(value: number, decimals = 4): string {
  if (!isFinite(value)) return '0'
  const fixed = value.toFixed(decimals)
  // Strip trailing zeros but keep at least one digit.
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '.0') : fixed
}

/** Coerce a string to an ASCII identifier (used for safe filenames in graphs). */
export function ident(value: string, prefix = 'x'): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, '_')
  return /^[0-9]/.test(cleaned) ? `${prefix}${cleaned}` : cleaned || prefix
}
