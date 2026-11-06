export type Side = 'left' | 'right' | 'unknown'
export type Rarity = 'normal' | 'four_star' | 'signature' | 'unknown'
export type Certainty = 'confirmed' | 'uncertain'
export const sideLabels: Record<Side, string> = { left: '左', right: '右', unknown: '不明' }
export const rarityLabels: Record<Rarity, string> = { normal: '普通', four_star: '四星', signature: '簽名', unknown: '未知' }
export interface Owned { id: string; owner_id: string; created_at: string }
export interface Store extends Owned { name: string; location: string }
export interface Machine extends Owned { store_id: string; machine_name: string; game_version: string }
export interface Segment extends Owned { machine_id: string; game_version: string; label: string; notes: string; started_at: string; ended_at: string | null; last_draw_index: number }
export interface Game extends Owned { segment_id: string; game_index: number; started_at: string; ended_at: string | null }
export interface Cartridge extends Owned { segment_id: string; side: 'left' | 'right'; batch_index: number; starts_at_index: number; certainty: Certainty; note: string }
export interface Draw extends Owned {
  segment_id: string; game_id: string; draw_index: number; side: Side; cartridge_id: string | null
  recorded_side: Side; recorded_cartridge_id: string | null; side_index: number | null
  card_number: string; rarity: Rarity; recorded_at: string; updated_at: string; revision: number; deleted_at: string | null
}
export interface AuditEvent extends Owned {
  operation_id: string; entity_type: string; entity_id: string; action: string
  old_data: Json | null; new_data: Json
}
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]
export type Payload = Record<string, Json | undefined>
export type CommandAction = 'create_store' | 'update_store' | 'create_machine' | 'update_machine' | 'create_segment' | 'start_game' | 'close_segment' | 'replace_cartridge' | 'append_draw' | 'update_draw' | 'void_draw'
export interface DataSet { stores: Store[]; machines: Machine[]; observation_segments: Segment[]; games: Game[]; cartridges: Cartridge[]; draws: Draw[]; audit_events: AuditEvent[] }
export const emptyData = (): DataSet => ({ stores: [], machines: [], observation_segments: [], games: [], cartridges: [], draws: [], audit_events: [] })
type Table<Row> = { Row: { [K in keyof Row]: Row[K] }; Insert: never; Update: never; Relationships: [] }
export interface Database {
  public: {
    Tables: { stores: Table<Store>; machines: Table<Machine>; observation_segments: Table<Segment>; games: Table<Game>; cartridges: Table<Cartridge>; draws: Table<Draw>; audit_events: Table<AuditEvent> }
    Views: Record<string, never>
    Functions: { apply_command: { Args: { p_operation_id: string; p_action: string; p_payload: Json }; Returns: Json } }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
