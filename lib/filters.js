import fs from 'node:fs'
import path from 'node:path'
import { discoverImageVariants } from 'poops/lib/markup/helpers.js'
import { translate, formatMoney, handleize, imageSrc, toDate, strftime, modifyFont } from './shopify-helpers.js'
import PAYMENT_ICONS from './payment-icons.js'

const REMOTE = /^(https?:)?\/\/|^data:/

// Shopify's image_url: width param → a resized image. For remote urls (Shopify
// CDN, the common case with mock data) there is nothing to resize locally, so
// pass through. For local assets, resolve the poops-images width variant from
// the compile cache — the smallest one at least as wide as requested.
function shopifyImageUrl(input, kw, outputDir) {
  const src = imageSrc(input)
  if (!src || REMOTE.test(src) || !outputDir) return src
  const rooted = (p) => '/' + p.replace(/^\//, '')
  const { src: cacheSrc, variants } = discoverImageVariants(src.replace(/^\//, ''), outputDir)
  const width = kw.width ? parseInt(kw.width, 10) : null
  if (!variants || variants.length === 0 || !width) return rooted(cacheSrc || src)
  const sorted = [...variants].sort((a, b) => a.width - b.width)
  const pick = sorted.find(v => v.width >= width) || sorted[sorted.length - 1]
  return rooted(pick.path)
}

// liquidjs passes keyword filter args as [key, value] pairs
function kwargs(args) {
  const out = {}
  for (const arg of args) {
    if (Array.isArray(arg) && arg.length === 2) out[arg[0]] = arg[1]
  }
  return out
}

export default function registerShopifyFilters(engine, shopifyEngine) {
  engine.registerFilter('handleize', handleize)
  engine.registerFilter('handle', handleize)
  engine.registerFilter('json', (obj) => JSON.stringify(obj))

  engine.registerFilter('t', function(key, ...args) {
    return translate(shopifyEngine.locale || {}, key, kwargs(args))
  })

  // Dawn emits relative asset urls (asset_url is prefixed with relativePathPrefix,
  // ../../ on nested pages) so they resolve under the serve base with no router.
  // font_url/font_face reuse this so local font files resolve the same way.
  const assetPath = (ctx, file) => `${ctx.getSync(['relativePathPrefix']) || ''}assets/${file}`
  engine.registerFilter('asset_url', function(file) {
    return assetPath(this.context, file)
  })

  engine.registerFilter('stylesheet_tag', (url) => `<link href="${url}" rel="stylesheet" type="text/css" media="all">`)
  engine.registerFilter('script_tag', (url) => `<script src="${url}"></script>`)

  // width variants come from the poops-images compile cache under the markup
  // output dir; remote urls (mock CDN images) pass through untouched
  const outputDir = () => shopifyEngine.markupOut && path.join(process.cwd(), shopifyEngine.markupOut)
  engine.registerFilter('image_url', (input, ...args) => shopifyImageUrl(input, kwargs(args), outputDir()))
  engine.registerFilter('img_url', (input, ...args) => shopifyImageUrl(input, kwargs(args), outputDir()))

  engine.registerFilter('image_tag', function(url, ...args) {
    const kw = kwargs(args)
    const attrs = [`src="${url}"`]
    for (const [key, value] of Object.entries(kw)) {
      attrs.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`)
    }
    if (!kw.loading) attrs.push('loading="lazy"')
    return `<img ${attrs.join(' ')}>`
  })

  const moneyFormat = function() {
    return this.context.getSync(['shop', 'money_format']) || '${{ amount }}'
  }
  engine.registerFilter('money', function(cents) {
    return formatMoney(cents, moneyFormat.call(this))
  })
  engine.registerFilter('money_with_currency', function(cents) {
    const currency = this.context.getSync(['shop', 'currency']) || 'USD'
    return `${formatMoney(cents, moneyFormat.call(this))} ${currency}`
  })
  engine.registerFilter('money_without_trailing_zeros', function(cents) {
    return formatMoney(cents, moneyFormat.call(this)).replace(/[.,]00(?=\D|$)/, '')
  })

  engine.registerFilter('within', (url) => url)

  // Shopify wraps text in an anchor; Dawn's footer copyright uses
  // `{{ shop.name | link_to: routes.root_url }}`. Without it strictFilters:false
  // passes the bare text through (no link).
  engine.registerFilter('link_to', (text, url, title) => {
    const t = title ? ` title="${String(title).replace(/"/g, '&quot;')}"` : ''
    return `<a href="${url}"${t}>${text}</a>`
  })

  // Payment brand icons in the footer — the real full-color Visa/Mastercard/… SVGs
  // (see payment-icons.js), matching what Shopify's payment_type_svg_tag emits, so
  // `for type in shop.enabled_payment_types` renders correct marks. The kwarg class
  // (Dawn passes 'icon icon--full-color') is applied to the svg root.
  engine.registerFilter('payment_type_svg_tag', function(type, ...args) {
    const svg = PAYMENT_ICONS[type]
    if (!svg) return ''
    const kw = kwargs(args)
    return kw.class ? svg.replace(/^<svg class="[^"]*"/, `<svg class="${kw.class}"`) : svg
  })

  // Total quantity of a variant already in the cart. Dawn's quantity inputs print
  // `{{ cart | item_count_for_variant: id }}`; without this filter liquidjs passes
  // the left operand (the cart object) straight through → "[object Object]".
  engine.registerFilter('item_count_for_variant', (cart, variantId) => {
    const items = (cart && cart.items) || []
    return items.reduce((sum, item) => {
      const id = item.variant_id != null ? item.variant_id : item.variant && item.variant.id
      return id === variantId ? sum + (item.quantity || 0) : sum
    }, 0)
  })

  // No real checkout in preview — dynamic checkout button / installment terms
  // render nothing.
  engine.registerFilter('payment_button', () => '')
  engine.registerFilter('payment_terms', () => '')

  // schema.org JSON-LD. Shopify builds a full schema; preview just needs valid
  // JSON so the ld+json script isn't "[object Object]". Emit the object as-is.
  engine.registerFilter('structured_data', (obj) => JSON.stringify(obj))

  // Single preview page — nothing to paginate through
  engine.registerFilter('default_pagination', () => '')

  // Shopify date is strftime with 'now'/'today' support; overrides poops' dayjs
  // `date` filter (registered by super) which can't parse 'now' or %Y tokens
  engine.registerFilter('date', (input, fmt) => strftime(toDate(input), fmt || '%Y-%m-%d'))

  // Inline the raw content of an assets/ file (Dawn inlines every SVG icon this
  // way). Cache — the same icon is inlined hundreds of times across a page.
  const assetCache = new Map()
  engine.registerFilter('inline_asset_content', (file) => {
    const name = String(file)
    if (!assetCache.has(name)) {
      try {
        assetCache.set(name, fs.readFileSync(path.join(shopifyEngine.themeDir, 'assets', name), 'utf-8'))
      } catch {
        assetCache.set(name, '')
      }
    }
    return assetCache.get(name)
  })

  // Shopify ships an illustration set for placeholder_svg_tag; locally a neutral
  // gray box is enough for the slot to render instead of collapsing.
  engine.registerFilter('placeholder_svg_tag', (_name, className) => {
    const cls = className ? ` class="${className}"` : ''
    return `<svg${cls} width="100%" height="100%" viewBox="0 0 525 525" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg"><rect width="525" height="525" fill="#e0e0e0"/></svg>`
  })

  // Web Pixels tracking payload — a noop locally, but the attribute must be valid
  // JSON so the platform's JSON.parse doesn't throw "[object Object]".
  engine.registerFilter('standard_event_data', () => '{}')

  // Font handling. Fonts are non-system (see shopify-helpers), so Dawn emits
  // @font-face + preload; these point at local assets/<handle>.woff2 files.
  engine.registerFilter('font_modify', (font, property, value) => modifyFont(font, property, value))

  // Only emit @font-face for a variant we actually have a file for — a missing
  // variant (Assistant ships no italic) returns '' so the browser faux-styles it
  // from the base weight rather than fetching a 404.
  const hasFontFile = (handle) => {
    try { return fs.existsSync(path.join(shopifyEngine.themeDir, 'assets', `${handle}.woff2`)) } catch { return false }
  }
  engine.registerFilter('font_face', function(font, ...args) {
    if (!font || !font.handle || !hasFontFile(font.handle)) return ''
    const kw = kwargs(args)
    const url = assetPath(this.context, `${font.handle}.woff2`)
    const display = kw.font_display ? ` font-display: ${kw.font_display};` : ''
    return `@font-face { font-family: "${font.family}"; font-style: ${font.style}; font-weight: ${font.weight};${display} src: url("${url}") format("woff2"); }`
  })
  engine.registerFilter('font_url', function(font) {
    return font && font.handle ? assetPath(this.context, `${font.handle}.woff2`) : ''
  })
}
