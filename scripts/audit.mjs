#!/usr/bin/env node
import { resolve } from 'node:path'
import { auditStatus, recordAudit } from './data/audit-workflow.mjs'

const root = resolve(import.meta.dirname, '..')
const command = process.argv[2]

function option(name, fallback = '') {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  return process.argv.includes(`--${name}`) ? 'true' : fallback
}

function printProgress(status) {
  for (const source of ['price', 'flood', 'liquefaction', 'parking', 'medical']) {
    const item = status[source]
    console.log(
      `[audit] ${source}: ${item.passed ? 'passed' : 'pending'} ` +
      `${item.sampleCount}/${item.requiredSampleCount}，mismatch ${item.mismatches}` +
      (source === 'price' ? '' :
        `，方式 ${(
          status.verificationMethods[source] ??
          status.facilityVerificationMethods[source] ??
          []
        ).join(', ') || '尚無'}`),
    )
  }
  console.log(
    `[audit] inconclusive ${status.inconclusive}；總 mismatch ${status.mismatches}`,
  )
}

async function main() {
  if (command === 'status') {
    const status = await auditStatus(root)
    printProgress(status)
    if (!status.ready) process.exitCode = 1
    return
  }
  if (command !== 'record') {
    throw new Error('用法：audit.mjs status，或 audit.mjs record --source=... --id=... --result=...')
  }
  const attempts = Number(option('attempts', '1'))
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('--attempts 必須是正整數')
  }
  const result = await recordAudit(root, {
    source: option('source'),
    id: option('id'),
    result: option('result'),
    observed: option('observed'),
    attempts,
    mismatchFields: option('mismatch-fields')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    replace: option('replace') === 'true',
  })
  console.log(`[audit] 已記錄 ${result.record.id}：${result.record.result}`)
  if (result.next) {
    console.log(
      `[audit] 同型態備援：${result.next.id} ` +
      `${result.next.city}/${result.next.districtLabel} ${result.next.address}`,
    )
  }
  const status = await auditStatus(root)
  printProgress(status)
}

main().catch((error) => {
  console.error(`[audit] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
