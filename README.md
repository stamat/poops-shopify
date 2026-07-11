# poops-shopify

> [!WARNING]
> AI slop! This is just a PoC and is still in progress!
> TBH, I have no idea why I was so eager to build this in the first place... maybe because I always hated theme sync for classic themes... maybe because I could... Guess I will never know now...

Shopify Liquid engine for [poops](https://github.com/stamat/poops). Develop Shopify themes locally — instant builds, livereload, mock data, no store, no `shopify theme dev` round-trips — then push the theme directory to Shopify as-is.

The trick: your `theme/` directory **is** a real Shopify theme. poops never compiles your Liquid files into anything Shopify sees — it only renders them locally for preview and compiles your JS/SCSS into `theme/assets/`. Migration is `shopify theme push --path theme`. There is nothing to migrate.

## Setup

```sh
npm install poops poops-shopify --save-dev
```

Project layout:

```
theme/                  ← a literal Shopify theme, push as-is
  layout/theme.liquid
  templates/            ← .liquid and .json (OS 2.0) templates
  sections/             ← sections with {% schema %}
  snippets/
  config/               ← settings_schema.json + settings_data.json
  locales/              ← en.default.json
  assets/               ← poops compiles your JS/SCSS here
src/
  js/  scss/            ← asset sources (never pushed)
mocks/
  product.json shop.json cart.json linklists.json …
dist/                   ← local preview output (gitignore it)
```

`poops.json`:

```json
{
  "scripts": [{ "in": "src/js/theme.js", "out": "theme/assets/theme.js" }],
  "styles": [{ "in": "src/scss/theme.scss", "out": "theme/assets/theme.css" }],
  "markup": {
    "in": "theme",
    "out": "dist",
    "engine": "poops-shopify",
    "includePaths": [
      "layout",
      "sections",
      "snippets",
      "config",
      "locales",
      "assets"
    ],
    "data": ["../mocks"]
  },
  "copy": [{ "in": "theme/assets", "out": "dist" }],
  "serve": { "port": 4141, "base": "/dist" },
  "livereload": true,
  "watch": ["theme", "src", "mocks"]
}
```

## Workflow

```sh
poops                               # dev server + livereload at :4141
open http://localhost:4141/templates/index.html

shopify theme check --path theme    # lint with Shopify's own checker
shopify theme push --path theme     # deploy — the theme dir is the artifact
```

Each file in `templates/` becomes a preview page in `dist/`, rendered with your mock data at its Shopify route (`templates/product.json` → `dist/products/<handle>/index.html`).

## Mock data

Every `.json`/`.yml` file in `mocks/` becomes a Liquid global named after the file: `mocks/product.json` → `{{ product.title }}`. Sensible defaults for `routes`, `shop`, `cart` and `request` are built in; your mocks override them.

## What's emulated

- **Theme structure** — `layout/theme.liquid` wrapping via `content_for_layout`, `content_for_header` (injects livereload), snippets via `{% render %}`
- **Sections** — `{% section %}`, `{% sections %}` (section groups), `{% schema %}` setting/block defaults, `settings_data.json` overrides, `shopify-section-*` wrapper divs
- **JSON templates** — OS 2.0 `templates/*.json` with section order, per-section settings, blocks and `block_order`
- **Settings** — `settings_schema.json` defaults + `settings_data.json` (including string presets) as the `settings` global; `shopify://` deep links resolve to storefront paths; collection/product/menu picker settings resolve handles to mock objects
- **Locales** — `{{ 'key.path' | t }}` with interpolation and one/other pluralization from `locales/*.default.json`
- **Tags** — `style`, `stylesheet`, `javascript`, `form`, `paginate`
- **Filters** — `asset_url`, `stylesheet_tag`, `script_tag`, `image_url`/`img_url`, `image_tag`, `money`, `money_with_currency`, `money_without_trailing_zeros`, `t`, `handleize`/`handle`, `json`, `default_pagination`, plus everything liquidjs ships (`default`, `date`, …)
- **Shopify routes** — templates land at their storefront paths: `products/<handle>/`, `collections/<handle>/`, `blogs/<blog>/<article>/`, `pages/<handle>/`, `cart/`, `search/`, and `customers/*` at `account/…`
- **Mock resource pages** — the `collections`, `pages` and `articles` mock dicts each emit one rendered page per entry (pages pick their template by `template_suffix`); every product handle referenced in mocks gets a copy of the sample product page, so no product card 404s
- **Session semantics** — `customer` is only in scope on `customers/*` templates (the storefront renders logged out, like Shopify); a cart with no items compares `== empty` the way Shopify's cart drop does

## What's not

This is a **preview environment**, not a Shopify emulator:

- No real store data — products, collections, cart and customer are your mock fixtures
- Forms render but don't submit anywhere useful; `{% paginate %}` reports a single page and loops render all items
- No cart AJAX API, Section Rendering API, metafields, checkout, or app blocks
- liquidjs is not Shopify's Liquid implementation — stick to documented Shopify tags/filters and run `shopify theme check` before pushing

Keep poops-only conveniences (front matter, collections, nunjucks) **out** of `theme/` — Shopify won't have them. `mocks/` and `src/` are safe, they're never pushed.

## Example

A runnable example theme lives in [`example/`](example/):

```sh
cd example && npm install && npm run dev
```

## License

MIT
