import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ALL_DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'
import {
  downloadFile,
  inTaipeiMetroArea,
  parseCsvLine,
  rowObject,
  sha256,
  stableId,
} from './core.mjs'
import { loadCommunityBoundaries } from './community.mjs'
import { sourceFilesSha256 } from './manifest.mjs'
import { pointMatchesDistrict } from './transport.mjs'

export const ACCIDENTS_ADAPTER_VERSION = 'accidents-v1'
export const ACCIDENT_YEARS = [2023, 2024, 2025]
const PUBLIC_PROPERTIES = new Set(['id', 'date', 'year', 'severity'])

function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function parseDate(value, expectedYear) {
  const digits = String(value ?? '').replace(/\D/g, '')
  if (digits.length !== 8) return null
  const year = Number(digits.slice(0, 4))
  const month = Number(digits.slice(4, 6))
  const day = Number(digits.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (year !== expectedYear || date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
}

export function parseAccidentRecord(row, expectedYear, expectedSeverity) {
  if (Number(row['發生年度']) !== expectedYear) return { excluded: 'invalidDate' }
  const date = parseDate(row['發生日期'], expectedYear)
  if (!date) return { excluded: 'invalidDate' }
  const severity = normalizeText(row['事故類別名稱']).toUpperCase()
  if (!['A1', 'A2'].includes(severity) || severity !== expectedSeverity) {
    return { excluded: 'invalidSeverity' }
  }
  const longitude = Number(row['經度'])
  const latitude = Number(row['緯度'])
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) ||
      longitude < 118 || longitude > 123 || latitude < 20 || latitude > 27) {
    return { excluded: 'invalidCoordinate' }
  }
  const coordinate = {
    longitude: Math.round(longitude * 1e6) / 1e6,
    latitude: Math.round(latitude * 1e6) / 1e6,
  }
  const identity = {
    year: expectedYear,
    date,
    time: normalizeText(row['發生時間']),
    severity,
    police: normalizeText(row['處理單位名稱警局層']),
    location: normalizeText(row['發生地點']),
    longitude: coordinate.longitude.toFixed(6),
    latitude: coordinate.latitude.toFixed(6),
  }
  return {
    id: stableId(Object.values(identity)),
    date,
    year: expectedYear,
    severity,
    coordinate,
    identity,
  }
}

export function accidentHeader(line) {
  const marker = line.lastIndexOf('發生年度')
  if (marker < 0 || !line.includes('事故類別名稱') || !line.includes('經度')) return null
  return parseCsvLine(line.slice(marker)).map((value) => value.replace(/^\uFEFF/, ''))
}

