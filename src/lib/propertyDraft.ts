import { DEFAULT_FLOOD_SCENARIO } from '../config/risks'
import type { BuildingType, PropertyInput } from '../types'

export interface PropertyFormDraft {
  city: PropertyInput['city']
  district: string
  address: string
  latitude: number
  longitude: number
  totalPrice: string
  areaPing: string
  age: string
  floor: string
  totalFloors: string
  buildingType: BuildingType
  hasParking: boolean
  parkingPrice: string
  parkingAreaPing: string
  radius: PropertyInput['radius']
  floodScenario: PropertyInput['floodScenario']
  locationConfirmed: boolean
  exampleMode: boolean
}

export const createEmptyDraft = (): PropertyFormDraft => ({
  city: 'taipei',
  district: 'daan',
  address: '',
  latitude: 25.0268,
  longitude: 121.5434,
  totalPrice: '',
  areaPing: '',
  age: '',
  floor: '',
  totalFloors: '',
  buildingType: 'highrise',
  hasParking: false,
  parkingPrice: '',
  parkingAreaPing: '',
  radius: 500,
  floodScenario: DEFAULT_FLOOD_SCENARIO,
  locationConfirmed: false,
  exampleMode: false,
})

export const createExampleDraft = (): PropertyFormDraft => ({
  city: 'taipei',
  district: 'daan',
  address: '和平東路二段',
  latitude: 25.0269,
  longitude: 121.5434,
  totalPrice: '26800000',
  areaPing: '36.8',
  age: '18',
  floor: '7',
  totalFloors: '12',
  buildingType: 'highrise',
  hasParking: true,
  parkingPrice: '2500000',
  parkingAreaPing: '10',
  radius: 500,
  floodScenario: DEFAULT_FLOOD_SCENARIO,
  locationConfirmed: true,
  exampleMode: true,
})

const positive = (value: string) => value.trim() !== '' && Number(value) > 0
const nonNegative = (value: string) => value.trim() !== '' && Number(value) >= 0

export function draftToInput(draft: PropertyFormDraft): PropertyInput | null {
  if (!draft.address.trim() || !draft.locationConfirmed ||
      !positive(draft.totalPrice) || !positive(draft.areaPing) ||
      !nonNegative(draft.age) || !positive(draft.floor) || !positive(draft.totalFloors) ||
      Number(draft.floor) > Number(draft.totalFloors)) return null

  return {
    city: draft.city,
    district: draft.district,
    address: draft.address.trim(),
    latitude: draft.latitude,
    longitude: draft.longitude,
    totalPrice: Number(draft.totalPrice),
    areaPing: Number(draft.areaPing),
    age: Number(draft.age),
    floor: Number(draft.floor),
    totalFloors: Number(draft.totalFloors),
    buildingType: draft.buildingType,
    hasParking: draft.hasParking,
    parkingPrice: draft.hasParking && draft.parkingPrice ? Number(draft.parkingPrice) : 0,
    parkingAreaPing: draft.hasParking && draft.parkingAreaPing ? Number(draft.parkingAreaPing) : 0,
    radius: draft.radius,
    floodScenario: draft.floodScenario,
  }
}

export function inputToDraft(input: PropertyInput): PropertyFormDraft {
  return {
    ...input,
    totalPrice: String(input.totalPrice),
    areaPing: String(input.areaPing),
    age: String(input.age),
    floor: String(input.floor),
    totalFloors: String(input.totalFloors),
    parkingPrice: input.parkingPrice ? String(input.parkingPrice) : '',
    parkingAreaPing: input.parkingAreaPing ? String(input.parkingAreaPing) : '',
    locationConfirmed: true,
    exampleMode: false,
  }
}
