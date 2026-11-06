import { test, expect, type Page } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

const USER = '00000000-0000-4000-8000-000000000001'
// Test-only HTTP adapter: execute the real migration/RPC in local PostgreSQL.
// Supabase Auth and PostgREST transport are simulated, not a hosted-service test.
async function attachDatabase(page: Page, loseFirstAppendResponse = false) {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values('${USER}');`)
  await db.exec(readFileSync(new URL('../../supabase/migrations/202611060001_mvp.sql', import.meta.url), 'utf8'))
  await db.exec('set role authenticated')
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [USER])
  const token = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: USER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test-signature`
  const authUser = { id: USER, aud: 'authenticated', role: 'authenticated', email: 'test@example.com', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() }
  const tables = new Set(['stores', 'machines', 'observation_segments', 'games', 'cartridges', 'draws', 'audit_events'])
  await page.route('https://test.supabase.co/**', async route => {
    const url = new URL(route.request().url())
    try {
      if (url.pathname === '/auth/v1/token') {
        await route.fulfill({ json: { access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'test-refresh', user: authUser } }); return
      }
      if (url.pathname === '/auth/v1/user') { await route.fulfill({ json: authUser }); return }
      if (url.pathname === '/auth/v1/logout') { await route.fulfill({ status: 204 }); return }
      if (url.pathname === '/rest/v1/rpc/apply_command') {
        const body = route.request().postDataJSON()
        const response = await db.query<{ value: unknown }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [body.p_operation_id, body.p_action, JSON.stringify(body.p_payload)])
        if (loseFirstAppendResponse && body.p_action === 'append_draw') {
          loseFirstAppendResponse = false
          await route.abort('connectionfailed'); return
        }
        await route.fulfill({ json: response.rows[0].value }); return
      }
      const table = url.pathname.replace('/rest/v1/', '')
      if (tables.has(table)) {
        const result = await db.query(`select * from public.${table} order by id limit $1 offset $2`, [Number(url.searchParams.get('limit') ?? 500), Number(url.searchParams.get('offset') ?? 0)])
        await route.fulfill({ json: result.rows }); return
      }
      await route.fulfill({ status: 404, json: { message: 'Unknown test endpoint', code: 'PGRST000' } })
    } catch (error) {
      await route.fulfill({ status: 400, json: { message: error instanceof Error ? error.message : 'Database error', code: 'P0001' } })
    }
  })
  return db
}
async function login(page: Page) {
  await page.getByLabel('電子郵件').fill('test@example.com')
  await page.getByLabel('密碼', { exact: true }).fill('test-password-123')
  await page.getByRole('button', { name: '登入', exact: true }).click()
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible()
}
async function draw(page: Page, side: '左卡匣' | '右卡匣', card: string, rarity?: string) {
  await page.getByLabel('卡片編號', { exact: true }).fill(card)
  await page.getByRole('radio', { name: side, exact: true }).check()
  if (rarity) await page.getByRole('combobox', { name: '稀有度', exact: true }).selectOption(rarity)
  await page.getByRole('button', { name: `儲存${side}出卡`, exact: true }).click()
  await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('')
}
async function createSegment(page: Page, label: string) {
  await page.getByText('建立新的連續觀測段', { exact: true }).click()
  await page.getByLabel('觀測段名稱', { exact: true }).fill(label)
  await page.getByRole('button', { name: '建立觀測段及第 1 局', exact: true }).click()
  await expect(page.getByRole('heading', { name: '紀錄出卡 · 第 1 局' })).toBeVisible()
}

