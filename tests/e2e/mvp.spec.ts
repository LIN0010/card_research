import { test, expect, type Page } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Draw } from '../../src/lib/types'

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
  if (rarity) await page.getByRole('radio', { name: ({ normal: '普通', four_star: '四星', signature: '簽名', unknown: '未知' } as Record<string, string>)[rarity], exact: true }).check()
  await page.getByRole('button', { name: `儲存${side}出卡`, exact: true }).click()
  await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('')
}
async function selectMachine(page: Page, id: string) {
  const switcher = page.locator('.session-switch')
  if (!await switcher.evaluate(element => element.hasAttribute('open'))) await switcher.locator('summary').click()
  await page.getByLabel('目前機台').selectOption(id)
  await switcher.getByRole('button', { name: '完成切換', exact: true }).click()
}
async function createSegment(page: Page, label: string) {
  await page.getByRole('button', { name: '開始抽卡', exact: true }).click()
  await page.getByLabel('場次名稱', { exact: true }).fill(label)
  await page.getByRole('button', { name: '開始第 1 局', exact: true }).click()
  await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 1 局')
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
    await selectMachine(page, machines.find(m => m.machine_name === '店內左台')!.id)
    await createSegment(page, 'A 連續觀測')
    await draw(page, '左卡匣', '049')
    await draw(page, '左卡匣', '022')
    await draw(page, '左卡匣', '14P')
    await page.getByRole('button', { name: '下一局', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 2 局')
    await draw(page, '右卡匣', '001', 'four_star')
    await page.getByRole('button', { name: '整體時間順序', exact: true }).click()
    await expect(page.locator('.card-number')).toHaveText(['049', '022', '14P', '001'])
    await expect(page.locator('.draw-item').last()).toContainText('原始 #4 · 第 2 局')
    await expect(page.locator('.draw-item').nth(2)).toContainText('簽名')

    await selectMachine(page, machines.find(m => m.machine_name === '店內右台')!.id)
    await createSegment(page, 'B 連續觀測')
    for (const [side, card] of [['左卡匣', '050'], ['右卡匣', '046'], ['右卡匣', '034'], ['左卡匣', '030'], ['右卡匣', '049']] as const) await draw(page, side, card)
    await page.getByRole('button', { name: '下一局', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 2 局')
    for (const card of ['033', '016', '035']) await draw(page, '右卡匣', card, card === '016' ? 'four_star' : 'normal')
    await page.getByRole('button', { name: '整體時間順序', exact: true }).click()
    await expect(page.locator('.card-number')).toHaveText(['050', '046', '034', '030', '049', '033', '016', '035'])
    await expect(page.locator('.draw-item').last()).toContainText('原始 #8 · 第 2 局')
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.card-number')).toHaveText(['046', '034', '049', '033', '016', '035'])
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').last()).toContainText('右批次 1 #6')
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '左卡匣序列' }).locator('.card-number')).toHaveText(['050', '030'])
    await page.reload()
    await expect(page.locator('.card-number')).toHaveCount(8)
    await page.getByRole('button', { name: '登出', exact: true }).click()
    await login(page)
    await expect(page.locator('.card-number')).toHaveCount(8)
    await selectMachine(page, machines.find(m => m.machine_name === '店內左台')!.id)
    await expect(page.locator('.card-number')).toHaveCount(4)
    await page.getByRole('button', { name: '整體時間順序', exact: true }).click()
    await page.locator('.draw-item').first().locator('.card-menu > summary').click()
    await page.locator('.draw-item').first().getByRole('button', { name: '修改', exact: true }).click()
    await page.getByLabel('修改卡片編號', { exact: true }).fill('AP6-049')
    await page.getByRole('button', { name: '儲存修改', exact: true }).click()
    await expect(page.locator('.card-number').first()).toHaveText('AP6-049')
    page.on('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '撤銷上一筆', exact: true }).click()
    await expect(page.locator('.draw-item').last()).toContainText('已撤銷')
    await expect(page.locator('.draw-item').last()).toContainText('原始 #4')
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
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

test('correcting left to right updates both sequences after reload and preserves original source in audit and export', async ({ page }) => {
  const db = await attachDatabase(page)
  async function seed(action: string, payload: object) {
    const result = await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])
    return result.rows[0].value
  }
  try {
    const store = await seed('create_store', { name: '來源修正測試店' })
    const machine = await seed('create_machine', { store_id: store.id, machine_name: '左台', game_version: 'AP6' })
    await seed('create_segment', { machine_id: machine.id, label: '連續觀測' })
    await page.goto('/')
    await login(page)
    await draw(page, '左卡匣', '049')
    await draw(page, '右卡匣', '001', 'four_star')
    await page.getByRole('button', { name: '下一局', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 2 局')
    await draw(page, '左卡匣', '022')
    const original = (await db.query<Draw>('select * from public.draws where draw_index = 1')).rows[0]

    await page.getByRole('button', { name: '整體時間順序', exact: true }).click()
    await page.locator('.draw-item').first().locator('.card-menu > summary').click()
    await page.locator('.draw-item').first().getByRole('button', { name: '修改', exact: true }).click()
    await page.locator('.edit-form').getByRole('radio', { name: '右卡匣', exact: true }).check()
    await page.getByRole('button', { name: '儲存修改', exact: true }).click()
    await page.locator('.draw-item').first().getByText('詳細資料', { exact: true }).click()
    await expect(page.locator('.draw-item').first()).toContainText('來源已修正：左 → 右')
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '左卡匣序列' }).locator('.card-number')).toHaveText(['022'])
    await expect(page.getByRole('region', { name: '左卡匣序列' }).locator('.draw-item')).toContainText('有效顯示 #3／左 #1')
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.card-number')).toHaveText(['049', '001'])
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').first()).toContainText('有效顯示 #1／右 #1')
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').last()).toContainText('有效顯示 #2／右 #2')
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').first()).toContainText('原始側序：左批次 1 #1（僅供稽核）')
    const events = page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').first().locator('.audit > ul > li')
    await expect(events).toHaveCount(2)
    await expect(events.nth(0)).toContainText('新增出卡')
    await expect(events.nth(1)).toContainText('修改出卡')

    await page.reload()
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.card-number')).toHaveText(['049', '001'])
    const corrected = (await db.query<Draw>('select * from public.draws where id = $1', [original.id])).rows[0]
    expect(corrected).toMatchObject({ side: 'right', draw_index: 1, recorded_side: 'left', recorded_cartridge_id: original.recorded_cartridge_id, side_index: 1, revision: 2 })
    expect(corrected.cartridge_id).not.toBe(original.recorded_cartridge_id)

    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 JSON', exact: true }).click()
    const exported = JSON.parse(readFileSync((await (await downloadEvent).path())!, 'utf8'))
    expect(exported.draws.find((d: Draw) => d.id === original.id)).toMatchObject({ side: 'right', recorded_side: 'left', recorded_cartridge_id: original.recorded_cartridge_id, side_index: 1 })
    expect(exported.audit_events.find((event: { action: string }) => event.action === 'update_draw')).toMatchObject({ old_data: { side: 'left' }, new_data: { side: 'right', recorded_side: 'left' } })
  } finally { await db.close() }
})

