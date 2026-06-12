import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: {
    ignorePatterns: ['**/dist/**'],
    singleQuote: true,
    semi: false,
    printWidth: 100,
  },
  lint: {
    ignorePatterns: ['**/dist/**'],
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: ['packages/*', 'apps/cli', 'apps/worker'],
  },
})
