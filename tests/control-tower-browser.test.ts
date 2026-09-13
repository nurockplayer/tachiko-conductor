import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { chromium } from 'playwright';

const port = 1427;
const origin = `http://127.0.0.1:${port}`;

async function waitForFixture(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Vite has not bound its local test port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Control Tower fixture server did not start');
}

test('Control Tower filter buttons update the rendered work list', async (t) => {
  const vite = spawn(process.execPath, ['../../node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: new URL('../apps/control-tower/', import.meta.url).pathname,
    stdio: 'ignore',
  });
  t.after(() => vite.kill('SIGTERM'));
  await waitForFixture();

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
  await page.goto(origin);

  await page.getByRole('button', { name: 'Codex 執行中' }).click();
  assert.equal(await page.locator('.status-line').textContent(), '目前顯示 2 個 Codex 執行中工作。');
  assert.equal(await page.locator('tbody tr').count(), 2);

  await page.getByRole('button', { name: '可回收' }).click();
  assert.equal(await page.locator('.status-line').textContent(), '目前顯示 2 個可回收 worktree。');
  assert.equal(await page.locator('tbody tr').count(), 2);
});
