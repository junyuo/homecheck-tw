#!/usr/bin/env node
import { resolve } from 'node:path'
import {
  buildAccidentEvidence,
  buildCommunityEvidence,
  buildFacilityEvidence,
  buildLibraryEvidence,
  buildRiskEvidence,
} from './data/audit-evidence.mjs'
import { recordAudit } from './data/audit-workflow.mjs'

const root = resolve(import.meta.dirname, '..')

function option(name, fallback = '') {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return process.argv.includes(`--${name}`) ? 'true' : fallback
}

async function main() {
  const source = option('source')
  const id = option('id')
  const confirmed = option('confirm') === 'true'
  const isFacility = ['parking', 'medical'].includes(source)
  const isCommunity = ['school', 'park'].includes(source)
  const result = source === 'accidents'
    ? await buildAccidentEvidence(root, { id })
    : source === 'library'
      ? await buildLibraryEvidence(root, { id })
    : isFacility
    ? await buildFacilityEvidence(root, { source, id })
    : isCommunity
      ? await buildCommunityEvidence(root, { source, id })
      : await buildRiskEvidence(root, { source, id })
  console.log(JSON.stringify({
    id: result.candidate.id,
    source: result.candidate.source,
    city: result.candidate.city,
    district: result.candidate.district,
    longitude: result.candidate.longitude,
    latitude: result.candidate.latitude,
    expectedCategory: result.candidate.expectedCategory,
    observedCategory: result.observedCategory,
    date: result.candidate.date,
    year: result.candidate.year,
    severity: result.candidate.severity,
    result: result.result,
    reason: result.reason,
    evidence: result.evidence,
  }, null, 2))
  if (!confirmed) {
    console.log('[audit] 尚未寫入；人工確認上述官方 raw 證據後，請加 --confirm')
    return
  }
  if (result.blocked) throw new Error(`證據被阻擋：${result.reason}`)
  const recorded = await recordAudit(root, {
    source,
    id,
    result: result.result,
    observed: result.observedCategory,
    evidence: result.evidence,
  })
  console.log(`[audit] 已確認並記錄 ${id}：${recorded.record.result}`)
}

main().catch((error) => {
  console.error(`[audit] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
