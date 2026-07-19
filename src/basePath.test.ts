import { describe, expect, it } from 'vitest'
import { pagesBase } from './config/site'

describe('GitHub Pages base path', () => {
  it('設定為 repository 子路徑', () => {
    expect(pagesBase).toBe('/homecheck-tw/')
  })
})
