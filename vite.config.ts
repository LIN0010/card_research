import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { include: ['tests/**/*.test.{ts,tsx}', 'supabase/tests/**/*.test.ts'], environment: 'node', testTimeout: 20000, hookTimeout: 60000, fileParallelism: false },
})
