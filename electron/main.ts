import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let mainWindow: BrowserWindow | null = null;
let activeRunnerProcess: ChildProcessWithoutNullStreams | null = null;

export type LoginMode = 'none' | 'wait-manual' | 'auto-credentials';

export interface RunPromptPayload {
  url: string;
  prompt: string;
  assertionPrompt?: string;
  loginMode: LoginMode;
  loginUser?: string;
  loginPassword?: string;
  loginWaitSeconds?: number;
  stepTimeoutSeconds?: number;
  blockAds?: boolean;
  browser: 'chromium' | 'firefox' | 'webkit';
  headed: boolean;
  useCache: boolean;
  provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'gateway';
  model: string;
  apiKey?: string;
  ollamaUrl?: string;
}

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function buildE2ETestCode(payload: RunPromptPayload): string {
  const normalizedTarget = payload.url.trim().replace(/\/+$/, '').toLowerCase();
  const filteredLines = payload.prompt
    .split('\n')
    .map((l) => l.trim())
    .filter((line) => {
      if (!line) return false;
      const lower = line.toLowerCase().replace(/\/+$/, '');
      const isRedundantGoto =
        /^(step\s*\d+\s*[:.-]?\s*)?(go\s+to|open|navigate\s+to|visit)\s+https?:\/\//i.test(
          line
        ) && lower.includes(normalizedTarget);
      return !isRedundantGoto;
    });

  const cleanPrompt =
    filteredLines.length > 0 ? filteredLines.join('\n') : payload.prompt.trim();

  const firstLine = (filteredLines[0] ?? payload.prompt.trim().split('\n')[0] ?? 'User Flow').slice(
    0,
    80
  );

  const stepTimeoutSec = Math.max(30, payload.stepTimeoutSeconds ?? 180);
  const stepTimeoutMs = stepTimeoutSec * 1000;
  const loginWaitMs =
    payload.loginMode === 'wait-manual'
      ? Math.max(30, payload.loginWaitSeconds ?? 180) * 1000
      : 0;
  const totalTimeoutMs = stepTimeoutMs + loginWaitMs + 120_000;

  const adBlockPart =
    payload.blockAds !== false
      ? `  // Block 3rd-party ad & tracker networks so heavy portals load in ~2s instead of 60s
  await browser.route(
    /(doubleclick\\.net|googlesyndication\\.com|googleadservices\\.com|adtrafficquality\\.google|amazon-adsystem\\.com|pubmatic\\.com|criteo\\.com|taboola\\.com|rubiconproject\\.com|inmobi\\.com|openx\\.net|adkernel\\.com|smartadserver\\.com|eskimi\\.com|adnxs\\.com|adform\\.net|outbrain\\.com|3lift\\.com|lijit\\.com|media\\.net|seedtag\\.com|cootlogix\\.com|kueezrtb\\.com|kueez\\.com|yellowblue\\.io|sparteo\\.com|admatic\\.de|4dex\\.io|presage\\.io|simpli\\.fi|kargo\\.com|casalemedia\\.com|indexww\\.com|startappnetwork\\.com|smaato\\.net|deepintent\\.com|iprom\\.net|adgrx\\.com|ctnsnet\\.com|everesttech\\.com|krushmedia\\.com|yieldmo\\.com|1rx\\.io|chocolateplatform\\.com|nrich\\.ai|eyeota\\.net|pinklion\\.io|vdo\\.ai|smilewanted\\.com|zemanta\\.com|serverbid\\.com|adtarget\\.com|turn\\.com|adotmob\\.com|tynt\\.com|360yield\\.com|fwmrm\\.net|richaudience\\.com|nextmillmedia\\.com|clmbtech\\.com|scorecardresearch\\.com)/i,
    (route) => route.abort()
  );\n\n`
      : '';

  let loginBlock = '';

  if (payload.loginMode === 'auto-credentials' && payload.loginUser) {
    loginBlock = `
  await agent.act(
    ${JSON.stringify(
      `If the current page is a login or sign-in screen: click "Login using email" or "Continue with email" if present, enter "${payload.loginUser}" and password "${payload.loginPassword ?? ''}", submit the login form, and wait until the main page finishes loading. If already signed in, do nothing.`
    )},
    { maxSteps: 20, maxModelCalls: 20, timeout: 120000 }
  );`;
  } else if (payload.loginMode === 'wait-manual') {
    loginBlock = `
  await expect
    .poll(
      async () => {
        return await browser.evaluate(() => {
          const path = window.location.pathname.toLowerCase();
          const bodyText = (document.body?.innerText || '').toLowerCase();
          const hasOtpButton = bodyText.includes('request otp') || bodyText.includes('verify otp');
          const isLoginUrl =
            path.includes('/login') ||
            path.includes('/signin') ||
            path.includes('/sign-in') ||
            path.includes('/auth');
          return !(isLoginUrl || hasOtpButton);
        });
      },
      {
        timeout: ${loginWaitMs},
        interval: 2000,
        message: 'Waiting in browser for user login / OTP verification to complete',
      }
    )
    .toBe(true);`;
  }

  const assertBlock =
    payload.assertionPrompt && payload.assertionPrompt.trim().length > 0
      ? `\n\n  // Verify expected outcome via agent.assert\n  await agent.assert(${JSON.stringify(payload.assertionPrompt.trim())}, { timeout: 60000 });`
      : '';

  return `import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test(
  ${JSON.stringify(`Prompt Run: ${firstLine}`)},
  { timeout: ${totalTimeoutMs} },
  async ({ app, agent, browser }) => {
${adBlockPart}  // Open Target URL provided in Desktop UI
  await app.open(${JSON.stringify(payload.url)});
${loginBlock}

  // Execute user prompt directly (no hardcoded wrapper text)
  await agent.act(${JSON.stringify(cleanPrompt)}, {
    maxSteps: 35,
    maxModelCalls: 35,
    timeout: ${stepTimeoutMs},
  });${assertBlock}
});
`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: 'TesterArmy E2E — Desktop Prompt Runner',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(path.join(projectRoot, 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (activeRunnerProcess) {
    activeRunnerProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('e2e:run-prompt', async (_event, payload: RunPromptPayload) => {
  if (activeRunnerProcess) {
    throw new Error('A test run is already in progress. Stop it before starting a new run.');
  }

  const generatedDir = path.join(projectRoot, 'tests', 'generated');
  await fs.mkdir(generatedDir, { recursive: true });

  const generatedTestPath = path.join(generatedDir, 'prompt-run.e2e.ts');
  const relativeTestPath = 'tests/generated/prompt-run.e2e.ts';
  const generatedCode = buildE2ETestCode(payload);

  await fs.writeFile(generatedTestPath, generatedCode, 'utf-8');

  mainWindow?.webContents.send('e2e:code-generated', {
    filePath: relativeTestPath,
    code: generatedCode,
  });

  mainWindow?.webContents.send('e2e:status', { status: 'running' });

  const cliArgs = ['e2e', 'run', relativeTestPath];
  if (payload.headed) {
    cliArgs.push('--headed');
  }
  if (!payload.useCache) {
    cliArgs.push('--no-cache');
  }

  const stepTimeoutMs = Math.max(30, payload.stepTimeoutSeconds ?? 180) * 1000;
  const loginWaitMs =
    payload.loginMode === 'wait-manual'
      ? Math.max(30, payload.loginWaitSeconds ?? 180) * 1000
      : 0;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    E2E_BASE_URL: payload.url,
    E2E_BROWSER: payload.browser,
    E2E_HEADLESS: payload.headed ? 'false' : 'true',
    E2E_LLM_PROVIDER: payload.provider,
    E2E_LLM_MODEL: payload.model,
    E2E_TEST_TIMEOUT_MS: String(stepTimeoutMs + loginWaitMs + 120_000),
  };

  if (payload.apiKey?.trim()) {
    const key = payload.apiKey.trim();
    if (payload.provider === 'anthropic') {
      env.ANTHROPIC_API_KEY = key;
    } else if (payload.provider === 'google') {
      env.GOOGLE_GENERATIVE_AI_API_KEY = key;
      env.GEMINI_API_KEY = key;
    } else {
      env.OPENAI_API_KEY = key;
    }
  }

  if (payload.ollamaUrl?.trim()) {
    env.OLLAMA_BASE_URL = payload.ollamaUrl.trim();
  }

  mainWindow?.webContents.send(
    'e2e:log',
    `[Desktop Runner] Generated ${relativeTestPath}\n[Desktop Runner] Launching: npx ${cliArgs.join(' ')}\n\n`
  );

  return new Promise<{ exitCode: number | null }>((resolve) => {
    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(npxCmd, cliArgs, {
      cwd: projectRoot,
      env,
      shell: true,
    });

    activeRunnerProcess = child;

    child.stdout.on('data', (chunk: Buffer) => {
      mainWindow?.webContents.send('e2e:log', stripAnsi(chunk.toString()));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      mainWindow?.webContents.send('e2e:log', stripAnsi(chunk.toString()));
    });

    child.on('close', (code) => {
      activeRunnerProcess = null;
      const finalStatus = code === 0 ? 'passed' : 'failed';
      mainWindow?.webContents.send(
        'e2e:log',
        `\n[Desktop Runner] Process finished with exit code ${code} (${finalStatus.toUpperCase()})\n`
      );
      mainWindow?.webContents.send('e2e:status', {
        status: finalStatus,
        exitCode: code,
      });
      resolve({ exitCode: code });
    });

    child.on('error', (err) => {
      activeRunnerProcess = null;
      mainWindow?.webContents.send(
        'e2e:log',
        `\n[Desktop Runner Error] ${stripAnsi(err.message)}\n`
      );
      mainWindow?.webContents.send('e2e:status', {
        status: 'failed',
        exitCode: 1,
      });
      resolve({ exitCode: 1 });
    });
  });
});

ipcMain.handle('e2e:stop-run', async () => {
  if (activeRunnerProcess) {
    activeRunnerProcess.kill();
    activeRunnerProcess = null;
    mainWindow?.webContents.send(
      'e2e:log',
      '\n[Desktop Runner] Test execution stopped by user.\n'
    );
    mainWindow?.webContents.send('e2e:status', { status: 'stopped' });
    return { stopped: true };
  }
  return { stopped: false };
});
