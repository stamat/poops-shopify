import fs from 'node:fs'
import path from 'node:path'
import LiquidEngine from 'poops/lib/markup/engines/liquid.js'
import { parseFrontMatter } from 'poops/lib/markup/helpers.js'
import registerShopifyFilters from './lib/filters.js'
import registerShopifyTags from './lib/tags.js'
import { extractSchema, stripSchema, settingDefaults, loadThemeSettings, loadLocale, readJson } from './lib/theme.js'
import { colorizeSettings, handleize } from './lib/shopify-helpers.js'

const DEFAULT_ROUTES = {
  root_url: '/',
  cart_url: '/cart',
  cart_add_url: '/cart/add',
  cart_change_url: '/cart/change',
  cart_update_url: '/cart/update',
  search_url: '/search',
  predictive_search_url: '/search/suggest',
  account_url: '/account',
  account_login_url: '/account/login',
  account_logout_url: '/account/logout',
  account_register_url: '/account/register',
  all_products_collection_url: '/collections/all'
}

export default class ShopifyEngine extends LiquidEngine {
  constructor(templatesDir, includePaths, options) {
    // Shopify theme dirs are always include roots, whatever the config says
    const roots = [...new Set([...(includePaths || []), 'layout', 'sections', 'snippets'])]
    super(templatesDir, roots, options)
    this.themeDir = templatesDir

    // Mock-data floor — user mock data files load after init and override these
    this.setGlobal('routes', DEFAULT_ROUTES)
    this.setGlobal('shop', { name: 'Dev Shop', money_format: '${{ amount }}', currency: 'USD' })
    this.setGlobal('cart', { item_count: 0, items: [], total_price: 0, total_weight: 0 })
    this.setGlobal('request', { host: 'localhost', path: '/', page_type: 'index', design_mode: false })
    // Shopify injects this global; Dawn's footer prints it verbatim as the store
    // attribution. A mock can override it.
    this.setGlobal('powered_by_link', '<a target="_blank" rel="nofollow" href="https://www.shopify.com?utm_campaign=poweredby&utm_medium=shopify&utm_source=onlinestore">Powered by Shopify</a>')
  }

  // Preview pages aren't site content — no search index / nav / sitemap
  get indexableExtensions() { return new Set() }
  get markupExtensions() { return 'liquid|json' }

  // Shopify routes templates/ at the site root (templates/index.liquid → /),
  // so flatten the templates/ segment out of the preview output path. Known
  // templates are emitted at their Shopify route (product → products/<handle>/
  // index.html) so mock urls like {{ product.url }} resolve on the static
  // server with no routing layer. Handles come from the mock data globals.
  replaceOutExtensions(outputPath) {
    const flattened = outputPath.replace(`${path.sep}templates${path.sep}`, path.sep)
    const name = path.basename(flattened).replace(/\.(liquid|json)$/, '')
    const route = this.previewRoute(name)
    if (route) {
      // customers/* templates route from the site root (/account/login), not
      // under a customers/ path segment — drop the source dir from the output
      let dir = path.dirname(flattened)
      if (path.basename(dir) === 'customers') dir = path.dirname(dir)
      return path.join(dir, ...route.split('/'), 'index.html')
    }
    return flattened.replace(/\.(liquid|json)$/, '.html')
  }

  // ponytail: covers the templates the mocks can feed; anything unlisted
  // falls back to flat <name>.html — add cases here when their mocks exist.
  previewRoute(name) {
    const handle = (key) => this.globals[key] && this.globals[key].handle
    switch (name) {
      case 'product': return `products/${handle('product') || 'sample'}`
      case 'collection': return `collections/${handle('collection') || 'all'}`
      case 'cart': return 'cart'
      case 'search': return 'search'
      case 'blog': return `blogs/${handle('blog') || 'news'}`
      case 'article': return `blogs/${handle('blog') || 'news'}/${handle('article') || 'article'}`
      // customers/* templates at their Shopify account routes
      case 'account': return 'account'
      case 'login': return 'account/login'
      case 'register': return 'account/register'
      case 'addresses': return 'account/addresses'
      case 'order': return 'account/orders/1001'
      case 'activate_account': return 'account/activate'
      case 'reset_password': return 'account/reset'
      default: return null
    }
  }

  registerFilters(opts) {
    super.registerFilters(opts)
    this.markupOut = opts && opts.markupOut // poops-images cache lives under this dir
    registerShopifyFilters(this.engine, this)
  }

