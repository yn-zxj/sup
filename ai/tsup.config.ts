import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // 把所有依赖打包进单文件
  noExternal: [/(?!node:).*/],
  // 产物配置
  splitting: false,
  sourcemap: false,
  minify: true,
  platform: 'node',
  // Node.js 内置模块和 native addons 不打包
  external: [],
})
