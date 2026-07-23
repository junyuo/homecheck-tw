import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertAuditPrivacy,
  auditStatus,
  recordAudit,
} from './audit-workflow.mjs'

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function priceCandidate(id, city, buildingType, tier = 'primary') {
  return {
    id,
    city,
    district: city === 'taipei' ? 'daan' : 'banqiao',
    districtLabel: city === 'taipei' ? '大安區' : '板橋區',
    address: `${tier}路1號`,
    buildingType,
  }
}

function riskSamples(source, city) {
  const cases = source === 'flood'
    ? [
        ['red', '0.5-1.0'],
        ['red', '1.0-2.0'],
        ['yellow', '0.3-0.5'],
        ['yellow', '0.3-0.5'],
        ['unknown', '未確認覆蓋'],
      ]
    : [
        ['high', '高潛勢'],
        ['medium', '中潛勢'],
        ['low', '低潛勢'],
        ['uncovered', '未確認覆蓋'],
        ['uncovered', '未確認覆蓋'],
      ]
  return cases.map(([caseType, expectedCategory], index) => ({
    id: `${source}-${city}-${index}`,
    source,
    city,
    district: city === 'taipei' ? 'daan' : 'banqiao',
    longitude: 121.543219 + index / 10000,
    latitude: 25.026879 + index / 10000,
    caseType,
    expectedCategory,
    boundaryDistanceMeters: 25,
    ...(source === 'flood' ? { scenario: '24h-500' } : {}),
  }))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-audit-'))
  await mkdir(join(root, 'public', 'data'), { recursive: true })
  await mkdir(join(root, 'scripts', 'data', 'audits'), { recursive: true })
  await mkdir(join(root, '.data-cache'), { recursive: true })
  const sources = Object.fromEntries([
    ['actual-price', 'price-v1'],
    ['flood', 'risks-v1'],
    ['liquefaction', 'risks-v1'],
    ['parking', 'facilities-v1'],
    ['medical', 'facilities-v1'],
    ['school', 'community-v2'],
    ['park', 'community-v2'],
    ['library', 'library-v1'],
    ['market', 'market-v1'],
    ['accidents', 'accidents-v1'],
  ].map(([id, adapterVersion]) => [id, {
    qualityGates: { automated: { adapterVersion } },
  }]))
  await writeJson(join(root, 'public', 'data', 'manifest.json'), { sources })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'price-v1.json'), {
    adapterVersion: 'price-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'risks-v1.json'), {
    adapterVersion: 'risks-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'facilities-v1.json'), {
    adapterVersion: 'facilities-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'community-v2.json'), {
    adapterVersion: 'community-v2',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'library-v1.json'), {
    adapterVersion: 'library-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'accidents-v1.json'), {
    adapterVersion: 'accidents-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  await writeJson(join(root, 'scripts', 'data', 'audits', 'market-v1.json'), {
    adapterVersion: 'market-v1',
    status: 'pending',
    checkedAt: null,
    samples: [],
  })
  const primary = ['taipei', 'new-taipei'].flatMap((city) =>
    ['apartment', 'mansion', 'highrise'].map((type, index) =>
      priceCandidate(`${city}-${type}-${index}`, city, type)))
  const reserve = ['taipei', 'new-taipei'].flatMap((city) =>
    ['apartment', 'mansion', 'highrise'].map((type, index) =>
      priceCandidate(`${city}-reserve-${type}-${index}`, city, type, 'reserve')))
  await writeJson(join(root, '.data-cache', 'price-audit-candidates.json'), {
    adapterVersion: 'price-v1',
    samples: {
      taipei: {
        primary: primary.filter((item) => item.city === 'taipei'),
        reserve: reserve.filter((item) => item.city === 'taipei'),
      },
      'new-taipei': {
        primary: primary.filter((item) => item.city === 'new-taipei'),
        reserve: reserve.filter((item) => item.city === 'new-taipei'),
      },
    },
  })
  await writeJson(join(root, '.data-cache', 'risk-audit-candidates.json'), {
    adapterVersion: 'risks-v1',
    samples: {
      flood: {
        taipei: riskSamples('flood', 'taipei'),
        'new-taipei': riskSamples('flood', 'new-taipei'),
      },
      liquefaction: {
        taipei: riskSamples('liquefaction', 'taipei'),
        'new-taipei': riskSamples('liquefaction', 'new-taipei'),
      },
    },
  })
  await writeJson(join(root, '.data-cache', 'facility-audit-candidates.json'), {
    adapterVersion: 'facilities-v1',
    samples: {
      parking: { taipei: [], 'new-taipei': [] },
      medical: { taipei: [], 'new-taipei': [] },
    },
  })
  await writeJson(join(root, '.data-cache', 'community-audit-candidates.json'), {
    adapterVersion: 'community-v2',
    samples: {
      school: { taipei: [], 'new-taipei': [] },
      park: { taipei: [], 'new-taipei': [] },
    },
  })
  await writeJson(join(root, '.data-cache', 'library-audit-candidates.json'), {
    adapterVersion: 'library-v1',
    samples: { taipei: [], 'new-taipei': [] },
  })
  await writeJson(join(root, '.data-cache', 'accident-audit-candidates.json'), {
    adapterVersion: 'accidents-v1',
    samples: { taipei: [], 'new-taipei': [] },
  })
  await writeJson(join(root, '.data-cache', 'market-audit-candidates.json'), {
    adapterVersion: 'market-v1',
    samples: { taipei: [], 'new-taipei': [] },
  })
  return root
}

