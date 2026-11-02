import { describe, expect, it } from 'vitest'
import { ingestMediaFile } from './media-ingest.js'
import { bytes, fill, jpeg } from './media-samples.test-util.js'

describe('media-ingest', () => {
  it('stores the re-encoded photo without the picked JPEG EXIF/GPS segment', async () => {
    const picked = jpeg(640, 480)
    const clean = bytes(
      [0xff, 0xd8],
      [0xff, 0xc0], [0, 17], [8], [1, 0xe0], [2, 0x80], [3], fill(9, 1),
      [0xff, 0xda], [0, 2], fill(20),
    )
    let closed = false
    const doc = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {}, fillRect() {} }),
        toBlob(callback, type) {
          callback(type === 'image/webp' ? null : new Blob([clean], { type: 'image/jpeg' }))
        },
      }),
    }

    const out = await ingestMediaFile(new Blob([picked], { type: 'image/jpeg' }), undefined, {
      doc,
      decodeImage: async source => ({ source, width: 640, height: 480, close: () => { closed = true } }),
    })

    const storedBytes = new Uint8Array(await out.blobs[0].blob.arrayBuffer())
    const storedText = new TextDecoder().decode(storedBytes)
    expect(new TextDecoder().decode(picked)).toContain('GPS')
    expect([...storedBytes]).toEqual([...clean])
    expect(storedText).not.toContain('Exif')
    expect(storedText).not.toContain('GPS')
    expect(out.media).toMatchObject({ kind: 'image', mime: 'image/jpeg', width: 640, height: 480 })
    expect(closed).toBe(true)
  })
})
