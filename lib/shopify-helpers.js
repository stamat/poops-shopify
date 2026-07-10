export function handleize(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/['"’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Dot-path lookup into the locale tree with {{ param }} interpolation,
// mirroring Shopify's "translation missing" output for absent keys.
// A `count` param selects the one/other plural form.
export function translate(locale, key, params = {}) {
  let node = locale
  for (const part of String(key).split('.')) {
    if (node == null || typeof node !== 'object') {
      node = undefined
      break
    }
    node = node[part]
  }
  if (node && typeof node === 'object' && params.count !== undefined) {
    node = Number(params.count) === 1 ? (node.one ?? node.other) : (node.other ?? node.one)
  }
  if (typeof node !== 'string') return `translation missing: ${key}`
  return node.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '')
}

// Shopify money amounts are integer cents; format placeholders follow
// Shopify's money_format conventions
export function formatMoney(cents, format = '${{ amount }}') {
  const amount = (Number(cents) || 0) / 100
  const fixed = amount.toFixed(2)
  const grouped = fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return format
    .replace(/\{\{\s*amount\s*\}\}/g, grouped)
    .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, String(Math.round(amount)))
    .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/g, fixed.replace(/\B(?=(\d{3})+(?!\d))/g, '.').replace(/\.(\d\d)$/, ',$1'))
}

// Shopify `color` settings are objects exposing .red/.green/.blue/.rgb/.hsl etc.
// poops stores them as the raw hex/rgb string from settings_data.json, so themes
// like Dawn that build `--color-x: {{ scheme.settings.button.red }},…` get `,,`
// and every button/input/background loses its color. Wrap color strings so the
// component accessors resolve; toString/toLiquid keep `{{ color }}` printing hex.
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b); const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, Math.round(l * 100)]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [Math.round((h / 6) * 360), Math.round(s * 100), Math.round(l * 100)]
}

export function isColorString(v) {
  return typeof v === 'string' && (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?$/.test(v) || /^rgba?\(/i.test(v))
}

export function shopifyColor(input) {
  const s = String(input).trim()
  let r, g, b, a = 1
  if (s.startsWith('#')) {
    let h = s.slice(1)
    if (h.length === 3) h = h.split('').map(c => c + c).join('')
    if (h.length !== 6 && h.length !== 8) return input
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16)
    if (h.length === 8) a = +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3)
  } else {
    const m = s.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?/i)
    if (!m) return input
    r = +m[1]; g = +m[2]; b = +m[3]; a = m[4] !== undefined ? +m[4] : 1
  }
  const [hue, saturation, lightness] = rgbToHsl(r, g, b)
  const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
  const str = a < 1 ? `rgba(${r}, ${g}, ${b}, ${a})` : hex
  const color = {
    red: r, green: g, blue: b, alpha: a,
    rgb: `${r}, ${g}, ${b}`, rgba: `${r}, ${g}, ${b}, ${a}`,
    hue, saturation, lightness, hex
  }
  // toString only — NOT toLiquid: liquidjs runs toLiquid() while walking a
  // property path, so a toLiquid returning the hex string would collapse the
  // object to a string before `.red`/`.rgb` resolve. Without it, `{{ color }}`
  // still falls through to String()→toString() and prints hex.
  Object.defineProperty(color, 'toString', { value: () => str })
  return color
}

// Shopify `font_picker` settings are objects with .family/.style/.weight/.system?
// etc.; poops stores the raw handle ("assistant_n4" = Assistant, normal, 400), so
// themes reading `settings.type_body_font.family` get nothing. Wrap the handle.
// Fonts are marked non-system so Dawn's `unless font.system?` guards DO emit
// @font-face/preload — the font_face/font_url filters point those at local woff2
// files (assets/<handle>.woff2, downloaded from the Shopify font CDN). A variant
// with no local file (Assistant has no italic) just falls back to faux styling.
const FONT_HANDLE = /^[a-z0-9]+(?:_[a-z0-9]+)*_([ni])([1-9])$/

export function isFontHandle(v) {
  return typeof v === 'string' && FONT_HANDLE.test(v)
}