test('稽核 CLI 拒絕未知 ID 與重複提交', async () => {
  const root = await fixture()
  await assert.rejects(recordAudit(root, {
    source: 'price',
    id: 'missing',
    result: 'matched',
  }), /不存在 ID/)
  const input = {
    source: 'price',
    id: 'taipei-apartment-0',
    result: 'matched',
  }
  await recordAudit(root, input)
  await assert.rejects(recordAudit(root, input), /已有稽核紀錄/)
})

test('價格 matched 自動保存七欄結果且不保存地址', async () => {
  const root = await fixture()
  await recordAudit(root, {
    source: 'price',
    id: 'taipei-apartment-0',
    result: 'matched',
    now: '2026-07-20T00:00:00.000Z',
  })
  const audit = JSON.parse(await readFile(
    join(root, 'scripts', 'data', 'audits', 'price-v1.json'),
    'utf8',
  ))
  assert.equal(Object.keys(audit.samples[0].fields).length, 7)
  assert.equal(JSON.stringify(audit).includes('address'), false)
})

test('inconclusive 要求兩次查詢並回傳同型態備援', async () => {
  const root = await fixture()
  const input = {
    source: 'price',
    id: 'taipei-apartment-0',
    result: 'inconclusive',
  }
  await assert.rejects(recordAudit(root, input), /至少記錄兩次/)
  const result = await recordAudit(root, { ...input, attempts: 2 })
  assert.equal(result.next.id, 'taipei-reserve-apartment-0')
})

test('災害紀錄驗證分類、邊界距離並保存五位小數', async () => {
  const root = await fixture()
  const result = await recordAudit(root, {
    source: 'flood',
    id: 'flood-taipei-0',
    result: 'matched',
    observed: '0.5-1.0',
  })
  assert.equal(result.record.longitude, 121.54322)
  await assert.rejects(recordAudit(root, {
    source: 'flood',
    id: 'flood-taipei-1',
    result: 'matched',
    observed: '0.5-1.0',
  }), /必須記為 mismatch/)
})

test('稽核狀態檢查 adapter 版本並排除隱私欄位', async () => {
  const root = await fixture()
  const status = await auditStatus(root)
  assert.equal(status.ready, false)
  assert.throws(() => assertAuditPrivacy({ address: '不應提交' }), /不得保存/)
  const auditFile = join(root, 'scripts', 'data', 'audits', 'price-v1.json')
  const audit = JSON.parse(await readFile(auditFile, 'utf8'))
  audit.adapterVersion = 'price-v0'
  await writeJson(auditFile, audit)
  await assert.rejects(auditStatus(root), /adapter 版本不一致/)
})
