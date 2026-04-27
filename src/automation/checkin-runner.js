import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { chromium } from 'playwright';

import { computeBackoffMs, executeWithRetry } from '../core/retry-executor.js';
import { sleep } from '../utils/sleep.js';
import { FatalError, RecoverableError, isRecoverable, normalizeError } from './errors.js';
import { resolveSubmitActions } from './submit-actions.js';

const execFileAsync = promisify(execFile);

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 60);
}

async function selectorVisible(page, selector, timeout = 1200) {
  if (!selector) return false;
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function expectVisible(page, selector, label, timeout = 12_000) {
  if (!selector) {
    throw new FatalError(`缺少必要选择器: ${label}`);
  }

  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
  } catch (error) {
    throw new FatalError(`未找到必要元素(${label})，疑似页面结构变更`, error);
  }
}

async function findVisibleLocator(page, selector) {
  const matches = page.locator(selector);
  const count = await matches.count();

  for (let i = 0; i < count; i += 1) {
    const candidate = matches.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return matches.first();
}

async function findVisibleInputAt(page, index) {
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
    throw new FatalError(`未找到第 ${index + 1} 个可见登录输入框`);
  }

  return target;
}

async function waitForStudentNameInput(page, browserConfig) {
  const secondInput = await findVisibleInputAt(page, 1);
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
    await sleep(browserConfig.loginNameReadySettleMs);
  }

  return findVisibleLocator(page, 'input[placeholder*="姓名"]');
}

async function clearInput(locator) {
  await locator.click();
  await locator.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await locator.press('Backspace');
}

