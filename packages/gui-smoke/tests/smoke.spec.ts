import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(here, '..', 'screenshots');

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
});

test('P1-A: Archon GUI smoke journey', async ({
  page,
  consoleErrors,
  networkFailures,
  tmpRepoPath,
}) => {
  // Step 1: Root → /chat redirect
  await page.goto('/');
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('link', { name: 'Chat' })).toBeVisible();

  // Step 2: Register the Archon repo via the Add-project flow.
  // The first-run state has no projects; the Plus button toggles the input.
  // If a previous smoke run already registered the repo (reuseExistingServer
  // for local dev) the option may already be present — tolerate either.
  const projectSelect = page.locator('select').first();
  const archonOption = projectSelect.locator('option:has-text("archon")').first();

  if (!(await archonOption.count())) {
    await page.getByTitle('Add project').click();
    const addInput = page.getByPlaceholder('GitHub URL or local path');
    await expect(addInput).toBeVisible();
    await addInput.fill(tmpRepoPath);
    await addInput.press('Enter');
    // The select repopulates after addCodebase resolves.
    await expect(projectSelect.locator('option').filter({ hasText: /./ })).toHaveCount(2, {
      timeout: 15_000,
    });
  }

  // Step 3: Send /help — deterministic, no LLM, no API key required.
  const messageInput = page.getByPlaceholder('Message Archon...');
  await expect(messageInput).toBeVisible({ timeout: 10_000 });
  await messageInput.fill('/help');
  await messageInput.press('Enter');

  // The /help response includes the literal string "Archon Orchestrator"
  // (see packages/core/src/handlers/command-handler.ts case 'help').
  await expect(page.getByText('Archon Orchestrator').first()).toBeVisible({ timeout: 30_000 });

  // Step 4: Dashboard
  await page.getByRole('link', { name: 'Dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Mission Control' })).toBeVisible();

  // Step 5: Workflows
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  const newWorkflowLink = page.getByRole('link', { name: /New Workflow/ });
  await expect(newWorkflowLink).toBeVisible();

  // Step 6: Workflow Builder
  await newWorkflowLink.click();
  await expect(page).toHaveURL(/\/workflows\/builder$/);
  // Outermost wrapper for WorkflowBuilder always renders this resize-handle
  // panel button regardless of XYFlow canvas mount latency.
  await expect(page.getByLabel('Resize node library panel')).toBeVisible({ timeout: 10_000 });

  // Step 7: Final screenshot for evidence (always, even if later assertions fail).
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, 'p1a-final.png'),
    fullPage: true,
  });

  // Step 8: Sanity-check the captured arrays before fixture finalizers run.
  expect(
    consoleErrors,
    `Unexpected console errors:\n${JSON.stringify(consoleErrors, null, 2)}`
  ).toEqual([]);
  expect(
    networkFailures,
    `Unexpected network failures:\n${JSON.stringify(networkFailures, null, 2)}`
  ).toEqual([]);
});
