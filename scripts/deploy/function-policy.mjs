import { createHash } from 'node:crypto'
import { DeploymentError } from './error.mjs'

const sha256 = text => createHash('sha256').update(text).digest('hex')
const identity = row => JSON.stringify([row.schema,row.name,row.arguments])
const normalizeCrlf = source => source.replaceAll('\r\n','\n')
const sameRecord = (a,b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b,key) && JSON.stringify(a[key]) === JSON.stringify(b[key]))

// Only these three reviewed baseline bodies may treat CRLF as LF. Future RPC
// bodies and all other functions remain byte-exact unless separately reviewed.
const verifiedApplicationSources = new Map([
  [JSON.stringify(['app_private','erase_draw_history','']),'d59466c049019812e456e254a895ea4aa2c859c222a12de9eb1e19a922988140'],
  [JSON.stringify(['app_private','prevent_deleted_draw_reuse','']),'f8714453c8713e662d20cec2a166f1c7f64a03734d089d0a4b52097ba41c1c19'],
  [JSON.stringify(['public','apply_command','p_operation_id uuid, p_action text, p_payload jsonb']),'321f79a4780a7d9037a40bd854f42ae752b0cfa9b4611ef72dd73bece716a17b'],
])

// Official Studio AUTO_ENABLE_RLS_EVENT_TRIGGER_SQL, immutable source:
// https://github.com/supabase/supabase/blob/4ead4b092ee7e5ad4def2cd295b14492db12720b/apps/studio/components/interfaces/Database/Triggers/EventTriggersList/EventTriggers.constants.ts
export const officialRlsSourceSha256 = '325ae266d9b166715ef5230ceaf7ff9d523e483cf5610dfb9779ab3f183f4af9'
const platformMetadata = {
  schema: 'public',name: 'rls_auto_enable',arguments: '',result: 'event_trigger',lanname: 'plpgsql',
  prosecdef: true,provolatile: 'v',proisstrict: false,proleakproof: false,proparallel: 'u',
  proconfig: ['search_path=pg_catalog'],owner: 'postgres',
}
const platformIdentity = identity(platformMetadata)
const platformProperties = {
  schema: 'public',name: 'rls_auto_enable',arguments: '',prokind: 'f',pronargs: 0,proretset: false,
  has_variadic: false,has_support_function: false,no_defaults: true,no_external_binary: true,procost: 100,prorows: 0,
}
const platformBinding = {
  evtname: 'ensure_rls',evtevent: 'ddl_command_end',evtenabled: 'O',owner: 'postgres',
  function_schema: 'public',function_name: 'rls_auto_enable',arguments: '',tags: ['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],
}
const platformGrants = ['PUBLIC','postgres'].map(role => ({ schema: 'public',name: 'rls_auto_enable',arguments: '',role,
  grantor: 'postgres',privilege_type: 'EXECUTE',is_grantable: false }))
const platformApiGrant = { schema: 'public',name: 'rls_auto_enable',arguments: '',role: 'PUBLIC',privilege_type: 'EXECUTE',is_grantable: false }

export function sourceFingerprint(source) {
  const lf = normalizeCrlf(source)
  return { sha256: sha256(source),utf8_bytes: Buffer.byteLength(source),lf_sha256: sha256(lf),lf_utf8_bytes: Buffer.byteLength(lf),
    crlf_count: source.split('\r\n').length-1,lone_cr_count: lf.split('\r').length-1 }
}

const reservedFunction = row => row.schema === 'public' && row.name === 'rls_auto_enable'
const reservedBinding = row => row.evtname === 'ensure_rls' || (row.function_schema === 'public' && row.function_name === 'rls_auto_enable')
export const containsPlatformFunction = snapshot => snapshot.functions.some(reservedFunction)

function assertPlatform(snapshot) {
  const functions = snapshot.functions.filter(reservedFunction)
  const bindings = snapshot.eventTriggers.filter(reservedBinding)
  const properties = snapshot.platformFunctionProperties
  const grants = snapshot.platformFunctionPrivileges
  if (!functions.length) {
    if (bindings.length || properties.length || grants.length) throw new DeploymentError('Platform RLS helper has orphaned or unexpected catalog context; stop and investigate')
    return false
  }
  if (functions.length !== 1) throw new DeploymentError('Platform RLS helper must have exactly one reviewed signature')
  const { prosrc,...metadata } = functions[0]
  if (!sameRecord(metadata,platformMetadata)) throw new DeploymentError('Platform RLS helper metadata does not match the reviewed official template')
  if (sha256(normalizeCrlf(prosrc)) !== officialRlsSourceSha256) throw new DeploymentError('Platform RLS helper source hash does not match the pinned official template')
  if (properties.length !== 1 || !sameRecord(properties[0],platformProperties)) throw new DeploymentError('Platform RLS helper properties do not match the reviewed official template')
  if (bindings.length !== 1 || !sameRecord(bindings[0],platformBinding)) throw new DeploymentError('Platform RLS event-trigger binding does not match the reviewed official template')
  if (grants.length !== platformGrants.length || platformGrants.some(expected => !grants.some(actual => sameRecord(actual,expected)))) {
    throw new DeploymentError('Platform RLS helper ACL does not match the verified PUBLIC/postgres EXECUTE profile')
  }
  const apiGrants = snapshot.functionGrants.filter(row => identity(row) === platformIdentity)
  if (apiGrants.length !== 1 || !sameRecord(apiGrants[0],platformApiGrant)) throw new DeploymentError('Platform RLS helper filtered ACL is inconsistent with its complete ACL')
  return true
}

export function comparisonCatalog(snapshot,{ preservePlatform = false } = {}) {
  // Fail closed with incomplete snapshots: recognition needs full ACL + binding,
  // not just the function name, owner or the filtered API-role grants.
  for (const field of ['eventTriggers','platformFunctionProperties','platformFunctionPrivileges']) {
    if (!Array.isArray(snapshot[field])) throw new DeploymentError(`Missing required catalog evidence: ${field}`)
  }
  const verifiedPlatform = assertPlatform(snapshot)
  const omitPlatform = verifiedPlatform && !preservePlatform
  const functions = snapshot.functions.filter(row => !omitPlatform || identity(row) !== platformIdentity).map(row => {
    const source = normalizeCrlf(row.prosrc)
    const trustedApplication = verifiedApplicationSources.get(identity(row)) === sha256(source)
    return trustedApplication || (verifiedPlatform && reservedFunction(row)) ? { ...row,prosrc: source } : row
  })
  return { ...snapshot,functions,
    functionGrants: snapshot.functionGrants.filter(row => !omitPlatform || !sameRecord(row,platformApiGrant)),
    eventTriggers: snapshot.eventTriggers.filter(row => !omitPlatform || !sameRecord(row,platformBinding)),
    platformFunctionProperties: omitPlatform ? [] : snapshot.platformFunctionProperties,
    platformFunctionPrivileges: omitPlatform ? [] : snapshot.platformFunctionPrivileges,
  }
}
