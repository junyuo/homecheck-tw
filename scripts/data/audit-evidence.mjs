import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256 } from './core.mjs'
import { FLOOD_SCENARIOS } from './constants.mjs'
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
