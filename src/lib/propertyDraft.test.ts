import { describe, expect, it } from 'vitest'
import { createEmptyDraft, createExampleDraft, draftToInput, inputToDraft } from './propertyDraft'

describe('物件表單草稿', () => {
  it('空白表單不能轉成分析輸入', () => {
    expect(draftToInput(createEmptyDraft())).toBeNull()
  })

  it('未確認地圖位置不能分析', () => {
    const draft = { ...createExampleDraft(), locationConfirmed: false }
    expect(draftToInput(draft)).toBeNull()
  })

  it('範例可轉換且不把選填空值轉成 NaN', () => {
    const draft = { ...createExampleDraft(), hasParking: false, parkingPrice: '', parkingAreaPing: '' }
    const input = draftToInput(draft)
    expect(input).toMatchObject({ address: '和平東路二段', totalPrice: 26800000, parkingPrice: 0, parkingAreaPing: 0 })
  })

  it('樓層高於總樓層時拒絕分析', () => {
    expect(draftToInput({ ...createExampleDraft(), floor: '13', totalFloors: '12' })).toBeNull()
  })

  it('正式輸入轉回草稿時保留數值並標記位置已確認', () => {
    const input = draftToInput(createExampleDraft())!
    expect(inputToDraft(input)).toMatchObject({ totalPrice: '26800000', locationConfirmed: true, exampleMode: false })
  })
})