test('journal UI: responsive navigation, explicit sources, prefixes, compact cards and advanced settings', async ({ page }, testInfo) => {
  const db = await attachDatabase(page)
  async function seed(action: string, payload: object) {
    const result = await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])
    return result.rows[0].value
  }
  try {
    const store = await seed('create_store', { name: '星光卡片小舖', location: '台北市' })
    const machine = await seed('create_machine', { store_id: store.id, machine_name: '店內左台', game_version: 'AP6' })
    const segment = await seed('create_segment', { machine_id: machine.id, label: '週五午後的收藏' })
    let game = (await db.query<{ id: string }>('select id from public.games where segment_id = $1', [segment.id])).rows[0]
    for (const [side, card, rarity] of [['left', 'AP6-049', 'normal'], ['right', 'A06-001', 'four_star'], ['left', 'AP6-14P', 'signature'], ['right', 'AP6-022', 'normal']]) {
      await seed('append_draw', { id: randomUUID(), segment_id: segment.id, game_id: game.id, side, card_number: card, rarity })
    }
    game = await seed('start_game', { segment_id: segment.id })
    await page.goto('/')
    await expect(page).toHaveTitle('Card Research')
    await expect(page.getByRole('heading', { name: 'Card Research', exact: true })).toBeVisible()
    await login(page)
    const status = page.getByRole('region', { name: '目前抽卡狀態' })
    await expect(status).toContainText('星光卡片小舖')
    await expect(status).toContainText('店內左台')
    await expect(status).toContainText('AP6')
    await expect(status).toContainText('第 2 局')
    await expect(status).toContainText('4 張')
    await expect(page.getByRole('radio', { name: '左卡匣', exact: true })).not.toBeChecked()
    await expect(page.getByRole('radio', { name: '右卡匣', exact: true })).not.toBeChecked()
    await expect(page.getByRole('radio', { name: /無法辨認/ })).not.toBeChecked()
    await expect(page.getByRole('button', { name: '選擇來源後儲存', exact: true })).toBeDisabled()
    await expect(page.locator('.advanced-settings .batch').first()).toBeHidden()
    await expect(page.locator('.draw-details').first()).toBeHidden()
    for (const [width, height] of [[390, 844], [1440, 1000], [768, 1024], [360, 800], [320, 740]]) {
      await page.setViewportSize({ width, height })
      await expect(page.getByRole('navigation', { name: '主要功能' })).toBeVisible()
      const left = await page.getByRole('region', { name: '左卡匣序列' }).boundingBox()
      const right = await page.getByRole('region', { name: '右卡匣序列' }).boundingBox()
      expect(left!.x).toBeLessThan(right!.x)
      expect(Math.abs(left!.y - right!.y)).toBeLessThan(2)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const navPosition = await page.getByRole('navigation', { name: '主要功能' }).evaluate(element => getComputedStyle(element).position)
      expect(navPosition).toBe(width < 768 ? 'fixed' : 'static')
      if (width === 390 || width === 1440) await page.screenshot({ path: testInfo.outputPath(`card-research-${width}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'AP6- 帶入', exact: true }).click()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('AP6-')
    await page.getByLabel('卡片編號', { exact: true }).pressSequentially('14P')
    await expect(page.getByRole('radio', { name: '簽名', exact: true })).toBeChecked()
    await page.getByRole('radio', { name: '四星', exact: true }).check()
    await page.getByRole('radio', { name: '左卡匣', exact: true }).check()
    await page.getByRole('button', { name: '儲存左卡匣出卡', exact: true }).click()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('')
    await expect(page.locator('.save-feedback')).toContainText('已儲存')
    await expect(page.getByRole('radio', { name: '左卡匣', exact: true })).not.toBeChecked()
    const saved = (await db.query<Draw>('select * from public.draws where draw_index = 5')).rows[0]
    expect(saved).toMatchObject({ card_number: 'AP6-14P', rarity: 'four_star', side: 'left' })
    await page.getByLabel('卡片編號', { exact: true }).fill('A06-001')
    await page.getByRole('button', { name: 'AP6- 帶入', exact: true }).click()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('A06-001')
    await page.getByRole('radio', { name: /無法辨認/ }).check()
    await page.getByRole('radio', { name: '未知', exact: true }).check()
    await page.getByRole('button', { name: '儲存來源不明出卡', exact: true }).click()
    await expect(page.getByLabel('卡片編號', { exact: true })).toHaveValue('')
    await page.getByRole('button', { name: '不明來源', exact: false }).click()
    await expect(page.locator('.single-sequence .card-number')).toHaveText(['A06-001'])
    await page.locator('.advanced-settings > summary').click()
    const leftBatch = page.locator('.batch.left')
    await leftBatch.getByRole('button', { name: '更換／標記不確定', exact: true }).click()
    await leftBatch.getByLabel('原因（選填）').fill('無法確認是否更換')
    await leftBatch.getByRole('button', { name: '建立新批次', exact: true }).click()
    await expect(leftBatch).toContainText('批次 2 · 不確定')
    await page.getByRole('button', { name: '下一局', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 3 局')
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '結束抽卡', exact: true }).click()
    await expect(status).toContainText('已結束')
    await expect(page.getByRole('heading', { name: '快速出卡紀錄', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '開始抽卡', exact: true })).toBeEnabled()
  } finally { await db.close() }
})
