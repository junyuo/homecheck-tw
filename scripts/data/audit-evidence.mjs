import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256 } from './core.mjs'
import { FLOOD_SCENARIOS } from './constants.mjs'
import { buildNewTaipeiAddressIndex, buildTaipeiAddressIndex } from './address-index.mjs'
import {
  mergeSchoolCampuses,
  loadCommunityBoundaries,
  parseNewTaipeiSchoolLandmarks,
  parseNewTaipeiParkLandmarks,
  parseNewTaipeiParks,
  parseSchools,
  parseTaipeiParks,
} from './community.mjs'
import { parseLibraries } from './library.mjs'
import {
  parseNewTaipeiHospitals,
  parseNewTaipeiParking,
  parseTaipeiHospitals,
  parseTaipeiParking,
} from './facilities.mjs'
import { inspectAccidentCandidate } from './accidents.mjs'
import { validateShapefileEntries } from './risks.mjs'

const LIQUEFACTION_CLASSES = ['低潛勢', '中潛勢', '高潛勢']
const TAIPEI_CLASS = { '1': '高潛勢', '2': '中潛勢', '3': '低潛勢' }

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} ${args.join(' ')}: ${stderr || code}`))
    })
  })
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

function allRiskCandidates(value) {
  return ['flood', 'liquefaction'].flatMap((source) =>
    Object.values(value.samples[source]).flat())
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function parseCrs(output, file) {
  const identifiers = [...output.matchAll(/ID\["EPSG",\s*(\d+)\]/g)]
  const epsg = identifiers.at(-1)?.[1]
  if (!epsg) throw new Error(`${file} CRS 不明`)
  return `EPSG:${epsg}`
}

function parseQuery(output, field, layer) {
  const count = Number(output.match(/Feature Count:\s*(\d+)/)?.[1] ?? NaN)
  if (!Number.isInteger(count)) throw new Error(`${layer} 無法判斷匹配筆數`)
  const pattern = new RegExp(`^\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\([^)]*\\) = (.*)$`, 'gm')
  const rawValues = [...output.matchAll(pattern)].map((match) => match[1].trim())
  if (rawValues.length !== count) {
    throw new Error(`${layer} 匹配 ${count} 筆，但只讀到 ${rawValues.length} 個 ${field}`)
  }
  return rawValues
}

async function inspectLayer(file, expectedCrs, {
  layer,
  field,
  longitude,
  latitude,
  transformTo,
  category,
}) {
  const summary = await run('ogrinfo', ['-so', '-al', file])
  const crs = parseCrs(summary, file)
  if (crs !== expectedCrs) throw new Error(`${file} CRS ${crs}，預期 ${expectedCrs}`)
  const point = transformTo
    ? `Transform(MakePoint(${longitude},${latitude},4326),${transformTo})`
    : `MakePoint(${longitude},${latitude},4326)`
  const sql = `SELECT ${quoteIdentifier(field)} FROM ${quoteIdentifier(layer)} ` +
    `WHERE ST_Intersects(geometry, ${point})`
  const output = await run('ogrinfo', [
    '-ro', '-geom=NO', '-dialect', 'SQLite', '-sql', sql, file,
  ])
  return {
    crs,
    matches: parseQuery(output, field, layer).map((rawValue) => ({
      layer,
      rawField: field,
      rawValue,
      category: category(rawValue),
    })),
  }
}

async function hashFiles(files) {
  return Promise.all(files.map(async (file) => ({
    file,
    sha256: sha256(await readFile(file)),
  })))
}

function aggregateHash(files) {
  return sha256(files.map((item) => item.sha256).join(':'))
}

async function floodRawFiles(root) {
  return hashFiles(FLOOD_SCENARIOS.map((scenario) =>
    join(root, '.data-cache', 'risks', `flood-${scenario.id}.zip`)))
}

async function liquefactionRawFiles(root) {
  return hashFiles([
    join(root, '.data-cache', 'risks', 'liquefaction-taipei.geojson'),
    ...LIQUEFACTION_CLASSES.map((classification) =>
      join(root, '.data-cache', 'risks', `liquefaction-${classification}.geojson`)),
  ])
}

async function floodShapefile(root) {
  const archive = join(root, '.data-cache', 'risks', 'flood-24h-500.zip')
  const entries = (await run('unzip', ['-Z1', archive])).split(/\r?\n/).filter(Boolean)
  const shapefile = validateShapefileEntries(entries, archive)
  return `/vsizip/${resolve(archive)}/${shapefile}`
}

export function resolveEvidenceMatches(matches) {
  if (matches.length === 0) {
    return { blocked: false, observedCategory: '未確認覆蓋' }
  }
  const categories = new Set(matches.map((item) => item.category).filter(Boolean))
  if (matches.length > 1) {
    return {
      blocked: true,
      reason: categories.size > 1 ? '多重匹配且分類衝突' : '多重匹配，即使同分類亦不自動通過',
    }
  }
  if (categories.size !== 1) return { blocked: true, reason: '未知官方分類' }
  return { blocked: false, observedCategory: matches[0].category }
}

export async function inspectOfficialRaw(root, candidate) {
  if (candidate.source === 'flood') {
    if (candidate.scenario !== '24h-500') throw new Error('離線淹水稽核只接受 24h-500')
    const rawFiles = await floodRawFiles(root)
    const inspected = await inspectLayer(await floodShapefile(root), 'EPSG:3826', {
      layer: 'Flood_500mm_24HR',
      field: 'flood_dept',
      longitude: candidate.longitude,
      latitude: candidate.latitude,
      transformTo: 3826,
      category: (value) => value,
    })
    return { ...inspected, rawFiles, sourceSha256: aggregateHash(rawFiles) }
  }

  const rawFiles = await liquefactionRawFiles(root)
  if (candidate.city === 'taipei') {
    const inspected = await inspectLayer(rawFiles[0].file, 'EPSG:4326', {
      layer: 'TPLiquid_84',
      field: 'class',
      longitude: candidate.longitude,
      latitude: candidate.latitude,
      category: (value) => TAIPEI_CLASS[value],
    })
    return { ...inspected, rawFiles, sourceSha256: aggregateHash(rawFiles) }
  }

  const results = []
  for (const classification of LIQUEFACTION_CLASSES) {
    results.push(await inspectLayer(
      join(root, '.data-cache', 'risks', `liquefaction-${classification}.geojson`),
      'EPSG:4326',
      {
        layer: `liquefaction-${classification}`,
        field: '分級',
        longitude: candidate.longitude,
        latitude: candidate.latitude,
        category: (value) => value,
      },
    ))
  }
  return {
    crs: 'EPSG:4326',
    matches: results.flatMap((item) => item.matches),
    rawFiles,
    sourceSha256: aggregateHash(rawFiles),
  }
}

export async function buildRiskEvidence(root, {
  source,
  id,
  now = new Date().toISOString(),
  inspector = inspectOfficialRaw,
}) {
  if (!['flood', 'liquefaction'].includes(source)) throw new Error(`不支援的 source：${source}`)
  const [manifest, candidates] = await Promise.all([
    readJson(join(root, 'public', 'data', 'manifest.json')),
    readJson(join(root, '.data-cache', 'risk-audit-candidates.json')),
  ])
  const candidate = allRiskCandidates(candidates)
    .find((item) => item.source === source && item.id === id)
  if (!candidate) throw new Error(`${source} 候選清單不存在 ID ${id}`)
  if (candidates.adapterVersion !== manifest.sources[source].qualityGates.automated.adapterVersion) {
    throw new Error(`${source} candidate adapter 版本與 manifest 不一致`)
  }
  const fingerprint = candidates.fingerprints[source]
  if (fingerprint.sourceSha256 !== manifest.sources[source].sha256 ||
      fingerprint.datasetSha256 !== manifest.sources[source].qualityGates.automated.datasetSha256) {
    throw new Error(`${source} 候選 fingerprints 與 manifest 不一致`)
  }

  const inspected = await inspector(root, candidate)
  const expectedCrs = source === 'flood' ? 'EPSG:3826' : 'EPSG:4326'
  if (inspected.crs !== expectedCrs) {
    throw new Error(`${source} raw CRS ${inspected.crs ?? '不明'}，預期 ${expectedCrs}`)
  }
  if (inspected.sourceSha256 !== fingerprint.sourceSha256) {
    throw new Error(`${source} raw cache 雜湊與候選來源不一致`)
  }
  const resolved = resolveEvidenceMatches(inspected.matches)
  const evidence = {
    verificationMethod: 'official-raw-offline',
    sourceSha256: inspected.sourceSha256,
    crs: inspected.crs,
    rawMatchCount: inspected.matches.length,
    rawMatches: inspected.matches,
    checkedAt: now,
  }
  evidence.queryOutputSha256 = sha256(JSON.stringify({
    source,
    id,
    longitude: candidate.longitude,
    latitude: candidate.latitude,
    ...evidence,
  }))
  return {
    candidate,
    evidence,
    blocked: resolved.blocked,
    reason: resolved.reason ?? null,
    observedCategory: resolved.observedCategory ?? null,
    result: resolved.blocked
      ? 'blocked'
      : resolved.observedCategory === candidate.expectedCategory ? 'matched' : 'mismatch',
  }
}

function allFacilityCandidates(value) {
  return ['parking', 'medical'].flatMap((source) =>
    Object.values(value.samples[source]).flat()
      .map((sample) => ({ ...sample, source })))
}

function coordinateDistance(first, second) {
  return Math.hypot(
    (first.latitude - second.latitude) * 111000,
    (first.longitude - second.longitude) * 101000,
  )
}

async function facilityRawBuffers(root, source) {
  const directory = join(root, '.data-cache', 'facilities')
  const names = source === 'parking'
    ? ['taipei-parking.json', 'new-taipei-parking.csv']
    : ['taipei-hospital.csv', 'new-taipei-hospital.csv']
  const buffers = await Promise.all(names.map((name) => readFile(join(directory, name))))
  return {
    buffers,
    sourceSha256: sha256(buffers.map((buffer) => sha256(buffer)).join(':')),
  }
}

export async function buildFacilityEvidence(root, {
  source,
  id,
  now = new Date().toISOString(),
}) {
  if (!['parking', 'medical'].includes(source)) throw new Error(`不支援的 source：${source}`)
  const [manifest, candidates] = await Promise.all([
    readJson(join(root, 'public', 'data', 'manifest.json')),
    readJson(join(root, '.data-cache', 'facility-audit-candidates.json')),
  ])
  const candidate = allFacilityCandidates(candidates)
    .find((item) => item.source === source && item.id === id)
  if (!candidate) throw new Error(`${source} 候選清單不存在 ID ${id}`)
  const manifestSource = manifest.sources[source]
  if (candidates.adapterVersion !== manifestSource.qualityGates.automated.adapterVersion) {
    throw new Error(`${source} candidate adapter 版本與 manifest 不一致`)
  }
  const fingerprint = candidates.fingerprints[source]
  if (fingerprint.sourceSha256 !== manifestSource.sha256 ||
      fingerprint.datasetSha256 !== manifestSource.qualityGates.automated.datasetSha256) {
    throw new Error(`${source} 候選 fingerprints 與 manifest 不一致`)
  }
  const raw = await facilityRawBuffers(root, source)
  if (raw.sourceSha256 !== fingerprint.sourceSha256) {
    throw new Error(`${source} raw cache 雜湊與候選來源不一致`)
  }
  let parsed
  let addressIndexSha256 = null
  if (source === 'parking') {
    parsed = candidate.city === 'taipei'
      ? parseTaipeiParking(JSON.parse(raw.buffers[0].toString('utf8')), now)
      : parseNewTaipeiParking(raw.buffers[1].toString('utf8'), now)
  } else if (candidate.city === 'taipei') {
    parsed = parseTaipeiHospitals(raw.buffers[0], now)
  } else {
    const addressIndex = await buildNewTaipeiAddressIndex(
      join(root, '.data-cache'),
      true,
    )
    addressIndexSha256 = addressIndex.sha256
    if (addressIndexSha256 !== candidates.addressIndexSha256) {
      throw new Error('medical 門牌索引雜湊與候選不一致')
    }
    parsed = parseNewTaipeiHospitals(
      raw.buffers[1].toString('utf8'),
      addressIndex.index,
      now,
    )
    addressIndex.index.clear()
  }
  const rawItem = parsed.find((item) => item.feature?.properties?.id === id)
  if (!rawItem) {
    return {
      candidate,
      blocked: true,
      reason: '官方原始檔找不到候選 ID',
      result: 'blocked',
      evidence: null,
    }
  }
  const fields = {
    id: rawItem.feature.properties.id === candidate.id,
    name: rawItem.name === candidate.name,
    district: rawItem.district === candidate.district,
    coordinate: coordinateDistance(rawItem.coordinate, {
      longitude: candidate.longitude,
      latitude: candidate.latitude,
    }) <= 1,
    ...(source === 'parking'
      ? {
          carCapacity:
            rawItem.feature.properties.carCapacity ===
            candidate.carCapacity,
        }
      : {}),
  }
  const evidence = {
    verificationMethod: 'official-raw-offline',
    sourceSha256: raw.sourceSha256,
    ...(addressIndexSha256 ? { addressIndexSha256 } : {}),
    rawRecordCount: 1,
    fields,
    checkedAt: now,
  }
  evidence.queryOutputSha256 = sha256(JSON.stringify({
    source,
    id,
    city: candidate.city,
    district: candidate.district,
    ...evidence,
  }))
  const matched = Object.values(fields).every((value) => value === true)
  return {
    candidate,
    evidence,
    blocked: false,
    reason: null,
    result: matched ? 'matched' : 'mismatch',
  }
}

export async function buildAccidentEvidence(root, {
  id,
  now = new Date().toISOString(),
}) {
  const [manifest, candidates] = await Promise.all([
    readJson(join(root, 'public', 'data', 'manifest.json')),
    readJson(join(root, '.data-cache', 'accident-audit-candidates.json')),
  ])
  const candidate = Object.entries(candidates.samples)
    .flatMap(([city, samples]) => samples.map((sample) => ({ ...sample, city, source: 'accidents' })))
    .find((item) => item.id === id)
  if (!candidate) throw new Error(`accidents 候選清單不存在 ID ${id}`)
  const source = manifest.sources.accidents
  if (candidates.adapterVersion !== source.qualityGates.automated.adapterVersion) {
    throw new Error('accidents candidate adapter 版本與 manifest 不一致')
  }
  if (candidates.fingerprints.sourceSha256 !== source.sha256 ||
      candidates.fingerprints.datasetSha256 !== source.qualityGates.automated.datasetSha256) {
    throw new Error('accidents 候選 fingerprints 與 manifest 不一致')
  }
  const archive = join(root, '.data-cache', 'accidents', `${candidate.year}.zip`)
  const boundaries = await loadCommunityBoundaries(join(root, 'public', 'data'))
  const inspected = await inspectAccidentCandidate(archive, candidate, boundaries)
  const fields = inspected.fields
  const evidence = {
    verificationMethod: 'official-raw-offline',
    sourceSha256: source.sha256,
    rawRecordCount: inspected.rawRecordCount,
    fields,
    checkedAt: now,
  }
  evidence.queryOutputSha256 = sha256(JSON.stringify({
    id,
    city: candidate.city,
    district: candidate.district,
    year: candidate.year,
    severity: candidate.severity,
    ...evidence,
  }))
  const matched = inspected.rawRecordCount > 0 &&
    ['id', 'date', 'severity', 'district', 'coordinate'].every((field) => fields[field] === true)
  return {
    candidate,
    evidence,
    blocked: inspected.rawRecordCount === 0,
    reason: inspected.rawRecordCount === 0 ? '官方原始 ZIP 找不到候選事故 ID' : null,
    result: matched ? 'matched' : 'mismatch',
  }
}

function allCommunityCandidates(value) {
  return ['school', 'park'].flatMap((source) =>
    Object.values(value.samples[source]).flat()
      .map((sample) => ({ ...sample, source })))
}

async function communityRawBuffers(root, source) {
  const directory = join(root, '.data-cache', 'community')
  const names = source === 'school'
    ? ['elementary.json', 'junior.json', 'senior.json', 'special.csv', 'new-taipei-landmarks.json']
    : ['taipei-park.json', 'new-taipei-park.csv', 'new-taipei-landmarks.json']
  const buffers = await Promise.all(names.map((name) => readFile(join(directory, name))))
  return {
    buffers,
    sourceSha256: sha256(buffers.map((buffer) => sha256(buffer)).join(':')),
  }
}

export async function buildCommunityEvidence(root, {
  source,
  id,
  now = new Date().toISOString(),
}) {
  if (!['school', 'park'].includes(source)) throw new Error(`不支援的 source：${source}`)
  const [manifest, candidates] = await Promise.all([
    readJson(join(root, 'public', 'data', 'manifest.json')),
    readJson(join(root, '.data-cache', 'community-audit-candidates.json')),
  ])
  const candidate = allCommunityCandidates(candidates)
    .find((item) => item.source === source && item.id === id)
  if (!candidate) throw new Error(`${source} 候選清單不存在 ID ${id}`)
  const manifestSource = manifest.sources[source]
  if (candidates.adapterVersion !== manifestSource.qualityGates.automated.adapterVersion) {
    throw new Error(`${source} candidate adapter 版本與 manifest 不一致`)
  }
  const fingerprint = candidates.fingerprints[source]
  if (fingerprint.sourceSha256 !== manifestSource.sha256 ||
      fingerprint.datasetSha256 !== manifestSource.qualityGates.automated.datasetSha256) {
    throw new Error(`${source} 候選 fingerprints 與 manifest 不一致`)
  }
  const raw = await communityRawBuffers(root, source)
  if (raw.sourceSha256 !== fingerprint.sourceSha256) {
    throw new Error(`${source} raw cache 雜湊與候選來源不一致`)
  }
  const cache = join(root, '.data-cache')
  const indexes = {
    taipei: await buildTaipeiAddressIndex(cache, true),
    'new-taipei': await buildNewTaipeiAddressIndex(cache, true),
  }
  for (const city of ['taipei', 'new-taipei']) {
    if (indexes[city].sha256 !== candidates.addressIndexSha256[city]) {
      throw new Error(`${source} ${city} 門牌索引雜湊與候選不一致`)
    }
  }
  let parsed
  const parseJson = (buffer) => JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  if (source === 'school') {
    if (sha256(raw.buffers[4]) !== candidates.landmarkSha256) {
      throw new Error('school 地標來源雜湊與候選不一致')
    }
    parsed = mergeSchoolCampuses(parseSchools({
      elementary: parseJson(raw.buffers[0]),
      junior: parseJson(raw.buffers[1]),
      senior: parseJson(raw.buffers[2]),
      special: raw.buffers[3].toString('utf8'),
    }, indexes, now, parseNewTaipeiSchoolLandmarks(parseJson(raw.buffers[4]))))
  } else {
    if (sha256(raw.buffers[2]) !== candidates.landmarkSha256) {
      throw new Error('park 地標來源雜湊與候選不一致')
    }
    parsed = candidate.city === 'taipei'
      ? parseTaipeiParks(
        parseJson(raw.buffers[0]),
        now,
        await loadCommunityBoundaries(join(root, 'public', 'data')),
      )
      : parseNewTaipeiParks(
        raw.buffers[1].toString('utf8'),
        indexes['new-taipei'].index,
        now,
        parseNewTaipeiParkLandmarks(parseJson(raw.buffers[2])),
      )
  }
  indexes.taipei.index.clear()
  indexes['new-taipei'].index.clear()
  const rawItem = parsed.find((item) => item.feature?.properties?.id === id)
  if (!rawItem) {
    return {
      candidate,
      blocked: true,
      reason: '官方原始檔找不到候選 ID',
      result: 'blocked',
      evidence: null,
    }
  }
  const fields = {
    id: rawItem.feature.properties.id === candidate.id,
    name: rawItem.name === candidate.name,
    district: rawItem.district === candidate.district,
    coordinate: coordinateDistance(rawItem.coordinate, {
      longitude: candidate.longitude,
      latitude: candidate.latitude,
    }) <= 1,
    ...(source === 'school'
      ? {
          schoolLevels:
            JSON.stringify(rawItem.feature.properties.schoolLevels) ===
            JSON.stringify(candidate.schoolLevels),
        }
      : { parkType: rawItem.feature.properties.parkType === candidate.parkType }),
  }
  const addressIndexSha256 = source === 'park' && candidate.city === 'taipei'
    ? null
    : candidates.addressIndexSha256[candidate.city]
  const evidence = {
    verificationMethod: 'official-raw-offline',
    sourceSha256: raw.sourceSha256,
    ...(addressIndexSha256 ? { addressIndexSha256 } : {}),
    ...(rawItem.evidence.locationMethod === 'ntpc-landmark-exact'
      ? { landmarkSha256: candidates.landmarkSha256 }
      : {}),
    locationMethod: rawItem.evidence.locationMethod ?? 'direct-coordinate',
    rawRecordCount: 1,
    fields,
    checkedAt: now,
  }
  evidence.queryOutputSha256 = sha256(JSON.stringify({
    source,
    id,
    city: candidate.city,
    district: candidate.district,
    ...evidence,
  }))
  return {
    candidate,
    evidence,
    blocked: false,
    reason: null,
    result: Object.values(fields).every(Boolean) ? 'matched' : 'mismatch',
  }
}

export async function buildLibraryEvidence(root, {
  id,
  now = new Date().toISOString(),
}) {
  const [manifest, candidates] = await Promise.all([
    readJson(join(root, 'public', 'data', 'manifest.json')),
    readJson(join(root, '.data-cache', 'library-audit-candidates.json')),
  ])
  const candidate = Object.entries(candidates.samples)
    .flatMap(([city, samples]) => samples.map((sample) => ({ ...sample, city, source: 'library' })))
    .find((item) => item.id === id)
  if (!candidate) throw new Error(`library 候選清單不存在 ID ${id}`)
  const source = manifest.sources.library
  if (candidates.adapterVersion !== source.qualityGates.automated.adapterVersion) {
    throw new Error('library candidate adapter 版本與 manifest 不一致')
  }
  if (candidates.fingerprints.sourceSha256 !== source.sha256 ||
      candidates.fingerprints.datasetSha256 !== source.qualityGates.automated.datasetSha256) {
    throw new Error('library 候選 fingerprints 與 manifest 不一致')
  }
  const rawFile = join(root, '.data-cache', 'library', 'public-libraries.json')
  const raw = await readFile(rawFile)
  if (sha256(raw) !== source.sha256) throw new Error('library raw cache 雜湊與候選不一致')
  const parsed = parseLibraries(
    JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')),
    now,
  )
  const rawItem = parsed.find((item) => item.feature?.properties?.id === id)
  if (!rawItem) {
    return {
      candidate,
      blocked: true,
      reason: '官方原始檔找不到候選 ID',
      result: 'blocked',
      evidence: null,
    }
  }
  const fields = {
    id: rawItem.feature.properties.id === candidate.id,
    name: rawItem.name === candidate.name,
    district: rawItem.district === candidate.district,
    coordinate: coordinateDistance(rawItem.coordinate, {
      longitude: candidate.longitude,
      latitude: candidate.latitude,
    }) <= 1,
  }
  const evidence = {
    verificationMethod: 'official-raw-offline',
    sourceSha256: source.sha256,
    rawRecordCount: 1,
    fields,
    checkedAt: now,
  }
  evidence.queryOutputSha256 = sha256(JSON.stringify({
    source: 'library',
    id,
    city: candidate.city,
    district: candidate.district,
    ...evidence,
  }))
  return {
    candidate,
    evidence,
    blocked: false,
    reason: null,
    result: Object.values(fields).every(Boolean) ? 'matched' : 'mismatch',
  }
}
