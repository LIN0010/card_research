import { Icon } from '../../components/Icon'
import { rarityLabels, type Rarity, type Side } from '../../lib/types'

export function QuickFields({ side, onSide, disabled }: {
  side: Side | null; onSide: (side: Side) => void; disabled: boolean
}) {
  return <fieldset className="source-picker" disabled={disabled}><legend>這張卡來自哪裡？</legend>
    <div className="large-sources">{(['left', 'right'] as const).map(value => <label className={`cartridge-choice ${value} ${side === value ? 'selected' : ''}`} key={value}>
      <input type="radio" name="side" aria-label={value === 'left' ? '左卡匣' : '右卡匣'} value={value} checked={side === value} onChange={() => onSide(value)} />
      <span className="cartridge-art"><Icon name="cards" size={34} /></span><strong>{value === 'left' ? '左卡匣' : '右卡匣'}</strong><span className="source-letter">{value === 'left' ? 'LEFT' : 'RIGHT'}</span>
      <span className="selection-check"><Icon name="check" size={14} /></span>
    </label>)}</div>
    <label className={`unknown-source ${side === 'unknown' ? 'selected' : ''}`}><input type="radio" name="side" value="unknown" checked={side === 'unknown'} onChange={() => onSide('unknown')} />無法辨認？記為來源不明</label>
  </fieldset>
}
export function RarityPicker({ rarity, onChange, disabled }: { rarity: Rarity; onChange: (rarity: Rarity) => void; disabled: boolean }) {
  return <fieldset className="rarity-picker" disabled={disabled}><legend>稀有度</legend><div className="rarity-options">
    {(Object.keys(rarityLabels) as Rarity[]).map(value => <label className={`rarity-choice ${value} ${rarity === value ? 'selected' : ''}`} key={value}>
      <input type="radio" name="rarity" value={value} checked={rarity === value} onChange={() => onChange(value)} />
      {value !== 'unknown' && <Icon name="star" size={14} />}<span>{rarityLabels[value]}</span>
    </label>)}
  </div></fieldset>
}
