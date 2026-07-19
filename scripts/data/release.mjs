import { access, rename, rm } from 'node:fs/promises'
import { manualGate } from './audit.mjs'

export function promoteSource(source, evaluation, audit, now) {
  if (source.qualityGates?.automated?.status !== 'passed') {
    throw new Error(`${source.id} 自動品質閘門未通過`)
  }
  if (!evaluation.passed) {
    throw new Error(
      `${source.id} 人工驗收未通過：${evaluation.sampleCount}/${evaluation.requiredSampleCount}，` +
      `mismatch ${evaluation.mismatches}`,
    )
  }
  source.status = 'official'
  source.attemptedAt = now
  source.qualityGates.manualAudit = manualGate(
    evaluation,
    source.qualityGates.automated.adapterVersion,
    audit.checkedAt,
  )
  source.lastAttempt = {
    status: 'success',
    message: `人工驗收 ${evaluation.sampleCount}/${evaluation.requiredSampleCount} 通過，候選資料正式發布`,
  }
}

export async function atomicReplace(current, staging, backup) {
  await rm(backup, { recursive: true, force: true })
  await rename(current, backup)
  try {
    await rename(staging, current)
    await rm(backup, { recursive: true, force: true })
  } catch (error) {
    await access(backup)
    await rename(backup, current)
    throw error
  }
}
