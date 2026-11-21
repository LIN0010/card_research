import { test, expect, type Page } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Draw } from '../../src/lib/types'

const USER = '00000000-0000-4000-8000-000000000001'
// Test-only HTTP adapter: execute the real migration/RPC in local PostgreSQL.
// Supabase Auth and PostgREST transport are simulated, not a hosted-service test.
async function attachDatabase(page: Page, loseFirstAppendResponse = false, options: { beforeUpgrade?: (db: PGlite) => Promise<void>; loseFirstDeleteResponse?: boolean } = {}) {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    insert into auth.users values('${USER}');`)
  await db.exec(readFileSync(new URL('../../supabase/migrations/202611060001_mvp.sql', import.meta.url), 'utf8'))
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [USER])
  await options.beforeUpgrade?.(db)
  await db.exec(readFileSync(new URL('../../supabase/migrations/202611210001_permanent_delete_unknown_cards.sql', import.meta.url), 'utf8'))
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
        if (options.loseFirstDeleteResponse && body.p_action === 'delete_draw') { options.loseFirstDeleteResponse = false; await route.abort('connectionfailed'); return }
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
    await page.getByRole('button', { name: '下一局（卡序延續）', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 2 局')
    await draw(page, '右卡匣', '001', 'four_star')
    await page.getByRole('button', { name: '整體時間順序', exact: true }).click()
    await expect(page.locator('.card-number')).toHaveText(['049', '022', '14P', '001'])
    await expect(page.locator('.draw-item').last()).toContainText('原始 #4 · 第 2 局')
    await expect(page.locator('.draw-item').nth(2)).toContainText('簽名')

    await selectMachine(page, machines.find(m => m.machine_name === '店內右台')!.id)
    await createSegment(page, 'B 連續觀測')
    for (const [side, card] of [['左卡匣', '050'], ['右卡匣', '046'], ['右卡匣', '034'], ['左卡匣', '030'], ['右卡匣', '049']] as const) await draw(page, side, card)
    await page.getByRole('button', { name: '下一局（卡序延續）', exact: true }).click()
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
    await page.getByRole('button', { name: '刪除上一筆', exact: true }).click()
    await expect(page.locator('.sequence-gap-notice')).toContainText('#4')
    await expect(page.locator('.card-number')).toHaveCount(3)
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.locator('.draw-item')).toHaveCount(11)
    const jsonEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 JSON', exact: true }).click()
    const jsonDownload = await jsonEvent
    const json = JSON.parse(readFileSync((await jsonDownload.path())!, 'utf8'))
    expect(json.draws).toHaveLength(11)
    expect(json.draws.filter((d: { deleted_at: string | null }) => d.deleted_at)).toHaveLength(0)
    expect(json.audit_events.filter((e: { action: string }) => e.action === 'void_draw')).toHaveLength(0)
    const csvEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 CSV', exact: true }).click()
    const csv = readFileSync((await (await csvEvent).path())!, 'utf8')
    expect(csv.split('\r\n')).toHaveLength(12)
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
    await page.getByRole('button', { name: '下一局（卡序延續）', exact: true }).click()
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
    await expect(page.getByRole('region', { name: '左卡匣序列' }).locator('.draw-item')).toContainText('原始 #3 · 第 2 局 · 目前來源：左')
    await page.getByRole('button', { name: '左右卡匣', exact: true }).click()
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.card-number')).toHaveText(['049', '001'])
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').first()).toContainText('原始 #1 · 第 1 局 · 目前來源：右')
    await expect(page.getByRole('region', { name: '右卡匣序列' }).locator('.draw-item').last()).toContainText('原始 #2 · 第 1 局 · 目前來源：右')
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
      await expect(page.getByRole('button', { name: '下一局（卡序延續）', exact: true })).toHaveAccessibleDescription('同一台機器繼續遊玩，中間沒有其他人抽卡。')
      await expect(page.getByRole('button', { name: '結束本次紀錄', exact: true })).toHaveAccessibleDescription('離開、換機台或其他玩家接手時使用。')
      const guides = page.locator('.session-action-guide')
      for (const guide of await guides.all()) {
        const buttonBox = await guide.locator('button').boundingBox()
        const noteBox = await guide.locator('small').boundingBox()
        expect(noteBox!.y).toBeGreaterThanOrEqual(buttonBox!.y + buttonBox!.height)
        expect(await guide.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      }
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
    await page.getByRole('button', { name: '下一局（卡序延續）', exact: true }).click()
    await expect(page.locator('.draw-entry .soft-tag')).toHaveText('第 3 局')
    page.once('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('確定要結束本次紀錄嗎？')
      expect(dialog.message()).toContain('離開、換機台或其他玩家接手時使用。')
      await dialog.dismiss()
    })
    await page.getByRole('button', { name: '結束本次紀錄', exact: true }).click()
    await expect(status).toContainText('抽卡中')
    expect((await db.query<{ ended_at: string | null }>('select ended_at from public.observation_segments where id = $1', [segment.id])).rows[0].ended_at).toBeNull()
    expect((await db.query("select * from public.audit_events where action = 'close_segment'")).rows).toHaveLength(0)
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: '結束本次紀錄', exact: true }).click()
    await expect(status).toContainText('已結束')
    await expect(page.getByRole('heading', { name: '快速出卡紀錄', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '開始抽卡', exact: true })).toBeEnabled()
  } finally { await db.close() }
})

test('same-name branches remain distinguishable across recording, management and history by store IDs', async ({ page }, testInfo) => {
  const db = await attachDatabase(page)
  async function seed(action: string, payload: object) {
    const result = await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])
    return result.rows[0].value
  }
  try {
    const branches = []
    for (const [location, card, version] of [['台北信義店', '049', 'AP6'], ['高雄左營店', '050', 'AP6'], ['', '001', 'A06']]) {
      const store = await seed('create_store', { name: '卡片研究所', location })
      const machine = await seed('create_machine', { store_id: store.id, machine_name: '店內左台', game_version: version })
      const segment = await seed('create_segment', { machine_id: machine.id, label: '週末抽卡' })
      const game = (await db.query<{ id: string }>('select id from public.games where segment_id = $1', [segment.id])).rows[0]
      await seed('append_draw', { id: randomUUID(), segment_id: segment.id, game_id: game.id, side: 'left', card_number: card, rarity: 'normal' })
      branches.push({ store, machine, segment, location, version })
    }
    await page.goto('/')
    await login(page)
    await selectMachine(page, branches[0].machine.id)
    const status = page.getByRole('region', { name: '目前抽卡狀態' })
    await expect(status.locator('.store-location')).toHaveText('台北信義店')
    await page.locator('.session-switch > summary').click()
    const machineSelect = page.getByLabel('目前機台')
    await expect(machineSelect.locator('optgroup')).toHaveCount(3)
    for (const branch of branches) {
      const location = branch.location || '未設定地點'
      await expect(machineSelect.locator(`option[value="${branch.machine.id}"]`)).toHaveText(`卡片研究所 · ${location}／店內左台 · ${branch.version}`)
      await expect(machineSelect.locator(`optgroup[label="卡片研究所 · ${location}"]`)).toHaveCount(1)
    }
    await page.getByRole('button', { name: '完成切換', exact: true }).click()
    await selectMachine(page, branches[1].machine.id)
    await expect(status.locator('.store-location')).toHaveText('高雄左營店')
    await expect(page.locator('.card-number')).toHaveText(['050'])
    await draw(page, '右卡匣', 'AP6-022')
    const saved = (await db.query<{ machine_id: string }>(`select s.machine_id from public.draws d
      join public.observation_segments s on s.id = d.segment_id where d.card_number = 'AP6-022'`)).rows[0]
    expect(saved.machine_id).toBe(branches[1].machine.id)
    await selectMachine(page, branches[2].machine.id)
    await expect(status.locator('.store-location')).toHaveText('未設定地點')
    await expect(page.locator('.card-number')).toHaveText(['001'])
    await selectMachine(page, branches[0].machine.id)
    for (const [width, height] of [[320, 740], [390, 844], [1440, 1000]]) {
      await page.setViewportSize({ width, height })
      await expect(status.locator('.store-location')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      if (width === 390) await status.screenshot({ path: testInfo.outputPath('store-location-mobile.png') })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: '店家與機台', exact: true }).click()
    const storeSelect = page.getByLabel('所屬店家')
    await expect(storeSelect.locator(`option[value="${branches[1].store.id}"]`)).toHaveText('卡片研究所 · 高雄左營店')
    await expect(storeSelect.locator(`option[value="${branches[2].store.id}"]`)).toHaveText('卡片研究所 · 未設定地點')
    await storeSelect.selectOption(branches[1].store.id)
    await page.getByLabel('機台名稱', { exact: true }).fill('新增測試機台')
    await page.getByLabel('遊戲版本', { exact: true }).fill('AP6')
    await page.getByRole('button', { name: '新增機台', exact: true }).click()
    await expect(page.getByLabel('機台名稱', { exact: true })).toHaveValue('')
    expect((await db.query<{ store_id: string }>("select store_id from public.machines where machine_name = '新增測試機台'")).rows[0].store_id).toBe(branches[1].store.id)
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.locator('.history-context')).toHaveCount(4)
    await expect(page.locator('.history-context').filter({ hasText: '台北信義店' })).toHaveCount(1)
    await expect(page.locator('.history-context').filter({ hasText: '高雄左營店' })).toHaveCount(2)
    await expect(page.locator('.history-context').filter({ hasText: '未設定地點' })).toHaveCount(1)
    await page.getByLabel('機台篩選').selectOption(branches[1].machine.id)
    await expect(page.locator('.card-number')).toHaveText(['050', 'AP6-022'])
    await expect(page.getByLabel('抽卡場次篩選').locator(`option[value="${branches[1].segment.id}"]`)).toContainText('高雄左營店')
    await page.getByLabel('機台篩選').selectOption(branches[0].machine.id)
    await expect(page.locator('.card-number')).toHaveText(['049'])
    await page.getByRole('button', { name: '店家與機台', exact: true }).click()
    await page.getByLabel('店家名稱', { exact: true }).fill('卡片研究所')
    await page.getByLabel('店家位置（選填）', { exact: true }).fill('高雄左營店')
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('可能重複建立'); await dialog.dismiss() })
    await page.getByRole('button', { name: '新增店家', exact: true }).click()
    expect((await db.query('select * from public.stores')).rows).toHaveLength(3)
    await expect(page.getByLabel('店家位置（選填）')).toHaveValue('高雄左營店')
    await page.getByLabel('店家位置（選填）').fill('台中西屯店')
    await page.getByRole('button', { name: '新增店家', exact: true }).click()
    await expect(page.getByLabel('店家名稱', { exact: true })).toHaveValue('')
    expect((await db.query('select * from public.stores')).rows).toHaveLength(4)
    expect((await db.query("select * from public.stores where name = '卡片研究所'")).rows).toHaveLength(4)
  } finally { await db.close() }
})

test('permanent deletion confirms, retries a lost response without restoring data, and preserves unknown card positions', async ({ page }, testInfo) => {
  const db = await attachDatabase(page, false, { loseFirstDeleteResponse: true })
  async function seed(action: string, payload: object) {
    return (await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])).rows[0].value
  }
  try {
    const store = await seed('create_store', { name: '永久刪除測試店' })
    const machine = await seed('create_machine', { store_id: store.id, machine_name: '左台', game_version: 'AP6' })
    const segment = await seed('create_segment', { machine_id: machine.id, label: '保留實際位置' })
    await page.goto('/'); await login(page)
    await draw(page, '左卡匣', 'AP6-049')
    await page.getByRole('checkbox', { name: /卡號未知/ }).check()
    await page.getByRole('radio', { name: '左卡匣', exact: true }).check()
    await page.getByRole('button', { name: '儲存左卡匣出卡', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /卡號未知/ })).not.toBeChecked()
    await draw(page, '左卡匣', 'AP6-022')
    const unknown = (await db.query<Draw>('select * from public.draws where segment_id=$1 and draw_index=2', [segment.id])).rows[0]
    expect(unknown).toMatchObject({ card_number: null, card_number_unknown: true, draw_index: 2, side_index: 2 })
    await expect(page.locator('.sequence-no')).toHaveText(['01', '02', '03'])
    const row = page.locator(`[data-draw-id="${unknown.id}"]`)
    await row.locator('.card-menu > summary').click()
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('永久刪除'); await dialog.dismiss() })
    await row.getByRole('button', { name: '刪除', exact: true }).click()
    expect((await db.query('select * from public.draws where id=$1', [unknown.id])).rows).toHaveLength(1)
    page.once('dialog', dialog => dialog.accept())
    await row.getByRole('button', { name: '刪除', exact: true }).click()
    await expect(page.getByRole('button', { name: '重試確認儲存', exact: true })).toBeVisible()
    expect((await db.query('select * from public.draws where id=$1', [unknown.id])).rows).toHaveLength(0)
    expect((await db.query('select * from public.audit_events where entity_id=$1', [unknown.id])).rows).toHaveLength(0)
    await page.getByRole('button', { name: '重試確認儲存', exact: true }).click()
    await expect(page.locator('.sequence-no')).toHaveText(['01', '03'])
    await expect(page.locator('.sequence-gap-notice')).toContainText('#2')
    await expect(page.locator('.sequence-gap-notice')).toContainText('不可視為連續卡序')
    await page.reload()
    await expect(page.locator('.sequence-no')).toHaveText(['01', '03'])
    await page.locator('.sequence-section').screenshot({ path: testInfo.outputPath('original-position-gap.png') })
    await page.getByRole('checkbox', { name: /卡號未知/ }).check()
    await page.getByRole('radio', { name: '左卡匣', exact: true }).check()
    await page.getByRole('button', { name: '儲存左卡匣出卡', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /卡號未知/ })).not.toBeChecked()
    const laterUnknown = (await db.query<Draw>('select * from public.draws where segment_id=$1 and draw_index=4', [segment.id])).rows[0]
    expect(laterUnknown).toMatchObject({ card_number: null, card_number_unknown: true, draw_index: 4, side_index: 4 })
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '匯出 JSON', exact: true }).click()
    const exported = JSON.parse(readFileSync((await (await downloadEvent).path())!, 'utf8'))
    expect(exported.schema_version).toBe(2)
    expect(exported.draws.map((draw: Draw) => draw.draw_index)).toEqual(expect.arrayContaining([1, 3, 4]))
    expect(exported.draws.find((draw: Draw) => draw.id === laterUnknown.id)).toMatchObject({ card_number: null, card_number_unknown: true })
    expect(exported.audit_events.some((event: { entity_id: string }) => event.entity_id === unknown.id)).toBe(false)
    await page.getByRole('button', { name: '出卡紀錄', exact: true }).click()
    const laterRow = page.locator(`[data-draw-id="${laterUnknown.id}"]`)
    await laterRow.locator('.card-menu > summary').click()
    await laterRow.getByRole('button', { name: '修改', exact: true }).click()
    await page.locator('.edit-form').getByRole('checkbox', { name: /卡號未知/ }).uncheck()
    await page.getByLabel('修改卡片編號').fill('AP6-14P')
    await page.getByRole('button', { name: '儲存修改', exact: true }).click()
    await expect(laterRow.locator('.card-number')).toHaveText('AP6-14P')
    expect((await db.query<Draw>('select * from public.draws where id=$1', [laterUnknown.id])).rows[0]).toMatchObject({ draw_index: 4, side_index: 4, card_number_unknown: false })
  } finally { await db.close() }
})

test('history hides empty sessions after deletion while retaining populated gaps and database sessions', async ({ page }) => {
  const db = await attachDatabase(page)
  async function seed(action: string, payload: object) {
    return (await db.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])).rows[0].value
  }
  try {
    const store = await seed('create_store', { name: '歷史顯示測試店' })
    const machine = await seed('create_machine', { store_id: store.id, machine_name: '左台', game_version: 'AP6' })
    const empty = await seed('create_segment', { machine_id: machine.id, label: '已結束空場次' })
    const emptyGame = (await db.query<{ id: string }>('select id from public.games where segment_id=$1', [empty.id])).rows[0]
    const removed = await seed('append_draw', { id: randomUUID(), segment_id: empty.id, game_id: emptyGame.id, side: 'left', card_number: 'AP6-050', rarity: 'normal' })
    await seed('delete_draw', { id: removed.id, segment_id: empty.id, revision: 1, confirmed: true })
    await seed('close_segment', { segment_id: empty.id })
    const populated = await seed('create_segment', { machine_id: machine.id, label: '保留缺口場次' })
    const game = (await db.query<{ id: string }>('select id from public.games where segment_id=$1', [populated.id])).rows[0]
    const ids: string[] = []
    for (const card of ['AP6-049', 'AP6-022', 'AP6-14P']) {
      ids.push((await seed('append_draw', { id: randomUUID(), segment_id: populated.id, game_id: game.id, side: 'left', card_number: card, rarity: 'normal' })).id)
    }
    await seed('delete_draw', { id: ids[1], segment_id: populated.id, revision: 1, confirmed: true })
    await seed('close_segment', { segment_id: populated.id })
    await seed('create_segment', { machine_id: machine.id, label: '進行中空場次' })
    const sessionsBefore = (await db.query('select * from public.observation_segments order by id')).rows
    const gamesBefore = (await db.query('select * from public.games order by id')).rows
    await page.goto('/'); await login(page)
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.getByRole('option', { name: /已結束空場次/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /進行中空場次/ })).toHaveCount(1)
    await expect(page.locator('.sequence-gap-notice')).toHaveCount(1)
    await expect(page.locator('.sequence-gap-notice')).toContainText('保留缺口場次 · 原始序號缺口：#2。')
    await page.getByLabel('抽卡場次篩選').selectOption(populated.id)
    await page.getByLabel('遊戲局數篩選').selectOption(game.id)
    for (const id of [ids[0], ids[2]]) {
      page.once('dialog', dialog => dialog.accept())
      await page.locator(`[data-draw-id="${id}"]`).getByRole('button', { name: '刪除', exact: true }).click()
      await expect(page.locator(`[data-draw-id="${id}"]`)).toHaveCount(0)
    }
    await expect(page.getByText('尚無抽卡紀錄', { exact: true })).toBeVisible()
    await expect(page.getByLabel('抽卡場次篩選')).toHaveCount(0)
    await expect(page.locator('.sequence-gap-notice')).toHaveCount(0)
    expect((await db.query('select * from public.observation_segments order by id')).rows).toEqual(sessionsBefore)
    expect((await db.query('select * from public.games order by id')).rows).toEqual(gamesBefore)
    await page.reload()
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.getByText('尚無抽卡紀錄', { exact: true })).toBeVisible()
    await expect(page.locator('.sequence-gap-notice')).toHaveCount(0)
  } finally { await db.close() }
})

test('legacy soft-deleted data survives upgrade until the owner confirms cleanup and then leaves no cached card snapshots', async ({ page }) => {
  let legacyId = ''
  let activeId = ''
  const db = await attachDatabase(page, false, { beforeUpgrade: async database => {
    async function old(action: string, payload: object) {
      return (await database.query<{ value: { id: string } }>('select public.apply_command($1::uuid,$2,$3::jsonb) as value', [randomUUID(), action, JSON.stringify(payload)])).rows[0].value
    }
    const store = await old('create_store', { name: '升級前的店家' })
    const machine = await old('create_machine', { store_id: store.id, machine_name: '原有機台', game_version: 'AP6' })
    const segment = await old('create_segment', { machine_id: machine.id, label: '既有資料' })
    const game = (await database.query<{ id: string }>('select id from public.games where segment_id=$1', [segment.id])).rows[0]
    activeId = randomUUID(); legacyId = randomUUID()
    await old('append_draw', { id: activeId, segment_id: segment.id, game_id: game.id, side: 'left', card_number: 'KEEP-ACTIVE', rarity: 'normal' })
    await old('append_draw', { id: legacyId, segment_id: segment.id, game_id: game.id, side: 'right', card_number: 'LEGACY-PRIVATE-CARD', rarity: 'normal' })
    await old('void_draw', { id: legacyId, segment_id: segment.id, revision: 1 })
  } })
  try {
    expect((await db.query('select * from public.draws')).rows).toHaveLength(2)
    await page.goto('/'); await login(page)
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: '包含已撤銷紀錄', exact: true })).toHaveCount(0)
    await expect(page.locator('.card-number')).toHaveText(['KEEP-ACTIVE'])
    const cleanup = page.getByRole('region', { name: '舊撤銷紀錄清理' })
    await expect(cleanup).toContainText('1 筆')
    page.once('dialog', dialog => dialog.dismiss())
    await cleanup.getByRole('button', { name: '永久清理舊撤銷紀錄', exact: true }).click()
    expect((await db.query('select * from public.draws where id=$1', [legacyId])).rows).toHaveLength(1)
    page.once('dialog', dialog => dialog.accept())
    await cleanup.getByRole('button', { name: '永久清理舊撤銷紀錄', exact: true }).click()
    await expect(cleanup).toHaveCount(0)
    expect((await db.query('select * from public.draws where id=$1', [legacyId])).rows).toHaveLength(0)
    expect((await db.query('select * from public.draws where id=$1', [activeId])).rows).toHaveLength(1)
    expect((await db.query('select * from public.audit_events where entity_id=$1', [legacyId])).rows).toHaveLength(0)
    await db.exec('reset role')
    expect(JSON.stringify((await db.query('select request,result from app_private.operations')).rows)).not.toContain('LEGACY-PRIVATE-CARD')
    await db.exec('set role authenticated')
    await page.reload()
    await page.getByRole('button', { name: '歷史紀錄', exact: true }).click()
    await expect(page.getByRole('button', { name: '永久清理舊撤銷紀錄', exact: true })).toHaveCount(0)
    await expect(page.locator('.card-number')).toHaveText(['KEEP-ACTIVE'])
  } finally { await db.close() }
})
