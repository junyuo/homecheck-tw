import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { csvFileRows, downloadFile, inTaipeiMetroArea, parseCsvLine, sha256, withRetry } from './core.mjs'
import { ALL_DISTRICTS, DISTRICTS, EMPTY_GEOJSON, SOURCE_URLS } from './constants.mjs'

function districtFromAddress(address) {
  const city = /新北市/.test(address) ? 'new-taipei' : /[臺台]北市/.test(address) ? 'taipei' : null
  if (!city) return null
  const district = Object.keys(DISTRICTS[city]).find((label) => address.includes(label))
  return district ? { city, district: DISTRICTS[city][district] } : null
}

function point(name, category, longitude, latitude) {
  return {
    type: 'Feature',
    properties: { name, category },
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  }
}

async function updateMetro(generated, cache, now) {
  const file = join(cache, 'metro.csv')
  await downloadFile(SOURCE_URLS.metro, file)
  const features = new Map(ALL_DISTRICTS.map(({ city, slug }) => [`${city}/${slug}`, []]))
  const seen = new Set()
  let excluded = 0
  for await (const row of csvFileRows(file)) {
    const id = String(row.StationID ?? '').replace(/^'/, '')
    if (!id || seen.has(id)) continue
    const location = districtFromAddress(String(row.StationAddress ?? '').replace(/^'/, ''))
    const coordinate = String(row.StationPosition ?? '').match(/([\d.]+)\s*,\s*([\d.]+)/)
    const nameMatch = String(row.StationName ?? '').match(/\{([^,}]+)/)
    if (!location || !coordinate) {
      excluded += 1
      continue
    }
    const longitude = Number(coordinate[1])
    const latitude = Number(coordinate[2])
    if (!inTaipeiMetroArea({ latitude, longitude })) {
      excluded += 1
      continue
    }
    seen.add(id)
    features.get(`${location.city}/${location.district}`)
      .push(point(nameMatch?.[1] ?? id, 'metro', longitude, latitude))
  }
  const files = []
  for (const [key, items] of features) {
    const relative = `${key}/facilities/metro.geojson`
    await mkdir(join(generated, key, 'facilities'), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features: items })}\n`)
    files.push(relative)
  }
  return {
    id: 'metro',
    status: 'official',
    version: `metro-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: seen.size,
    sha256: sha256(await readFile(file)),
    excluded: { invalidOrUnassigned: excluded },
    files,
  }
}

async function updateNewTaipeiBus(generated, now) {
  const url = `${SOURCE_URLS.newTaipeiBus}?page=0&size=100000`
  const text = await withRetry('new-taipei-bus', async () => {
    const response = await fetch(url, { headers: { 'user-agent': 'homecheck-tw-data-pipeline/1.0' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const value = await response.text()
    if (/^\s*</.test(value)) throw new Error('HTML response')
    return value
  })
  const lines = text.split(/\r?\n/).filter(Boolean)
  const headers = parseCsvLine(lines.shift() ?? '').map((value) => value.replace(/^\uFEFF/, ''))
  const features = new Map(Object.values(DISTRICTS['new-taipei']).map((slug) => [slug, []]))
  const seen = new Set()
  let invalid = 0
  for (const line of lines) {
    const values = parseCsvLine(line)
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']))
    const id = String(row.stoplocationid ?? '')
    if (!id || seen.has(id)) continue
    const district = districtFromAddress(row.address)
    const longitude = Number(row.showlon || row.longitude)
    const latitude = Number(row.showlat || row.latitude)
    if (!district || district.city !== 'new-taipei' || !inTaipeiMetroArea({ latitude, longitude })) {
      invalid += 1
      continue
    }
    seen.add(id)
    features.get(district.district).push(point(row.namezh || id, 'bus', longitude, latitude))
  }
  const duplicateRate = lines.length ? (lines.length - seen.size - invalid) / lines.length : 0
  if (duplicateRate < 0 || duplicateRate > 0.99) throw new Error(`公車站位去重比例異常：${duplicateRate}`)
  const files = []
  for (const [district, items] of features) {
    const relative = `new-taipei/${district}/facilities/bus-new-taipei.geojson`
    await mkdir(join(generated, 'new-taipei', district, 'facilities'), { recursive: true })
    await writeFile(join(generated, relative), `${JSON.stringify({ ...EMPTY_GEOJSON, features: items })}\n`)
    files.push(relative)
  }
  return {
    id: 'bus-new-taipei',
    status: 'official',
    version: `bus-new-taipei-${now.toISOString().slice(0, 10)}`,
    updatedAt: now.toISOString(),
    recordCount: seen.size,
    sha256: sha256(text),
    excluded: { invalidOrUnassigned: invalid, duplicateRouteStops: lines.length - seen.size - invalid },
    files,
  }
}

export async function updateOfficialTransport({ output, cache, now = new Date(), dryRun = false }) {
  const generated = join(cache, 'generated-transport')
  await rm(generated, { recursive: true, force: true })
  await mkdir(generated, { recursive: true })
  const results = []
  for (const operation of [
    () => updateMetro(generated, cache, now),
    () => updateNewTaipeiBus(generated, now),
  ]) {
    try {
      results.push(await operation())
    } catch (error) {
      results.push({ status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!dryRun) {
    for (const result of results) {
      if (result.status !== 'official') continue
      for (const file of result.files) {
        await mkdir(dirname(join(output, file)), { recursive: true })
        await writeFile(join(output, file), await readFile(join(generated, file)))
      }
    }
  }
  return results
}