  registerTags(getOutputDir) {
    super.registerTags(getOutputDir)
    registerShopifyTags(this.engine, this)
  }

  // Re-read settings/locales on every page render so watch-mode edits to
  // config/ and locales/ show up without a restart. A theme has a handful of
  // pages and these are tiny JSON files — not worth a cache.
  refreshThemeState() {
    const { settings, sections } = loadThemeSettings(this.themeDir)
    this.setGlobal('settings', settings)
    this.sectionSettingsData = sections
    this.locale = loadLocale(this.themeDir)

    // Themes both iterate `collections` (main-list-collections) and index it by
    // handle (collections['bags']). The mock is a handle-keyed dict, which liquidjs
    // can't iterate as collection objects — swap it for an array carrying the
    // handles as extra properties so both access patterns work.
    const cols = this.globals.collections
    if (cols && typeof cols === 'object' && !Array.isArray(cols)) {
      const arr = Object.values(cols)
      for (const [k, v] of Object.entries(cols)) arr[k] = v
      this.setGlobal('collections', arr)
    }

    // Shopify's cart drop compares equal to `empty` when it holds no items —
    // Dawn gates the header count bubble on {% if cart != empty %}. liquidjs
    // decides emptiness by Object.keys().length, so make an itemless cart's
    // properties non-enumerable: lookups still resolve, `cart == empty` is true.
    const cart = this.globals.cart
    if (cart && typeof cart === 'object' && !cart.item_count && Object.keys(cart).length) {
      const hidden = {}
      for (const [k, v] of Object.entries(cart)) Object.defineProperty(hidden, k, { value: v, enumerable: false })
      this.setGlobal('cart', hidden)
    }
  }

  // poops passes relativePathPrefix (../../ for nested pages) in the render data,
  // which reaches the template/section scope. But liquidjs {% render %} isolates a
  // snippet to `globals` only, so asset_url called inside a snippet loses the prefix
  // and emits a root-relative `assets/…` that 404s on nested pages (products/<h>/,
  // collections/<h>/, cart/, search/). Thread the prefix — and any per-page resource
  // override from emitResourcePages (_extraGlobals) — through globals too.
  globalsFor(context) {
    const prefix = context && context.relativePathPrefix
    const extra = context && context._extraGlobals
    if (prefix == null && !extra) return this.globals
    return { ...this.globals, ...(extra || {}), ...(prefix != null ? { relativePathPrefix: prefix } : {}) }
  }

  async render(templateName, context) {
    this.refreshThemeState()

    const name = path.basename(templateName).replace(/\.(liquid|json)$/, '')
    const ctx = { ...context, template: { name, directory: 'templates', suffix: '' } }

    // Shopify only exposes `customer` on logged-in account pages — the public
    // storefront renders as a guest (header "Log in" link, cart sign-in prompt).
    // Scope the customer mock to customers/* templates to match.
    if (this.globals.customer && !/[\\/]customers[\\/]/.test(templateName)) {
      ctx.customer = null
      ctx._extraGlobals = { ...(ctx._extraGlobals || {}), customer: null }
    }

    // Shopify computes link.current/active/child_active per requested URL —
    // themes underline the current page in the nav. Rebuild linklists with
    // those flags for this page's route.
    const route = name === 'index' ? '/' : this.previewRoute(name) && `/${this.previewRoute(name)}`
    const linklists = this.linklistsFor(route)
    if (linklists) {
      ctx.linklists = linklists
      ctx._extraGlobals = { ...(ctx._extraGlobals || {}), linklists }
    }

    let content
    let layoutSpec
    let tpl
    if (path.extname(templateName) === '.json') {
      tpl = readJson(templateName) || {}
      layoutSpec = tpl.layout
      content = await this.renderSectionList(tpl.sections || {}, tpl.order, ctx)
    } else {
      const { content: source } = parseFrontMatter(templateName)
      // 3rd arg sets liquidjs ambient globals — objects like product/settings/routes
      // must survive into {% render %} snippets, which isolate the parent scope
      content = await this.engine.parseAndRender(stripSchema(source), { ...this.globals, ...ctx }, { globals: this.globalsFor(ctx) })
    }

    const html = await this.wrapInLayout(content, ctx, layoutSpec)
    if (name === 'product') this.emitProductAliases(html)
    if (tpl) await this.emitResourcePages(name, tpl, ctx, layoutSpec)
    return html
  }

