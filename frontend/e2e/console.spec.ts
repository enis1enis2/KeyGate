import { expect, test, type Page } from '@playwright/test';

const adminToken = process.env.KEYGATE_E2E_ADMIN_TOKEN ?? '';
const baseURL = process.env.KEYGATE_E2E_URL || 'http://127.0.0.1:3000';
const adminHeaders = { Authorization: `Bearer ${adminToken}` };

// These tests mutate the target instance (they create and then delete a gateway key),
// so only run them against a disposable deployment you own.
test.skip(!adminToken, 'Set KEYGATE_E2E_ADMIN_TOKEN to run the end-to-end suite.');

// A failed run can leave its key behind; clear leftovers so reruns stay deterministic.
test.beforeEach(async ({ request }) => {
  const response = await request.get(`${baseURL}/api/gateway-keys`, { headers: adminHeaders });
  if (!response.ok()) return;
  const keys = (await response.json()) as Array<{ id: string; name: string }>;
  for (const key of keys.filter((entry) => entry.name.startsWith('e2e-'))) {
    await request.delete(`${baseURL}/api/gateway-keys/${key.id}`, { headers: adminHeaders });
  }
});

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Admin token').fill(adminToken);
  await page.getByRole('button', { name: 'Unlock console' }).click();
  await expect(page.getByRole('heading', { name: 'System Health & Live Metrics' })).toBeVisible();
}

test('rejects a wrong token, then unlocks with the real one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Admin token required' })).toBeVisible();

  await page.getByLabel('Admin token').fill('definitely-not-the-token');
  await page.getByRole('button', { name: 'Unlock console' }).click();
  await expect(page.getByText('Invalid admin token.')).toBeVisible();

  await page.getByLabel('Admin token').fill(adminToken);
  await page.getByRole('button', { name: 'Unlock console' }).click();
  await expect(page.getByRole('heading', { name: 'System Health & Live Metrics' })).toBeVisible();
  await expect(page.getByText(/^Updated \d/)).toBeVisible();
});

test('navigates every console tab without crashing', async ({ page }) => {
  await login(page);

  const tabs: Array<[string, string]> = [
    ['Providers & Wizard', 'Declarative Providers & Wizard'],
    ['Upstream Keys', 'Upstream API Keys Pool'],
    ['Gateway Keys', 'Gateway Bearer Keys'],
  ];

  for (const [tab, heading] of tabs) {
    await page.getByRole('button', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
});

test('creates, revokes and deletes a gateway key through the UI', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Gateway Keys' }).click();

  const keyName = `e2e-${Date.now()}`;
  await page.getByRole('button', { name: 'Generate Gateway Key' }).click();

  const createDialog = page.getByRole('dialog', { name: 'Generate Gateway Bearer Token' });
  await expect(createDialog).toBeVisible();
  await createDialog.getByLabel('Key Name / Client ID:').fill(keyName);
  await createDialog.getByRole('button', { name: 'Generate Token' }).click();

  const revealDialog = page.getByRole('dialog', { name: 'Save Your Gateway Token Now' });
  await expect(revealDialog).toBeVisible();
  const token = (await revealDialog.getByText(/^kg-live[_-]/).innerText()).trim();
  expect(token).toMatch(/^kg-live[_-]/);
  await revealDialog.getByRole('button', { name: 'I Have Safely Saved It' }).click();

  const row = page.getByRole('row', { name: new RegExp(keyName) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();

  await row.getByRole('button', { name: 'Revoke' }).click();
  const revokeDialog = page.getByRole('dialog', { name: 'Revoke gateway key?' });
  await revokeDialog.getByRole('button', { name: 'Revoke' }).click();
  await expect(row.getByText('Revoked')).toBeVisible();

  await row.getByRole('button', { name: `Delete gateway key ${keyName}` }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete gateway key?' });
  await deleteDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('row', { name: new RegExp(keyName) })).toHaveCount(0);
});
