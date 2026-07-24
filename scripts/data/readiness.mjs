import { readFile, rename, writeFile } from 'node:fs/promises'

export const READINESS_SCHEMA_VERSION = '1.0.0'
export const READINESS_SOURCE_IDS = ['market', 'park']

function counts(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必須是計數物件`)
  }
  return Object.fromEntries(Object.entries(value)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, count]) => {
      if (!key || !Number.isInteger(count) || count < 0) {
        throw new Error(`${label} 含無效計數`)
      }
      return [key, count]
    }))
}

function matchingRates(value) {
  const rates = {}
  for (const city of ['taipei', 'new-taipei', 'overall']) {
    const rate = value?.[city]
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new Error(`readiness ${city} 定位率無效`)
    }
    rates[city] = rate
  }
  return rates
}

export function readinessSource(id, candidate) {
  if (!READINESS_SOURCE_IDS.includes(id)) throw new Error(`不支援的 readiness source：${id}`)
  const value = id === 'park' ? candidate?.readiness?.park : candidate
  if (!value || !['blocked', 'ready'].includes(value.status)) {
    throw new Error(`${id} 候選沒有可發布的 readiness 狀態`)
  }
  const quality = value.qualityReport ?? {}
  return {
    id,
    status: value.status,
    checkedAt: value.generatedAt ?? candidate.generatedAt,
    adapterVersion: value.adapterVersion ?? candidate.adapterVersion,
    matchingRates: matchingRates(value.matchingRates),
    excluded: counts(quality.excluded ?? {}, `${id} excluded`),
    locationMethods: counts(quality.locationMethods ?? {}, `${id} locationMethods`),
    blockedReason: value.status === 'blocked' ? String(value.blockedReason ?? '') : null,
  }
}

export function validateReadinessManifest(value) {
  if (value?.schemaVersion !== READINESS_SCHEMA_VERSION ||
      typeof value.generatedAt !== 'string' ||
      !value.sources || typeof value.sources !== 'object' ||
      Array.isArray(value.sources)) {
    throw new Error('readiness manifest 格式無效')
  }
  const sourceIds = Object.keys(value.sources)
  if (sourceIds.some((id) => !READINESS_SOURCE_IDS.includes(id))) {
    throw new Error('readiness manifest 含非白名單來源')
  }
  for (const [id, source] of Object.entries(value.sources)) {
    const allowed = new Set([
      'id',
      'status',
      'checkedAt',
      'adapterVersion',
      'matchingRates',
      'excluded',
      'locationMethods',
      'blockedReason',
    ])
    if (Object.keys(source).some((key) => !allowed.has(key)) ||
        source.id !== id ||
        !['blocked', 'ready'].includes(source.status) ||
        typeof source.checkedAt !== 'string' ||
        typeof source.adapterVersion !== 'string' ||
        (source.status === 'blocked' && !source.blockedReason) ||
        (source.status === 'ready' && source.blockedReason !== null)) {
      throw new Error(`${id} readiness 欄位無效`)
    }
    matchingRates(source.matchingRates)
    counts(source.excluded, `${id} excluded`)
    counts(source.locationMethods, `${id} locationMethods`)
  }
  return value
}

export function buildReadinessManifest(previous, reports, generatedAt) {
  const existing = previous?.schemaVersion === READINESS_SCHEMA_VERSION
    ? previous.sources
    : {}
  const sources = { ...existing }
  for (const report of reports) sources[report.id] = report
  return validateReadinessManifest({
    schemaVersion: READINESS_SCHEMA_VERSION,
    generatedAt,
    sources,
  })
}

export async function readReadinessManifest(file) {
  return readFile(file, 'utf8')
    .then(JSON.parse)
    .then(validateReadinessManifest)
    .catch(() => null)
}

export async function writeReadinessManifest(file, manifest) {
  validateReadinessManifest(manifest)
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`)
  await rename(temporary, file)
}