async function imeCommitInput(locator, value) {
  await locator.evaluate((element, nextValue) => {
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

async function pasteTextInput(page, locator, value, browserConfig) {
  await setWindowsClipboardText(value);
  await clearInput(locator);
  await page.waitForTimeout(150);
  await locator.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');

  if (browserConfig.loginPasteSettleMs > 0) {
    await page.waitForTimeout(browserConfig.loginPasteSettleMs);
  }
}

async function nativeImeInput(page, locator, value, browserConfig) {
  await clearInput(locator);
  await page.waitForTimeout(300);
  await locator.click();
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
    'if ($target) { [NativeWindow]::ShowWindowAsync($target.MainWindowHandle, 9) | Out-Null; [NativeWindow]::SetForegroundWindow($target.MainWindowHandle) | Out-Null }',
    'Start-Sleep -Milliseconds 700',
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKeysText.replace(/'/g, "''")}')`,
    'Start-Sleep -Milliseconds 200',
    commitKey
      ? `[System.Windows.Forms.SendKeys]::SendWait('${commitKey.replace(/'/g, "''")}')`
      : '',
    '[System.Windows.Forms.SendKeys]::Flush()',
  ].filter(Boolean).join('; ');

  await execFileAsync('powershell.exe', ['-STA', '-NoProfile', '-Command', script], {
    windowsHide: true,
  });
  await page.waitForTimeout(browserConfig.loginFieldSettleMs);
}

async function inputValue(locator) {
  return locator.inputValue().catch(() => '');
}

async function humanTypeInput(page, selector, value, browserConfig) {
  const locator = await findVisibleLocator(page, selector);

  await clearInput(locator);

  if (browserConfig.loginInputMode === 'native-ime' && /[^\x00-\x7F]/.test(value)) {
    await nativeImeInput(page, locator, value, browserConfig);
    return locator;
  }

  if (browserConfig.loginInputMode === 'ime') {
    await imeCommitInput(locator, value);
    if (browserConfig.loginTypeDelayMs > 0) {
      await sleep(browserConfig.loginTypeDelayMs);
    }
    return locator;
  }

  let currentValue = '';
  for (const char of Array.from(value)) {
    currentValue += char;
    await locator.evaluate((element, args) => {
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
      await sleep(browserConfig.loginTypeDelayMs);
    }
  }

  await locator.evaluate((element) => {
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });

  return locator;
}

async function humanTypeIntoLocator(page, locator, value, browserConfig) {
  await clearInput(locator);

  if (browserConfig.loginInputMode === 'paste-twice') {
    await pasteTextInput(page, locator, value, browserConfig);
    return locator;
  }

  if (browserConfig.loginInputMode === 'native-ime' && /[^\x00-\x7F]/.test(value)) {
    await nativeImeInput(page, locator, value, browserConfig);
    if ((await inputValue(locator)) === value) {
      return locator;
    }
    await clearInput(locator);
    await imeCommitInput(locator, value);
    return locator;
  }

  if (browserConfig.loginInputMode === 'ime') {
    await imeCommitInput(locator, value);
    return locator;
  }

  for (const char of Array.from(value)) {
    await locator.pressSequentially(char, { delay: browserConfig.loginTypeDelayMs });
  }

  return locator;
}

async function dragElementByDistance(page, selector, distance, steps = 30) {
  const locator = page.locator(selector).first();
  const box = await locator.boundingBox();
  if (!box) {
    throw new RecoverableError(`滑块元素不可见或无法获取位置: ${selector}`);
  }

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  // 曲线抖动轨迹生成
  function generateCurveTrack(distance, steps) {
    const track = [];
    let x = 0, y = 0;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      // 贝塞尔曲线加速-减速
      const ease = 3 * t * t - 2 * t * t * t;
      // y轴微抖动
      const jitter = (Math.random() - 0.5) * 2;
      x = Math.round(distance * ease);
      y = Math.round(jitter * 2);
      track.push({ x, y });
    }
    // 去重，保证每步都移动
    return track.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
  }

  const track = generateCurveTrack(distance, steps);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (const point of track) {
    await page.mouse.move(startX + point.x, startY + point.y, { steps: 1 });
    await page.waitForTimeout(8 + Math.random() * 8); // 8~16ms 间隔
  }
  await page.mouse.up();
}

async function dragTrackByText(page, text, distance, steps = 30) {
  const target = page.getByText(text, { exact: true }).first();
  await target.waitFor({ state: 'visible' });

  const handle = await target.elementHandle();
  if (!handle) {
    throw new FatalError(`未找到滑块轨道文本: ${text}`);
  }

  const trackBox = await handle.evaluate((element) => {
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const rect = current.getBoundingClientRect();
      const style = window.getComputedStyle(current);
      const visible = rect.width > 0
        && rect.height > 0
        && style.visibility !== 'hidden'
        && style.display !== 'none';

      if (visible && rect.width >= 250 && rect.height >= 35 && rect.height <= 80) {
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }

      current = current.parentElement;
    }

    const rect = element.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  });

  const startX = trackBox.x + 18;
  const startY = trackBox.y + trackBox.height / 2;

  // 曲线抖动轨迹生成（更拟人）
  function generateCurveTrack(distance, steps) {
    const track = [];
    let x = 0, y = 0;
    let lastX = 0;
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      // 三次贝塞尔加减速，前慢中快后慢
      const ease = 6 * t * t * t - 9 * t * t + 4 * t;
      // y轴微抖动
      const jitter = (Math.random() - 0.5) * 2;
      x = Math.round(distance * ease);
      // 保证每步都前进
      if (x <= lastX) x = lastX + 1;
      lastX = x;
      y = Math.round(jitter * 2);
      track.push({ x, y });
    }
    // 去重，保证每步都移动
    return track.filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x);
  }

  const track = generateCurveTrack(distance, steps);

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let i = 0; i < track.length; i++) {
    const point = track[i];
    await page.mouse.move(startX + point.x, startY + point.y, { steps: 1 });
    // 前慢后慢中间快，停顿时间动态调整
    let base = 18;
    if (i < 3 || i > track.length - 4) base = 32 + Math.random() * 16; // 起步和结尾更慢
    else if (i > track.length / 2 - 3 && i < track.length / 2 + 3) base = 8 + Math.random() * 6; // 中段最快
    else base = 14 + Math.random() * 10;
    await page.waitForTimeout(base);
    // 偶尔短暂停顿
    if (Math.random() < 0.08) await page.waitForTimeout(60 + Math.random() * 60);
  }
  await page.mouse.up();
}

