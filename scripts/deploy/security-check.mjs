import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { assertNoReset, baselineVersions, migrations, needsReview } from './plan.mjs'

const git = args => execFileSync('git',args,{ encoding: 'utf8' })
const local = migrations()
for (const migration of local.filter(item => !baselineVersions.includes(item.version))) {
  assertNoReset(migration.sql)
  console.log(`${migration.file}: ${needsReview(migration.sql) ? 'requires separate production migration review' : 'eligible for automatic additive deployment'}`)
}
const base = process.env.BASE_SHA
if (base && !/^0+$/.test(base)) {
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid comparison commit')
  const changes = git(['diff','--name-status',base,'HEAD','--','supabase/migrations']).trim().split('\n').filter(Boolean)
  if (changes.some(line => !line.startsWith('A\t'))) throw new Error('Existing migrations are immutable; add a new migration instead of editing/deleting/renaming old SQL')
  const previous = git(['ls-tree','--name-only',`${base}:supabase/migrations`]).trim().split('\n').filter(Boolean).map(file => file.split('_')[0]).sort().at(-1)
  for (const line of changes) if (line.split('/').at(-1).split('_')[0] <= previous) throw new Error('New migration versions must be later than all previously merged versions')
}
const signatures = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9]{30,}\b/, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/, /\bsb_secret_[A-Za-z0-9_-]{20,}\b/]
for (const file of git(['ls-files','-z']).split('\0').filter(Boolean)) {
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) throw new Error(`Environment file must not be tracked: ${file}`)
  if (/\.(png|jpg|woff2?|ico)$/.test(file)) continue
  const content = readFileSync(file,'utf8')
  if (signatures.some(pattern => pattern.test(content))) throw new Error(`Possible credential in tracked file: ${file}`)
  const jwt = content.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []
  for (const token of jwt) {
    try {
      if (JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).role === 'service_role') throw new Error('service_role')
    } catch (error) { if (error.message === 'service_role') throw new Error(`Service-role JWT in tracked file: ${file}`) }
  }
}
console.log(`Security checks passed; ${local.length} immutable/ordered migrations validated. SQL safety still requires PR review.`)
