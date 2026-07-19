import type { AnalysisResult, SavedProperty } from '../types'

export const STORAGE_KEY = 'homecheck-tw:properties'
export const MAX_PROPERTIES = 3

export function loadSavedProperties(storage: Pick<Storage, 'getItem'> = localStorage): SavedProperty[] {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.slice(0, MAX_PROPERTIES) : []
  } catch {
    return []
  }
}

export function saveProperty(
  result: AnalysisResult,
  label: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): SavedProperty[] {
  const current = loadSavedProperties(storage)
  if (current.length >= MAX_PROPERTIES) throw new Error('最多只能保存三間房屋')
  const item: SavedProperty = {
    id: result.input.id ?? crypto.randomUUID(),
    savedAt: new Date().toISOString(),
    label,
    result,
  }
  const next = [...current, item]
  storage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function deleteProperty(
  id: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): SavedProperty[] {
  const next = loadSavedProperties(storage).filter((item) => item.id !== id)
  storage.setItem(STORAGE_KEY, JSON.stringify(next))
  return next
}

export function clearProperties(storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(STORAGE_KEY, '[]')
}