async function clickExactTextCard(page, text) {
  const matches = page.getByText(text, { exact: true });
  await matches.first().waitFor({ state: 'visible' });

  const count = await matches.count();
  let target = null;
  let targetBox = null;

  for (let i = 0; i < count; i += 1) {
    const candidate = matches.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const box = await candidate.boundingBox();
    if (!box) continue;

    // Prefer the status card in the "今日打卡" panel, not historical table tags.
    if (box.y < 520 && box.x > 250) {
      target = candidate;
      targetBox = box;
      break;
    }
  }

  if (!target) {
    target = matches.first();
    targetBox = await target.boundingBox();
  }

  const handle = await target.elementHandle();
  if (!handle) {
    throw new FatalError(`未找到精确文本元素: ${text}`);
  }

  const point = await handle.evaluate((element) => {
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1) {
      const textContent = (current.textContent || '').replace(/\s+/g, '');
      const rect = current.getBoundingClientRect();
      const hasOnlyInSchool = textContent === '在校' || textContent.includes('在校') && !textContent.includes('不在校');
      if (hasOnlyInSchool && rect.width >= 80 && rect.height >= 80) {
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        };
      }
      current = current.parentElement;
    }

    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  });

  await page.mouse.click(point.x, point.y);

  const selected = await page.waitForFunction(() => {
    const labels = Array.from(document.querySelectorAll('*')).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 80
        && rect.height > 80
        && (element.textContent || '').replace(/\s+/g, '') === '在校';
    });
    return labels.some((element) => {
      const style = window.getComputedStyle(element);
      return style.borderColor.includes('64, 158, 255')
        || style.backgroundColor.includes('236, 245, 255')
        || element.className.toString().includes('active')
        || element.className.toString().includes('selected');
    });
  }, null, { timeout: 1500 }).then(() => true).catch(() => false);

  if (!selected) {
    const fallbackX = targetBox ? targetBox.x + targetBox.width / 2 : point.x;
    const fallbackY = targetBox ? targetBox.y - 45 : point.y - 35;
    await page.mouse.click(fallbackX, fallbackY);
  }
}

async function clickExactTextOffset(page, text, offsetX = 0, offsetY = 0) {
  const matches = page.getByText(text, { exact: true });
  await matches.first().waitFor({ state: 'visible' });

  const count = await matches.count();
  let box = null;

  for (let i = 0; i < count; i += 1) {
    const candidate = matches.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    const candidateBox = await candidate.boundingBox();
    if (!candidateBox) continue;

    if (candidateBox.y < 520 && candidateBox.x > 250) {
      box = candidateBox;
      break;
    }
  }

  if (!box) {
    box = await matches.first().boundingBox();
  }

  if (!box) {
    throw new FatalError(`未找到可点击文本位置: ${text}`);
  }

  await page.mouse.click(
    box.x + box.width / 2 + offsetX,
    box.y + box.height / 2 + offsetY,
  );
}

async function gotoPage(page, url, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    throw new RecoverableError(`访问页面失败(${label}): ${url}`, error);
  }
}

async function captureFailureScreenshot({ page, screenshotDir, runId, attempt, step }) {
  if (!page || page.isClosed()) {
    return null;
  }

  await fs.mkdir(screenshotDir, { recursive: true });
  const filename = `${slug(runId)}-a${attempt}-${slug(step)}-${Date.now()}.png`;
  const fullPath = path.join(screenshotDir, filename);

  try {
    await page.screenshot({ path: fullPath, fullPage: true });
    return fullPath;
  } catch {
    return null;
  }
}

