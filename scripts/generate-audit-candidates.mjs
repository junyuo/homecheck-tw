#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import { stableId } from './data/core.mjs'
import { ALL_DISTRICTS, DEFAULT_FLOOD_SCENARIO } from './data/constants.mjs'
import { sourceFilesSha256 } from './data/manifest.mjs'

const root = resolve(import.meta.dirname, '..')
const data = join(root, 'public', 'data')
const cache = join(root, '.data-cache')

function polygons(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates
}

function rings(feature) {
  return polygons(feature.geometry).flat()
}

function distanceToSegmentMeters([longitude, latitude], start, end) {
  const scaleX = 111000 * Math.cos(latitude * Math.PI / 180)
  const scaleY = 111000
  const ax = (start[0] - longitude) * scaleX
  const ay = (start[1] - latitude) * scaleY
  const bx = (end[0] - longitude) * scaleX
  const by = (end[1] - latitude) * scaleY
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const ratio = lengthSquared
    ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared))
    : 0
  return Math.hypot(ax + ratio * dx, ay + ratio * dy)
}

function edgeDistanceMeters(coordinate, features) {
  let closest = Infinity
  for (const feature of features) {
    for (const ring of rings(feature)) {
      for (let index = 1; index < ring.length; index += 1) {
        closest = Math.min(
          closest,
          distanceToSegmentMeters(coordinate, ring[index - 1], ring[index]),
        )
      }
    }
  }
  return closest
}

function bbox(feature) {
  const coordinates = polygons(feature.geometry).flat(2)
  return coordinates.reduce((box, coordinate) => ({
    minX: Math.min(box.minX, coordinate[0]),
    minY: Math.min(box.minY, coordinate[1]),
    maxX: Math.max(box.maxX, coordinate[0]),
    maxY: Math.max(box.maxY, coordinate[1]),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
}

function interiorPoint(feature, excluded = []) {
  const box = bbox(feature)
  let best = null
  for (let xIndex = 1; xIndex < 40; xIndex += 1) {
    for (let yIndex = 1; yIndex < 40; yIndex += 1) {
      const coordinate = [
        box.minX + (box.maxX - box.minX) * xIndex / 40,
        box.minY + (box.maxY - box.minY) * yIndex / 40,
      ]
      const candidate = point(coordinate)
      if (!booleanPointInPolygon(candidate, feature) ||
          excluded.some((item) => booleanPointInPolygon(candidate, item))) continue
      const boundaryDistance = Math.min(
        edgeDistanceMeters(coordinate, [feature]),
        excluded.length ? edgeDistanceMeters(coordinate, excluded) : Infinity,
      )
      if (!best || boundaryDistance > best.boundaryDistance) {
        best = { coordinate, boundaryDistance }
      }
    }
  }
  return best?.boundaryDistance >= 20 ? best : null
}

async function collection(file) {
  return JSON.parse(await readFile(join(data, file), 'utf8'))
}

function auditPoint(source, city, district, feature, location, caseType, extra = {}) {
  const longitude = Number(location.coordinate[0].toFixed(5))
  const latitude = Number(location.coordinate[1].toFixed(5))
  const expectedCategory = feature?.properties?.officialCategory ?? '未確認覆蓋'
  return {
    id: stableId([source, city, district, longitude, latitude, expectedCategory]),
    source,
    city,
    district,
    longitude,
    latitude,
    caseType,
    expectedCategory,
    boundaryDistanceMeters: Math.round(location.boundaryDistance),
    ...extra,
  }
}

async function districtCandidates(source, city) {
  const candidates = []
  for (const district of ALL_DISTRICTS.filter((item) => item.city === city)) {
    const boundary = (await collection(`boundaries/${city}/${district.slug}.geojson`)).features[0]
    const riskFile = source === 'flood'
      ? `${city}/${district.slug}/risks/flood/${DEFAULT_FLOOD_SCENARIO}.geojson`
      : `${city}/${district.slug}/risks/liquefaction.geojson`
    const risks = (await collection(riskFile)).features
    for (const feature of risks) {
      const location = interiorPoint(feature)
      if (!location) continue
      const caseType = source === 'flood'
        ? feature.properties.level === 'priority' ? 'red' : 'yellow'
        : feature.properties.level === 'priority'
          ? 'high'
          : feature.properties.level === 'attention' ? 'medium' : 'low'
      candidates.push(auditPoint(
        source,
        city,
        district.slug,
        feature,
        location,
        caseType,
        source === 'flood' ? { scenario: DEFAULT_FLOOD_SCENARIO } : {},
      ))
    }
    const uncovered = interiorPoint(boundary, risks)
    if (uncovered) {
      candidates.push(auditPoint(
        source,
        city,
        district.slug,
        null,
        uncovered,
        source === 'flood' ? 'unknown' : 'uncovered',
        source === 'flood' ? { scenario: DEFAULT_FLOOD_SCENARIO } : {},
      ))
    }
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id))
}

function selectFlood(candidates) {
  const selected = []
  const reds = candidates.filter((item) => item.caseType === 'red')
  const firstRed = reds[0]
  const secondRed = reds.find((item) => item.expectedCategory !== firstRed?.expectedCategory)
  if (firstRed) selected.push(firstRed)
  if (secondRed) selected.push(secondRed)
  selected.push(...candidates.filter((item) => item.caseType === 'yellow').slice(0, 2))
  selected.push(...candidates.filter((item) => item.caseType === 'unknown').slice(0, 1))
  return selected
}

function selectLiquefaction(candidates) {
  return [
    ...candidates.filter((item) => item.caseType === 'high').slice(0, 1),
    ...candidates.filter((item) => item.caseType === 'medium').slice(0, 1),
    ...candidates.filter((item) => item.caseType === 'low').slice(0, 1),
    ...candidates.filter((item) => item.caseType === 'uncovered').slice(0, 2),
  ]
}

async function main() {
  const manifest = JSON.parse(await readFile(join(data, 'manifest.json'), 'utf8'))
  const samples = {}
  for (const source of ['flood', 'liquefaction']) {
    samples[source] = {}
    for (const city of ['taipei', 'new-taipei']) {
      const candidates = await districtCandidates(source, city)
      samples[source][city] = source === 'flood'
        ? selectFlood(candidates)
        : selectLiquefaction(candidates)
      if (samples[source][city].length !== 5) {
        throw new Error(`${source}/${city} 無法產生 5 個符合條件且離邊界 20 公尺的樣本`)
      }
    }
  }
  const fingerprints = Object.fromEntries(await Promise.all(
    ['flood', 'liquefaction'].map(async (source) => [source, {
      sourceSha256: manifest.sources[source].sha256,
      datasetSha256: await sourceFilesSha256(data, manifest.sources[source].files),
    }]),
  ))
  await writeFile(join(cache, 'risk-audit-candidates.json'), `${JSON.stringify({
    adapterVersion: 'risks-v1',
    generatedAt: new Date().toISOString(),
    fingerprints,
    samples,
  }, null, 2)}\n`)
  console.log('[audit] 已產生 20 個災害人工驗收代表點')
}

main().catch((error) => {
  console.error(`[audit] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
