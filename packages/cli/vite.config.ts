import { readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Bundles the `reborn` CLI and MCP server into one ESM file for Node, with
// studio-core inlined so the executable has no runtime dependencies.
const desktop = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  define: { __REBORN_VERSION__: JSON.stringify(desktop.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node22',
    ssr: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { reborn: 'src/main.ts' },
      external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
      output: { format: 'es', entryFileNames: '[name].mjs' },
    },
  },
  ssr: { noExternal: true },
})
