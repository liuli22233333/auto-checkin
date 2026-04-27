import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

import { buildConfig } from '../src/config.js';
import { loadDotEnv } from '../src/utils/load-dotenv.js';

const execFileAsync = promisify(execFile);

async function findVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return locator.first();
}

async function clearInput(target) {
  await target.click();
  await target.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await target.press('Backspace');
}

async function imeCommitInput(target, value) {
  await target.evaluate((element, nextValue) => {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    const setValue = (value) => {
      if (descriptor?.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
    };

    element.focus();
    element.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
      cancelable: true,
      data: '',
    }));
    element.dispatchEvent(new CompositionEvent('compositionupdate', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
    }));
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
      inputType: 'insertCompositionText',
      isComposing: true,
    }));

    setValue(nextValue);

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertCompositionText',
      isComposing: true,
    }));
    element.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
    }));
    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
      inputType: 'insertFromComposition',
      isComposing: false,
    }));
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertFromComposition',
      isComposing: false,
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function escapeSendKeys(value) {
  return value.replace(/[+^%~()[\]{}]/g, (char) => `{${char}}`);
}

function escapePowerShellSingleQuoted(value) {
  return value.replace(/'/g, "''");
}

async function setWindowsClipboardText(value) {
  const script = `Set-Clipboard -Value '${escapePowerShellSingleQuoted(value)}'`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', script], {
    windowsHide: true,
  });
}

async function pasteTextInput(page, target, value, browserConfig) {
  await setWindowsClipboardText(value);
  await clearInput(target);
  await page.waitForTimeout(150);
  await target.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');

  if (browserConfig.loginPasteSettleMs > 0) {
    await page.waitForTimeout(browserConfig.loginPasteSettleMs);
  }
}

async function nativeImeInput(page, target, value, browserConfig) {
  await clearInput(target);
  await page.waitForTimeout(300);
  await target.click();
  await page.bringToFront();

  const imeText = browserConfig.loginImeText || value;
  const sendKeysText = escapeSendKeys(imeText);
  const commitKey = browserConfig.loginImeCommitKey
    ? `{${browserConfig.loginImeCommitKey}}`
    : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NativeWindow {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@`,
    `$title = '${(browserConfig.loginWindowTitle || '').replace(/'/g, "''")}'`,
    '$target = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and ($title -eq "" -or $_.MainWindowTitle -like "*$title*") } | Select-Object -First 1',
    'if (-not $target) { $target = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }',
    'if ($target) { Write-Output ("native_ime_target_title=" + $target.MainWindowTitle) } else { Write-Output "native_ime_target_title=<none>" }',
    'if ($target) { [NativeWindow]::ShowWindowAsync($target.MainWindowHandle, 9) | Out-Null; [NativeWindow]::SetForegroundWindow($target.MainWindowHandle) | Out-Null }',
    'Start-Sleep -Milliseconds 700',
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKeysText.replace(/'/g, "''")}')`,
    'Start-Sleep -Milliseconds 200',
    commitKey
      ? `[System.Windows.Forms.SendKeys]::SendWait('${commitKey.replace(/'/g, "''")}')`
      : '',
    '[System.Windows.Forms.SendKeys]::Flush()',
  ].filter(Boolean).join('; ');

  const result = await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-Command', script], {
    windowsHide: true,
  });
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }
  await page.waitForTimeout(browserConfig.loginFieldSettleMs);
}

async function humanTypeInput(page, target, value, browserConfig) {
  await clearInput(target);

  if (browserConfig.loginInputMode === 'paste-twice') {
    await pasteTextInput(page, target, value, browserConfig);
    return;
  }

  if (browserConfig.loginInputMode === 'native-ime' && /[^\x00-\x7F]/.test(value)) {
    await nativeImeInput(page, target, value, browserConfig);
    return;
  }

  if (browserConfig.loginInputMode === 'ime') {
    await imeCommitInput(target, value);
    if (browserConfig.loginTypeDelayMs > 0) {
      await page.waitForTimeout(browserConfig.loginTypeDelayMs);
    }
    return;
  }

  let currentValue = '';
  for (const char of Array.from(value)) {
    currentValue += char;
    await target.evaluate((element, args) => {
      const { nextValue, inputChar } = args;
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      element.dispatchEvent(new CompositionEvent('compositionupdate', {
        bubbles: true,
        data: inputChar,
      }));
      element.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: inputChar,
        inputType: 'insertCompositionText',
      }));

      if (descriptor?.set) {
        descriptor.set.call(element, nextValue);
      } else {
        element.value = nextValue;
      }

      element.dispatchEvent(new CompositionEvent('compositionend', {
        bubbles: true,
        data: inputChar,
      }));
      element.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: inputChar,
        inputType: 'insertText',
      }));
      element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: inputChar }));
    }, { nextValue: currentValue, inputChar: char });

    if (browserConfig.loginTypeDelayMs > 0) {
      await page.waitForTimeout(browserConfig.loginTypeDelayMs);
    }
  }

  await target.evaluate((element) => {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function fillVisibleInputAt(page, index, value, browserConfig) {
  const inputs = page.locator('input');
  const visibleInputs = [];
  const count = await inputs.count();

  for (let i = 0; i < count; i += 1) {
    const candidate = inputs.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      visibleInputs.push(candidate);
    }
  }

  const target = visibleInputs[index];
  if (!target) {
    throw new Error(`visible input not found at index ${index}`);
  }

  await humanTypeInput(page, target, value, browserConfig);
  return target;
}

async function waitForStudentNameInput(page, browserConfig) {
  const secondInput = await findVisible(page.locator('input').nth(1));
  await secondInput.click();

  await page.waitForFunction(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.some((input) => {
      const rect = input.getBoundingClientRect();
      const style = window.getComputedStyle(input);
      const visible = rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';
      return visible && (input.getAttribute('placeholder') || '').includes('姓名');
    });
  }, null, { timeout: browserConfig.timeoutMs });

  if (browserConfig.loginNameReadySettleMs > 0) {
    await page.waitForTimeout(browserConfig.loginNameReadySettleMs);
  }

  return findVisible(page.locator('input[placeholder*="姓名"]'));
}

