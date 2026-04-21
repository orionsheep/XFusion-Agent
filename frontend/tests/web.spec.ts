import { expect, test } from '@playwright/test'

test('agent-first home and secondary workspace show PDF-facing capabilities', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: '进入控制台' }).click()

  await expect(page.getByRole('button', { name: 'XFusion Agent' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: '直接用 Agent 驱动运维任务' })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.workspace-overlay')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /appstore 工作区/ })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '会话设置' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '新对话' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: 'GLM-4.5' }).click()
  await expect(page.getByText('模型切换', { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /台目标主机/ }).click()
  await expect(page.getByText('目标主机', { exact: true })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /appstore 工作区/ }).click()
  await expect(page.locator('.workspace-overlay')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('heading', { name: '总览' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('服务器总览')).toBeVisible({ timeout: 15_000 })

  await page.goto('/hosts/1')
  await expect(page.locator('.workspace-overlay')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('资源趋势')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('近期 AI 操作记录')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '重新采集主机指标' })).toBeVisible({ timeout: 15_000 })
  await page.goto('/hosts/4')
  await expect(page.getByText('运行时分布')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('数据库服务')).toBeVisible({ timeout: 15_000 })

  await page.goto('/tasks')
  await expect(page.getByText('Goal-driven 任务中心')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.workspace-overlay').getByRole('button', { name: '语音输入' }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('PDF 验收矩阵')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '执行任务' })).toBeDisabled()
  await page.screenshot({ path: '/tmp/xfusion-tasks-pdf.png', fullPage: true })

  await page.goto('/settings')
  await expect(page.getByText('当前账号')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('账号与权限')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('模型自由切换')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '切换模型' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('PDF 要求覆盖')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('高风险识别、预警、二次确认、拒绝非法请求')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: '/tmp/xfusion-settings-pdf.png', fullPage: true })
})

test('host detail handoff and host form mode logic work', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: '进入控制台' }).click()

  await page.goto('/hosts/1')
  await expect(page.getByRole('button', { name: '去任务中心' })).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '去任务中心' }).click()
  await expect(page.getByText('Goal-driven 任务中心')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '执行任务' })).toBeEnabled()

  await page.goto('/hosts')
  await page.getByRole('button', { name: '新增主机' }).click()
  await expect(page.getByText('接入主机')).toBeVisible()
  await expect(page.getByLabel('Agent URL')).toBeVisible()
  await expect(page.getByLabel('SSH 私钥')).toBeVisible()
  await expect(page.getByLabel('SSH 密码')).toBeHidden()

  await page.locator('.ant-form-item').filter({ hasText: '认证方式' }).locator('.ant-select').click()
  await page.getByTitle('password').click()
  await expect(page.getByLabel('SSH 密码')).toBeVisible()
  await expect(page.getByLabel('SSH 私钥')).toBeHidden()

  await page.locator('.ant-form-item').filter({ hasText: '连接模式' }).locator('.ant-select').click()
  await page.locator('.ant-select-item-option[title="agent"]').click()
  await expect(page.getByLabel('Agent URL')).toBeVisible()
  await expect(page.getByLabel('SSH 用户名')).toBeHidden()
})

test('agent panel can send a real task from the UI', async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto('/login')

  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: '进入控制台' }).click()

  await page.goto('/')
  await expect(page.locator('.agent-stage')).toBeVisible({ timeout: 15_000 })

  const composer = page.locator('.agent-stage textarea')
  await composer.fill('查询当前磁盘剩余空间')
  await expect(page.locator('.agent-stage').getByRole('button', { name: '发送给 Agent' })).toBeEnabled()
  await page.locator('.agent-stage').getByRole('button', { name: '发送给 Agent' }).click()

  await expect(page.locator('.agent-message--assistant').last()).toContainText('正在连接目标主机', { timeout: 20_000 })
  await expect(page.locator('.agent-message--assistant').filter({ hasText: '已在 4 台主机上执行' }).first()).toBeVisible({ timeout: 150_000 })
})

test('tasks execute through claude sdk gateway and record provider metadata', async ({ request }) => {
  test.setTimeout(240_000)

  const login = await request.post('http://127.0.0.1:8000/api/auth/login', {
    data: { username: 'admin', password: 'admin123' },
  })
  expect(login.ok()).toBeTruthy()
  const { access_token } = await login.json()

  const switchProfile = await request.put('http://127.0.0.1:8000/api/runtime/llm-profile', {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    data: {
      model_alias: 'GLM-4.5',
      provider: 'zhipu',
    },
  })

  expect(switchProfile.ok()).toBeTruthy()

  const execute = await request.post('http://127.0.0.1:8000/api/tasks/execute', {
    headers: {
      Authorization: `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    data: {
      prompt: '查询当前磁盘剩余空间',
      session_id: 'playwright-claude-gateway',
      selected_host_ids: [1],
    },
  })

  expect(execute.ok()).toBeTruthy()
  const task = await execute.json()
  expect(task.status).toBe('succeeded')
  expect(task.plan_json.ai.agent_runtime).toBe('claude_agent_sdk')
  expect(task.plan_json.ai.gateway_mode).toBeTruthy()
  expect(task.plan_json.ai.gateway_provider).toBe('zhipu')
  expect(task.plan_json.ai.gateway_model).toBe('GLM-4.5')
  expect(task.plan_json.ai.tool_calls.length).toBeGreaterThan(0)
  expect(task.result_json.per_host[0].success).toBeTruthy()
})