export async function streamAccidentArchive(file, severity, onRecord) {
  const child = spawn('unzip', ['-p', file, `*${severity}*`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let headers = null
  let headerCount = 0
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  for await (const line of lines) {
    const nextHeaders = accidentHeader(line)
    if (nextHeaders) {
      headers = nextHeaders
      headerCount += 1
      continue
    }
    if (!headers || !line.trim()) continue
    await onRecord(rowObject(headers, parseCsvLine(line)))
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (exitCode !== 0) throw new Error(`unzip ${severity} 失敗：${stderr.trim() || `exit ${exitCode}`}`)
  const expectedHeaders = severity === 'A1' ? 1 : 12
  if (headerCount !== expectedHeaders) {
    throw new Error(`${severity} CSV 段落數 ${headerCount}，預期 ${expectedHeaders}`)
  }
  return headerCount
}

async function assertZip(file) {
  const handle = await open(file, 'r')
  try {
    const signature = Buffer.alloc(4)
    const { bytesRead } = await handle.read(signature, 0, 4, 0)
    if (bytesRead !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
      throw new Error(`${file} 不是 ZIP 檔`)
    }
  } finally {
    await handle.close()
  }
}

function geometryBounds(value, bounds = {
  minLongitude: Infinity,
  maxLongitude: -Infinity,
  minLatitude: Infinity,
  maxLatitude: -Infinity,
}) {
  if (Array.isArray(value) && value.length >= 2 && value.every(Number.isFinite)) {
    bounds.minLongitude = Math.min(bounds.minLongitude, value[0])
    bounds.maxLongitude = Math.max(bounds.maxLongitude, value[0])
    bounds.minLatitude = Math.min(bounds.minLatitude, value[1])
    bounds.maxLatitude = Math.max(bounds.maxLatitude, value[1])
  } else if (Array.isArray(value)) {
    for (const child of value) geometryBounds(child, bounds)
  }
  return bounds
}

function prepareBoundaries(boundaries) {
  return ALL_DISTRICTS.map((district) => {
    const boundary = boundaries.get(`${district.city}/${district.slug}`)
    const coordinates = boundary.type === 'FeatureCollection'
      ? boundary.features.map((feature) => feature.geometry.coordinates)
      : boundary.geometry.coordinates
    return { district, boundary, bounds: geometryBounds(coordinates) }
  })
}

function districtsFor(boundaries, coordinate) {
  const prepared = boundaries instanceof Map ? prepareBoundaries(boundaries) : boundaries
  return prepared
    .filter(({ bounds }) =>
      coordinate.longitude >= bounds.minLongitude && coordinate.longitude <= bounds.maxLongitude &&
      coordinate.latitude >= bounds.minLatitude && coordinate.latitude <= bounds.maxLatitude)
    .filter(({ boundary }) => pointMatchesDistrict(boundary, coordinate))
    .map(({ district }) => district)
}

function selectAuditSamples(items) {
  return Object.fromEntries(['taipei', 'new-taipei'].map((city) => {
    const available = items.filter((item) => item.city === city)
      .sort((a, b) => a.feature.properties.id.localeCompare(b.feature.properties.id))
    const selected = []
    for (const year of ACCIDENT_YEARS) {
      const item = available.find((candidate) =>
        candidate.feature.properties.year === year && !selected.includes(candidate))
      if (item) selected.push(item)
    }
    for (const severity of ['A1', 'A2']) {
      const item = available.find((candidate) =>
        candidate.feature.properties.severity === severity && !selected.includes(candidate))
      if (item) selected.push(item)
    }
    for (const item of available) {
      if (selected.length >= 5) break
      if (!selected.includes(item)) selected.push(item)
    }
    return [city, selected.slice(0, 5).map((item) => ({
      id: item.feature.properties.id,
      city,
      district: item.district,
      date: item.feature.properties.date,
      year: item.feature.properties.year,
      severity: item.feature.properties.severity,
      longitude: item.coordinate.longitude,
      latitude: item.coordinate.latitude,
      sourceSha256: item.sourceSha256,
    }))]
  }))
}

function assertPublicFeature(feature) {
  const keys = Object.keys(feature.properties ?? {})
  if (keys.some((key) => !PUBLIC_PROPERTIES.has(key))) {
    throw new Error(`事故公開檔含非白名單欄位：${keys.join(', ')}`)
  }
}

async function buildYear(file, year, sourceSha256, boundaries) {
  const unique = new Map()
  const seenMetro = new Set()
  const excluded = {
    invalidDate: 0,
    invalidSeverity: 0,
    invalidCoordinate: 0,
    outsideTaipeiMetro: 0,
    ambiguousDistrict: 0,
    duplicatePartyRow: 0,
  }
  let rawRows = 0
  let metroRows = 0
  for (const severity of ['A1', 'A2']) {
    await streamAccidentArchive(file, severity, async (row) => {
      rawRows += 1
      const parsed = parseAccidentRecord(row, year, severity)
      if (parsed.excluded) {
        excluded[parsed.excluded] += 1
        return
      }
      if (!inTaipeiMetroArea(parsed.coordinate)) {
        excluded.outsideTaipeiMetro += 1
        return
      }
      metroRows += 1
      if (seenMetro.has(parsed.id)) {
        excluded.duplicatePartyRow += 1
        const existing = unique.get(parsed.id)
        if (existing) existing.partyRowCount += 1
        return
      }
      seenMetro.add(parsed.id)
      const districts = districtsFor(boundaries, parsed.coordinate)
      if (districts.length === 0) {
        excluded.outsideTaipeiMetro += 1
        return
      }
      if (districts.length > 1) {
        excluded.ambiguousDistrict += 1
        return
      }
      const district = districts[0]
      const feature = {
        type: 'Feature',
        properties: {
          id: parsed.id,
          date: parsed.date,
          year: parsed.year,
          severity: parsed.severity,
        },
        geometry: {
          type: 'Point',
          coordinates: [parsed.coordinate.longitude, parsed.coordinate.latitude],
        },
      }
      assertPublicFeature(feature)
      unique.set(parsed.id, {
        city: district.city,
        district: district.slug,
        coordinate: parsed.coordinate,
        identity: parsed.identity,
        sourceSha256,
        partyRowCount: 1,
        feature,
      })
    })
  }
  const majorExclusions = excluded.invalidDate + excluded.invalidSeverity +
    excluded.invalidCoordinate + excluded.ambiguousDistrict
  if (rawRows > 0 && majorExclusions / rawRows > 0.02) {
    throw new Error(`${year} 重大格式排除率 ${((majorExclusions / rawRows) * 100).toFixed(2)}% 超過 2%`)
  }
  const items = [...unique.values()]
  const reconciled = Object.values(excluded).reduce((sum, count) => sum + count, 0) + items.length
  if (reconciled !== rawRows) throw new Error(`${year} 原始列數無法完整對帳`)
  for (const city of ['taipei', 'new-taipei']) {
    const cityItems = items.filter((item) => item.city === city)
    if (!cityItems.some((item) => item.feature.properties.severity === 'A1') ||
        !cityItems.some((item) => item.feature.properties.severity === 'A2')) {
      throw new Error(`${year} ${city} 缺少 A1 或 A2 事故`)
    }
  }
  return { items, excluded, rawRows, metroRows }
}

export async function updateOfficialAccidents({
  output,
  cache,
  now = new Date(),
  dryRun = false,
  reuseCache = false,
  previous,
}) {
  const directory = join(cache, 'accidents')
  const generated = join(cache, 'generated-accidents')
  await mkdir(directory, { recursive: true })
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const archives = []
  for (const year of ACCIDENT_YEARS) {
    const file = join(directory, `${year}.zip`)
    if (!reuseCache || !await readFile(file).catch(() => null)) {
      await downloadFile(SOURCE_URLS.accidents[year], file)
    }
    await assertZip(file)
    const buffer = await readFile(file)
    archives.push({ year, file, sha256: sha256(buffer) })
  }
  const sourceSha256 = sha256(archives.map((item) => `${item.year}:${item.sha256}`).join('|'))
  if (previous?.status === 'official' && previous?.sha256 === sourceSha256 && previous?.files?.length === 123 &&
      previous?.qualityGates?.automated?.adapterVersion === ACCIDENTS_ADAPTER_VERSION) {
    return {
      id: 'accidents',
      status: 'official',
      version: previous.version,
      updatedAt: previous.updatedAt,
      metadataCheckedAt: now.toISOString(),
      recordCount: previous.recordCount,
      sha256: sourceSha256,
      matchingRate: null,
      excluded: previous.excluded ?? {},
      files: previous.files,
      years: ACCIDENT_YEARS,
      adapterVersion: ACCIDENTS_ADAPTER_VERSION,
      unchanged: true,
    }
  }
  const boundaries = prepareBoundaries(await loadCommunityBoundaries(output))
  const allItems = []
  const excluded = {}
  const yearly = {}
  for (const archive of archives) {
    const result = await buildYear(archive.file, archive.year, archive.sha256, boundaries)
    allItems.push(...result.items)
    yearly[archive.year] = {
      rawRows: result.rawRows,
      metroRows: result.metroRows,
      cases: result.items.length,
      excluded: result.excluded,
    }
    for (const [reason, count] of Object.entries(result.excluded)) {
      excluded[reason] = (excluded[reason] ?? 0) + count
    }
  }
  allItems.forEach((item) => { item.sourceSha256 = sourceSha256 })
  if (new Set(allItems.map((item) => item.feature.properties.id)).size !== allItems.length) {
    throw new Error('三年事故穩定 ID 重複')
  }
  if (previous?.recordCount > 0 && allItems.length < previous.recordCount * 0.9) {
    throw new Error(`事故筆數較 last-good 異常下降：${previous.recordCount} → ${allItems.length}`)
  }
  const grouped = new Map()
  for (const { city, slug } of ALL_DISTRICTS) {
    for (const year of ACCIDENT_YEARS) grouped.set(`${city}/${slug}/${year}`, [])
  }
  for (const item of allItems) {
    grouped.get(`${item.city}/${item.district}/${item.feature.properties.year}`).push(item.feature)
  }
  const files = []
  for (const [key, features] of grouped) {
    const [city, district, year] = key.split('/')
    const relative = `${city}/${district}/accidents/${year}.json`
    await mkdir(dirname(join(generated, relative)), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features })}\n`)
    files.push(relative)
  }
  const candidates = {
    adapterVersion: ACCIDENTS_ADAPTER_VERSION,
    generatedAt: now.toISOString(),
    fingerprints: { sourceSha256 },
    samples: selectAuditSamples(allItems),
  }
  candidates.fingerprints.datasetSha256 = await sourceFilesSha256(generated, files)
  await writeFile(join(cache, 'accident-audit-candidates.json'), `${JSON.stringify(candidates, null, 2)}\n`)
  if (!dryRun) {
    for (const file of files) {
      await mkdir(dirname(join(output, file)), { recursive: true })
      await writeFile(join(output, file), await readFile(join(generated, file)))
    }
  }
  return {
    id: 'accidents',
    status: 'official',
    version: `accidents-${ACCIDENT_YEARS[0]}-${ACCIDENT_YEARS.at(-1)}-${sourceSha256.slice(0, 8)}`,
    updatedAt: now.toISOString(),
    metadataCheckedAt: now.toISOString(),
    recordCount: allItems.length,
    sha256: sourceSha256,
    matchingRate: null,
    excluded,
    files,
    years: ACCIDENT_YEARS,
    yearly,
    adapterVersion: ACCIDENTS_ADAPTER_VERSION,
  }
}

export async function inspectAccidentCandidate(file, candidate, boundaries) {
  let rawRecordCount = 0
  let parsedMatch = null
  await streamAccidentArchive(file, candidate.severity, async (row) => {
    const parsed = parseAccidentRecord(row, candidate.year, candidate.severity)
    if (parsed.id !== candidate.id) return
    rawRecordCount += 1
    parsedMatch = parsed
  })
  if (!parsedMatch) return { rawRecordCount: 0, fields: {} }
  const districts = districtsFor(boundaries, parsedMatch.coordinate)
  const district = districts.length === 1 ? districts[0] : null
  return {
    rawRecordCount,
    fields: {
      id: parsedMatch.id === candidate.id,
      date: parsedMatch.date === candidate.date,
      severity: parsedMatch.severity === candidate.severity,
      district: district?.city === candidate.city && district?.slug === candidate.district,
      coordinate: parsedMatch.coordinate.longitude === candidate.longitude &&
        parsedMatch.coordinate.latitude === candidate.latitude,
    },
  }
}
