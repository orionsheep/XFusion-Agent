import { expect, test } from '@playwright/test'

test('dashboard, tasks, and settings show PDF-facing capabilities', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: '进入控制台' }).click()

  await expect(page.getByText('全局主机态势')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('服务器总览')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '刷新全部快照' })).toBeVisible({ timeout: 15_000 })

  await page.goto('/hosts/1')
  await expect(page.getByText('资源趋势')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('近期 AI 操作记录')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '重新采集主机指标' })).toBeVisible({ timeout: 15_000 })

  await page.goto('/tasks')
  await expect(page.getByText('Goal-driven 任务中心')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: '语音输入' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('PDF 验收矩阵')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: '/tmp/xfusion-tasks-pdf.png', fullPage: true })

  await page.goto('/settings')
  await expect(page.getByText('PDF 要求覆盖')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('高风险识别、预警、二次确认、拒绝非法请求')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: '/tmp/xfusion-settings-pdf.png', fullPage: true })
})
