import { pathToFileURL } from 'node:url'

export function validateFrontend(env) {
  if (env.VITE_SUPABASE_URL !== `https://${env.SUPABASE_PROJECT_REF}.supabase.co`) throw new Error('Frontend URL must match the production Supabase project')
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return
  try { if (JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role === 'anon') return } catch { /* Reject malformed or privileged keys. */ }
  throw new Error('Frontend key must be publishable or anon; never service_role/secret')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) validateFrontend(process.env)
