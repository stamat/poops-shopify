// Block tag helper: collects inner templates until {% end<name> %} and wraps
// the rendered content
function registerBlockTag(engine, name, wrap) {
  engine.registerTag(name, {
    parse(tagToken, remainTokens) {
      this.templates = []
      const stream = this.liquid.parser.parseStream(remainTokens)
        .on(`tag:end${name}`, () => stream.stop())
        .on('template', (tpl) => this.templates.push(tpl))
        .on('end', () => { throw new Error(`tag {% ${name} %} not closed with {% end${name} %}`) })
      stream.start()
    },
    * render(ctx) {
      const content = yield this.liquid.renderer.renderTemplates(this.templates, ctx)
      return wrap(content)
    }
  })
}

// Form types Shopify posts to distinct endpoints; anything unknown posts to /
const FORM_ACTIONS = {
  product: '/cart/add',
  contact: '/contact',
  customer: '/contact',
  customer_login: '/account/login',
  create_customer: '/account',
  recover_customer_password: '/account/recover',
  currency: '/cart/update',
  localization: '/localization',
  cart: '/cart'
}

export default function registerShopifyTags(engine, shopifyEngine) {
  engine.registerTag('section', {
    parse(tagToken) {
      this.value = tagToken.args.trim()
    },
    * render(ctx) {
      const name = yield this.liquid.evalValue(this.value, ctx)
      return yield shopifyEngine.renderSectionByName(name, ctx.getAll())
    }
  })

  engine.registerTag('sections', {
    parse(tagToken) {
      this.value = tagToken.args.trim()
    },
    * render(ctx) {
      const name = yield this.liquid.evalValue(this.value, ctx)
      return yield shopifyEngine.renderSectionGroup(name, ctx.getAll())
    }
  })

  // Fallback only: renderSection() strips {% schema %} before parsing (see
  // theme.js) — this catches section sources parsed through other paths
  registerBlockTag(engine, 'schema', () => '')

  registerBlockTag(engine, 'style', (css) => `<style data-shopify>${css}</style>`)

  // ponytail: Shopify bundles per-section stylesheet/javascript into shared
  // assets, deduped once per section type — locally they inline per instance
  registerBlockTag(engine, 'stylesheet', (css) => `<style>${css}</style>`)
  registerBlockTag(engine, 'javascript', (js) => `<script>${js}</script>`)

  // Preview forms render markup but never submit anywhere useful
  engine.registerTag('form', {
    parse(tagToken, remainTokens) {
      this.args = tagToken.args
      this.templates = []
      const stream = this.liquid.parser.parseStream(remainTokens)
        .on('tag:endform', () => stream.stop())
        .on('template', (tpl) => this.templates.push(tpl))
        .on('end', () => { throw new Error('tag {% form %} not closed with {% endform %}') })
      stream.start()
    },
    * render(ctx) {
      // ponytail: naive comma split — breaks on commas inside quoted kwarg
      // values, which Dawn never passes. Real arg tokenizer if a theme does.
      const parts = this.args.split(',').map(s => s.trim())
      const type = yield this.liquid.evalValue(parts[0], ctx)
      // kwargs (id:, class:, novalidate:, data-type:, …) become form attributes,
      // as on Shopify — Dawn associates outside inputs via form="{{ product_form_id }}"
      // and selects the form by id in JS. Positional args (the resource) are unused.
      let attrs = ''
      for (const part of parts.slice(1)) {
        const m = part.match(/^([\w-]+)\s*:\s*(.+)$/)
        if (!m) continue
        const val = yield this.liquid.evalValue(m[2], ctx)
        if (val == null || val === false) continue
        attrs += ` ${m[1]}="${String(val).replace(/"/g, '&quot;')}"`
      }
      // errors is nil (not []) on a clean form — Liquid treats an empty array as
      // truthy, so `[]` makes Dawn's `{% if form.errors %}` render the error state
      // (aria-invalid + autofocus) on every field, which also scroll-jumps the page
      ctx.push({ form: { errors: null, posted_successfully: false } })
      const content = yield this.liquid.renderer.renderTemplates(this.templates, ctx)
      ctx.pop()
      const action = FORM_ACTIONS[type] || '/'
      return `<form method="post" action="${action}" accept-charset="UTF-8"${attrs}>` +
        `<input type="hidden" name="form_type" value="${type}"><input type="hidden" name="utf8" value="✓">` +
        `${content}</form>`
    }
  })

  // ponytail: paginate object reports one page and loops render ALL items —
  // real slicing of the looped expression if mock datasets ever get big
  engine.registerTag('paginate', {
    parse(tagToken, remainTokens) {
      const match = tagToken.args.match(/^(.+?)\s+by\s+(.+)$/)
      this.collectionExpr = match ? match[1].trim() : tagToken.args.trim()
      this.sizeExpr = match ? match[2].trim() : '20'
      this.templates = []
      const stream = this.liquid.parser.parseStream(remainTokens)
        .on('tag:endpaginate', () => stream.stop())
        .on('template', (tpl) => this.templates.push(tpl))
        .on('end', () => { throw new Error('tag {% paginate %} not closed with {% endpaginate %}') })
      stream.start()
    },
    * render(ctx) {
      const items = (yield this.liquid.evalValue(this.collectionExpr, ctx)) || []
      const pageSize = Number(yield this.liquid.evalValue(this.sizeExpr, ctx)) || 20
      const count = Array.isArray(items) ? items.length : (items.length || 0)
      ctx.push({
        paginate: {
          current_page: 1,
          current_offset: 0,
          items: count,
          parts: [],
          page_size: pageSize,
          pages: Math.max(1, Math.ceil(count / pageSize)),
          previous: null,
          next: null
        }
      })
      const content = yield this.liquid.renderer.renderTemplates(this.templates, ctx)
      ctx.pop()
      return content
    }
  })
}
