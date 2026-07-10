import neostandard from 'neostandard'

export default [
  { ignores: ['example/dist/**', 'example/dist-dawn/**', 'example/theme/assets/**', 'example/theme-dawn/**'] },
  ...neostandard(),
  {
    rules: {
      '@stylistic/space-before-function-paren': ['error', 'never'],
      // Shopify money_format strings legitimately contain ${{ amount }}
      'no-template-curly-in-string': 'off'
    }
  }
]
