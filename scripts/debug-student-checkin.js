import fs from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';

import { buildConfig } from '../src/config.js';
import { loadDotEnv } from '../src/utils/load-dotenv.js';

function launchOptions(browserConfig) {
  const options = {
    headless: browserConfig.headless,
    slowMo: browserConfig.slowMoMs,
  };
  if (browserConfig.channel) {
    options.channel = browserConfig.channel;
  }
  return options;
}

async function clickFirstVisible(page, selector) {
  const matches = page.locator(selector);
  const count = await matches.count();
  for (let i = 0; i < count; i += 1) {
    const item = matches.nth(i);
    if (await item.isVisible().catch(() => false)) {
      await item.click();
      return i;
    }
  }
  throw new Error(`No visible match for ${selector}`);
}

async function snapshot(page, label, screenshotDir) {
  await fs.mkdir(screenshotDir, { recursive: true });
  const screenshotPath = path.join(screenshotDir, `debug-${label}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const text = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 2000);
  console.log(`${label}_url=${page.url()}`);
  console.log(`${label}_screenshot=${screenshotPath}`);
  console.log(`${label}_text=${JSON.stringify(text)}`);
}

async function main() {
  await loadDotEnv('.env');
  const config = await buildConfig();

  const browser = await chromium.launch(launchOptions(config.browser));
  const page = await browser.newPage();
  page.setDefaultTimeout(config.browser.timeoutMs);

  await page.goto(config.site.login.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(config.site.login.usernameSelector, { state: 'visible' });

  await page.locator(config.site.login.usernameSelector).first().fill(config.username);
  await page.waitForTimeout(config.browser.loginFieldSettleMs);

  const secondInput = page.locator('input').nth(1);
  await secondInput.fill(config.password);
  await page.waitForTimeout(config.browser.loginPasteSettleMs);
  await secondInput.click();
  await page.waitForSelector('input[placeholder*="姓名"]', { state: 'visible' });
  await page.locator('input[placeholder*="姓名"]').first().fill(config.password);
  await page.click(config.site.login.submitSelector);
  await page.waitForLoadState('networkidle', { timeout: config.browser.timeoutMs }).catch(() => {});
  await page.waitForTimeout(2000);

  await snapshot(page, 'after-login', config.screenshotDir);
  await clickFirstVisible(page, '.checkin-btn:has(span:has-text("在校")), .checkin-btn:has-text("在校"), div:has(> span:text-is("在校"))');
  await page.waitForTimeout(1000);
  await snapshot(page, 'after-in-school', config.screenshotDir);
  await clickFirstVisible(page, 'role=button[name="提交打卡"], .el-button:has-text("提交打卡"), button:has-text("提交打卡")');
  await page.waitForTimeout(3000);
  await snapshot(page, 'after-submit-click', config.screenshotDir);

  await page.waitForTimeout(Number(process.env.FILL_LOGIN_HOLD_MS || 30_000));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
