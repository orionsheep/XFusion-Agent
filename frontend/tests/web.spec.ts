import { expect, test } from '@playwright/test'

test('login dashboard and hosts page', async ({ page }) => {
  await page.goto('/login')

  await page.getByLabel('用户名').fill('admin')
  await page.getByLabel('密码').fill('admin123')
  await page.getByRole('button', { name: '进入控制台' }).click()

  await expect(page.getByText('Fleet Dashboard')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: '/tmp/xfusion-dashboard.png', fullPage: true })

  await page.goto('/hosts')
  await expect(page.getByText('主机与服务纳管')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('server-1-public')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('server-2')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: '/tmp/xfusion-hosts.png', fullPage: true })
})
