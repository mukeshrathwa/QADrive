import fs from 'node:fs/promises';
import path from 'node:path';

export interface RecordedDomAction {
  kind: 'click' | 'fill' | 'select';
  tag: string;
  id: string;
  testId: string;
  name: string;
  type: string;
  placeholder: string;
  ariaLabel: string;
  role: string;
  href: string;
  text: string;
  cssPath: string;
  value?: string;
  isEmail?: boolean;
  pageUrl?: string;
}

export type ActionCacheMap = Record<string, RecordedDomAction[]>;

export function normalizeOriginKey(rawUrl: string): string {
  try {
    const u = new URL(rawUrl.trim());
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return rawUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export function getHostSessionFilename(rawUrl: string, prompt?: string): string {
  try {
    const u = new URL(rawUrl.trim());
    const hostBase = u.host.replace(/[^a-z0-9.-]/gi, '_').toLowerCase();
    if (prompt) {
      const emailMatch = prompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        const userSlug = emailMatch[0].replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 36);
        return `${hostBase}__${userSlug}.json`;
      }
    }
    return `${hostBase}.json`;
  } catch {
    return 'default_session.json';
  }
}

export function buildStepCacheKey(rawUrl: string, stepText: string): string {
  return `${normalizeOriginKey(rawUrl)}::${stepText.trim().toLowerCase()}`;
}

/**
 * Converts a single recorded DOM action into an idiomatic `@playwright/test` statement.
 */
function formatPlaywrightActionLine(act: RecordedDomAction, hasDynamicEmail: boolean): string {
  let locatorCode = '';

  if (act.testId) {
    locatorCode = `page.getByTestId(${JSON.stringify(act.testId)})`;
  } else if (act.id) {
    locatorCode = `page.locator(${JSON.stringify(`#${act.id}`)})`;
  } else if (act.placeholder && (act.kind === 'fill' || act.tag === 'input' || act.tag === 'textarea')) {
    locatorCode = `page.getByPlaceholder(${JSON.stringify(act.placeholder)})`;
  } else if (act.name && (act.kind === 'fill' || act.kind === 'select')) {
    locatorCode = `page.locator(${JSON.stringify(`${act.tag}[name="${act.name}"]`)})`;
  } else if (act.ariaLabel) {
    locatorCode = `page.getByLabel(${JSON.stringify(act.ariaLabel)})`;
  } else if ((act.tag === 'button' || act.role === 'button') && act.text) {
    locatorCode = `page.getByRole('button', { name: ${JSON.stringify(act.text)} })`;
  } else if ((act.tag === 'a' || act.role === 'link') && act.text) {
    locatorCode = `page.getByRole('link', { name: ${JSON.stringify(act.text)} })`;
  } else if (act.text && act.kind === 'click') {
    locatorCode = `page.getByText(${JSON.stringify(act.text)}).first()`;
  } else if (act.href && act.tag === 'a') {
    locatorCode = `page.locator(${JSON.stringify(`a[href="${act.href}"]`)}).first()`;
  } else {
    locatorCode = `page.locator(${JSON.stringify(act.cssPath || act.tag)}).first()`;
  }

  if (act.kind === 'fill') {
    if (act.isEmail && hasDynamicEmail) {
      return `  await ${locatorCode}.fill(dynamicUserEmail);`;
    }
    return `  await ${locatorCode}.fill(${JSON.stringify(act.value ?? '')});`;
  }

  if (act.kind === 'select') {
    return `  await ${locatorCode}.selectOption(${JSON.stringify(act.value ?? '')});`;
  }

  return `  await ${locatorCode}.click();`;
}

/**
 * Feature #17: Generates a standalone, zero-LLM `@playwright/test` `.spec.ts` file
 * from the recorded DOM actions in `.e2e/action-cache.json`.
 */