// handle is derived from slug + variant so font_modify's bold/italic derivatives
// resolve to their own file (assistant_n4 → bold assistant_n7 → italic i4 → i7),
// not the base handle.
function makeFont({ slug, family, style, weight, fallback }) {
  const variant = `${style === 'italic' ? 'i' : 'n'}${weight / 100}`
  const font = {
    family,
    fallback_families: fallback || 'sans-serif',
    style,
    weight,
    variant,
    system: false,
    'system?': false,
    slug,
    handle: `${slug}_${variant}`
  }
  Object.defineProperty(font, 'toString', { value: () => family })
  return font
}

export function shopifyFont(handle) {
  const m = String(handle).match(FONT_HANDLE)
  if (!m) return handle
  const slug = String(handle).replace(/_[ni][1-9]$/, '')
  const family = slug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return makeFont({ slug, family, style: m[1] === 'i' ? 'italic' : 'normal', weight: +m[2] * 100 })
}

// font_modify: 'weight'|'style', <value> — returns a derived font (Dawn builds
// its bold/italic @font-face variants this way).
export function modifyFont(font, property, value) {
  if (!font || typeof font !== 'object') return font
  const next = { slug: font.slug, family: font.family, fallback: font.fallback_families, style: font.style, weight: font.weight }
  if (property === 'style') next.style = value
  else if (property === 'weight') {
    if (value === 'bold') next.weight = Math.min(next.weight + 300, 900)
    else if (value === 'normal') next.weight = 400
    else next.weight = parseInt(value, 10) || next.weight
  }
  return makeFont(next)
}

// Deep-wrap every color/font string in a settings tree (color_schemes, section
// /block color & font pickers). Other values pass through untouched.
export function colorizeSettings(obj) {
  if (Array.isArray(obj)) return obj.map(colorizeSettings)
  if (obj && typeof obj === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(obj)) out[k] = colorizeSettings(v)
    return out
  }
  if (isColorString(obj)) return shopifyColor(obj)
  if (isFontHandle(obj)) return shopifyFont(obj)
  return obj
}

// Mock images are either plain path strings or objects with a src property
export function imageSrc(input) {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') return input.src || ''
  return ''
}

// Shopify's `date` filter follows Ruby strftime; 'now'/'today' mean the current
// time and bare integers are unix seconds. poops' own `date` filter formats with
// dayjs tokens (which don't understand %Y) and passes 'now' to `new Date('now')`
// → Invalid Date, so the shopify engine needs its own coercion + formatter.
export function toDate(input) {
  if (input == null || input === '' || input === 'now' || input === 'today') return new Date()
  if (typeof input === 'number') return new Date(input * 1000)
  if (input instanceof Date) return input
  return new Date(input)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The strftime subset Shopify themes actually reach for in locale date_formats.
// `%-d` (dash flag) strips leading zeros, matching Ruby.
export function strftime(date, fmt = '%Y-%m-%d') {
  if (!(date instanceof Date) || isNaN(date.getTime())) return ''
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const map = {
    Y: date.getFullYear(),
    y: pad(date.getFullYear() % 100),
    m: pad(date.getMonth() + 1),
    B: MONTHS[date.getMonth()],
    b: MONTHS[date.getMonth()].slice(0, 3),
    d: pad(date.getDate()),
    e: String(date.getDate()).padStart(2, ' '),
    j: pad(Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000), 3),
    A: DAYS[date.getDay()],
    a: DAYS[date.getDay()].slice(0, 3),
    H: pad(date.getHours()),
    I: pad(((date.getHours() + 11) % 12) + 1),
    M: pad(date.getMinutes()),
    S: pad(date.getSeconds()),
    p: date.getHours() < 12 ? 'AM' : 'PM',
    '%': '%'
  }
  return fmt.replace(/%(-?)([A-Za-z%])/g, (m, dash, c) => {
    if (!(c in map)) return m
    const v = String(map[c])
    return dash ? v.replace(/^[0\s]+(?=\d)/, '') : v
  })
}
