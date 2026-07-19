import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { atomicReplace, promoteSource } from './release.mjs'

function candidateSource() {
  return {
    id: 'actual-price',
    status: 'unavailable',
    qualityGates: {
      automated: {
        status: 'passed',
        adapterVersion: 'price-v1',
      },
    },
  }
}

test('發布提升要求人工驗收完全通過', () => {
  const source = candidateSource()
  assert.throws(() => promoteSource(source, {
    passed: false,
    sampleCount: 19,
    requiredSampleCount: 20,
    mismatches: 0,
  }, { checkedAt: '2026-07-19T00:00:00Z' }, '2026-07-19T00:00:00Z'))
  assert.equal(source.status, 'unavailable')
})

test('發布提升寫入正式狀態與完整人工閘門', () => {
  const source = candidateSource()
  promoteSource(source, {
    passed: true,
    sampleCount: 20,
    requiredSampleCount: 20,
    mismatches: 0,
  }, { checkedAt: '2026-07-19T00:00:00Z' }, '2026-07-19T01:00:00Z')
  assert.equal(source.status, 'official')
  assert.deepEqual(source.qualityGates.manualAudit, {
    status: 'passed',
    adapterVersion: 'price-v1',
    checkedAt: '2026-07-19T00:00:00Z',
    sampleCount: 20,
    requiredSampleCount: 20,
  })
})

test('原子替換成功後移除 backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-release-'))
  const current = join(root, 'current')
  const staging = join(root, 'staging')
  const backup = join(root, 'backup')
  await mkdir(current)
  await mkdir(staging)
  await writeFile(join(current, 'value'), 'last-good')
  await writeFile(join(staging, 'value'), 'candidate')

  await atomicReplace(current, staging, backup)
  assert.equal(await readFile(join(current, 'value'), 'utf8'), 'candidate')
  await assert.rejects(readFile(join(backup, 'value'), 'utf8'))
})

test('原子替換失敗時回復 last-good', async () => {
  const root = await mkdtemp(join(tmpdir(), 'homecheck-release-'))
  const current = join(root, 'current')
  const missingStaging = join(root, 'missing')
  const backup = join(root, 'backup')
  await mkdir(current)
  await writeFile(join(current, 'value'), 'last-good')

  await assert.rejects(atomicReplace(current, missingStaging, backup))
  assert.equal(await readFile(join(current, 'value'), 'utf8'), 'last-good')
})
