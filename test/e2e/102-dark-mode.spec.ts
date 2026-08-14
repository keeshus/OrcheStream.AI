import { test, expect } from '@playwright/test';
import { createFlow, deleteFlow, uniqueFlowName } from './helpers/api';

// ─── Theme (dark mode) ────────────────────────────────────────────────────────
// The floating theme toggle (bottom-left) and the flow editor's theme button
// both flip the `.dark` class on <html> and persist to localStorage 'm3-theme'.
//
// NOTE: the E2E frontend runs `next dev`, whose dev-tools "toast" lives in a
// shadow DOM at the bottom-left corner and swallows pointer events aimed at the
// floating toggle. The toggle's click handler is therefore dispatched
// programmatically (the dev toast does not exist in production builds).

test.describe('Dark mode', () => {
  test('floating toggle switches theme, persists across reload, and flips back', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10000 });

    // Start from a known state (light)
    await page.evaluate(() => { localStorage.removeItem('m3-theme'); document.documentElement.classList.remove('dark'); });
    await page.reload();
    // Wait for the ThemeProvider mount effect to settle (it writes the
    // resolved initial theme to localStorage); dispatching the toggle before
    // that would get overridden.
    await expect.poll(async () => page.evaluate(() => localStorage.getItem('m3-theme')), { timeout: 10000 }).toBe('light');

    // Switch to dark via the floating toggle (bottom-left)
    // The dev-toast swallows real pointer events, so dispatch the click
    // handler directly (no such overlay in production builds).
    await expect(async () => {
      await page.evaluate(() => {
        const btn = document.querySelector('button[class*="bottom-6 left-6"]') as HTMLElement | null;
        if (!btn) throw new Error('theme toggle not mounted yet');
        const r = btn.getBoundingClientRect();
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
      });
    }).toPass({ timeout: 5000 });
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')), { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('m3-theme'))).toBe('dark');
    // The icon flips to light_mode
    await expect(page.locator('button[class*="bottom-6 left-6"] span.material-symbols-outlined')).toHaveText('light_mode');

    // Persisted across reload
    await page.reload();
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')), { timeout: 10000 }).toBe(true);

    // Toggle back to light
    await page.evaluate(() => {
      const btn = document.querySelector('button[class*="bottom-6 left-6"]') as HTMLElement | null;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
    });
    await expect.poll(async () => page.evaluate(() => !document.documentElement.classList.contains('dark')), { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('m3-theme'))).toBe('light');
  });

  test('flow editor theme button toggles dark mode', async ({ page, request }) => {
    const flowRes = await createFlow(request, { name: uniqueFlowName('DarkEditor') });
    const flow = await flowRes.json();

    await page.goto(`/flows/${flow.id}/edit`);
    await expect(page.getByTestId('flow-canvas')).toBeVisible({ timeout: 15000 });

    // Start light
    await page.evaluate(() => { localStorage.removeItem('m3-theme'); document.documentElement.classList.remove('dark'); });

    // The editor shows "Dark" in light mode; clicking it enables dark
    const darkBtn = page.getByRole('button', { name: /Dark/ });
    await expect(darkBtn).toBeVisible({ timeout: 5000 });
    await darkBtn.click();
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')), { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('m3-theme'))).toBe('dark');

    // The button label flips to "Light"; clicking restores light mode
    const lightBtn = page.getByRole('button', { name: /Light/ });
    await expect(lightBtn).toBeVisible({ timeout: 5000 });
    await lightBtn.click();
    await expect.poll(async () => page.evaluate(() => !document.documentElement.classList.contains('dark')), { timeout: 5000 }).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('m3-theme'))).toBe('light');

    await deleteFlow(request, flow.id);
  });
});
