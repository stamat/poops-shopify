import fs from 'node:fs'
import path from 'node:path'
import { colorizeSettings } from './shopify-helpers.js'

// {% schema %} is extracted/stripped with a regex instead of the Liquid parser:
// schema JSON routinely contains liquid examples in strings ("{{ product.title }}")
// that would confuse template parsing
const SCHEMA_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/

export function extractSchema(source) {
  const match = source.match(SCHEMA_RE)
  if (!match) return {}
  try {
    return JSON.parse(match[1])
  } catch {
    return {}
  }
}

export function stripSchema(source) {
  return source.replace(SCHEMA_RE, '')
}

// Collects `default` values from a schema settings array, keyed by setting id
export function settingDefaults(settings) {
  const out = {}
  for (const setting of settings || []) {
    if (setting.id !== undefined && setting.default !== undefined) {
      out[setting.id] = setting.default
    }
  }
  return out
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

// Theme state (settings, locales, section groups) is re-read on every page
// render so watch-mode edits show up — but that made every page pay the
// read+parse. mtime-keyed memo: one statSync per use, entries self-invalidate
// when the file changes. Missing files aren't cached, so a file created
// mid-watch is picked up immediately.
const jsonCache = new Map()
export function readJsonCached(file) {
  let mtimeMs
  try {
    mtimeMs = fs.statSync(file).mtimeMs
  } catch {
    return null
  }
  const cached = jsonCache.get(file)
  if (cached && cached.mtimeMs === mtimeMs) return cached.value
  const value = readJson(file)
  jsonCache.set(file, { mtimeMs, value })
  return value
}

// Theme settings: settings_schema.json defaults overlaid with the
// settings_data.json `current` values. `current` may be a preset name.
// Returns the merged settings plus per-section data (used by {% section %}).
// Result is memoized on the two source files' mtimes — refreshThemeState calls
// this once per page, and the merge/colorize pass only needs to rerun when a
// config file actually changed. Callers share the returned object; treat it
// as read-only.
const themeSettingsCache = new Map()
export function loadThemeSettings(themeDir) {
  const schemaFile = path.join(themeDir, 'config', 'settings_schema.json')
  const dataFile = path.join(themeDir, 'config', 'settings_data.json')
  const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
  const stamp = `${mtimeOf(schemaFile)}:${mtimeOf(dataFile)}`
  const cached = themeSettingsCache.get(themeDir)
  if (cached && cached.stamp === stamp) return cached.value

  const schema = readJson(schemaFile) || []
  const defaults = {}
  for (const group of schema) {
    Object.assign(defaults, settingDefaults(group.settings))
  }

  const data = readJson(dataFile) || {}
  let current = data.current || {}
  if (typeof current === 'string') {
    current = (data.presets || {})[current] || {}
  }

  const { sections, ...settings } = current
  const merged = colorizeSettings({ ...defaults, ...settings })
  if (merged.color_schemes && !Array.isArray(merged.color_schemes)) {
    merged.color_schemes = toSchemeArray(merged.color_schemes)
  }
  const value = { settings: merged, sections: sections || {} }
  themeSettingsCache.set(themeDir, { stamp, value })
  return value
}

// Shopify's color_scheme_group iterates to scheme objects that carry `.id` and
// `.settings` (Dawn: `for scheme in settings.color_schemes` → `scheme.id`,
// `scheme.settings.button.red`). poops stores them as an id→scheme dict, which
// Liquid would iterate as [key,value] pairs (scheme.settings undefined → `,,`).
// Return an array of {id, settings} — stringifying to the id for `| first` and
// class names — with the id also keyed on the array for `color_schemes[id]`.
function toSchemeArray(dict) {
  const arr = []
  for (const [id, val] of Object.entries(dict)) {
    const scheme = { ...val, id }
    Object.defineProperty(scheme, 'toString', { value: () => id })
    arr.push(scheme)
    Object.defineProperty(arr, id, { value: scheme, enumerable: false })
  }
  return arr
}

// ponytail: first *.default.json wins, single-locale only — per-request locale
// switching if multi-language preview ever matters
export function loadLocale(themeDir) {
  const dir = path.join(themeDir, 'locales')
  let files
  try {
    files = fs.readdirSync(dir)
  } catch {
    return {}
  }
  const file = files.find(f => f.endsWith('.default.json')) || files.find(f => f.endsWith('.json'))
  if (!file) return {}
  // mtime-cached: the default locale is ~100KB of JSON, re-parsed per page otherwise
  return readJsonCached(path.join(dir, file)) || {}
}
