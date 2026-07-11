import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ShopifyEngine from '../index.js'
import { handleize, translate, formatMoney, toDate, toDisplayDate, strftime, shopifyColor, colorizeSettings, shopifyFont, modifyFont } from '../lib/shopify-helpers.js'
import { extractSchema, stripSchema, loadThemeSettings } from '../lib/theme.js'

let themeDir

function write(rel, content) {
  const file = path.join(themeDir, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function makeEngine() {
  const engine = new ShopifyEngine(themeDir, [], {})
  engine.registerFilters({ markupOut: 'dist' })
  engine.registerTags(() => path.join(themeDir, 'dist'))
  return engine
}

beforeAll(() => {
  themeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poops-shopify-'))

  write('layout/theme.liquid', `<!doctype html>
<html><head><title>{{ page_title }}</title>{{ content_for_header }}</head>
<body>{{ content_for_layout }}</body></html>`)

  write('sections/hero.liquid', `<h1>{{ section.settings.heading }}</h1>
{% for block in section.blocks %}<p class="{{ block.type }}">{{ block.settings.text }}</p>{% endfor %}
{% schema %}
{
  "name": "Hero",
  "settings": [
    { "id": "heading", "type": "text", "default": "Default heading" }
  ],
  "blocks": [
    { "type": "line", "settings": [{ "id": "text", "type": "text", "default": "default line" }] }
  ]
}
{% endschema %}`)

  write('snippets/price.liquid', '<span class="price">{{ price | money }}</span>')
  // ambient globals (shop) must reach {% render %} snippets without being passed
  write('snippets/shop-name.liquid', '{{ shop.name }}')
  write('sections/global-render.liquid', "{% render 'shop-name' %}")
  // collection-picker setting holds a handle; engine resolves it to the mock global
  write('sections/coll.liquid', `{{ section.settings.pick.title }}:{{ section.settings.pick.products.size }}
{% schema %}{ "name": "Coll", "settings": [{ "id": "pick", "type": "collection" }] }{% endschema %}`)

  write('templates/index.liquid', "{% section 'hero' %}")
  write('templates/product.liquid', "{% render 'price', price: product.price %}<h2>{{ product.title }}</h2>")
  write('templates/page.about.json', JSON.stringify({
    sections: {
      main: { type: 'hero', settings: { heading: 'About us' } },
      extra: {
        type: 'hero',
        settings: { heading: 'Blocks' },
        blocks: { one: { type: 'line', settings: { text: 'custom line' } }, two: { type: 'line' } },
        block_order: ['two', 'one']
      }
    },
    order: ['main', 'extra']
  }))

  write('config/settings_schema.json', JSON.stringify([
    { name: 'Colors', settings: [{ id: 'accent', type: 'color', default: '#ff0000' }] }
  ]))
  write('config/settings_data.json', JSON.stringify({
    current: { accent: '#00ff00', sections: { hero: { settings: { heading: 'From settings_data' } } } }
  }))

  write('locales/en.default.json', JSON.stringify({
    general: { search: { placeholder: 'Search {{ shop }}' } }
  }))
})

afterAll(() => {
  fs.rmSync(themeDir, { recursive: true, force: true })
})

describe('rendering', () => {
  it('wraps pages in layout/theme.liquid with content_for_layout', async() => {
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'product.liquid'), {
      page: { title: 'Product' },
      product: { title: 'Cup', price: 1250 }
    })
    expect(html).toContain('<title>Product</title>')
    expect(html).toContain('<h2>Cup</h2>')
  })

  it('renders snippets from snippets/ via {% render %}', async() => {
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'product.liquid'), {
      page: {},
      product: { title: 'Cup', price: 1250 }
    })
    expect(html).toContain('<span class="price">$12.50</span>')
  })

  it('renders {% section %} with settings_data overriding schema defaults', async() => {
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'index.liquid'), { page: {} })
    expect(html).toContain('id="shopify-section-hero"')
    expect(html).toContain('<h1>From settings_data</h1>')
  })

  it('emits a sample product page for every product handle referenced in mocks', async() => {
    const engine = makeEngine()
    const outDir = path.join(themeDir, 'alias-out')
    engine.markupOut = outDir // absolute → written under the tmp theme dir, not the repo
    engine.setGlobal('product', { title: 'Cup', price: 1250, handle: 'sample' })
    engine.setGlobal('collection', { products: [{ handle: 'sample' }, { handle: 'other-a' }, { handle: 'other-b' }] })

    await engine.render(path.join(themeDir, 'templates', 'product.liquid'), { page: {}, product: engine.globals.product })

    // canonical (sample) is written by poops itself, not aliased; every other
    // referenced handle gets a copy of the sample page
    expect(fs.existsSync(path.join(outDir, 'products', 'sample', 'index.html'))).toBe(false)
    for (const h of ['other-a', 'other-b']) {
      const page = path.join(outDir, 'products', h, 'index.html')
      expect(fs.existsSync(page)).toBe(true)
      expect(fs.readFileSync(page, 'utf-8')).toContain('<h2>Cup</h2>')
    }
  })

  it('fakes the recommendations drop from mock products, excluding the current one', async() => {
    write('templates/product.recs.liquid', 'performed={{ recommendations.performed }} recs={% for p in recommendations.products %}{{ p.handle }},{% endfor %}')
    const engine = makeEngine()
    engine.setGlobal('product', { handle: 'sample' })
    engine.setGlobal('all_products', {
      sample: { handle: 'sample' },
      'other-a': { handle: 'other-a' },
      'other-b': { handle: 'other-b' }
    })
    const html = await engine.render(path.join(themeDir, 'templates', 'product.recs.liquid'), { page: {}, product: engine.globals.product })
    expect(html).toContain('performed=true')
    expect(html).toContain('recs=other-a,other-b,')
  })

  it('item_count_for_variant sums cart quantities for a variant (not the cart object)', async() => {
    write('templates/qty-probe.liquid', 'qty={{ cart | item_count_for_variant: 42 }}')
    const engine = makeEngine()
    engine.setGlobal('cart', { items: [{ variant_id: 42, quantity: 2 }, { variant_id: 42, quantity: 3 }, { variant_id: 7, quantity: 9 }] })
    const html = await engine.render(path.join(themeDir, 'templates', 'qty-probe.liquid'), { page: {} })
    expect(html).toContain('qty=5')
    expect(html).not.toContain('[object Object]')
  })

  it('exposes ambient globals to {% render %} snippets inside a section', async() => {
    const engine = makeEngine()
    // shop-name snippet reads {{ shop.name }} — never passed, only ambient.
    // {% render %} isolates parent scope, so this only works if globals are set.
    const html = await engine.renderSection('global-render', {}, {})
    expect(html).toContain('Dev Shop')
  })

  it('resolves collection-picker settings from a handle to the mock global', async() => {
    const engine = makeEngine()
    engine.setGlobal('collections', { all: { title: 'Everything', products: [1, 2, 3] } })
    const html = await engine.renderSection('coll', { settings: { pick: 'all' } }, {})
    expect(html).toContain('Everything:3')
  })

  it('renders Liquid embedded in section and block setting values', async() => {
    const engine = makeEngine()
    engine.setGlobal('product', { vendor: 'ACME' })
    const html = await engine.renderSection('hero', {
      settings: { heading: '{{ product.vendor }} store' },
      blocks: { v: { type: 'line', settings: { text: '{{ product.vendor }}' } } }
    }, {})
    expect(html).toContain('<h1>ACME store</h1>')
    expect(html).toContain('<p class="line">ACME</p>')
    expect(html).not.toContain('{{ product.vendor }}')
  })

  it('renders JSON templates in order with block defaults applied', async() => {
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'page.about.json'), { page: {} })
    expect(html).toContain('<h1>About us</h1>')
    expect(html).toContain('<h1>Blocks</h1>')
    expect(html.indexOf('About us')).toBeLessThan(html.indexOf('Blocks'))
    // block_order: "two" (default text) precedes "one" (custom text)
    expect(html.indexOf('default line')).toBeLessThan(html.indexOf('custom line'))
    expect(html).toContain('<p class="line">custom line</p>')
  })

  it('exposes merged theme settings as the settings global', async() => {
    write('templates/settings-probe.liquid', '{{ settings.accent }}')
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'settings-probe.liquid'), { page: {} })
    expect(html).toContain('#00ff00')
  })

  it('injects livereload into content_for_header when configured', async() => {
    const engine = makeEngine()
    engine.setGlobal('livereload_port', 35729)
    const html = await engine.render(path.join(themeDir, 'templates', 'index.liquid'), { page: {} })
    expect(html).toContain('http://localhost:35729/livereload.js')
  })

  it('maps output paths to .html, flattens templates/, routes known templates', () => {
    const engine = makeEngine()
    // unknown/alternate templates fall back to flat .html
    expect(engine.replaceOutExtensions('/x/page.about.json')).toBe('/x/page.about.html')
    // templates/ segment is flattened out
    expect(engine.replaceOutExtensions('/x/templates/index.json')).toBe('/x/index.html')
    // known templates land at their Shopify route; handle from mock global
    expect(engine.replaceOutExtensions('/x/templates/product.liquid')).toBe('/x/products/sample/index.html')
    engine.setGlobal('product', { handle: 'enamel-mug' })
    expect(engine.replaceOutExtensions('/x/templates/product.liquid')).toBe('/x/products/enamel-mug/index.html')
    expect(engine.replaceOutExtensions('/x/templates/cart.liquid')).toBe('/x/cart/index.html')
    expect(engine.replaceOutExtensions('/x/templates/collection.json')).toBe('/x/collections/all/index.html')
  })

  it('routes customers/* templates at Shopify account routes', () => {
    const engine = makeEngine()
    expect(engine.replaceOutExtensions('/x/templates/customers/login.json')).toBe('/x/account/login/index.html')
    expect(engine.replaceOutExtensions('/x/templates/customers/account.json')).toBe('/x/account/index.html')
    expect(engine.replaceOutExtensions('/x/templates/customers/order.json')).toBe('/x/account/orders/1001/index.html')
  })

  it('routes the article template and emits a page per articles-mock entry', async() => {
    write('templates/article.json', JSON.stringify({ sections: { main: { type: 'hero' } }, order: ['main'] }))
    write('sections/article-title.liquid', '<h1>{{ article.title }}</h1>{% schema %}{ "name": "A" }{% endschema %}')
    write('templates/article2.json', JSON.stringify({ sections: { main: { type: 'article-title' } }, order: ['main'] }))
    const engine = makeEngine()
    engine.setGlobal('blog', { handle: 'news' })
    engine.setGlobal('article', { handle: 'first-post', title: 'First post' })
    engine.setGlobal('articles', {
      'first-post': { handle: 'first-post', title: 'First post' },
      'second-post': { handle: 'second-post', title: 'Second post' }
    })
    expect(engine.replaceOutExtensions('/x/templates/article.json')).toBe('/x/blogs/news/first-post/index.html')

    const outDir = path.join(themeDir, 'article-out')
    engine.markupOut = outDir
    fs.renameSync(path.join(themeDir, 'templates', 'article2.json'), path.join(themeDir, 'templates', 'article.json'))
    await engine.render(path.join(themeDir, 'templates', 'article.json'), { page: {} })
    const page = path.join(outDir, 'blogs', 'news', 'second-post', 'index.html')
    expect(fs.existsSync(page)).toBe(true)
    expect(fs.readFileSync(page, 'utf-8')).toContain('<h1>Second post</h1>')
  })

  it('resolves shopify:// deep links in setting values', async() => {
    const engine = makeEngine()
    const html = await engine.renderSection('hero', {
      settings: { heading: 'shopify://collections/all' }
    }, {})
    expect(html).toContain('<h1>/collections/all</h1>')
  })

  it('exposes the collections mock dict as an iterable array with handle lookup', async() => {
    write('templates/cols-probe.liquid', "{% for c in collections %}[{{ c.title }}]{% endfor %}|{{ collections['bags'].title }}")
    const engine = makeEngine()
    engine.setGlobal('collections', { bags: { handle: 'bags', title: 'Bags' }, shoes: { handle: 'shoes', title: 'Shoes' } })
    const html = await engine.render(path.join(themeDir, 'templates', 'cols-probe.liquid'), { page: {} })
    expect(html).toContain('[Bags][Shoes]|Bags')
  })

  it('treats an itemless cart as == empty while its properties still resolve', async() => {
    write('templates/cart-probe.liquid', '{% if cart == empty %}EMPTY{% endif %}count={{ cart.item_count }}')
    const engine = makeEngine()
    engine.setGlobal('cart', { item_count: 0, items: [], total_price: 0 })
    const html = await engine.render(path.join(themeDir, 'templates', 'cart-probe.liquid'), { page: {} })
    expect(html).toContain('EMPTY')
    expect(html).toContain('count=0')

    engine.setGlobal('cart', { item_count: 2, items: [{}, {}], total_price: 100 })
    const filled = await engine.render(path.join(themeDir, 'templates', 'cart-probe.liquid'), { page: {} })
    expect(filled).not.toContain('EMPTY')
    expect(filled).toContain('count=2')
  })

  it('computes link.current/child_active against the rendered page url', async() => {
    write('templates/collection.liquid', '{% for l in linklists.main.links %}{{ l.title }}:{{ l.current }}:{{ l.child_active }};{% endfor %}')
    const engine = makeEngine()
    engine.setGlobal('collection', { handle: 'bags' })
    engine.setGlobal('linklists', {
      main: {
        handle: 'main',
        links: [
          { title: 'Bags', url: '/collections/bags', links: [{ title: 'Shop all', url: '/collections/bags', links: [] }] },
          { title: 'Shoes', url: '/collections/shoes', links: [] }
        ]
      }
    })
    // collection template renders at /collections/bags → Bags is current, and
    // its "Shop all" child makes it child_active too
    const html = await engine.render(path.join(themeDir, 'templates', 'collection.liquid'), { page: {} })
    expect(html).toContain('Bags:true:true;')
    expect(html).toContain('Shoes:false:false;')
  })

  it('scopes the customer mock to customers/* templates (storefront renders as guest)', async() => {
    write('templates/customer-probe.liquid', '{% if customer %}IN:{{ customer.first_name }}{% else %}GUEST{% endif %}')
    write('templates/customers/account-probe.liquid', '{% if customer %}IN:{{ customer.first_name }}{% else %}GUEST{% endif %}')
    const engine = makeEngine()
    engine.setGlobal('customer', { first_name: 'Jane' })
    const storefront = await engine.render(path.join(themeDir, 'templates', 'customer-probe.liquid'), { page: {} })
    expect(storefront).toContain('GUEST')
    const account = await engine.render(path.join(themeDir, 'templates', 'customers', 'account-probe.liquid'), { page: {} })
    expect(account).toContain('IN:Jane')
  })
})

