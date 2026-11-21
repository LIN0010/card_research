import { DeploymentError } from './error.mjs'
import { readdirSync, readFileSync } from 'node:fs'
import { digest } from './catalog.mjs'

export const baselineVersions = ['202611060001', '202611210001']
export function migrations(directory = 'supabase/migrations') {
  const baseline = JSON.parse(readFileSync('scripts/deploy/baseline.json','utf8'))
  const files = readdirSync(directory).sort()
  const result = files.map(file => {
    const match = /^(\d{12,14})_([a-z0-9_]+)\.sql$/.exec(file)
    if (!match) throw new DeploymentError(`Invalid migration filename: ${file}`)
    const sql = readFileSync(`${directory}/${file}`,'utf8')
    return { version: match[1], file, sql, sha256: digest(sql) }
  })
  if (new Set(result.map(item => item.version)).size !== result.length) throw new DeploymentError('Duplicate migration versions')
  for (const version of baselineVersions) {
    const item = result.find(row => row.version === version)
    if (!item || item.sha256 !== baseline[version]) throw new DeploymentError(`Immutable baseline changed: ${version}`)
  }
  return result
}

export function migrationPlan(local, remote, { bootstrap = false } = {}) {
  if (new Set(remote).size !== remote.length || remote.some(version => !local.some(item => item.version === version))) throw new DeploymentError('Unknown or duplicate remote migration history; stop and investigate')
  if (bootstrap) {
    if (remote.some(version => !baselineVersions.includes(version))) throw new DeploymentError('Baseline synchronization only supports the two manually applied migrations')
    return local.filter(item => baselineVersions.includes(item.version) && !remote.includes(item.version))
  }
  if (baselineVersions.some(version => !remote.includes(version))) throw new DeploymentError('Baseline history is incomplete. Run verify-history then sync-history first; old SQL must never be replayed.')
  if (remote.some((version,index) => local[index]?.version !== version)) throw new DeploymentError('Migration history is not a contiguous prefix; refuse out-of-order migrations')
  return local.slice(remote.length)
}

// Conservative allowlist. Anything complex (including function bodies, DML,
// privileges, ALTER, dynamic SQL) requires a separate human approval run.
// This is a deployment gate, not a proof that an SQL change is safe.
export function needsReview(sql) {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g,' ').replace(/--[^\n]*/g,' ')
  const statements = withoutComments.split(';').map(s => s.trim()).filter(Boolean)
  if (!statements.length) return true
  return statements.some(statement => {
    if (/^(begin|commit)$/i.test(statement)) return false
    if (/^create\s+(?:unique\s+)?index\s+[a-z_]\w*\s+on\s+(?:public|app_private)\.[a-z_]\w*\s*\(\s*[a-z_]\w*(?:\s*,\s*[a-z_]\w*)*\s*\)$/i.test(statement)) return false
    if (/^alter\s+table\s+(?:public|app_private)\.[a-z_]\w*\s+add\s+column\s+[a-z_]\w*\s+(?:text|integer|bigint|boolean|uuid|jsonb|timestamptz)(?:\s+null)?$/i.test(statement)) return false
    return true
  })
}

export function assertNoReset(sql) {
  if (/\b(?:drop\s+(?:database|schema|role)|alter\s+system|truncate\s+(?:table\s+)?(?:auth|storage|supabase_migrations)\.)/i.test(sql)) throw new DeploymentError('Database/schema reset or platform destruction is forbidden, including reviewed deployments')
}

export const planDigest = (commit, pending, project) => digest({ commit, project, migrations: pending.map(({ version, sha256 }) => ({ version, sha256 })) })

export function validateContext(env, mode) {
  if (env.GITHUB_REF !== 'refs/heads/main' || !['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new DeploymentError('Production operations require main and a push/manual event')
  if (env.GITHUB_EVENT_NAME === 'push' && (mode !== 'deploy' || env.AUTOMATION_ENABLED !== 'true')) throw new DeploymentError('Automatic production deployment is not enabled')
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.EXPECTED_COMMIT !== env.GITHUB_SHA) throw new DeploymentError('Manual confirmation must match the exact main commit SHA')
  if (!['deploy','deploy-reviewed','verify-history','sync-history'].includes(mode)) throw new DeploymentError('Unsupported production mode')
}