export async function generateExportedPlaywrightSpec(params: {
  projectRoot: string;
  targetUrl: string;
  actionSteps: string[];
  assertionPrompt?: string;
  reuseSession?: boolean;
}): Promise<{ exportedPath: string; exportedCode: string }> {
  const { projectRoot, targetUrl, actionSteps, assertionPrompt, reuseSession } = params;
  const cachePath = path.join(projectRoot, '.e2e', 'action-cache.json');
  let cacheMap: ActionCacheMap = {};
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    cacheMap = JSON.parse(raw) as ActionCacheMap;
  } catch {
    // empty cache if not recorded yet
  }

  const hasSignupStep = actionSteps.some((s) =>
    /\b(sign\s*up|signup|register|create\s+account)\b/i.test(s)
  );
  const sessionFile = getHostSessionFilename(targetUrl);

  const lines: string[] = [
    `// @ts-nocheck`,
    `import { test, expect } from '@playwright/test';`,
    `import fs from 'node:fs';`,
    ``,
    `/**`,
    ` * Auto-Exported Zero-LLM Playwright Test (.spec.ts)`,
    ` * Target URL: ${targetUrl}`,
    ` * LLM API Calls Required: 0 ($0 Cost — Deterministic Selector Replay)`,
    ` */`,
    `test('Recorded Zero-LLM E2E Flow: ${targetUrl}', async ({ page }) => {`,
  ];

  if (hasSignupStep) {
    lines.push(
      `  const dynamicUserEmail = \`qa.tester.\${Date.now().toString().slice(-6)}@example.com\`;`
    );
  }

  lines.push(`  await page.goto(${JSON.stringify(targetUrl)});`);

  if (reuseSession) {
    lines.push(
      `  // Feature #14: Restore saved login session state (cookies + localStorage) if available`,
      `  if (fs.existsSync('.e2e/sessions/${sessionFile}')) {`,
      `    const savedSession = JSON.parse(fs.readFileSync('.e2e/sessions/${sessionFile}', 'utf-8'));`,
      `    await page.evaluate((s) => {`,
      `      for (const [k, v] of Object.entries(s.localStorage || {})) localStorage.setItem(k, String(v));`,
      `      for (const [k, v] of Object.entries(s.sessionStorage || {})) sessionStorage.setItem(k, String(v));`,
      `      if (s.cookies) s.cookies.split(';').forEach((c: string) => { if (c.trim()) document.cookie = c.trim() + '; path=/'; });`,
      `    }, savedSession);`,
      `    await page.reload();`,
      `  }`
    );
  }

  lines.push(``);

  for (let i = 0; i < actionSteps.length; i++) {
    const stepText = actionSteps[i];
    const key = buildStepCacheKey(targetUrl, stepText);
    const recorded = cacheMap[key] || [];

    lines.push(`  // Step ${i + 1}: ${stepText}`);
    if (recorded.length > 0) {
      for (const act of recorded) {
        lines.push(formatPlaywrightActionLine(act, hasSignupStep));
      }
      lines.push(`  await page.waitForTimeout(400);`);
    } else {
      lines.push(
        `  // (Run this step once with the AI Agent to record its exact DOM selectors here)`
      );
    }
    lines.push(``);
  }

  if (assertionPrompt?.trim()) {
    lines.push(`  // Verification Goal: ${assertionPrompt.trim()}`);
    lines.push(`  await expect(page.locator('body')).toBeVisible();`);
  }

  lines.push(`});`, ``);

  const exportedCode = lines.join('\n');
  const exportDir = path.join(projectRoot, 'tests', 'exported');
  await fs.mkdir(exportDir, { recursive: true });
  const exportedPath = path.join(exportDir, 'playwright-zero-llm.spec.ts');
  await fs.writeFile(exportedPath, exportedCode, 'utf-8');

  return {
    exportedPath: 'tests/exported/playwright-zero-llm.spec.ts',
    exportedCode,
  };
}

/**
 * Inspects whether a target URL has cached Zero-LLM actions (#15) and/or a saved Login Session (#14).
 */
export async function getCacheAndSessionStatus(
  projectRoot: string,
  targetUrl: string,
  prompt: string
): Promise<{
  hasSession: boolean;
  hasSavedSession: boolean;
  sessionSavedAt?: string;
  cachedStepsCount: number;
  totalStepsCount: number;
  totalCachedActions: number;
  exportedPlaywrightExists: boolean;
}> {
  const sessionFile = path.join(
    projectRoot,
    '.e2e',
    'sessions',
    getHostSessionFilename(targetUrl)
  );
  let hasSavedSession = false;
  let sessionSavedAt: string | undefined;

  try {
    const rawSess = await fs.readFile(sessionFile, 'utf-8');
    const parsed = JSON.parse(rawSess) as { savedAt?: string; localStorage?: Record<string, string>; cookies?: string };
    const hasData =
      Object.keys(parsed.localStorage || {}).length > 0 ||
      Boolean(parsed.cookies && parsed.cookies.trim().length > 0);
    if (hasData) {
      hasSavedSession = true;
      sessionSavedAt = parsed.savedAt;
    }
  } catch {
    // no saved session
  }

  const steps = prompt
    .split('\n')
    .map((l) => l.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim())
    .filter(Boolean);

  let cachedStepsCount = 0;
  let totalCachedActions = 0;
  try {
    const cacheRaw = await fs.readFile(
      path.join(projectRoot, '.e2e', 'action-cache.json'),
      'utf-8'
    );
    const cacheMap = JSON.parse(cacheRaw) as ActionCacheMap;
    for (const s of steps) {
      const key = buildStepCacheKey(targetUrl, s);
      if (cacheMap[key] && cacheMap[key].length > 0) {
        cachedStepsCount++;
        totalCachedActions += cacheMap[key].length;
      }
    }
  } catch {
    // no action cache yet
  }

  let exportedPlaywrightExists = false;
  try {
    await fs.access(
      path.join(projectRoot, 'tests', 'exported', 'playwright-zero-llm.spec.ts')
    );
    exportedPlaywrightExists = true;
  } catch {
    // not exported yet
  }

  return {
    hasSession: hasSavedSession,
    hasSavedSession,
    sessionSavedAt,
    cachedStepsCount,
    totalStepsCount: steps.length,
    totalCachedActions,
    exportedPlaywrightExists,
  };
}

/**
 * Clears saved login session (#14) or recorded action cache (#15) for a URL.
 */
export async function clearCacheOrSession(
  projectRoot: string,
  targetUrl: string,
  clearType: 'session' | 'cache' | 'both'
): Promise<void> {
  if (clearType === 'session' || clearType === 'both') {
    const sessionFile = path.join(
      projectRoot,
      '.e2e',
      'sessions',
      getHostSessionFilename(targetUrl)
    );
    try {
      await fs.unlink(sessionFile);
    } catch {
      // ignore if already deleted
    }
  }

  if (clearType === 'cache' || clearType === 'both') {
    const cachePath = path.join(projectRoot, '.e2e', 'action-cache.json');
    try {
      const raw = await fs.readFile(cachePath, 'utf-8');
      const map = JSON.parse(raw) as ActionCacheMap;
      const prefix = `${normalizeOriginKey(targetUrl)}::`;
      for (const k of Object.keys(map)) {
        if (k.startsWith(prefix)) {
          delete map[k];
        }
      }
      await fs.writeFile(cachePath, JSON.stringify(map, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }
}