describe('tags', () => {
  it('renders style/stylesheet/javascript block tags', async() => {
    const engine = makeEngine()
    const html = await engine.renderString(
      '{% style %}.a { color: {{ settings.accent }}; }{% endstyle %}{% stylesheet %}.b{}{% endstylesheet %}{% javascript %}var x=1;{% endjavascript %}',
      { settings: { accent: 'red' } }
    )
    expect(html).toContain('<style data-shopify>.a { color: red; }</style>')
    expect(html).toContain('<style>.b{}</style>')
    expect(html).toContain('<script>var x=1;</script>')
  })

  it('renders {% form %} with hidden inputs and a form object in scope', async() => {
    const engine = makeEngine()
    const html = await engine.renderString(
      "{% form 'product', product %}{% if form.errors %}ERR{% endif %}{% if form.errors == empty %}ok{% endif %}<button>Add</button>{% endform %}",
      { product: { id: 1 } }
    )
    expect(html).toContain('<form method="post" action="/cart/add" accept-charset="UTF-8">')
    expect(html).toContain('name="form_type" value="product"')
    expect(html).toContain('<button>Add</button>')
    expect(html).toContain('</form>')
    // clean form: errors is nil, so `{% if form.errors %}` must be falsy — an
    // empty array would be truthy in Liquid and render every field in error state
    expect(html).not.toContain('ERR')
  })

  it('emits {% form %} kwargs as form attributes', async() => {
    const engine = makeEngine()
    const html = await engine.renderString(
      "{% form 'product', product, id: form_id, class: 'form', novalidate: 'novalidate', data-type: 'add-to-cart-form' %}x{% endform %}",
      { product: { id: 1 }, form_id: 'ProductForm-1' }
    )
    expect(html).toContain('id="ProductForm-1"')
    expect(html).toContain('class="form"')
    expect(html).toContain('novalidate="novalidate"')
    expect(html).toContain('data-type="add-to-cart-form"')
  })

  it('renders {% paginate %} with a paginate object over all items', async() => {
    const engine = makeEngine()
    const html = await engine.renderString(
      '{% paginate collection.products by 2 %}{{ paginate.pages }}:{% for p in collection.products %}{{ p }}{% endfor %}{% endpaginate %}',
      { collection: { products: ['a', 'b', 'c', 'd', 'e'] } }
    )
    expect(html).toBe('3:abcde')
  })

  it('renders {% sections %} groups from sections/*.json', async() => {
    write('sections/header-group.json', JSON.stringify({
      type: 'header',
      sections: { hero: { type: 'hero', settings: { heading: 'Group hero' } } },
      order: ['hero']
    }))
    write('templates/group-probe.liquid', "{% sections 'header-group' %}")
    const engine = makeEngine()
    const html = await engine.render(path.join(themeDir, 'templates', 'group-probe.liquid'), { page: {} })
    expect(html).toContain('<h1>Group hero</h1>')
  })

  it('swallows {% schema %} parsed outside renderSection', async() => {
    const engine = makeEngine()
    const html = await engine.renderString('a{% schema %}{ "name": "x" }{% endschema %}b', {})
    expect(html).toBe('ab')
  })
})

