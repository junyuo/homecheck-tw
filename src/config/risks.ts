import type { FloodScenarioId } from '../types'

export const DEFAULT_FLOOD_SCENARIO: FloodScenarioId = '24h-500'

export const floodScenarios: Array<{
  id: FloodScenarioId
  durationHours: number
  rainfallMm: number
  label: string
}> = [
  { id: '6h-150', durationHours: 6, rainfallMm: 150, label: '6 小時 150 mm' },
  { id: '6h-250', durationHours: 6, rainfallMm: 250, label: '6 小時 250 mm' },
  { id: '6h-350', durationHours: 6, rainfallMm: 350, label: '6 小時 350 mm' },
  { id: '12h-200', durationHours: 12, rainfallMm: 200, label: '12 小時 200 mm' },
  { id: '12h-300', durationHours: 12, rainfallMm: 300, label: '12 小時 300 mm' },
  { id: '12h-400', durationHours: 12, rainfallMm: 400, label: '12 小時 400 mm' },
  { id: '24h-200', durationHours: 24, rainfallMm: 200, label: '24 小時 200 mm' },
  { id: '24h-350', durationHours: 24, rainfallMm: 350, label: '24 小時 350 mm' },
  { id: '24h-500', durationHours: 24, rainfallMm: 500, label: '24 小時 500 mm（預設）' },
  { id: '24h-650', durationHours: 24, rainfallMm: 650, label: '24 小時 650 mm' },
]
