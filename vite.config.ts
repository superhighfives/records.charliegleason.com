import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    // remoteBindings: dev connects to the real D1/R2 (bindings marked
    // `remote: true` in wrangler.jsonc). No local DB — single source of truth.
    cloudflare({ viteEnvironment: { name: 'ssr' }, remoteBindings: true }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
