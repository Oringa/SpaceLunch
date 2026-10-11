import { expect, test } from '@playwright/test';

/**
 * Browser smoke test against the production build served under /centrifuge/
 * (the same static output deployed to a sub-path). Exercises: first load,
 * prediction from the worker, a launch, fast-forward to the end, the
 * analysis view, view switching and a clean console.
 */
test('loads, predicts, launches and reports a solver result', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('./');
  await expect(page).toHaveTitle('CENTRIFUGE');
  await expect(page.getByText('Primary controls')).toBeVisible();
  // Prediction arrives from the prediction worker.
  await expect(page.getByText('Prediction (same solver)')).toBeVisible();
  await expect(page.locator('.preflight').getByText(/Apogee|Orbit|✖/)).toBeVisible({ timeout: 60_000 });
  // Renderer: a WebGL2 canvas or the 2D fallback is present.
  await expect(page.locator('.renderer-host canvas').first()).toBeVisible();
  // Launch within seconds of opening the app.
  await page.getByRole('button', { name: '▶ Launch' }).click();
  await expect(page.getByRole('tab', { name: 'Flight' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.clock .p')).toContainText(/Pump-down|Spin-up|Hold|Release|Free flight/, { timeout: 20_000 });
  await page.screenshot({ path: 'test-results/flight.png' });
  // Views
  for (const v of ['World', 'Orbit', 'Launcher']) {
    await page.getByRole('button', { name: v, exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/view-${v.toLowerCase()}.png` });
  }
  // Integrate to the end and read the analysis.
  await page.getByRole('button', { name: '⏭ end' }).click();
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.locator('.analysis')).toContainText('Last run', { timeout: 60_000 });
  await expect(page.locator('.analysis')).toContainText(/Apogee|Orbit/);
  await page.screenshot({ path: 'test-results/analysis.png', fullPage: true });
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('invalid configuration blocks launch with a visible diagnostic', async ({ page }) => {
  await page.goto('./');
  const radius = page.getByLabel('Effective arm radius', { exact: true });
  await radius.fill('99');
  await radius.press('Enter');
  await expect(page.getByRole('button', { name: /Fix \d+ error/ })).toBeVisible();
  await expect(page.getByText(/Chamber radius .* does not clear the vehicle/).first()).toBeVisible();
});
