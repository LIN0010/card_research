import { DeploymentError } from './error.mjs'
import { assertNoReset, baselineVersions, migrationPlan, needsReview, planDigest } from './plan.mjs'

// Dependencies are injected so failure ordering is tested without any production secrets.
export async function release({ mode, local, commit, project, approval = '', remoteHistory, verify, cli, preflight, deploy, log = console.log }) {
  await preflight()
  const remote = await remoteHistory()
  const bootstrap = mode === 'verify-history' || mode === 'sync-history'
  const pending = migrationPlan(local, remote, { bootstrap })
  const applied = bootstrap ? local.filter(item => baselineVersions.includes(item.version)) : local.filter(item => remote.includes(item.version))
  await verify(applied)
  const fingerprint = planDigest(commit, bootstrap ? applied : pending, project)
  log(`Verified plan: ${fingerprint}`)
  log(`Pending history versions: ${pending.map(item => item.version).join(', ') || '(none)'}`)
  if (mode === 'verify-history') return { fingerprint }
  if (mode === 'sync-history') {
    if (approval !== fingerprint) throw new DeploymentError('History synchronization requires the fingerprint from verify-history for this exact commit/project')
    // Repair history only. NEVER db push or execute baseline SQL in this mode.
    if (pending.length) await cli('repair', pending.map(item => item.version))
    migrationPlan(local, await remoteHistory())
    await verify(applied)
    return { fingerprint }
  }
  for (const item of pending) assertNoReset(item.sql)
  if (pending.some(item => needsReview(item.sql)) && (mode !== 'deploy-reviewed' || approval !== fingerprint)) {
    throw new DeploymentError(`Pending migration requires additional review. Inspect SQL and run deploy-reviewed with approval ${fingerprint} and this exact main commit.`)
  }
  if (mode === 'deploy-reviewed' && approval !== fingerprint) throw new DeploymentError('Reviewed deployment fingerprint does not match this commit, project and pending migrations')
  if (pending.length) {
    await cli('dry-run')
    await cli('push')
  }
  const after = await remoteHistory()
  if (JSON.stringify(after) !== JSON.stringify(local.map(item => item.version))) throw new DeploymentError('Migration history did not reach the expected version; website deployment stopped')
  await verify(local)
  // Recheck main and the Git disconnection immediately before production deployment.
  await preflight()
  await deploy()
  return { fingerprint }
}
