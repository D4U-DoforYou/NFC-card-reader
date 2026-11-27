import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' })
after(() => server.close())
const { createPreviewBand, putCodeBand, putPreviewBand } = await server.ssrLoadModule('/src/core/image/canvas.ts')

function surface(width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(19)
  return {
    pixels,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData(image, dx, dy, sx = 0, sy = 0, w = image.width, h = image.height) {
      for (let y = sy; y < sy + h; y++) {
        for (let x = sx; x < sx + w; x++) {
          if (dy + y >= height) continue
          const source = (y * image.width + x) * 4
          pixels.set(image.data.subarray(source, source + 4), ((dy + y) * width + dx + x) * 4)
        }
      }
    },
  }
}
const palette = [{ r: 20, g: 40, b: 60 }, { r: 170, g: 90, b: 30 }]
for (const [width, height] of [[7, 113], [552, 768]]) {
  const codes = Uint8Array.from({ length: width * height }, (_, i) => (i + Math.floor(i / width)) % 2)
  const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) => {
    const entry = palette[codes[Math.floor(i / 4)]]
    return [entry.r, entry.g, entry.b, 255][i % 4]
  })
  for (const mode of ['codes', 'rgba']) {
    const paint = (ctx, band, start, end) => mode === 'codes'
      ? putCodeBand(ctx, band, codes, palette, width, start, end)
      : putPreviewBand(ctx, band, rgba, width, start, end)
    test(`${mode}: full cached ${width}×${height} restores every pixel`, () => {
      const ctx = surface(width, height)
      paint(ctx, createPreviewBand(ctx, width, 48), 0, height)
      assert.deepEqual(ctx.pixels, new Uint8ClampedArray(rgba))
    })
    test(`${mode}: partial range preserves pixels before and after it (${width}×${height})`, () => {
      const ctx = surface(width, height)
      paint(ctx, createPreviewBand(ctx, width, 48), 13, 70)
      const expected = new Uint8ClampedArray(rgba.length).fill(19)
      expected.set(rgba.subarray(13 * width * 4, 70 * width * 4), 13 * width * 4)
      assert.deepEqual(ctx.pixels, expected)
    })
    test(`${mode}: progressive bands match full cache restore (${width}×${height})`, () => {
      const ctx = surface(width, height)
      const band = createPreviewBand(ctx, width, 48)
      for (let start = 0; start < height; start += 48) paint(ctx, band, start, Math.min(start + 48, height))
      assert.deepEqual(ctx.pixels, new Uint8ClampedArray(rgba))
    })
  }
}