describe('filters', () => {
  it('t translates with interpolation', async() => {
    const engine = makeEngine()
    engine.refreshThemeState()
    const html = await engine.renderString("{{ 'general.search.placeholder' | t: shop: 'Dev' }}", {})
    expect(html).toBe('Search Dev')
    expect(await engine.renderString("{{ 'nope.nope' | t }}", {})).toBe('translation missing: nope.nope')
  })

  it('asset_url prefixes with relativePathPrefix', async() => {
    const engine = makeEngine()
    const html = await engine.renderString("{{ 'theme.css' | asset_url | stylesheet_tag }}", { relativePathPrefix: '../' })
    expect(html).toBe('<link href="../assets/theme.css" rel="stylesheet" type="text/css" media="all">')
  })

  it('money uses shop.money_format', async() => {
    const engine = makeEngine()
    expect(await engine.renderString('{{ 123456 | money }}', {})).toBe('$1,234.56')
    engine.setGlobal('shop', { money_format: '{{ amount }} kr' })
    expect(await engine.renderString('{{ 123456 | money }}', {})).toBe('1,234.56 kr')
  })

  it('image_url passes remote urls through untouched (mock CDN images)', async() => {
    const engine = makeEngine()
    const url = 'https://cdn.shopify.com/s/files/1/x.jpg?v=1'
    expect(await engine.renderString(`{{ '${url}' | image_url: width: 165 }}`, {})).toBe(url)
    // object input (media/image drop) resolves via .src, then passes through
    expect(await engine.renderString('{{ img | image_url: width: 200 }}', { img: { src: url } })).toBe(url)
  })

  it('image_url returns the local path when there are no poops-images variants', async() => {
    const engine = makeEngine()
    expect(await engine.renderString("{{ '/assets/foo.jpg' | image_url: width: 200 }}", {})).toBe('/assets/foo.jpg')
  })
})

