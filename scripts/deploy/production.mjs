import { DeploymentError } from './error.mjs'
import pg from 'pg'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, cpSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCatalog, expectedCatalog, history, readCatalog } from './catalog.mjs'
import { migrations, validateContext } from './plan.mjs'
import { release } from './release.mjs'

export function databaseConfig(env) {
  const url = new URL(env.SUPABASE_DB_URL)
  const ref = env.SUPABASE_PROJECT_REF
  if (!/^[a-z]{20}$/.test(ref ?? '')) throw new DeploymentError('Invalid Supabase project reference')
  const direct = url.hostname === `db.${ref}.supabase.co` && decodeURIComponent(url.username) === 'postgres'
  const sessionPool = url.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(url.username) === `postgres.${ref}`
  if (!['postgres:','postgresql:'].includes(url.protocol) || (!direct && !sessionPool) || (url.port && url.port !== '5432') || url.pathname !== '/postgres') {
    throw new DeploymentError('Use the expected Supabase project direct/session connection on port 5432, database postgres; transaction pooling is unsupported')
  }
  // Do not let URL options silently disable certificate verification in node-postgres.
  for (const key of [...url.searchParams.keys()]) if (/^ssl/i.test(key)) url.searchParams.delete(key)
  return { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ...(env.SUPABASE_DB_CA_CERT ? { ca: env.SUPABASE_DB_CA_CERT } : {}) }, connectionTimeoutMillis: 15000, query_timeout: 30000, keepAlive: true }
}

export async function withLock(db, task) {
  const result = await db.query('select pg_try_advisory_lock(178403,1) as locked')
  if (!result.rows[0].locked) throw new DeploymentError('Another production operation holds the database deployment lock')
  try { return await task() } finally { await db.query('select pg_advisory_unlock(178403,1)') }
}

export function assertVercelProject(project, env) {
  if (project.id !== env.VERCEL_PROJECT_ID || project.accountId !== env.VERCEL_ORG_ID) throw new DeploymentError('Vercel project/team does not match Secrets')
  if (project.link || project.gitRepository) throw new DeploymentError('Disconnect Vercel Git integration and cancel queued Git deployments before enabling Actions. Refusing a race with Git auto-deploy.')
}

export function assertNoActiveDeployments(result) {
  if (!Array.isArray(result.deployments)) throw new DeploymentError('Vercel deployments response is invalid')
  if (result.deployments.length) throw new DeploymentError('Vercel has unfinished production deployments; cancel or wait for them before migrating/deploying')
}

export function prepareOutput(env, directory = process.cwd()) {
  const output = join(directory,'.vercel/output')
  rmSync(output,{ recursive: true,force: true })
  mkdirSync(output, { recursive: true })
  writeFileSync(join(directory,'.vercel/project.json'), JSON.stringify({ orgId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID }))
  cpSync(join(directory,'dist'),join(output,'static'), { recursive: true })
  writeFileSync(join(output,'config.json'), JSON.stringify({ version: 3, routes: [{ handle: 'filesystem' }, { src: '/((?!assets/).*)', dest: '/index.html' }] }))
}

