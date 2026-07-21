import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertAuditPrivacy } from './audit-workflow.mjs'
import { buildFacilityEvidence, buildLibraryEvidence, buildRiskEvidence, resolveEvidenceMatches } from './audit-evidence.mjs'
import { sha256, stableId, twd97ToWgs84 } from './core.mjs'
import { parseLibraries } from './library.mjs'

const sourceSha256 = 'a'.repeat(64)
const datasetSha256 = 'b'.repeat(64)

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-evidence-'))
  await mkdir(join(root, 'public', 'data'), { recursive: true })
  await mkdir(join(root, '.data-cache'), { recursive: true })
  await writeJson(join(root, 'public', 'data', 'manifest.json'), {
    sources: {
      flood: {
        sha256: sourceSha256,
        qualityGates: {
          automated: { adapterVersion: 'risks-v1', datasetSha256 },
        },
      },
      liquefaction: {
        sha256: sourceSha256,
        qualityGates: {
          automated: { adapterVersion: 'risks-v1', datasetSha256 },
        },
      },
    },
  })
  await writeJson(join(root, '.data-cache', 'risk-audit-candidates.json'), {
    adapterVersion: 'risks-v1',
    fingerprints: {
      flood: { sourceSha256, datasetSha256 },
      liquefaction: { sourceSha256, datasetSha256 },
    },
    samples: {
      flood: {
        taipei: [{
          id: 'flood-id',
          source: 'flood',
          city: 'taipei',
          district: 'beitou',
          longitude: 121.47551,
          latitude: 25.12427,
          expectedCategory: '1.0-2.0',
          scenario: '24h-500',
        }],
        'new-taipei': [],
      },
      liquefaction: {
        taipei: [{
          id: 'liquid-id',
          source: 'liquefaction',
          city: 'taipei',
          district: 'datong',
          longitude: 121.51529,
          latitude: 25.06019,
          expectedCategory: '高潛勢',
        }],
        'new-taipei': [],
      },
    },
  })
  return root
}

function inspector(matches, crs = 'EPSG:3826', hash = sourceSha256) {
  return async () => ({ matches, crs, sourceSha256: hash, rawFiles: [] })
}