async function ensureLoggedIn({ page, config, logger, runId }) {
  const { site, username, password, browser } = config;
  const auth = site.auth || {};

  await gotoPage(page, site.login.url, 'login');

  if (await selectorVisible(page, auth.loggedInSelector, 1500)) {
    await logger.info('login_skip_already_logged_in', { run_id: runId });
    return 'already_logged_in';
  }

  await expectVisible(page, site.login.usernameSelector, 'login.usernameSelector', browser.timeoutMs);
  await expectVisible(page, site.login.passwordSelector, 'login.passwordSelector', browser.timeoutMs);
  await expectVisible(page, site.login.submitSelector, 'login.submitSelector', browser.timeoutMs);

  await humanTypeInput(page, site.login.usernameSelector, username, browser);
  if (browser.loginFieldSettleMs > 0) {
    await sleep(browser.loginFieldSettleMs);
  }
  if (/[^\x00-\x7F]/.test(password)) {
    if (browser.loginInputMode === 'paste-twice') {
      const secondInput = await findVisibleInputAt(page, 1);
      await pasteTextInput(page, secondInput, password, browser);
    }

    const nameInput = await waitForStudentNameInput(page, browser);
    await humanTypeIntoLocator(page, nameInput, password, browser);
  } else {
    await humanTypeInput(page, site.login.passwordSelector, password, browser);
  }
  if (browser.loginFieldSettleMs > 0) {
    await sleep(browser.loginFieldSettleMs);
  }
  await page.click(site.login.submitSelector);

  await page.waitForLoadState('networkidle', { timeout: browser.timeoutMs }).catch(() => {});

  if (await selectorVisible(page, auth.loginErrorSelector, 1200)) {
    throw new FatalError('登录失败：检测到登录错误提示，请检查账号密码');
  }

  if (auth.loginFailedPattern) {
    const bodyText = (await page.textContent('body')) || '';
    const failed = new RegExp(auth.loginFailedPattern, 'i').test(bodyText);
    if (failed) {
      throw new FatalError('登录失败：匹配到登录失败文案，请检查账号密码');
    }
  }

  if (auth.loggedInSelector) {
    const loggedIn = await selectorVisible(page, auth.loggedInSelector, browser.timeoutMs);
    if (!loggedIn) {
      throw new RecoverableError('登录后未检测到已登录标记');
    }
  } else {
    const stillOnLogin = await selectorVisible(page, site.login.usernameSelector, 2000);
    if (stillOnLogin) {
      throw new FatalError('登录后仍停留在登录页，疑似凭据错误或页面结构变化');
    }
  }

  await logger.info('login_success', { run_id: runId });
  return 'logged_in';
}

async function waitCheckinOutcome({
  page,
  alreadyDoneSelector,
  successSelector,
  timeoutMs,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await selectorVisible(page, alreadyDoneSelector, 400)) {
      return 'already_done';
    }

    if (successSelector && (await selectorVisible(page, successSelector, 400))) {
      return 'submitted';
    }

    await sleep(300);
  }

  if (!successSelector && (await selectorVisible(page, alreadyDoneSelector, 1200))) {
    return 'submitted';
  }

  throw new RecoverableError('提交后未检测到成功状态', undefined, {
    retryable: true,
    reason: 'checkin_outcome_missing',
  });
}

async function runCheckinStep({
  page,
  runId,
  logger,
  siteNode,
  stepName,
  browserTimeoutMs,
  actionBufferMs,
}) {
  await gotoPage(page, siteNode.url, stepName);

  if (await selectorVisible(page, siteNode.alreadyDoneSelector, 1500)) {
    await logger.info('checkin_already_done', { run_id: runId, step: stepName });
    return { step: stepName, status: 'already_done' };
  }

  const submitActions = resolveSubmitActions(siteNode, stepName);

  for (let i = 0; i < submitActions.length; i += 1) {
    const action = submitActions[i];
    const actionLabel = `${stepName}.submitSequence[${i}]`;

    if (actionBufferMs > 0) {
      await sleep(actionBufferMs);
    }

    await expectVisible(page, action.selector, `${actionLabel}.selector`, browserTimeoutMs);

    if (action.type === 'drag') {
      await dragElementByDistance(
        page,
        action.selector,
        action.distance,
        action.steps || 30,
      );
    } else if (action.type === 'dragTrackByText') {
      await dragTrackByText(
        page,
        action.text,
        action.distance,
        action.steps || 30,
      );
    } else if (action.type === 'clickExactTextCard') {
      await clickExactTextCard(page, action.text);
    } else if (action.type === 'clickExactTextOffset') {
      await clickExactTextOffset(page, action.text, action.offsetX || 0, action.offsetY || 0);
    } else {
      await page.click(action.selector);
    }

    if (action.confirmSelector && (await selectorVisible(page, action.confirmSelector, 1500))) {
      await page.click(action.confirmSelector);
    }

    if (action.waitForSelector) {
      await expectVisible(
        page,
        action.waitForSelector,
        `${actionLabel}.waitForSelector`,
        browserTimeoutMs,
      );
    }

    if (action.waitMs && action.waitMs > 0) {
      await sleep(action.waitMs);
    }
  }

  if (actionBufferMs > 0) {
    await sleep(actionBufferMs);
  }

  const outcome = await waitCheckinOutcome({
    page,
    alreadyDoneSelector: siteNode.alreadyDoneSelector,
    successSelector: siteNode.successSelector,
    timeoutMs: browserTimeoutMs,
  });

  await logger.info('checkin_step_done', { run_id: runId, step: stepName, outcome });
  return { step: stepName, status: outcome };
}