async function inputValue(target) {
  return target.inputValue().catch(() => '');
}

async function fillNameInput(page, value, browserConfig) {
  if (browserConfig.loginInputMode === 'paste-twice') {
    const firstTarget = await findVisible(page.locator('input').nth(1));
    await pasteTextInput(page, firstTarget, value, browserConfig);
    await firstTarget.click();
  }

  const target = await waitForStudentNameInput(page, browserConfig);
  await humanTypeInput(page, target, value, browserConfig);

  if ((await inputValue(target)) === value) {
    return target;
  }

  await clearInput(target);
  await imeCommitInput(target, value);
  return target;
}

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

async function visibleInputSnapshot(page, label) {
  const snapshot = await page.locator('input').evaluateAll((inputs) =>
    inputs
      .filter((input) => {
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      })
      .map((input, index) => ({
        index,
        type: input.getAttribute('type') || '',
        name: input.getAttribute('name') || '',
        placeholder: input.getAttribute('placeholder') || '',
        value: input.value || '',
        className: input.className || '',
        readonly: input.readOnly,
        disabled: input.disabled,
      })),
  );
  console.log(`${label}=${JSON.stringify(snapshot)}`);
}

async function main() {
  await loadDotEnv('.env');
  const config = await buildConfig();
  const holdMs = Number(process.env.FILL_LOGIN_HOLD_MS || 30_000);
  const shouldClickLogin = process.argv.includes('--click-login');

  const browser = await chromium.launch(launchOptions(config.browser));
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.timeoutMs);

  await page.goto(config.site.login.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(config.site.login.usernameSelector, {
    state: 'visible',
    timeout: config.browser.timeoutMs,
  });
  await page.waitForSelector(config.site.login.passwordSelector, {
    state: 'visible',
    timeout: config.browser.timeoutMs,
  });
  await visibleInputSnapshot(page, 'inputs_initial');
  const usernameInput = await fillVisibleInputAt(page, 0, config.username, config.browser);
  await visibleInputSnapshot(page, 'inputs_after_username');
  await page.waitForTimeout(config.browser.loginFieldSettleMs);
  await visibleInputSnapshot(page, 'inputs_after_username_settle');
  const nameInput = await fillNameInput(page, config.password, config.browser);
  await visibleInputSnapshot(page, 'inputs_after_name');

  const usernameValue = await usernameInput.inputValue();
  const nameValue = await nameInput.inputValue();

  await page.waitForTimeout(Number(process.env.FILL_LOGIN_VERIFY_DELAY_MS || 3000));

  const usernameValueAfterDelay = await usernameInput.inputValue();
  const nameValueAfterDelay = await nameInput.inputValue();

  if (shouldClickLogin) {
    await page.click(config.site.login.submitSelector);
    await page.waitForLoadState('networkidle', { timeout: config.browser.timeoutMs }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  await fs.mkdir(config.screenshotDir, { recursive: true });
  const screenshotPrefix = shouldClickLogin ? 'login-only' : 'fill-login-only';
  const screenshotPath = path.join(config.screenshotDir, `${screenshotPrefix}-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(`filled_login_only=true`);
  console.log(`clicked_login=${shouldClickLogin}`);
  console.log(`username_value=${usernameValue}`);
  console.log(`name_value=${nameValue}`);
  console.log(`name_length=${nameValue.length}`);
  console.log(`username_value_after_delay=${usernameValueAfterDelay}`);
  console.log(`name_value_after_delay=${nameValueAfterDelay}`);
  console.log(`name_length_after_delay=${nameValueAfterDelay.length}`);
  console.log(`current_url=${page.url()}`);
  console.log(`screenshot=${screenshotPath}`);
  console.log(`hold_ms=${holdMs}`);

  await page.waitForTimeout(holdMs);
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