test('mobile MVP: manage, record A/B across games, reload, relogin, edit, undo, export', async ({ page }) => {
  const db = await attachDatabase(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('/')
    await login(page)
    await page.getByRole('button', { name: '店家與機台', exact: true }).click()
    await page.getByLabel('店家名稱', { exact: true }).fill('測試店家')
    await page.getByRole('button', { name: '新增店家', exact: true }).click()
    await expect(page.getByLabel('所屬店家')).toContainText('測試店家')
    for (const machine of ['店內左台', '店內右台']) {
      await page.getByLabel('機台名稱', { exact: true }).fill(machine)
      await page.getByLabel('遊戲版本', { exact: true }).fill('AP6')
      await page.getByRole('button', { name: '新增機台', exact: true }).click()
      await expect(page.getByLabel('機台名稱', { exact: true })).toHaveValue('')
    }
    await page.getByRole('button', { name: '出卡紀錄', exact: true }).click()
    const machines = (await db.query<{ id: string; machine_name: string }>('select id, machine_name from public.machines')).rows
    await page.getByLabel('目前機台').selectOption(machines.find(m => m.machine_name === '店內左台')!.id)
    await createSegment(page, 'A 連續觀測')
    await draw(page, '左卡匣', '049')
    await draw(page, '左卡匣', '022')
    await draw(page, '左卡匣', '14P')
    await page.getByRole('button', { name: '下一局（卡序繼續）', exact: true }).click()
    await expect(page.getByRole('heading', { name: '紀錄出卡 · 第 2 局' })).toBeVisible()
    await draw(page, '右卡匣', '001', 'four_star')
    await expect(page.locator('.card-number')).toHaveText(['049', '022', '14P', '001'])
    await expect(page.locator('.draw-item').last()).toContainText('原始 #4 · 第 2 局')
    await expect(page.locator('.draw-item').nth(2)).toContainText('簽名')

    await page.getByLabel('目前機台').selectOption(machines.find(m => m.machine_name === '店內右台')!.id)
    await createSegment(page, 'B 連續觀測')
    for (const [side, card] of [['左卡匣', '050'], ['右卡匣', '046'], ['右卡匣', '034'], ['左卡匣', '030'], ['右卡匣', '049']] as const) await draw(page, side, card)
    await page.getByRole('button', { name: '下一局（卡序繼續）', exact: true }).click()
    await expect(page.getByRole('heading', { name: '紀錄出卡 · 第 2 局' })).toBeVisible()
    for (const card of ['033', '016', '035']) await draw(page, '右卡匣', card, card === '016' ? 'four_star' : 'normal')
    await expect(page.locator('.card-number')).toHaveText(['050', '046', '034', '030', '049', '033', '016', '035'])
    await expect(page.locator('.draw-item').last()).toContainText('原始 #8 · 第 2 局')
    await page.getByRole('button', { name: '右側', exact: true }).click()
    await expect(page.locator('.card-number')).toHaveText(['046', '034', '049', '033', '016', '035'])
    await expect(page.locator('.draw-item').last()).toContainText('右批次 1 #6')
    await page.getByRole('button', { name: '左側', exact: true }).click()
    await expect(page.locator('.card-number')).toHaveText(['050', '030'])
    await page.reload()
    await expect(page.locator('.card-number')).toHaveCount(8)
    await page.getByRole('button', { name: '登出', exact: true }).click()
    await login(page)
    await expect(page.locator('.card-number')).toHaveCount(8)
    await page.getByLabel('目前機台').selectOption(machines.find(m => m.machine_name === '店內左台')!.id)
    await expect(page.locator('.card-number')).toHaveCount(4)
    await page.locator('.draw-item').first().getByRole('button', { name: '修改', exact: true }).click()
    await page.getByLabel('修改卡片編號', { exact: true }).fill('AP6-049')
    await page.getByRole('button', { name: '儲存修改', exact: true }).click()
    await expect(page.locator('.card-number').first()).toHaveText('AP6-049')
    page.on('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '撤銷上一筆', exact: true }).click()
    await expect(page.locator('.draw-item').last()).toContainText('已撤銷')
    await expect(page.locator('.draw-item').last()).toContainText('原始 #4')
    await page.getByRole('button', { name: '歷史與匯出', exact: true }).click()
    await expect(page.locator('.draw-item')).toHaveCount(12)
    const jsonEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 JSON', exact: true }).click()
    const jsonDownload = await jsonEvent
    const json = JSON.parse(readFileSync((await jsonDownload.path())!, 'utf8'))
    expect(json.draws).toHaveLength(12)
    expect(json.draws.filter((d: { deleted_at: string | null }) => d.deleted_at)).toHaveLength(1)
    expect(json.audit_events.filter((e: { action: string }) => e.action === 'void_draw')).toHaveLength(1)
    const csvEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 CSV', exact: true }).click()
    const csv = readFileSync((await (await csvEvent).path())!, 'utf8')
    expect(csv.split('\r\n')).toHaveLength(13)
    expect(csv).toContain('"AP6-049"')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } finally { await db.close() }
})

test('a lost response after commit preserves input and retries without duplicating the draw', async ({ page }) => {
  const db = await attachDatabase(page, true)
  async function seed(action: string, payload: object) {
    const result = await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])
    return result.rows[0].value
  }
  try {
    const store = await seed('create_store', { name: '測試店家' })
    const machine = await seed('create_machine', { store_id: store.id, machine_name: '左台', game_version: 'AP6' })
    await seed('create_segment', { machine_id: machine.id, label: '儲存可靠性驗證' })
    await page.goto('/')
    await login(page)
    await page.getByLabel('卡片編號', { exact: true }).fill('AP6-049')
    await page.getByRole('radio', { name: '左卡匣', exact: true }).check()
    await page.getByRole('button', { name: '儲存左卡匣出卡', exact: true }).click()
    await expect(page.getByRole('button', { name: '重試確認儲存', exact: true })).toBeVisible()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('AP6-049')
    await expect(page.getByLabel('卡片編號', { exact: true })).toBeDisabled()
    expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
    await page.getByRole('button', { name: '重試確認儲存', exact: true }).click()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('')
    await expect(page.locator('.card-number')).toHaveText(['AP6-049'])
    expect((await db.query('select * from public.draws')).rows).toHaveLength(1)
    expect((await db.query("select * from public.audit_events where action = 'append_draw'")).rows).toHaveLength(1)
  } finally { await db.close() }
})
