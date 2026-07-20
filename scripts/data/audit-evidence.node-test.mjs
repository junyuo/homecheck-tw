import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertAuditPrivacy } from './audit-workflow.mjs'
import { buildRiskEvidence, resolveEvidenceMatches } from './audit-evidence.mjs'

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