describe('helpers', () => {
  it('handleize matches Shopify handle rules', () => {
    expect(handleize("Wanda's 100% Juice")).toBe('wandas-100-juice')
    expect(handleize('  -- Hello, World! --  ')).toBe('hello-world')
  })

  it('translate walks dot paths', () => {
    expect(translate({ a: { b: 'hi {{ name }}' } }, 'a.b', { name: 'x' })).toBe('hi x')
  })

  it('translate picks plural forms by count', () => {
    const locale = { items: { one: '{{ count }} item', other: '{{ count }} items' } }
    expect(translate(locale, 'items', { count: 1 })).toBe('1 item')
    expect(translate(locale, 'items', { count: 5 })).toBe('5 items')
  })

  it('formatMoney handles placeholder variants', () => {
    expect(formatMoney(199, '${{ amount }}')).toBe('$1.99')
    expect(formatMoney(150000, '{{ amount_no_decimals }} €')).toBe('1,500 €')
  })

  it('extractSchema/stripSchema tolerate liquid inside schema strings', () => {
    const src = 'x{% schema %}{ "name": "{{ product.title }}" }{% endschema %}y'
    expect(extractSchema(src)).toEqual({ name: '{{ product.title }}' })
    expect(stripSchema(src)).toBe('xy')
  })

  it('toDisplayDate reads the ISO offset wall-clock, not the server timezone', () => {
    // -07:00 "Jan 18 17:24" must stay Jan 18 regardless of the machine's tz —
    // the old toDate path would roll to Jan 19 east of UTC.
    const d = toDisplayDate('2022-01-18T17:24:12-07:00')
    expect(strftime(d, '%B %d, %Y')).toBe('January 18, 2022')
    expect(strftime(d, '%I:%M %p')).toBe('05:24 PM')
    // non-ISO inputs still flow through toDate (local 'now')
    expect(strftime(toDisplayDate('now'), '%Y')).toBe(String(new Date().getFullYear()))
  })

  it('loadThemeSettings resolves string presets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poops-shopify-settings-'))
    fs.mkdirSync(path.join(dir, 'config'))
    fs.writeFileSync(path.join(dir, 'config', 'settings_schema.json'), JSON.stringify([
      { settings: [{ id: 'a', default: 1 }, { id: 'b', default: 2 }] }
    ]))
    fs.writeFileSync(path.join(dir, 'config', 'settings_data.json'), JSON.stringify({
      current: 'Default',
      presets: { Default: { b: 3 } }
    }))
    expect(loadThemeSettings(dir).settings).toEqual({ a: 1, b: 3 })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('date filter: now/today and strftime tokens (Shopify semantics)', () => {
    // 'now'/'today' resolve to a real date, not Invalid Date (the copyright bug)
    expect(strftime(toDate('now'), '%Y')).toBe(String(new Date().getFullYear()))
    const d = new Date(2023, 0, 5, 9, 7) // 2023-01-05 09:07, a Thursday
    expect(strftime(d, '%B %d, %Y')).toBe('January 05, 2023')
    expect(strftime(d, '%b %-d, %Y')).toBe('Jan 5, 2023')
    expect(strftime(d, '%A %H:%M %p')).toBe('Thursday 09:07 AM')
    expect(strftime(toDate(''), '%Y')).toBe(String(new Date().getFullYear()))
  })

  it('shopifyColor exposes Shopify color object accessors', () => {
    const c = shopifyColor('#121212')
    expect([c.red, c.green, c.blue]).toEqual([18, 18, 18])
    expect(c.rgb).toBe('18, 18, 18')
    expect(String(c)).toBe('#121212') // {{ color }} still prints hex
    // deep-wrap leaves non-colors alone, wraps color strings in place
    const s = colorizeSettings({ color_schemes: { 'scheme-1': { settings: { button: '#FFFFFF', gradient: '' } } }, count: 3 })
    expect(s.color_schemes['scheme-1'].settings.button.rgb).toBe('255, 255, 255')
    expect(s.color_schemes['scheme-1'].settings.gradient).toBe('')
    expect(s.count).toBe(3)
  })

  it('shopifyFont wraps a handle and font_modify derives variants', () => {
    const f = shopifyFont('assistant_n4')
    expect(f.family).toBe('Assistant')
    // non-system so Dawn emits @font-face/preload against local files
    expect([f.style, f.weight, f['system?'], f.handle]).toEqual(['normal', 400, false, 'assistant_n4'])
    expect(String(f)).toBe('Assistant')
    // derived variants resolve to their OWN handle → own woff2 file
    expect(modifyFont(f, 'weight', 'bold').handle).toBe('assistant_n7')
    expect(modifyFont(f, 'style', 'italic').handle).toBe('assistant_i4')
    expect(modifyFont(modifyFont(f, 'weight', 'bold'), 'style', 'italic').handle).toBe('assistant_i7')
    // colorizeSettings wraps font handles in the settings tree
    expect(colorizeSettings({ type_body_font: 'pt_sans_i7' }).type_body_font.weight).toBe(700)
  })
})
