import { expect, test, type Page } from '@playwright/test';

/**
 * Browser tests against the production build served under /centrifuge/ (the
 * same static output deployed to a sub-path).
 */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test('Play mode: home → mission 1 → launch → results with stars', async ({ page }) => {
  const errors = trackErrors(page);
  await expect(page).toHaveTitle('CENTRIFUGE');
  await expect(page.locator('.home-title')).toHaveText('CENTRIFUGE');
  await expect(page.locator('.renderer-host canvas').first()).toBeAttached();
  await page.getByRole('button', { name: /Start here/ }).click();
  await expect(page.locator('.dock')).toBeVisible();
  // The prediction comes from the prediction worker running the same solver.
  // Spoiler-free by default: the outcome is found by launching.
  await expect(page.locator('.prediction-pill')).toContainText('Launch to find out');
  await expect(page.locator('.minimap-cap')).toContainText('Launch to find out');
  // The forecast (same solver) is one click away.
  await page.getByRole('button', { name: /Forecast/ }).click();
  await expect(page.locator('.prediction-pill')).toContainText('Forecast: mission passes', { timeout: 60_000 });
  await expect(page.locator('.minimap-cap')).toContainText(/Lands .* km E of the launch site/, { timeout: 30_000 });
  await page.screenshot({ path: 'test-results/play-dock.png' });
  await page.locator('.launch-btn').click();
  await expect(page.locator('.hud-banner')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/play-hud.png' });
  await page.getByRole('button', { name: 'Skip to release' }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/play-release.png' });
  await page.getByRole('button', { name: 'Skip to end' }).click();
  await expect(page.getByRole('dialog', { name: 'Results' })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.results-stars .big-star.on').first()).toBeVisible();
  await expect(page.locator('.landing-line')).toContainText('Landed');
  await page.screenshot({ path: 'test-results/play-results.png' });
  await page.getByRole('button', { name: 'See it on the map' }).click();
  await expect(page.getByRole('dialog', { name: 'World map' })).toBeVisible();
  await expect(page.locator('.map-overlay canvas')).toBeVisible();
  await page.screenshot({ path: 'test-results/play-map.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'World map' })).toBeHidden();
  // Mission 2 unlocked after passing Mission 1.
  await page.getByRole('button', { name: 'Next mission →' }).click();
  await expect(page.locator('.dock-mission')).toContainText('Mission 2');
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('Engineer mode: full panels, prediction, launch, analysis, views', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Engineer mode/ }).click();
  await expect(page.getByText('Primary controls')).toBeVisible();
  await expect(page.locator('.preflight').getByText(/Apogee|Orbit|✖/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '▶ Launch' }).click();
  await expect(page.locator('.clock .p')).toContainText(/Pump-down|Spin-up|Hold|Release|Free flight/, { timeout: 20_000 });
  for (const v of ['World', 'Orbit', 'Map', 'Launcher']) {
    await page.getByRole('button', { name: v, exact: true }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/eng-view-${v.toLowerCase()}.png` });
  }
  await page.getByRole('button', { name: '⏭ end' }).click();
  await page.getByRole('tab', { name: 'Analysis' }).click();
  await expect(page.locator('.analysis')).toContainText('Last run', { timeout: 60_000 });
  await expect(page.locator('.analysis')).toContainText(/Apogee|Orbit/);
  await page.screenshot({ path: 'test-results/eng-analysis.png' });
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('Engineer mode: an invalid configuration blocks launch with a visible diagnostic', async ({ page }) => {
  await page.getByRole('button', { name: /Engineer mode/ }).click();
  const radius = page.getByLabel('Effective arm radius', { exact: true });
  await radius.fill('99');
  await radius.press('Enter');
  await expect(page.getByRole('button', { name: /Fix \d+ error/ })).toBeVisible();
  await expect(page.getByText(/Chamber radius .* does not clear the vehicle/).first()).toBeVisible();
});

test('Play mode: an over-the-top design launches and breaks instead of being refused', async ({ page }) => {
  const errors = trackErrors(page);
  await page.getByRole('button', { name: /Start here/ }).click();
  const speed = page.getByRole('slider', { name: 'Release speed' });
  await speed.evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, el.max);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('.dock-value').nth(1)).toContainText('4,000');
  await expect(page.locator('.launch-btn')).toBeEnabled();
  await page.locator('.launch-btn').click();
  await page.getByRole('button', { name: 'Skip to end' }).click();
  const stamp = page.locator('.fail-stamp');
  await expect(stamp).toBeVisible({ timeout: 60_000 });
  await expect(stamp).toContainText(/LAUNCH FAILED|LAUNCH ABORTED/);
  await page.screenshot({ path: 'test-results/play-fail-stamp.png' });
  // The stamp gives way to the results card on its own after a moment (or on tap).
  await expect(page.getByRole('dialog', { name: 'Results' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.results-stamp')).toBeVisible();
  await expect(page.locator('.results-tip')).toBeVisible();
  await page.screenshot({ path: 'test-results/play-fail-results.png' });
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});