test('證據只接受候選 ID 且 fingerprints 必須一致', async () => {
  const root = await fixture()
  await assert.rejects(buildRiskEvidence(root, {
    source: 'flood',
    id: 'missing',
    inspector: inspector([]),
  }), /不存在 ID/)
  const manifestFile = join(root, 'public', 'data', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
  manifest.sources.flood.sha256 = 'c'.repeat(64)
  await writeJson(manifestFile, manifest)
  await assert.rejects(buildRiskEvidence(root, {
    source: 'flood',
    id: 'flood-id',
    inspector: inspector([]),
  }), /fingerprints/)
})

test('raw cache 雜湊與 CRS 不符時阻擋', async () => {
  const root = await fixture()
  await assert.rejects(buildRiskEvidence(root, {
    source: 'flood',
    id: 'flood-id',
    inspector: inspector([], 'EPSG:3826', 'c'.repeat(64)),
  }), /raw cache 雜湊/)
  await assert.rejects(buildRiskEvidence(root, {
    source: 'flood',
    id: 'flood-id',
    inspector: inspector([], 'EPSG:4326'),
  }), /raw CRS/)
})

test('單一匹配、無匹配、多重同分類與多重衝突有明確結果', () => {
  assert.deepEqual(resolveEvidenceMatches([{ category: '1.0-2.0' }]), {
    blocked: false,
    observedCategory: '1.0-2.0',
  })
  assert.deepEqual(resolveEvidenceMatches([]), {
    blocked: false,
    observedCategory: '未確認覆蓋',
  })
  assert.match(resolveEvidenceMatches([
    { category: '高潛勢' },
    { category: '高潛勢' },
  ]).reason, /多重匹配/)
  assert.match(resolveEvidenceMatches([
    { category: '高潛勢' },
    { category: '中潛勢' },
  ]).reason, /分類衝突/)
})

test('預覽證據不寫檔且不包含地址或 geometry', async () => {
  const root = await fixture()
  const before = await readFile(
    join(root, '.data-cache', 'risk-audit-candidates.json'),
    'utf8',
  )
  const result = await buildRiskEvidence(root, {
    source: 'flood',
    id: 'flood-id',
    now: '2026-07-20T00:00:00.000Z',
    inspector: inspector([{
      layer: 'Flood_500mm_24HR',
      rawField: 'flood_dept',
      rawValue: '1.0-2.0',
      category: '1.0-2.0',
    }]),
  })
  assert.equal(result.result, 'matched')
  assert.match(result.evidence.queryOutputSha256, /^[a-f0-9]{64}$/)
  assertAuditPrivacy(result.evidence)
  assert.equal(JSON.stringify(result.evidence).includes('geometry'), false)
  assert.equal(
    await readFile(join(root, '.data-cache', 'risk-audit-candidates.json'), 'utf8'),
    before,
  )
})

test('停車場證據從官方 raw 重建並比對格位，來源雜湊不符時阻擋', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-facility-evidence-'))
  await mkdir(join(root, 'public', 'data'), { recursive: true })
  await mkdir(join(root, '.data-cache', 'facilities'), { recursive: true })
  const taipei = Buffer.from(JSON.stringify({
    data: {
      park: [{
        id: 'tp-1',
        name: '測試停車場',
        area: '大安區',
        totalcar: '10',
        tw97x: '306948',
        tw97y: '2770968',
      }],
    },
  }))
  const newTaipei = Buffer.from('ID,AREA,NAME,TOTALCAR,TW97X,TW97Y\n')
  await writeFile(join(root, '.data-cache', 'facilities', 'taipei-parking.json'), taipei)
  await writeFile(join(root, '.data-cache', 'facilities', 'new-taipei-parking.csv'), newTaipei)
  const sourceHash = sha256([sha256(taipei), sha256(newTaipei)].join(':'))
  const id = stableId(['parking', 'taipei', 'tp-1'])
  const coordinate = twd97ToWgs84(306948, 2770968)
  await writeJson(join(root, 'public', 'data', 'manifest.json'), {
    sources: {
      parking: {
        sha256: sourceHash,
        qualityGates: {
          automated: { adapterVersion: 'facilities-v1', datasetSha256 },
        },
      },
    },
  })
  await writeJson(join(root, '.data-cache', 'facility-audit-candidates.json'), {
    adapterVersion: 'facilities-v1',
    addressIndexSha256: null,
    fingerprints: {
      parking: { sourceSha256: sourceHash, datasetSha256 },
    },
    samples: {
      parking: {
        taipei: [{
          id,
          city: 'taipei',
          district: 'daan',
          name: '測試停車場',
          longitude: coordinate.longitude,
          latitude: coordinate.latitude,
          carCapacity: 10,
        }],
        'new-taipei': [],
      },
      medical: { taipei: [], 'new-taipei': [] },
    },
  })
  const result = await buildFacilityEvidence(root, { source: 'parking', id })
  assert.equal(result.result, 'matched')
  assert.deepEqual(result.evidence.fields, {
    id: true,
    name: true,
    district: true,
    coordinate: true,
    carCapacity: true,
  })
  const candidatesFile = join(root, '.data-cache', 'facility-audit-candidates.json')
  const candidates = JSON.parse(await readFile(candidatesFile, 'utf8'))
  candidates.fingerprints.parking.sourceSha256 = 'c'.repeat(64)
  await writeJson(candidatesFile, candidates)
  await assert.rejects(
    buildFacilityEvidence(root, { source: 'parking', id }),
    /fingerprints/,
  )
})

test('圖書館證據從官方 raw 重建且不保存地址', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-library-evidence-'))
  await mkdir(join(root, 'public', 'data'), { recursive: true })
  await mkdir(join(root, '.data-cache', 'library'), { recursive: true })
  const value = [{
    縣市: '臺北市',
    圖書館資訊: [{
      Name: '臺北市立圖書館總館',
      Area: '大安區',
      Address: '臺北市大安區建國南路二段125號',
      Longitude: 121.5384,
      Latitude: 25.0292,
    }],
  }]
  const raw = Buffer.from(JSON.stringify(value))
  const sourceHash = sha256(raw)
  const [item] = parseLibraries(value, '2026-07-21T00:00:00.000Z')
  await writeFile(join(root, '.data-cache', 'library', 'public-libraries.json'), raw)
  await writeJson(join(root, 'public', 'data', 'manifest.json'), {
    sources: {
      library: {
        sha256: sourceHash,
        qualityGates: { automated: { adapterVersion: 'library-v1', datasetSha256 } },
      },
    },
  })
  await writeJson(join(root, '.data-cache', 'library-audit-candidates.json'), {
    adapterVersion: 'library-v1',
    fingerprints: { sourceSha256: sourceHash, datasetSha256 },
    samples: {
      taipei: [{
        id: item.feature.properties.id,
        city: 'taipei',
        district: 'daan',
        name: item.name,
        longitude: item.coordinate.longitude,
        latitude: item.coordinate.latitude,
      }],
      'new-taipei': [],
    },
  })
  const result = await buildLibraryEvidence(root, { id: item.feature.properties.id })
  assert.equal(result.result, 'matched')
  assert.equal(JSON.stringify(result.evidence).includes('address'), false)
  assert.deepEqual(result.evidence.fields, {
    id: true,
    name: true,
    district: true,
    coordinate: true,
  })
})
