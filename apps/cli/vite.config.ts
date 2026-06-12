import { defineConfig } from 'vite-plus'

// loro-crdt's package.json points `main` at `nodejs/index.js`, which loads
// its WASM via `fs.readFileSync(path.join(__dirname, "loro_wasm_bg.wasm"))` —
// useless inside a single-file bundle. Loro's bundler entry imports the WASM
// as a module; the `.wasm: binary` loader inlines it as a Uint8Array and
// loro's loader takes the `ArrayBuffer.isView` branch
// (`WebAssembly.instantiate(bytes)`), which Node supports. Same setup as the
// loro-2 CLI; `--exe` SEA packaging deliberately not restored yet (open
// question in the M8 scope note — verify it before promising it).
export default defineConfig({
  pack: {
    entry: { glovebox: 'src/cli/index.ts' },
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
    alias: {
      'loro-crdt': 'loro-crdt/bundler/index.js',
    },
    loader: {
      '.wasm': 'binary',
    },
    shims: true,
  },
})
