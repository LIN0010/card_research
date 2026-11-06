import { rarityLabels, sideLabels, type Rarity, type Side } from '../lib/types'

export function SourceFields({ side, onSide, rarity, onRarity, disabled = false }: {
  side: Side; onSide: (side: Side) => void; rarity: Rarity; onRarity: (rarity: Rarity) => void; disabled?: boolean
}) {
  return <>
    <fieldset disabled={disabled}><legend>來源卡匣</legend><div className="grid grid-cols-3 gap-2">
      {(Object.keys(sideLabels) as Side[]).map(value => <label className={`choice ${side === value ? 'selected' : ''}`} key={value}>
        <input type="radio" name="side" value={value} checked={side === value} onChange={() => onSide(value)} />{sideLabels[value]}{value !== 'unknown' && '卡匣'}
      </label>)}
    </div></fieldset>
    <label>稀有度<select value={rarity} disabled={disabled} onChange={e => onRarity(e.target.value as Rarity)}>
      {(Object.keys(rarityLabels) as Rarity[]).map(value => <option key={value} value={value}>{rarityLabels[value]}</option>)}
    </select></label>
  </>
}
