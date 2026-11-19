import type { AuditEvent } from './types'

function drawRevision(event: AuditEvent): number {
  const snapshot = event.new_data
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    && typeof snapshot.revision === 'number' && Number.isSafeInteger(snapshot.revision)
    && snapshot.revision > 0) return snapshot.revision
  return Number.MAX_SAFE_INTEGER
}

export function drawAuditHistory(events: AuditEvent[], drawId: string): AuditEvent[] {
  // Revisions reflect committed draw changes. Transaction timestamps can tie or
  // predate a row-lock wait, and REST's UUID ordering is not operation ordering.
  return events.filter(event => event.entity_type === 'draws' && event.entity_id === drawId)
    .sort((a, b) => drawRevision(a) - drawRevision(b)
      || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}
