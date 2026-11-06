/** Escaping helpers for building ffmpeg filter graphs safely. */

/**
 * Escape a string for use as a filter *option value* inside a filtergraph.
 * Handles both the option-level escaping (`\`, `'`, `:`, `,`) required by
 * drawtext's text and fontfile options, and path separators on Windows.
 */
export function escapeFilterValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
}

/** Windows paths inside filtergraphs need forward slashes plus drive colon escaping. */
export function filterPath(p: string): string {
  return escapeFilterValue(p.replace(/\\/g, '/'))
}

/** Plain text option value (drawtext text=). */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, '\\n')
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