async function checkStepDoneOnly({ page, runId, logger, siteNode, stepName }) {
  await gotoPage(page, siteNode.url, stepName);
  const done = await selectorVisible(page, siteNode.alreadyDoneSelector, 1500);
  const status = done ? 'already_done' : 'not_done';
  await logger.info('checkin_precheck', {
    run_id: runId,
    step: stepName,
    status,
  });
  return { step: stepName, status };
}

function makeLaunchOptions(browserConfig) {
  const launchOptions = {
    headless: browserConfig.headless,
    slowMo: browserConfig.slowMoMs,
  };

  if (browserConfig.channel) {
    launchOptions.channel = browserConfig.channel;
  }

  return launchOptions;
}

async function runSingleAttempt({ config, runId, attempt, logger }) {
  const browser = await chromium.launch(makeLaunchOptions(config.browser));

  let page = null;

  try {
    const context = await browser.newContext();
    page = await context.newPage();
    page.setDefaultTimeout(config.browser.timeoutMs);

    // 注入反自动化检测脚本
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    await logger.info('attempt_start', {
      run_id: runId,
      attempt,
    });

    await ensureLoggedIn({ page, config, logger, runId });

    const summary = {};

    for (const stepName of config.checkinSteps) {
      summary[stepName] = await runCheckinStep({
        page,
        runId,
        logger,
        siteNode: config.site[stepName],
        stepName,
        browserTimeoutMs: config.browser.timeoutMs,
        actionBufferMs: config.browser.actionBufferMs,
      });
    }

    return summary;
  } catch (error) {
    const normalized = normalizeError(error);
    const screenshotPath = await captureFailureScreenshot({
      page,
      screenshotDir: config.screenshotDir,
      runId,
      attempt,
      step: 'attempt_failed',
    });

    if (screenshotPath) {
      normalized.screenshotPath = screenshotPath;
    }

    throw normalized;
  } finally {
    await browser.close();
  }
}

export async function runCheckinWithRetries({
  config,
  runId,
  logger,
}) {
  const result = await executeWithRetry({
    runAttempt: ({ attempt }) => runSingleAttempt({ config, runId, attempt, logger }),
    isRecoverable,
    maxAttempts: Math.min(config.retry.maxAttempts, 3),
    backoffMs: () =>
      computeBackoffMs({
        minMs: config.retry.backoffMinMs,
        maxMs: config.retry.backoffMaxMs,
      }),
    sleep,
  });

  if (result.status !== 'success') {
    await logger.warn('run_failed', {
      run_id: runId,
      status: result.status,
      attempts: result.attempts,
      error: result.error,
      screenshot_path: result.error?.screenshotPath,
    });
    return result;
  }

  await logger.info('run_success', {
    run_id: runId,
    attempts: result.attempts,
    ...Object.fromEntries(
      Object.entries(result.result).map(([stepName, step]) => [stepName, step.status]),
    ),
  });

  return {
    ...result,
    summary: Object.fromEntries(
      Object.entries(result.result).map(([stepName, step]) => [stepName, step.status]),
    ),
  };
}

export async function checkCheckinCompleted({
  config,
  runId,
  logger,
}) {
  const browser = await chromium.launch(makeLaunchOptions(config.browser));

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(config.browser.timeoutMs);

    // 注入反自动化检测脚本
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    });

    await ensureLoggedIn({ page, config, logger, runId });

    const summary = {};
    for (const stepName of config.checkinSteps) {
      summary[stepName] = await checkStepDoneOnly({
        page,
        runId,
        logger,
        siteNode: config.site[stepName],
        stepName,
      });
    }

    return {
      completed: Object.values(summary).every((step) => step.status === 'already_done'),
      summary: Object.fromEntries(
        Object.entries(summary).map(([stepName, step]) => [stepName, step.status]),
      ),
    };
  } finally {
    await browser.close();
  }
}