async function main() {
  const env = process.env
  const mode = env.DEPLOY_MODE || 'deploy'
  validateContext(env, mode)
  for (const name of ['SUPABASE_DB_URL','SUPABASE_PROJECT_REF','GITHUB_TOKEN','GITHUB_REPOSITORY','GITHUB_SHA']) {
    if (!env[name]) throw new DeploymentError(`Missing required Secret/context: ${name}`)
  }
  const bootstrap = mode.endsWith('history')
  if (!bootstrap) for (const name of ['VERCEL_TOKEN','VERCEL_ORG_ID','VERCEL_PROJECT_ID']) if (!env[name]) throw new DeploymentError(`Missing required Secret: ${name}`)
  const local = migrations()
  const config = databaseConfig(env)
  const cliUrl = new URL(config.connectionString)
  cliUrl.searchParams.set('sslmode','verify-full')
  const certificateDirectory = env.SUPABASE_DB_CA_CERT ? mkdtempSync(join(tmpdir(),'card-research-db-')) : undefined
  let certificate
  if (certificateDirectory) {
    certificate = join(certificateDirectory,'root.crt')
    writeFileSync(certificate,env.SUPABASE_DB_CA_CERT,{ mode: 0o600 })
    cliUrl.searchParams.set('sslrootcert',certificate)
  }
  const db = new pg.Client(config)
  let lockLost = false
  let child
  db.on('error', () => { lockLost = true; child?.kill('SIGTERM') })
  const stop = () => { lockLost = true; child?.kill('SIGTERM') }
  process.once('SIGTERM',stop)
  process.once('SIGINT',stop)
  const guard = () => { if (lockLost) throw new DeploymentError('Database lock connection lost; deployment stopped') }
  const run = (command, args) => new Promise((resolve,reject) => {
    guard()
    // CLI 2.x rebuilds connection URLs internally; enforce TLS in libpq env too.
    child = spawn(command,args,{ env: { ...env, PGSSLMODE: 'verify-full', PGSSLROOTCERT: certificate }, stdio: ['ignore','pipe','pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', () => {})
    child.on('error', () => reject(new DeploymentError(`${command} could not start`)))
    child.on('exit', code => { child = undefined; if (code || lockLost) reject(new DeploymentError(`${command} failed (exit ${code}); subsequent steps stopped. Check the service status before retrying an uncertain request. Command output suppressed to avoid leaking connection credentials.`)); else resolve(output) })
  })
  const api = async (url, token) => {
    const response = await fetch(url,{ headers: { Authorization: `Bearer ${token}` },signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new DeploymentError(`Deployment preflight API failed with status ${response.status}`)
    return response.json()
  }
  const preflight = async () => {
    guard()
    const head = await api(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/main`, env.GITHUB_TOKEN)
    if (head.object.sha !== env.GITHUB_SHA) throw new DeploymentError('This commit is no longer main HEAD; run the latest main workflow instead')
    if (!bootstrap) {
      const team = env.VERCEL_ORG_ID.startsWith('team_') ? `?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}` : ''
      const project = await api(`https://api.vercel.com/v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}${team}`,env.VERCEL_TOKEN)
      assertVercelProject(project,env)
      const params = new URLSearchParams({ projectId: env.VERCEL_PROJECT_ID,target: 'production',state: 'QUEUED,INITIALIZING,BUILDING',limit: '100' })
      if (env.VERCEL_ORG_ID.startsWith('team_')) params.set('teamId',env.VERCEL_ORG_ID)
      assertNoActiveDeployments(await api(`https://api.vercel.com/v6/deployments?${params}`,env.VERCEL_TOKEN))
    }
  }
  try {
    await db.connect()
    await withLock(db, async () => release({ mode, local, commit: env.GITHUB_SHA, project: env.SUPABASE_PROJECT_REF, approval: env.PLAN_APPROVAL,
      remoteHistory: () => history(db), preflight,
      verify: async applied => { const expected = await expectedCatalog(applied); guard(); assertCatalog(expected, await readCatalog(db)) },
      cli: async (action, versions = []) => {
        guard()
        const args = action === 'repair'
          ? ['migration','repair',...versions,'--status','applied','--db-url',cliUrl.toString(),'--yes']
          : ['db','push','--db-url',cliUrl.toString(),'--yes',...(action === 'dry-run' ? ['--dry-run'] : [])]
        await run('supabase',args)
        guard()
      },
      deploy: async () => {
        prepareOutput(env)
        const output = await run('scripts/deploy/tools/node_modules/@vercel/vc-native-linux-x64/bin/vercel',['deploy','--prebuilt','--prod','--yes','--token',env.VERCEL_TOKEN,'--archive=tgz'])
        const url = output.match(/https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\b/)?.[0]
        console.log(url ? `Production deployment: ${url}` : 'Vercel production deployment completed')
        if (url && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,`Production deployment: ${url}\n`)
      },
      log: message => { console.log(message); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,`${message}\n\n`) },
    }))
  } finally {
    process.removeListener('SIGTERM',stop); process.removeListener('SIGINT',stop)
    await db.end()
    if (certificateDirectory) rmSync(certificateDirectory,{ recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Database errors can contain SQL, connection strings or row values. Emit only our own controlled errors.
    console.error(error instanceof DeploymentError ? error.message : 'Production operation failed. Check migration history and Vercel deployment status using trusted tools. Raw database/tool errors are not logged.')
    process.exitCode = 1
  })
}