  // The product template renders a single sample product page (from the `product`
  // global). Collections in the mocks link many other product handles that have no
  // template of their own, so every product card but the sample would 404. Copy the
  // rendered sample page to each referenced handle so all product links resolve to a
  // sample product page. poops writes the canonical (sample) page itself.
  // ponytail: copies are written on each product-template render; a handle added to a
  // collection mock only gets a page once the product template re-renders (full build).
  emitProductAliases(html) {
    if (!this.markupOut) return
    const canonical = this.globals.product && this.globals.product.handle
    const outRoot = path.resolve(process.cwd(), this.markupOut, 'products')
    for (const handle of this.productHandles()) {
      if (!handle || handle === canonical) continue
      const dir = path.join(outRoot, handle)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'index.html'), html)
    }
  }

  // A collection/page template stands for many resources, but poops emits only the
  // single canonical page (the `collection`/`page` global's handle). Every other
  // collection or page a nav menu links to (/collections/bags, /pages/about) 404s.
  // Render the template once per mock entry with that entry as its resource global,
  // writing each at its Shopify route (collections/<h>/, pages/<h>/). Page templates
  // select by template_suffix: page.json → entries with no suffix, page.contact.json →
  // suffix "contact" (Shopify's own alternate-template mechanism). The resource rides
  // in via context (_extraGlobals), never a this.globals mutation, so concurrent
  // renders of other templates are unaffected.
  async emitResourcePages(name, tpl, ctx, layoutSpec) {
    if (!this.markupOut) return
    const cfg = this.resourceTemplate(name)
    const dict = cfg && this.globals[cfg.dict]
    if (!dict) return
    const outRoot = path.resolve(process.cwd(), this.markupOut, cfg.route)
    // Pages land at <route>/<handle>/index.html — one dir per route segment plus the
    // handle dir — so asset_url must walk back that many levels. ctx.relativePathPrefix
    // is for the canonical page's depth (flat page.html for pages), not this one.
    const prefix = '../'.repeat(cfg.route.split('/').length + 1)
    // dict may be the hybrid collections array (handle props duplicate the
    // indexed entries) — Array.from takes only the indexed elements
    const resources = Array.isArray(dict) ? Array.from(dict) : Object.values(dict)
    for (const res of resources) {
      if (!res || !res.handle) continue
      if (cfg.suffix !== undefined && (res.template_suffix || '') !== cfg.suffix) continue
      const linklists = this.linklistsFor(res.url)
      const rctx = {
        ...ctx,
        [cfg.key]: res,
        relativePathPrefix: prefix,
        ...(linklists ? { linklists } : {}),
        _extraGlobals: { ...(ctx._extraGlobals || {}), [cfg.key]: res, ...(linklists ? { linklists } : {}) }
      }
      const content = await this.renderSectionList(tpl.sections || {}, tpl.order, rctx)
      const html = await this.wrapInLayout(content, rctx, layoutSpec)
      const dir = path.join(outRoot, res.handle)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'index.html'), html)
    }
  }

  // A copy of the linklists mock with link.current/active/child_active (and a
  // handle, which Dawn uses for element ids) computed against a page URL —
  // Shopify derives these per request, so they can't live in the static mock.
  linklistsFor(currentUrl) {
    const src = this.globals.linklists
    if (!src || !currentUrl) return null
    const mapLinks = (links) => (links || []).map((l) => {
      const child = mapLinks(l.links)
      const current = l.url === currentUrl
      const childActive = child.some((c) => c.current || c.child_active)
      return {
        ...l,
        links: child,
        handle: l.handle || handleize(l.title || ''),
        current,
        active: current,
        child_active: childActive,
        child_current: childActive
      }
    })
    const out = {}
    for (const [k, v] of Object.entries(src)) out[k] = { ...v, links: mapLinks(v.links) }
    return out
  }

  resourceTemplate(name) {
    if (name === 'collection') return { key: 'collection', dict: 'collections', route: 'collections' }
    if (name === 'page' || name.startsWith('page.')) {
      return { key: 'page', dict: 'pages', route: 'pages', suffix: name === 'page' ? '' : name.slice('page.'.length) }
    }
    if (name === 'article') {
      const blog = (this.globals.blog && this.globals.blog.handle) || 'news'
      return { key: 'article', dict: 'articles', route: `blogs/${blog}` }
    }
    return null
  }

  // Every product handle referenced by mock data: the `product` global, the
  // `all_products` dict, and the products of `collection`/`collections`.
  productHandles() {
    const handles = new Set()
    const add = (p) => { if (p && p.handle) handles.add(p.handle) }
    const addProducts = (c) => { if (c && Array.isArray(c.products)) c.products.forEach(add) }
    add(this.globals.product)
    if (this.globals.all_products) Object.values(this.globals.all_products).forEach(add)
    addProducts(this.globals.collection)
    const cols = this.globals.collections
    if (cols) (Array.isArray(cols) ? Array.from(cols) : Object.values(cols)).forEach(addProducts)
    return handles
  }

  async renderSectionList(sections, order, context, groupName) {
    const parts = []
    for (const id of order || Object.keys(sections)) {
      const section = sections[id]
      if (!section || section.disabled) continue
      parts.push(await this.renderSection(section.type, { ...section, id }, context, groupName))
    }
    return parts.join('\n')
  }

  async renderSection(type, data = {}, context = {}, groupName) {
    const file = path.join(this.themeDir, 'sections', `${type}.liquid`)
    if (!fs.existsSync(file)) return `<!-- poops-shopify: section '${type}' not found -->`

    const source = fs.readFileSync(file, 'utf-8')
    const schema = extractSchema(source)
    const settings = colorizeSettings({ ...settingDefaults(schema.settings), ...(data.settings || {}) })
    this.resolveSettingRefs(schema.settings, settings, context)
    await this.renderSettingLiquid(settings, context)

    const blockDefaults = {}
    for (const block of schema.blocks || []) {
      blockDefaults[block.type] = settingDefaults(block.settings)
    }
    const blocks = []
    if (data.blocks) {
      for (const blockId of data.block_order || Object.keys(data.blocks)) {
        const raw = data.blocks[blockId]
        const settings = colorizeSettings({ ...blockDefaults[raw.type], ...(raw.settings || {}) })
        const blockSchema = (schema.blocks || []).find(b => b.type === raw.type)
        this.resolveSettingRefs(blockSchema && blockSchema.settings, settings, context)
        await this.renderSettingLiquid(settings, context)
        blocks.push({ id: blockId, type: raw.type, settings, shopify_attributes: '' })
      }
    }

    const id = data.id || type
    const section = { id, settings, blocks }
    // `section` is ambient inside a section's render subtree on Shopify: snippets
    // like product-media-gallery read section.settings without it being passed
    const html = await this.engine.parseAndRender(stripSchema(source), { ...this.globals, ...context, section }, { globals: { ...this.globalsFor(context), section } })
    // Shopify applies the schema's `class` to the section wrapper; themes select
    // on it (e.g. Dawn's StickyHeader reads `.section-header`), so it must be here.
    // Sections rendered inside a group also get `shopify-section-group-<group>-group`
    // — Dawn gates the header's z-index on it (.section-header.shopify-section-group-
    // header-group), so without it the header sits under z-indexed sections like the hero.
    const groupClass = groupName ? ` shopify-section-group-${groupName}` : ''
    const wrapperClass = schema.class ? `shopify-section${groupClass} ${schema.class}` : `shopify-section${groupClass}`
    return `<div id="shopify-section-${id}" class="${wrapperClass}">${html}</div>`
  }

  // collection/product picker settings hold a handle string in poops (there's no
  // store). Themes then read section.settings.collection.products etc., so swap
  // the handle for the matching mock global. Only these two types: menus/pages
  // are indexed by handle against their global dicts, so leave those as strings.
  resolveSettingRefs(schemaSettings, settings, context) {
    const DICT = { collection: 'collections', product: 'all_products' }
    const SINGLE = { collection: 'collection', product: 'product' }
    for (const def of schemaSettings || []) {
      if (!def || def.id === undefined) continue
      // link_list holds a menu handle; swap it for the matching linklists mock,
      // as Shopify auto-resolves link_list settings to the LinkList object. It's a
      // single menu (not a comma list), so handle it before the _list branch below.
      // Prefer the page-scoped copy (link.current flags) over the raw mock.
      if (def.type === 'link_list') {
        const handle = settings[def.id]
        if (typeof handle === 'string' && handle) {
          const dict = (context && context.linklists) || this.globals.linklists || {}
          settings[def.id] = dict[handle] || handle
        }
        continue
      }
      const base = typeof def.type === 'string' ? def.type.replace(/_list$/, '') : ''
      if (!DICT[base]) continue
      const val = settings[def.id]
      if (val == null || val === '' || typeof val === 'object') continue
      const dict = this.globals[DICT[base]] || {}
      if (def.type.endsWith('_list')) {
        const handles = Array.isArray(val) ? val : String(val).split(',').map(s => s.trim()).filter(Boolean)
        settings[def.id] = handles.map(h => dict[h]).filter(Boolean)
      } else {
        settings[def.id] = dict[val] || this.globals[SINGLE[base]] || val
      }
    }
  }

  // Shopify renders Liquid embedded in setting values — text/richtext/inline_richtext
  // /html/liquid settings can hold drops like {{ product.vendor }}, and the theme
  // outputs {{ block.settings.text }} expecting the rendered result. liquidjs treats
  // a setting value as an inert string, so evaluate any setting holding Liquid against
  // the page context here. Also resolve shopify:// deep links (url settings like
  // shopify://collections/all) to their storefront paths, as Shopify does.
  async renderSettingLiquid(settings, context) {
    const ctx = { ...this.globals, ...context }
    for (const [k, v] of Object.entries(settings)) {
      if (typeof v !== 'string') continue
      let val = v
      if (val.includes('shopify://')) val = val.replace(/shopify:\/\//g, '/')
      if (val.includes('{{') || val.includes('{%')) {
        val = await this.engine.parseAndRender(val, ctx, { globals: this.globals })
      }
      if (val !== v) settings[k] = val
    }
  }

  // {% section 'name' %} — static sections keep their customized settings in
  // settings_data.json under the section name
  renderSectionByName(name, context) {
    const data = (this.sectionSettingsData || {})[name]
    return this.renderSection(name, { ...(data || {}), id: name }, context)
  }

  // {% sections 'group' %} — section groups are JSON files in sections/
  renderSectionGroup(name, context) {
    const group = readJson(path.join(this.themeDir, 'sections', `${name}.json`))
    if (!group) return Promise.resolve(`<!-- poops-shopify: section group '${name}' not found -->`)
    // Group name = group file handle (header-group), so the wrapper class becomes
    // shopify-section-group-header-group — matching Shopify's real output
    return this.renderSectionList(group.sections || {}, group.order, context, name)
  }

  async wrapInLayout(content, context, layoutSpec) {
    if (layoutSpec === false || layoutSpec === 'none') return content
    const layoutName = typeof layoutSpec === 'string' ? layoutSpec : 'theme'
    const layoutPath = path.join(this.themeDir, 'layout', `${layoutName}.liquid`)
    if (!fs.existsSync(layoutPath)) return content

    const templateName = (context.template && context.template.name) || ''
    const source = fs.readFileSync(layoutPath, 'utf-8')
    return this.engine.parseAndRender(source, {
      ...this.globals,
      ...context,
      content_for_layout: content,
      content_for_header: this.contentForHeader(),
      page_title: (context.page && context.page.title) ||
        (templateName.charAt(0).toUpperCase() + templateName.slice(1))
    }, { globals: this.globalsFor(context) })
  }

  contentForHeader() {
    // Shopify injects the global `Shopify` object via content_for_header, before
    // any theme script. Layouts run inline scripts (Dawn: `if (Shopify.designMode)`)
    // that assume it exists, so stub it here or they throw "Shopify is not defined".
    const shop = this.globals.shop || {}
    const routes = this.globals.routes || {}
    const designMode = !!(this.globals.request && this.globals.request.design_mode)
    const shopify = `<script>window.Shopify=window.Shopify||{};Shopify.designMode=${designMode};Shopify.routes=${JSON.stringify(routes)};Shopify.currency=${JSON.stringify({ active: shop.currency || 'USD', rate: '1.0' })};Shopify.locale='en';Shopify.country='US';Shopify.shop=${JSON.stringify(shop.permanent_domain || 'dev-shop.myshopify.com')};Shopify.cdnHost='';Shopify.PaymentButton=null;</script>`

    const port = this.globals.livereload_port
    const livereload = port ? `<script src="http://localhost:${port}/livereload.js?snipver=1"></script>` : ''
    return shopify + livereload
  }
}
