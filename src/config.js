import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveSubmitActions } from './automation/submit-actions.js';

const REQUIRED_ENV = [
  'TARGET_URL',
  'CHECKIN_USERNAME',
  'CHECKIN_PASSWORD',
];

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//;
const CHECKIN_STEP_NAMES = ['personal', 'leader'];

function requireEnv(env, key) {
  const value = env[key];
  if (!value || String(value).trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return String(value).trim();
}

function readInt(env, key, defaultValue) {
  const raw = env[key];
  if (!raw) return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return value;
}

function readCheckinSteps(env) {
  const raw = env.CHECKIN_STEPS || CHECKIN_STEP_NAMES.join(',');
  const steps = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (steps.length === 0) {
    throw new Error('CHECKIN_STEPS must include at least one step');
  }

  for (const stepName of steps) {
    if (!CHECKIN_STEP_NAMES.includes(stepName)) {
      throw new Error(`Invalid CHECKIN_STEPS item: ${stepName}`);
    }
  }

  return [...new Set(steps)];
}

function readBrowserChannel(env) {
  const raw = env.BROWSER_CHANNEL;
  if (!raw || String(raw).trim() === '') return undefined;
  return String(raw).trim();
}

function readLoginInputMode(env) {
  const raw = env.LOGIN_INPUT_MODE || 'ime';
  const value = String(raw).trim().toLowerCase();
  if (!['ime', 'native-ime', 'paste-twice', 'type'].includes(value)) {
    throw new Error(`Invalid LOGIN_INPUT_MODE: ${raw}`);
  }
  return value;
}

function readBoolean(env, key, defaultValue) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return defaultValue;
  return !['false', '0', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

function assertPositive(value, key) {
  if (value <= 0) {
    throw new Error(`${key} must be greater than 0`);
  }
}

async function readSiteConfig(siteConfigPath) {
  const raw = await fs.readFile(siteConfigPath, 'utf8');
  const site = JSON.parse(raw);

  const checks = [
    ['login.url', site?.login?.url],
    ['login.usernameSelector', site?.login?.usernameSelector],
    ['login.passwordSelector', site?.login?.passwordSelector],
    ['login.submitSelector', site?.login?.submitSelector],
    ['personal.url', site?.personal?.url],
    ['personal.alreadyDoneSelector', site?.personal?.alreadyDoneSelector],
    ['leader.url', site?.leader?.url],
    ['leader.alreadyDoneSelector', site?.leader?.alreadyDoneSelector],
  ];

  for (const [label, value] of checks) {
    if (!value) {
      throw new Error(`site config missing field: ${label}`);
    }
  }

  resolveSubmitActions(site?.personal, 'personal');
  resolveSubmitActions(site?.leader, 'leader');

  return site;
}

function assertValidTargetUrl(targetUrl) {
  try {
    // Validate early to make site URL resolution deterministic.
    new URL(targetUrl);
  } catch {
    throw new Error(`Invalid TARGET_URL: ${targetUrl}`);
  }
}

function resolveSiteUrl({ targetUrl, value, label }) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`site config missing field: ${label}`);
  }

  const raw = value.trim();
  if (ABSOLUTE_URL_PATTERN.test(raw)) {
    return raw;
  }

  try {
    return new URL(raw, targetUrl).toString();
  } catch {
    throw new Error(`site config invalid url field: ${label}`);
  }
}

function applyTargetUrlToSite({ site, targetUrl }) {
  site.login.url = resolveSiteUrl({
    targetUrl,
    value: site.login.url,
    label: 'login.url',
  });
  site.personal.url = resolveSiteUrl({
    targetUrl,
    value: site.personal.url,
    label: 'personal.url',
  });
  site.leader.url = resolveSiteUrl({
    targetUrl,
    value: site.leader.url,
    label: 'leader.url',
  });
}

export async function buildConfig({ env = process.env, cwd = process.cwd() } = {}) {
  for (const key of REQUIRED_ENV) {
    requireEnv(env, key);
  }

  const targetUrl = requireEnv(env, 'TARGET_URL');
  assertValidTargetUrl(targetUrl);

  const timezone = (env.TIMEZONE || 'Asia/Shanghai').trim();

  const screenshotDir = path.resolve(cwd, env.SCREENSHOT_DIR || './runtime/screenshots');
  const logPath = path.resolve(cwd, env.LOG_PATH || './runtime/app.log');
  const siteConfigPath = path.resolve(cwd, env.SITE_CONFIG_PATH || './config/site-config.json');

  const site = await readSiteConfig(siteConfigPath);
  applyTargetUrlToSite({ site, targetUrl });
  const checkinSteps = readCheckinSteps(env);

  const maxAttempts = readInt(env, 'MAX_ATTEMPTS', 3);
  const backoffMinMs = readInt(env, 'BACKOFF_MIN_MS', 30_000);
  const backoffMaxMs = readInt(env, 'BACKOFF_MAX_MS', 90_000);
  const browserTimeoutMs = readInt(env, 'BROWSER_TIMEOUT_MS', 20_000);
  const actionBufferMs = readInt(env, 'CHECKIN_ACTION_BUFFER_MS', 1500);
  const loginTypeDelayMs = readInt(env, 'LOGIN_TYPE_DELAY_MS', 180);
  const loginFieldSettleMs = readInt(env, 'LOGIN_FIELD_SETTLE_MS', 2000);
  const loginNameReadySettleMs = readInt(env, 'LOGIN_NAME_READY_SETTLE_MS', 1500);
  const loginPasteSettleMs = readInt(env, 'LOGIN_PASTE_SETTLE_MS', 1200);

  assertPositive(maxAttempts, 'MAX_ATTEMPTS');
  assertPositive(browserTimeoutMs, 'BROWSER_TIMEOUT_MS');
  if (backoffMaxMs < backoffMinMs) {
    throw new Error('BACKOFF_MAX_MS must be greater than or equal to BACKOFF_MIN_MS');
  }

  return {
    targetUrl,
    username: requireEnv(env, 'CHECKIN_USERNAME'),
    password: requireEnv(env, 'CHECKIN_PASSWORD'),
    timezone,
    precheckEnabled: readBoolean(env, 'CHECKIN_PRECHECK', true),
    checkinSteps,
    screenshotDir,
    logPath,
    siteConfigPath,
    site,
    retry: {
      maxAttempts,
      backoffMinMs,
      backoffMaxMs,
    },
    browser: {
      headless: (env.HEADLESS || 'true').toLowerCase() !== 'false',
      channel: readBrowserChannel(env) || 'msedge',
      timeoutMs: browserTimeoutMs,
      slowMoMs: readInt(env, 'BROWSER_SLOW_MO_MS', 0),
      actionBufferMs,
      loginTypeDelayMs,
      loginFieldSettleMs,
      loginNameReadySettleMs,
      loginPasteSettleMs,
      loginInputMode: readLoginInputMode(env),
      loginImeText: (env.LOGIN_IME_TEXT || '').trim(),
      loginImeCommitKey: (env.LOGIN_IME_COMMIT_KEY || 'SPACE').trim(),
      loginWindowTitle: (env.LOGIN_WINDOW_TITLE || '学生日常打卡系统').trim(),
    },
  };
}
