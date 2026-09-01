import { test, expect } from '@playwright/test';

async function completeSetup(page) {
  const fallbackButton = page.getByRole('button', { name: 'Use browser storage instead' });
  if (await fallbackButton.isVisible().catch(() => false)) await fallbackButton.click();
  await expect(page.locator('#setup-overlay')).toBeHidden();
  await expect(page.locator('#content')).not.toBeEmpty();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await completeSetup(page);
});

test('renders Study charts and sessions in a real browser', async ({ page }) => {
  await page.getByRole('button', { name: 'Study' }).click();
  await expect(page.getByRole('heading', { name: /Study Tracker/ })).toBeVisible();
  await expect(page.locator('.offline-chart').first()).toBeVisible();
  await expect(page.getByText("Today's Sessions")).toBeVisible();
});

test('persists a task across a real browser reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.locator('#task-in').first().fill('Survives reload');
  await page.getByRole('button', { name: '+ Add' }).first().click();
  await expect(page.getByText('Survives reload')).toBeVisible();
  await page.reload();
  await completeSetup(page);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.getByText('Survives reload')).toBeVisible();
});

test('opens the task detail panel and persists its metadata', async ({ page }) => {
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.locator('#task-in').first().fill('Detailed task');
  await page.getByRole('button', { name: '+ Add' }).first().click();
  await page.getByText('Detailed task', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await page.locator('[id^="detail-notes-personal-"]').fill('A useful note');
  await page.locator('[id^="detail-notes-personal-"]').blur();
  await expect(page.getByText('A useful note')).toBeVisible();
  await page.reload();
  await completeSetup(page);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.getByText('Detailed task', { exact: true }).click();
  await expect(page.locator('[id^="detail-notes-personal-"]')).toHaveValue('A useful note');
});

test('filters tasks, supports keyboard actions, searches offline, and opens the command palette', async ({ page }) => {
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.locator('#task-in').first().fill('Keyboard target');
  await page.getByRole('button', { name: '+ Add' }).first().click();
  const task = page.locator('.task-item').filter({ hasText: 'Keyboard target' }).first();
  await task.focus();
  await page.keyboard.press('x');
  await page.locator('label').filter({ hasText: 'Completion' }).locator('select').selectOption('all');
  const completedTask = page.locator('.task-item').filter({ hasText: 'Keyboard target' }).first();
  await expect(completedTask).toHaveClass(/done/);
  await completedTask.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Task details' })).not.toBeVisible();

  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('dialog', { name: 'Search Outline' }).locator('input').fill('Keyboard target');
  await page.getByRole('dialog', { name: 'Search Outline' }).getByRole('button', { name: 'Keyboard target' }).click();
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Command palette' }).locator('input').fill('Go to Projects');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('previews and restores a browser backup', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('pvp_tasks', JSON.stringify([{ id: 'backup-task', title: 'Restored from backup', date: '2026-08-26', done: false, subtasks: [] }])));
  await page.getByRole('button', { name: 'Settings & Data' }).click();
  await page.getByRole('tab', { name: 'Storage' }).click();
  const backup = JSON.stringify({ schemaVersion: 1, savedAt: '2026-08-26T10:00:00.000Z', values: { pvp_tasks: JSON.stringify([]) } });
  await page.locator('#settings-import-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.getByRole('heading', { name: 'Review backup' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore backup' }).click();
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.getByText('Restored from backup')).not.toBeVisible();
});

test('keeps journal text and selected metrics after reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Journal' }).click();
  await page.locator('#journal-text-area').fill('A journal entry that must survive reload.');
  await page.locator('.j-capsule').filter({ hasText: 'Great' }).click();
  await page.reload();
  await completeSetup(page);
  await page.getByRole('button', { name: 'Journal' }).click();
  await expect(page.locator('#journal-text-area')).toHaveValue('A journal entry that must survive reload.');
  await expect(page.locator('.j-capsule.active')).toContainText('Great');
});

test('sets and rotates the encryption password through the UI', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings & Data' }).click();
  await page.getByRole('tab', { name: 'Security' }).click();
  await page.locator('#settings-first-password').fill('first password');
  await page.locator('#settings-confirm-first-password').fill('first password');
  await page.getByRole('button', { name: 'Enable encryption' }).click();
  await expect(page.getByText('Vault encryption enabled')).toBeVisible();
  await page.locator('#settings-new-password').fill('second password');
  await page.locator('#settings-confirm-password').fill('second password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('Password changed and vault re-encrypted')).toBeVisible();
});

test('keeps navigation usable on mobile and closes backup dialogs with Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings & Data' }).click();
  await page.getByRole('tab', { name: 'Storage' }).click();
  await page.locator('#settings-import-input').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, values: {} })) });
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
