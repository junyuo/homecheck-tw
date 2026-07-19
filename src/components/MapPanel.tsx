import { useMemo, useState } from 'react'
import { CircleMarker, GeoJSON, MapContainer, TileLayer, useMapEvents } from 'react-leaflet'
import type { LatLngExpression, LeafletMouseEvent } from 'leaflet'
import type { DistrictDataset, FacilityProperties, RiskCollection } from '../types'

function ClickHandler({ onChange }: { onChange: (latitude: number, longitude: number) => void }) {
  useMapEvents({
    click(event: LeafletMouseEvent) {
      onChange(event.latlng.lat, event.latlng.lng)
    },
  })
  return null
}

interface MapPickerProps {
  latitude: number
  longitude: number
  onChange: (latitude: number, longitude: number) => void
}

export function MapPicker({ latitude, longitude, onChange }: MapPickerProps) {
  const position: LatLngExpression = [latitude, longitude]
  return (
    <div className="map-shell">
      <MapContainer center={position} zoom={16} scrollWheelZoom className="map" aria-label="位置確認地圖">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ClickHandler onChange={onChange} />
        <CircleMarker center={position} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#e97732', fillOpacity: 1 }} />
      </MapContainer>
      <p className="map-hint">在地圖上點一下確認位置。空間分析只使用這個座標，不會上傳。</p>
    </div>
  )
}

const facilityColors: Record<FacilityProperties['category'], string> = {
  metro: '#006c67',
  rail: '#365a7a',
  bus: '#527a62',
  school: '#c2692f',
  medical: '#8d4563',
  park: '#527a62',
  market: '#9a6a22',
  parking: '#59636e',
  library: '#66558b',
}

interface AnalysisMapProps {
  latitude: number
  longitude: number
  dataset: DistrictDataset
  flood: RiskCollection
  liquefaction: RiskCollection
}

export function AnalysisMap({ latitude, longitude, dataset, flood, liquefaction }: AnalysisMapProps) {
  const [visible, setVisible] = useState(() => new Set<FacilityProperties['category']>(['metro', 'bus', 'medical', 'park']))
  const [showFlood, setShowFlood] = useState(true)
  const [showLiquefaction, setShowLiquefaction] = useState(true)
  const position: LatLngExpression = [latitude, longitude]
  const categories = useMemo(
    () => [...new Set(dataset.facilities.features.map((item) => item.properties.category))],
    [dataset],
  )
  const toggle = (category: FacilityProperties['category']) => {
    setVisible((current) => {
      const next = new Set(current)
      if (next.has(category)) next.delete(category)
      else next.add(category)
      return next
    })
  }

  return (
    <div className="analysis-map-layout">
      <div className="layer-controls" aria-label="地圖圖層">
        <strong>顯示圖層</strong>
        <div className="chip-row">
          {categories.map((category) => (
            <label className="layer-chip" key={category}>
              <input type="checkbox" checked={visible.has(category)} onChange={() => toggle(category)} />
              {categoryLabel[category]}
            </label>
          ))}
          <label className="layer-chip">
            <input type="checkbox" checked={showFlood} onChange={(event) => setShowFlood(event.target.checked)} />
            淹水 Demo
          </label>
          <label className="layer-chip">
            <input type="checkbox" checked={showLiquefaction} onChange={(event) => setShowLiquefaction(event.target.checked)} />
            液化 Demo
          </label>
        </div>
      </div>
      <MapContainer center={position} zoom={15} scrollWheelZoom className="map result-map" aria-label="分析圖層地圖">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <CircleMarker center={position} radius={9} pathOptions={{ color: '#fff', weight: 3, fillColor: '#e97732', fillOpacity: 1 }} />
        {dataset.facilities.features
          .filter((feature) => visible.has(feature.properties.category))
          .map((feature, index) => (
            <CircleMarker
              key={`${feature.properties.name}-${index}`}
              center={[feature.geometry.coordinates[1], feature.geometry.coordinates[0]]}
              radius={6}
              pathOptions={{
                color: '#fff',
                weight: 2,
                fillColor: facilityColors[feature.properties.category],
                fillOpacity: 0.9,
              }}
            />
          ))}
        {showFlood && (
          <GeoJSON data={flood} style={() => ({ color: '#386d84', weight: 2, fillColor: '#65a8c2', fillOpacity: 0.22 })} />
        )}
        {showLiquefaction && (
          <GeoJSON data={liquefaction} style={() => ({ color: '#a46327', weight: 2, fillColor: '#dc9c50', fillOpacity: 0.18 })} />
        )}
      </MapContainer>
      <p className="map-hint">所有彩色點位與風險圖層目前皆為 Demo，只用於驗證互動與資料介面。</p>
    </div>
  )
}

const categoryLabel: Record<FacilityProperties['category'], string> = {
  metro: '捷運',
  rail: '火車',
  bus: '公車',
  school: '學校',
  medical: '醫療',
  park: '公園',
  market: '市場',
  parking: '停車場',
  library: '圖書館',
}
