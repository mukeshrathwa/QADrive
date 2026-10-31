import http from 'node:http';
import { spawn, exec, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateWordObservationReport,
  type ScreenshotItem,
  type StepObservation,
} from './docx-report.js';
import {
  fetchTestRailCase,
  submitTestRailResult,
  testTestRailConnection,
  type TestRailConfig,
} from './testrail.js';
import {
  browseForExeFile,
  buildDesktopTestCodePreview,
  executeHybridDesktopStep,
  executeHybridMobileStep,
  formatRecordCorrelationHint,
  mergeSharedRecordCorrelation,
  readSharedRecordCorrelation,
  resetHybridDesktopSession,
  runDesktopExeTest,
  stopActiveDesktopRun,
  type HybridDesktopStepRecord,
} from './desktop-runner.js';
import {
  clearCacheOrSession,
  generateExportedPlaywrightSpec,
  getCacheAndSessionStatus,
  getHostSessionFilename,
  normalizeOriginKey,
} from './cache-and-session.js';
import { testOrgAwsConnection } from './org-aws-llm.js';
import {
  buildLoadTestCodePreview,
  discoverLoadSamplers,
  runJMeterLoadTest,
  stopActiveLoadRun,
} from './load-runner.js';
import {
  getSiteMapForUrl,
  mergeLiveDiscoveredNodesIntoSiteMap,
  scanWebsiteGeneric,
  type ScannedElementInfo,
} from './site-scanner.js';
import type { LoadTestConfig, LoadTestSummary, OrgAwsConfig } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

let PORT = Number(process.env.E2E_SERVER_PORT ?? 4002);
const UI_PORT = Number(process.env.VITE_PORT ?? 4001);

export type LoginMode = 'none' | 'wait-manual' | 'auto-credentials';

export interface FormDataProfile {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  address: string;
  city: string;
  postalCode: string;
  country: string;
  message: string;
  customJson?: string;
}

export interface RunPromptPayload {
  targetType?: 'web' | 'desktop' | 'hybrid' | 'load';
  loadConfig?: LoadTestConfig;
  url: string;
  prompt: string;
  assertionPrompt?: string;
  loginMode: LoginMode;
  loginUser?: string;
  loginPassword?: string;
  loginWaitSeconds?: number;
  desktopExePath?: string;
  desktopLoginMode?: LoginMode;
  desktopLoginUser?: string;
  desktopLoginPassword?: string;
  stepTimeoutSeconds?: number;
  maxRetries?: number;
  blockAds?: boolean;
  recordVideo?: boolean;
  autoFillForms?: boolean;
  formData?: FormDataProfile;
  browser: 'chromium' | 'firefox' | 'webkit';
  headed: boolean;
  useCache: boolean;
  reuseSession?: boolean;
  provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'gateway';
  model: string;
  apiKey?: string;
  ollamaUrl?: string;
  orgAws?: OrgAwsConfig;

  // TestRail execution tracking
  testrailCaseId?: string;
  testrailRunId?: string;
  testrailConfig?: TestRailConfig;
}

let activeRunnerProcess: ChildProcessWithoutNullStreams | null = null;
let activeDesktopRunInProgress = false;
let activeLoadRunInProgress = false;
let latestDocxFilePath: string | null = null;
let latestEvidencePayload: unknown = null;
const sseClients = new Set<http.ServerResponse>();

function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function broadcastEvent(event: string, data: unknown) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function cleanStepLabelForReport(rawLabel: string): string {
  if (!rawLabel) return '';
  let cleaned = rawLabel.trim();
  // Strip any legacy multi-line internal context prefixes (e.g. "IMPORTANT: ...\n" or "Continue from the current page state...\n")
  while (
    /^(IMPORTANT:|Continue from the current page state and complete this step:)/i.test(
      cleaned
    )
  ) {
    const newlineIdx = cleaned.indexOf('\n');
    if (newlineIdx !== -1) {
      cleaned = cleaned.slice(newlineIdx + 1).trim();
    } else {
      break;
    }
  }
  // Strip any legacy appended cart guidance
  cleaned = cleaned
    .replace(/\s*\(If the current page only shows category banners[^)]*\)\s*$/i, '')
    .trim();
  return cleaned;
}

/**
 * Parses `.e2e/report.json`, collects all step observations, PNG screenshots, and recorded videos,
 * generates the `.docx` Word document, and returns both console text and UI evidence payload.
 */
async function buildDiagnosticsAndWordReport(
  payload?: Partial<RunPromptPayload>
): Promise<{
  consoleSummary: string;
  evidencePayload?: {
    docxPath: string;
    timestampedDocxPath: string;
    docxDownloadUrl: string;
    exportedPlaywrightPath?: string;
    exportedPlaywrightCode?: string;
    highlightedSummary?: string;
    loadSummary?: LoadTestSummary;
    observations: StepObservation[];
    screenshots: Array<{ id: string; label: string; url: string }>;
    videos: Array<{ id: string; label: string; url: string; savedPath: string }>;
    testrailResult?: {
      caseId: string;
      runId: string;
      status: 'passed' | 'failed';
      resultId?: number;
      error?: string;
    };
  };
}> {
  try {
    const reportPath = path.join(projectRoot, '.e2e', 'report.json');
    const raw = await fs.readFile(reportPath, 'utf-8');
    const report = JSON.parse(raw) as {
      run?: {
        startedAt?: string;
        targets?: Array<{ baseOrigin?: string }>;
        results?: Array<{
          selected?: boolean;
          status?: string;
          attempts?: Array<{
            status?: string;
            startedAt?: string;
            durationMs?: number;
            error?: { code?: string; message?: string };
            failure?: { url?: string };
            artifacts?: Array<{
              id: string;
              kind: string;
              path: string;
            }>;
            steps?: Array<{
              id: string;
              index: number;
              api?: string;
              label?: string;
              status?: string;
              durationMs?: number;
              summary?: string;
              explanation?: string;
              screen?: { location?: string };
              artifacts?: string[];
              error?: { code?: string; message?: string };
            }>;
          }>;
        }>;
      };
    };

    const selected = report.run?.results?.find((r) => r.selected);
    const lastAttempt = selected?.attempts?.[selected.attempts.length - 1];
    if (!lastAttempt) return { consoleSummary: '' };

    const observations: StepObservation[] = [];
    const lines: string[] = ['\n─── Run Diagnostic & Observation Summary ───'];

    let finalUrl = lastAttempt.failure?.url;
    if (lastAttempt.steps && lastAttempt.steps.length > 0) {
      for (const step of lastAttempt.steps) {
        if (step.screen?.location) {
          finalUrl = step.screen.location;
        }
        // Skip internal plumbing steps (ad-block route regex & internal DOM polling) unless they threw an error
        if (
          (step.api === 'browser.route' || step.api === 'browser.evaluate') &&
          !step.error
        ) {
          continue;
        }
        const icon = step.status === 'passed' ? '✓' : '✗';
        const durationSec =
          typeof step.durationMs === 'number'
            ? (step.durationMs / 1000).toFixed(1)
            : '0.0';
        const obsSummary = step.summary || step.explanation;
        const cleanedLabel = cleanStepLabelForReport(step.label ?? '');

        const newObs: StepObservation = {
          index: observations.length + 1,
          api: step.api ?? 'step',
          label: cleanedLabel,
          status: step.status ?? 'unknown',
          durationSec,
          summary: obsSummary,
          locationUrl: step.screen?.location,
          errorMessage: step.error
            ? `${step.error.code}: ${step.error.message}`
            : undefined,
        };

        // If this is a retry attempt of the exact same agent.act step, update the existing observation entry
        // so the Word document and UI summary stay concise (1 row per logical step), while keeping all attempts in console logs.
        const prevObs = observations[observations.length - 1];
        if (
          prevObs &&
          prevObs.api === 'agent.act' &&
          newObs.api === 'agent.act' &&
          prevObs.label === newObs.label
        ) {
          newObs.index = prevObs.index;
          observations[observations.length - 1] = newObs;
        } else {
          observations.push(newObs);
        }

        lines.push(`  ${icon} [${step.api}] (${durationSec}s) ${cleanedLabel}`);
        if (obsSummary) {
          lines.push(`      Observation: ${obsSummary}`);
        }
        if (step.error) {
          lines.push(`      Error (${step.error.code}): ${step.error.message}`);
        }
      }
    }

    if (lastAttempt.error) {
      lines.push(`\n  Failure Code: ${lastAttempt.error.code}`);
      lines.push(`  Failure Message: ${lastAttempt.error.message}`);
      if (lastAttempt.failure?.url) {
        lines.push(`  Page URL at Failure: ${lastAttempt.failure.url}`);
      }
      if (lastAttempt.error.code === 'MODEL_PROVIDER_FAILED') {
        lines.push(
          `  💡 Hint: Check that your API Key is valid for the selected LLM Provider and that the Model Name exists (e.g. "gpt-4o", "claude-sonnet-4-5", or "gemini-2.5-flash").`
        );
      }
    }

    // Collect all screenshots and videos from `.e2e/results/` referenced in the attempt
    const resultsRoot = path.join(projectRoot, '.e2e', 'results');
    const reportsDir = path.join(projectRoot, 'reports');
    await fs.mkdir(reportsDir, { recursive: true });

    const screenshots: ScreenshotItem[] = [];
    const videos: Array<{ id: string; label: string; url: string; savedPath: string }> = [];
    const artifactMap = new Map<string, { id: string; kind: string; path: string }>();

    for (const art of lastAttempt.artifacts ?? []) {
      if (art.kind === 'screenshot') {
        artifactMap.set(art.id, art);
      } else if (art.kind === 'video') {
        const absVideoPath = path.join(resultsRoot, art.path);
        try {
          const videoBytes = await fs.readFile(absVideoPath);
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const savedVideoPath = path.join(
            reportsDir,
            `e2e-recording-${stamp}-${videos.length + 1}.webm`
          );
          const latestVideoPath = path.join(reportsDir, 'e2e-recording-latest.webm');
          await fs.writeFile(savedVideoPath, videoBytes);
          try {
            await fs.writeFile(latestVideoPath, videoBytes);
          } catch {
            // Ignore if latest video is locked by media player
          }

          videos.push({
            id: art.id,
            label: `Test Execution Recording (${path.basename(art.path)})`,
            url: `/api/artifact?path=${encodeURIComponent(art.path)}&t=${Date.now()}`,
            savedPath: savedVideoPath,
          });
        } catch {
          // Ignore if video file could not be read
        }
      }
    }

    // Map step labels to screenshot artifacts
    const stepArtifactLabels = new Map<string, string>();
    for (const step of lastAttempt.steps ?? []) {
      const cleanedLabel = cleanStepLabelForReport(step.label ?? '');
      for (const artId of step.artifacts ?? []) {
        const prefix =
          step.api === 'app.screenshot'
            ? `Screenshot: ${cleanedLabel || 'Page Capture'}`
            : step.api === 'agent.assert'
              ? `Verified Assertion: ${cleanedLabel || ''}`
              : `${step.api}: ${cleanedLabel || ''}`;
        stepArtifactLabels.set(artId, prefix);
      }
    }

    for (const [artId, art] of artifactMap.entries()) {
      const absPath = path.join(resultsRoot, art.path);
      try {
        const bytes = await fs.readFile(absPath);
        const label =
          stepArtifactLabels.get(artId) ??
          (art.path.includes('failure')
            ? 'Screen State at Failure'
            : path.basename(art.path));
        screenshots.push({
          id: artId,
          label,
          relativePath: art.path,
          absolutePath: absPath,
          bytes: new Uint8Array(bytes),
        });
      } catch {
        // Ignore missing screenshot file
      }
    }

    // Merge any Hybrid Desktop (.exe) step observations and screenshots executed during a Web <-> Desktop flow
    try {
      const hybridStepsRaw = await fs.readFile(
        path.join(projectRoot, '.e2e', 'hybrid-desktop-steps.json'),
        'utf-8'
      );
      const hybridRecords = JSON.parse(hybridStepsRaw) as HybridDesktopStepRecord[];
      if (Array.isArray(hybridRecords) && hybridRecords.length > 0) {
        for (const rec of hybridRecords) {
          observations.push({
            index: observations.length + 1,
            api: 'desktop.act',
            label: rec.label,
            status: rec.status,
            durationSec: rec.durationSec,
            summary: rec.summary,
            locationUrl: rec.locationUrl,
          });
          if (rec.screenshotRelPath) {
            try {
              const absShot = path.join(projectRoot, rec.screenshotRelPath);
              const shotBytes = await fs.readFile(absShot);
              const relFromResults = rec.screenshotRelPath.replace(/^\.e2e[\\/]+results[\\/]+/i, '');
              screenshots.push({
                id: `hybrid-desktop-${rec.stepNumber}`,
                label: `Desktop Step ${rec.stepNumber}: ${rec.label}`,
                relativePath: relFromResults,
                absolutePath: absShot,
                bytes: new Uint8Array(shotBytes),
              });
            } catch {
              // ignore missing screenshot
            }
          }
        }
      }
    } catch {
      // ignore if not a hybrid run
    }

    // Check if there is a highlighted observation summary saved from browser.evaluate
    let highlightedSummary: string | undefined;
    try {
      const highlightJsonPath = path.join(
        projectRoot,
        '.e2e',
        'highlighted-observation.json'
      );
      const rawHighlight = await fs.readFile(highlightJsonPath, 'utf-8');
      const parsed = JSON.parse(rawHighlight) as { summary?: string };
      highlightedSummary = parsed.summary;
    } catch {
      // Ignore if not present
    }

    // Load saved last-run-payload.json if payload was not directly passed
    let savedPayload: Partial<RunPromptPayload> = {};
    if (!payload?.prompt) {
      try {
        const savedRaw = await fs.readFile(
          path.join(projectRoot, '.e2e', 'last-run-payload.json'),
          'utf-8'
        );
        savedPayload = JSON.parse(savedRaw) as Partial<RunPromptPayload>;
      } catch {
        // Ignore if not present
      }
    }

    const totalSec =
      typeof lastAttempt.durationMs === 'number'
        ? (lastAttempt.durationMs / 1000).toFixed(1)
        : '0.0';

    const uniqueActLabels = Array.from(
      new Set(
        (lastAttempt.steps ?? [])
          .filter((s) => s.api === 'agent.act' && s.label)
          .map((s) => cleanStepLabelForReport(s.label ?? ''))
          .filter(Boolean)
      )
    );

    const fallbackUrl =
      payload?.url ||
      savedPayload.url ||
      report.run?.targets?.[0]?.baseOrigin ||
      finalUrl ||
      'http://localhost:5000/';

    // Incrementally merge any live-discovered DOM links/elements from the run into the Unified Site Map
    try {
      const rawLiveNodes = await fs.readFile(
        path.join(projectRoot, '.e2e', 'live-site-nodes.json'),
        'utf-8'
      );
      const parsedLiveNodes = JSON.parse(rawLiveNodes) as Array<{
        url: string;
        pathname: string;
        title: string;
        elements: ScannedElementInfo[];
      }>;
      await mergeLiveDiscoveredNodesIntoSiteMap(projectRoot, fallbackUrl, parsedLiveNodes);
    } catch {
      // ignore if not present
    }
    const fallbackPrompt =
      payload?.prompt ||
      savedPayload.prompt ||
      uniqueActLabels.map((lbl, idx) => `Step ${idx + 1}: ${lbl}`).join('\n') ||
      'Automated E2E Run';
    const fallbackAssertion =
      payload?.assertionPrompt ||
      savedPayload.assertionPrompt ||
      (lastAttempt.steps ?? []).find((s) => s.api === 'agent.assert')?.label;

    const { latestDocxPath, timestampedDocxPath } =
      await generateWordObservationReport({
        projectRoot,
        targetUrl: fallbackUrl,
        prompt: fallbackPrompt,
        assertionPrompt: fallbackAssertion,
        highlightedSummary,
        runStatus: selected?.status ?? lastAttempt.status ?? 'completed',
        startedAt:
          lastAttempt.startedAt ?? report.run?.startedAt ?? new Date().toISOString(),
        durationSec: totalSec,
        finalUrl: finalUrl ?? fallbackUrl,
        observations,
        screenshots,
        videoPaths: videos.map((v) => v.savedPath),
      });

    latestDocxFilePath = timestampedDocxPath;

    const parsedSteps = fallbackPrompt
      .split('\n')
      .map((l) => l.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim())
      .filter(Boolean);

    const { exportedPath: exportedPlaywrightPath, exportedCode: exportedPlaywrightCode } =
      await generateExportedPlaywrightSpec({
        projectRoot,
        targetUrl: fallbackUrl,
        actionSteps: parsedSteps,
        assertionPrompt: fallbackAssertion,
        reuseSession: payload?.reuseSession,
      });

    lines.push(`\n  📄 Word Document Report (.docx) Stored At:`);
    lines.push(`     • Folder: ${reportsDir}`);
    lines.push(`     • File:   ${timestampedDocxPath}`);
    lines.push(`     • Latest: ${latestDocxPath}`);
    lines.push(
      `     • Embedded ${screenshots.length} screenshot(s) & ${observations.length} step observation(s)`
    );
    lines.push(
      `  ⚡ Exported Zero-LLM Playwright Script (.spec.ts): ${path.join(projectRoot, exportedPlaywrightPath)}`
    );
    if (videos.length > 0) {
      lines.push(`  🎥 Video Recording (.webm) Saved:`);
      for (const v of videos) {
        lines.push(`     • ${v.savedPath}`);
      }
    }
    lines.push('────────────────────────────────────────────\n');

    let loadSummary: LoadTestSummary | undefined;
    if ((payload?.targetType || savedPayload.targetType) === 'load') {
      try {
        const rawLoad = await fs.readFile(
          path.join(projectRoot, '.e2e', 'load-summary.json'),
          'utf-8'
        );
        loadSummary = JSON.parse(rawLoad) as LoadTestSummary;
      } catch {
        // ignore
      }
    }

    return {
      consoleSummary: lines.join('\n'),
      evidencePayload: {
        docxPath: latestDocxPath,
        timestampedDocxPath,
        docxDownloadUrl: `/api/report/docx?t=${Date.now()}`,
        exportedPlaywrightPath,
        exportedPlaywrightCode,
        highlightedSummary,
        loadSummary,
        observations,
        screenshots: screenshots.map((s) => ({
          id: s.id,
          label: s.label,
          url: `/api/artifact?path=${encodeURIComponent(s.relativePath)}&t=${Date.now()}`,
        })),
        videos,
      },
    };
  } catch (err) {
    return {
      consoleSummary: `\n[Report Generator Warning] ${(err as Error).message}\n`,
    };
  }
}

function isPureLoginStepLine(line: string): boolean {
  const withoutStepPrefix = line.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim();
  if (!/\b(login|log\s+in|sign\s+in|signin|authenticate|otp)\b/i.test(withoutStepPrefix)) {
    return false;
  }
  // Any line explicitly asking to wait for login / OTP / password is a login step
  if (
    /\b(wait|waiting|pause)\s+(for|until|till)\b.*\b(login|log\s+in|sign\s+in|logged\s+in|signed\s+in|otp|password|authenticate|authenticated)\b/i.test(
      withoutStepPrefix
    )
  ) {
    return true;
  }
  const loginStopWords = new Set([
    'go', 'to', 'click', 'on', 'open', 'tap', 'visit', 'navigate', 'select', 'choose',
    'the', 'a', 'an', 'from', 'in', 'at', 'of', 'by', 'top', 'header', 'navbar', 'nav',
    'navigation', 'bar', 'menu', 'section', 'tab', 'option', 'dropdown', 'panel', 'box',
    'form', 'window', 'browser', 'login', 'log', 'signin', 'sign', 'into', 'it', 'app',
    'application', 'site', 'website', 'portal', 'page', 'screen', 'modal', 'dialog',
    'popup', 'button', 'link', 'icon', 'and', 'then', 'wait', 'waiting', 'pause',
    'until', 'till', 'for', 'user', 'me', 'manual', 'manually', 'enter', 'entering',
    'input', 'fill', 'type', 'credentials', 'credential', 'username', 'phone', 'mobile',
    'number', 'email', 'password', 'passcode', 'otp', 'verification', 'code', 'complete',
    'completed', 'completes', 'done', 'finish', 'finished', 'first', 'please', 'with',
    'valid', 'account', 'profile', 'session', 'is', 'has', 'logged', 'signed',
  ]);
  const tokens = withoutStepPrefix
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const nonLoginTokens = tokens.filter((t) => !loginStopWords.has(t));
  return nonLoginTokens.length === 0;
}

function cleanActionStepLine(line: string): string {
  let cleaned = line
    .replace(/^step\s*\d+\s*[:.-]?\s*/i, '')
    // Strip "once/after/when user logged in" at the beginning of the sentence
    .replace(
      /^(once|after|when)\s+(the\s+)?(user\s+)?(is\s+|has\s+)?(logged\s+in|signed\s+in|login\s+is\s+complete|login\s+completes|authenticated)[,.:;-]*\s*/i,
      ''
    )
    // Strip "once/after/when user logged in" at the end or middle of the sentence
    .replace(
      /[,.:;-]*\s*\b(once|after|when)\s+(the\s+)?(user\s+)?(is\s+|has\s+)?(logged\s+in|signed\s+in|login\s+is\s+complete|login\s+completes|authenticated)\b[.!]?\s*$/i,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    cleaned = line.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim();
  }

  return cleaned;
}

function buildE2ETestCode(payload: RunPromptPayload): string {
  const normalizedTarget = payload.url.trim().replace(/\/+$/, '').toLowerCase();
  let hasExplicitLoginStepInPrompt = false;
  let seenNonLoginStep = false;

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
      if (isRedundantGoto) return false;

      // Only hoist a pure login step into upfront login if no prior step (such as signup/registration) has occurred yet
      if (!seenNonLoginStep && isPureLoginStepLine(line)) {
        hasExplicitLoginStepInPrompt = true;
        return false;
      }
      seenNonLoginStep = true;
      return true;
    });

  const actionSteps =
    filteredLines.length > 0
      ? filteredLines.map(cleanActionStepLine).filter(Boolean)
      : [cleanActionStepLine(payload.prompt.trim())].filter(Boolean);

  const cleanPrompt =
    actionSteps.length > 0 ? actionSteps.join('\n') : payload.prompt.trim();

  const firstLine = (
    filteredLines[0] ??
    payload.prompt.trim().split('\n')[0] ??
    'User Flow'
  ).slice(0, 80);

  const stepTimeoutSec = Math.max(30, payload.stepTimeoutSeconds ?? 180);
  const stepTimeoutMs = stepTimeoutSec * 1000;
  const maxLoginWaitMs = Math.max(60, payload.loginWaitSeconds ?? 180) * 1000;
  const maxRetries = Math.max(0, Math.min(5, payload.maxRetries ?? 2));
  const maxAttempts = 1 + maxRetries;
  const totalTimeoutMs =
    stepTimeoutMs * Math.max(2, actionSteps.length) + maxLoginWaitMs + 120_000;

  const adBlockPart =
    payload.blockAds !== false
      ? `  // Block 3rd-party ad & tracker networks so heavy portals load in ~2s instead of 60s
  await browser.route(
    /(doubleclick\\.net|googlesyndication\\.com|googleadservices\\.com|adtrafficquality\\.google|amazon-adsystem\\.com|pubmatic\\.com|criteo\\.com|taboola\\.com|rubiconproject\\.com|inmobi\\.com|openx\\.net|adkernel\\.com|smartadserver\\.com|eskimi\\.com|adnxs\\.com|adform\\.net|outbrain\\.com|3lift\\.com|lijit\\.com|media\\.net|seedtag\\.com|cootlogix\\.com|kueezrtb\\.com|kueez\\.com|yellowblue\\.io|sparteo\\.com|admatic\\.de|4dex\\.io|presage\\.io|simpli\\.fi|kargo\\.com|casalemedia\\.com|indexww\\.com|startappnetwork\\.com|smaato\\.net|deepintent\\.com|iprom\\.net|adgrx\\.com|ctnsnet\\.com|everesttech\\.com|krushmedia\\.com|yieldmo\\.com|1rx\\.io|chocolateplatform\\.com|nrich\\.ai|eyeota\\.net|pinklion\\.io|vdo\\.ai|smilewanted\\.com|zemanta\\.com|serverbid\\.com|adtarget\\.com|turn\\.com|adotmob\\.com|tynt\\.com|360yield\\.com|fwmrm\\.net|richaudience\\.com|nextmillmedia\\.com|clmbtech\\.com|scorecardresearch\\.com)/i,
    (route) => route.abort()
  );\n\n`
      : '';

  // Do not run upfront login before Step 1 if any step in the prompt initiates signup/registration or phone/email/OTP entry
  const hasSignupStepInPrompt = actionSteps.some((step) =>
    /\b(sign\s*up|signup|register|create\s+account)\b/i.test(step)
  );
  const firstStepInitiatesAuthEntry =
    !hasExplicitLoginStepInPrompt &&
    (hasSignupStepInPrompt ||
      /\b(get\s+started|enter\s+(mobile|phone|email|number)|register|registered|sign\s*up|signup|create\s+account|otp)\b/i.test(
        actionSteps[0] || ''
      ));

  const shouldRunUpfrontLogin =
    !hasSignupStepInPrompt &&
    (hasExplicitLoginStepInPrompt ||
      (payload.loginMode !== 'none' && !firstStepInitiatesAuthEntry));

  const loginHelpersCode = `
  // Helper: Check if a phone number, email, password, or OTP login screen/modal is currently visible (including inside iframes)
  const isLoginInputVisible = async (): Promise<boolean> => {
    return await browser.evaluate(() => {
      const getAllDocs = (): Document[] => {
        const docs: Document[] = [document];
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const frame of iframes) {
          try {
            if (frame.contentDocument) {
              docs.push(frame.contentDocument);
            }
          } catch {
            // cross-origin iframe
          }
        }
        return docs;
      };

      const isVisible = (el: Element) => {
        const htmlEl = el as HTMLElement;
        const win = htmlEl.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = htmlEl.getBoundingClientRect();
        return (
          rect.width > 16 &&
          rect.height > 10 &&
          rect.top >= -20 &&
          rect.top <= (win.innerHeight || 1080)
        );
      };

      const isSearchInput = (el: Element) => {
        const attrs = [
          el.getAttribute('type'),
          el.getAttribute('name'),
          el.getAttribute('id'),
          el.getAttribute('placeholder'),
          el.getAttribute('aria-label'),
          el.getAttribute('role'),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return (
          el.getAttribute('type') === 'search' ||
          el.getAttribute('name') === 'q' ||
          /\\b(search|find|pincode|zip|postal|delivery|newsletter|subscribe|coupon|promo|voucher)\\b/i.test(attrs)
        );
      };

      const path = (window.location.pathname + window.location.search).toLowerCase();
      if (
        path.includes('/login') ||
        path.includes('/signin') ||
        path.includes('/sign-in') ||
        path.includes('/auth') ||
        path.includes('/ap/signin') ||
        path.includes('/otp') ||
        path.includes('/verify')
      ) {
        return true;
      }

      // Check if a visible login/onboarding iframe is open on the page
      const visibleAuthIframe = Array.from(document.querySelectorAll('iframe')).some((frame) => {
        if (!isVisible(frame)) return false;
        const srcAndName = [frame.getAttribute('src'), frame.getAttribute('name'), frame.getAttribute('id')]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return /\\b(login|signin|sign-in|signup|auth|otp|onboarding)\\b/i.test(srcAndName);
      });

      const docs = getAllDocs();
      const inputs: HTMLInputElement[] = [];
      for (const doc of docs) {
        const docInputs = Array.from(
          doc.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
          )
        ).filter(isVisible) as HTMLInputElement[];
        inputs.push(...docInputs);
      }

      // 1. Any visible password field or one-time-code input means login/password/OTP entry is active
      for (const inp of inputs) {
        const type = (inp.getAttribute('type') || '').toLowerCase();
        const auto = (inp.getAttribute('autocomplete') || '').toLowerCase();
        if (type === 'password' || auto === 'current-password' || auto === 'new-password' || auto === 'one-time-code') {
          return true;
        }
      }

      // 2. Multi-box OTP inputs (e.g., 4 to 8 boxes with maxlength="1")
      const singleCharInputs = inputs.filter((inp) => inp.getAttribute('maxlength') === '1');
      if (singleCharInputs.length >= 4) {
        return true;
      }

      // 3. If the user is actively focused inside any non-search input field, keep waiting
      for (const doc of docs) {
        const activeEl = doc.activeElement;
        if (
          activeEl &&
          activeEl.tagName === 'INPUT' &&
          isVisible(activeEl) &&
          !isSearchInput(activeEl)
        ) {
          return true;
        }
      }

      // 4. Match input attributes & surrounding labels for phone/email/password/OTP/login
      for (const inp of inputs) {
        if (isSearchInput(inp)) continue;
        if (inp.disabled) continue;
        const attrs = [
          inp.getAttribute('type'),
          inp.getAttribute('name'),
          inp.getAttribute('id'),
          inp.getAttribute('placeholder'),
          inp.getAttribute('aria-label'),
          inp.getAttribute('autocomplete'),
          inp.closest('label')?.innerText,
          inp.parentElement?.innerText,
          inp.parentElement?.parentElement?.innerText,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (
          /\\b(phone|mobile|email|password|passcode|pin|otp|verification|username|user\\s*id|login|sign\\s*in)\\b/i.test(
            attrs
          )
        ) {
          return true;
        }
      }

      // 5. Check visible headings/modals/buttons for password or OTP prompts across all docs
      for (const doc of docs) {
        const bodyText = (doc.body?.innerText || '').toLowerCase();
        if (
          bodyText.includes('request otp') ||
          bodyText.includes('verify otp') ||
          bodyText.includes('enter otp') ||
          bodyText.includes('resend otp') ||
          bodyText.includes('otp will') ||
          bodyText.includes('otp has been sent') ||
          bodyText.includes('enter password') ||
          bodyText.includes('forgot password') ||
          bodyText.includes('enter verification code') ||
          bodyText.includes('two-step verification')
        ) {
          const nonSearchInputs = inputs.filter((i) => !isSearchInput(i) && !i.disabled);
          if (nonSearchInputs.length > 0) {
            return true;
          }
        }
      }

      return visibleAuthIframe && inputs.filter((i) => !isSearchInput(i) && !i.disabled).length > 0;
    });
  };

  // Helper: Check if an OTP or Password input field on screen (or inside an iframe) has ALREADY been filled by the user
  const isOtpOrPasswordFilledByUser = async (): Promise<boolean> => {
    return await browser.evaluate(() => {
      const docs: Document[] = [document];
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (frame.contentDocument) docs.push(frame.contentDocument);
        } catch {
          // ignore cross-origin
        }
      }

      const isVisible = (el: Element) => {
        const htmlEl = el as HTMLElement;
        const win = htmlEl.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 12 && rect.height > 10;
      };

      for (const doc of docs) {
        const inputs = Array.from(
          doc.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
          )
        ).filter((el) => isVisible(el) && !(el as HTMLInputElement).disabled) as HTMLInputElement[];

        // Check multi-box OTP inputs (4+ single-character inputs)
        const singleCharInputs = inputs.filter((inp) => inp.getAttribute('maxlength') === '1');
        if (singleCharInputs.length >= 4) {
          const filledCount = singleCharInputs.filter((inp) => (inp.value || '').trim().length === 1).length;
          if (filledCount >= 4 && filledCount === singleCharInputs.length) {
            return true;
          }
        }

        for (const inp of inputs) {
          const val = (inp.value || '').trim();
          if (val.length < 4) continue;

          const type = (inp.getAttribute('type') || '').toLowerCase();
          const auto = (inp.getAttribute('autocomplete') || '').toLowerCase();
          const attrs = [
            type,
            auto,
            inp.getAttribute('name'),
            inp.getAttribute('id'),
            inp.getAttribute('placeholder'),
            inp.getAttribute('aria-label'),
            inp.closest('label')?.innerText,
            inp.parentElement?.innerText,
            inp.parentElement?.parentElement?.innerText,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          const isOtpOrPass =
            type === 'password' ||
            auto === 'one-time-code' ||
            auto === 'current-password' ||
            /\\b(otp|verification\\s*code|passcode|password|pin)\\b/i.test(attrs);

          if (isOtpOrPass) {
            return true;
          }
        }
      }
      return false;
    });
  };

  // Helper: Check if an OTP / Verification Code input or prompt is currently visible (distinct from standard email/password login)
  const isOtpInputVisible = async (): Promise<boolean> => {
    return await browser.evaluate(() => {
      const docs: Document[] = [document];
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        try {
          if (frame.contentDocument) docs.push(frame.contentDocument);
        } catch {
          // ignore cross-origin
        }
      }

      const isVisible = (el: Element) => {
        const htmlEl = el as HTMLElement;
        const win = htmlEl.ownerDocument?.defaultView || window;
        const style = win.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 12 && rect.height > 10;
      };

      const path = (window.location.pathname + window.location.search).toLowerCase();
      if (path.includes('/otp') || path.includes('/verify')) {
        return true;
      }

      for (const doc of docs) {
        const inputs = Array.from(
          doc.querySelectorAll(
            'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'
          )
        ).filter((el) => isVisible(el) && !(el as HTMLInputElement).disabled) as HTMLInputElement[];

        // Multi-box OTP inputs (4+ single-character inputs)
        const singleCharInputs = inputs.filter((inp) => inp.getAttribute('maxlength') === '1');
        if (singleCharInputs.length >= 4) {
          return true;
        }

        for (const inp of inputs) {
          const auto = (inp.getAttribute('autocomplete') || '').toLowerCase();
          if (auto === 'one-time-code') {
            return true;
          }
          const attrs = [
            inp.getAttribute('name'),
            inp.getAttribute('id'),
            inp.getAttribute('placeholder'),
            inp.getAttribute('aria-label'),
            inp.closest('label')?.innerText,
            inp.parentElement?.innerText,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

          if (/\\b(otp|one[\\s-]*time|verification\\s*code|verify\\s*code|security\\s*code|passcode|pin)\\b/i.test(attrs)) {
            return true;
          }
        }

        const bodyText = (doc.body?.innerText || '').toLowerCase();
        if (
          (bodyText.includes('enter otp') ||
            bodyText.includes('verify otp') ||
            bodyText.includes('resend otp') ||
            bodyText.includes('otp has been sent') ||
            bodyText.includes('otp will') ||
            bodyText.includes('enter verification code') ||
            bodyText.includes('two-step verification')) &&
          inputs.length > 0
        ) {
          return true;
        }
      }
      return false;
    });
  };

  // Helper: Retrieve credentials registered/entered by the app during signup or earlier steps in this test session
  const getCapturedCredentials = async (
    registeredInStep: boolean,
    fallbackUser: string,
    fallbackPassword: string
  ): Promise<{ user: string; password: string; hasAppCredentials: boolean }> => {
    const fromBrowser = await browser.evaluate(() => {
      try {
        return {
          user: window.localStorage.getItem('__e2eCapturedUser') || '',
          password: window.localStorage.getItem('__e2eCapturedPassword') || '',
          registeredByApp: window.localStorage.getItem('__e2eRegisteredByApp') === 'true',
        };
      } catch {
        return { user: '', password: '', registeredByApp: false };
      }
    });

    const user = fromBrowser.user || (registeredInStep ? fallbackUser : '') || ${JSON.stringify(payload.loginUser || '')};
    const password =
      fromBrowser.password || (registeredInStep ? fallbackPassword : '') || ${JSON.stringify(payload.loginPassword || '')};
    const hasAppCredentials = Boolean(
      (user && password) &&
        (registeredInStep ||
          fromBrowser.registeredByApp ||
          Boolean(fromBrowser.user && fromBrowser.password) ||
          Boolean(${Boolean(payload.loginUser && payload.loginPassword)}))
    );

    return { user, password, hasAppCredentials };
  };

  // Track whether manual login has already been completed in this session
  let hasCompletedLoginSession = false;

  // Helper: Check if a "Login" or "Sign In" trigger button/link is visible in the page header
  const hasVisibleLoginTriggerButton = async (): Promise<boolean> => {
    return await browser.evaluate(() => {
      const isVisible = (el: Element) => {
        const htmlEl = el as HTMLElement;
        const style = window.getComputedStyle(htmlEl);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = htmlEl.getBoundingClientRect();
        return rect.width > 20 && rect.height > 10 && rect.top >= 0 && rect.top <= 250;
      };
      const triggers = Array.from(
        document.querySelectorAll('a, button, [role="button"], span')
      ).filter(isVisible);
      return triggers.some((el) => {
        const txt = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || '').trim();
        return /^(login|log\s+in|sign\s+in)$/i.test(txt);
      });
    });
  };

  // Helper: Ensure the login / phone number / password input screen is open (retries up to maxTries if it didn't open on first click)
  const ensureLoginScreenOpenWithRetry = async (maxTries = 3) => {
    if (hasCompletedLoginSession && !(await isLoginInputVisible())) {
      return false;
    }
    for (let tryIdx = 1; tryIdx <= maxTries; tryIdx++) {
      if (await isLoginInputVisible()) {
        return true;
      }
      // If there is no "Login" / "Sign In" button in the header and no login input is visible, user is already logged in
      if (!(await hasVisibleLoginTriggerButton())) {
        return false;
      }
      try {
        await agent.act(
          tryIdx === 1
            ? 'Click the explicit "Login" or "Sign In" button/link on the page to open the phone number, email, or password login screen. NEVER click on a logged-in user’s name/profile menu and NEVER click Logout.'
            : \`Attempt \${tryIdx}: Click the explicit "Login" or "Sign In" button/link so the phone number, email, or password input field becomes visible. Do not click a user profile menu or Logout.\`,
          { maxSteps: 8, maxModelCalls: 8, timeout: 30000 }
        );
      } catch {
        // continue checking if login screen opened
      }
      await new Promise((r) => setTimeout(r, 1500));
      if (await isLoginInputVisible()) {
        return true;
      }
    }
    return await isLoginInputVisible();
  };

  // Helper: Pre-fill credentials if provided and wait in browser for user to complete Phone / Password / OTP Login
  const handleLoginAndWaitForCompletion = async () => {
    if (hasCompletedLoginSession && !(await isLoginInputVisible())) {
      return;
    }
    await ensureLoginScreenOpenWithRetry(3);
    ${
      payload.loginUser
        ? `try {
      await agent.act(
        ${JSON.stringify(
          payload.loginPassword
            ? `If a login screen is visible: enter "${payload.loginUser}" and password "${payload.loginPassword}", and click Sign In / Continue.`
            : `If a phone or email login input is visible: enter "${payload.loginUser}" and click Continue / Request OTP so the user can enter their password or OTP.`
        )},
        { maxSteps: 12, maxModelCalls: 12, timeout: 45000 }
      );
    } catch {
      // Fall through to manual wait poll
    }`
        : ''
    }

    // Give the page 2 seconds to transition to Password / OTP field if Continue was just clicked
    await new Promise((r) => setTimeout(r, 2000));

    const needsManualEntry =
      !hasCompletedLoginSession &&
      (${!payload.loginUser || !payload.loginPassword ? 'true' : 'false'} ||
        (await isLoginInputVisible()));

    if (needsManualEntry) {
      await browser.evaluate(() => {
        (window as unknown as { __e2eLoginConfirmed?: boolean }).__e2eLoginConfirmed = false;
        let b = document.getElementById('e2e-login-wait-banner');
        if (!b) {
          b = document.createElement('div');
          b.id = 'e2e-login-wait-banner';
          b.style.cssText =
            'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1e293b;color:#ffffff;padding:10px 18px;border-radius:10px;font-family:sans-serif;font-size:13px;font-weight:600;box-shadow:0 10px 30px rgba(0,0,0,0.55);border:2px solid #f59e0b;display:flex;align-items:center;gap:14px;max-width:92vw;';

          const msg = document.createElement('span');
          msg.id = 'e2e-login-wait-msg';
          msg.textContent =
            '⏳ PAUSED FOR OTP / PASSWORD / LOGIN: Please enter your dynamic OTP or credentials in the browser (then click Login/Submit, or click "✓ Done — Continue Test").';

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = '✓ Done — Continue Test';
          btn.style.cssText =
            'background:#16a34a;color:#ffffff;border:none;padding:7px 14px;border-radius:6px;font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
          btn.onclick = () => {
            (window as unknown as { __e2eLoginConfirmed?: boolean }).__e2eLoginConfirmed = true;
            btn.textContent = '✓ Resuming...';
            btn.style.background = '#2563eb';
          };

          b.appendChild(msg);
          b.appendChild(btn);
          document.body.appendChild(b);
        }
        return true;
      });

      const waitStartedAt = Date.now();
      const minGracePeriodMs = 15000; // Always wait at least 15s unless user clicks Done or finishes typing OTP
      let consecutiveClearPolls = 0;
      let consecutiveOtpFilledPolls = 0;

      await expect
        .poll(
          async () => {
            const userClickedDone = await browser.evaluate(
              () => Boolean((window as unknown as { __e2eLoginConfirmed?: boolean }).__e2eLoginConfirmed)
            );
            if (userClickedDone) {
              return true;
            }

            // If user typed the dynamic OTP/password into the field and stopped typing for ~6s (3 polls), auto-resume so agent can click Submit/Login
            const otpFilled = await isOtpOrPasswordFilledByUser();
            if (otpFilled) {
              consecutiveOtpFilledPolls++;
              if (consecutiveOtpFilledPolls >= 3) {
                return true;
              }
            } else {
              consecutiveOtpFilledPolls = 0;
            }

            const loginStillVisible = await isLoginInputVisible();
            if (loginStillVisible) {
              consecutiveClearPolls = 0;
              return false;
            }

            // Do not auto-resume during the initial 15s grace window while user focuses inputs or page transitions to password/OTP
            if (Date.now() - waitStartedAt < minGracePeriodMs) {
              return false;
            }

            // Require 5 consecutive polls (10+ seconds) with no login/password/OTP fields before auto-resuming
            consecutiveClearPolls++;
            return consecutiveClearPolls >= 5;
          },
          {
            timeout: ${maxLoginWaitMs},
            interval: 2000,
            message: 'Waiting in browser for user login / password / OTP entry to complete',
          }
        )
        .toBe(true);

      await browser.evaluate(() => {
        document.getElementById('e2e-login-wait-banner')?.remove();
        // Blur any active element and close any open hover/dropdown menu before proceeding to Step 2
        if (document.activeElement && typeof (document.activeElement as HTMLElement).blur === 'function') {
          (document.activeElement as HTMLElement).blur();
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      });
      hasCompletedLoginSession = true;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };`;

  const loginBlock = shouldRunUpfrontLogin
    ? `\n  // 1b. Upfront Login & Phone Input Retry Handler\n  await handleLoginAndWaitForCompletion();`
    : '';

  const verificationQuery = (
    payload.assertionPrompt?.trim() || cleanPrompt
  ).slice(0, 240);

  const needsCartViewBeforeAssert =
    /\b(cart|bag|basket)\b/i.test(payload.assertionPrompt || '') &&
    !/\b(order\s+listing|orders|history|profile|account)\b/i.test(
      actionSteps[actionSteps.length - 1] || ''
    );

  const ensureCartVisibleBlock = needsCartViewBeforeAssert
    ? `
  // 2c. Ensure the shopping cart page is open so cart items and prices are visible for verification
  const isOnCartPage = await browser.evaluate(() => {
    const url = window.location.href.toLowerCase();
    return url.includes('cart') || url.includes('bag') || url.includes('basket') || url.includes('checkout');
  });
  if (!isOnCartPage) {
    try {
      await agent.act(
        'Navigate to or open the shopping cart page (click the "Cart" or "Go to cart" link/button in the header or page) so that all items in the cart and their prices are visible on screen.',
        { maxSteps: 12, maxModelCalls: 12, timeout: 45000 }
      );
    } catch {
      // Proceed to observation capture even if navigation attempt timed out
    }
  }
`
    : '';

  const originKey = normalizeOriginKey(payload.url);
  const sessionFilename = getHostSessionFilename(payload.url, payload.prompt);
  const useZeroLlmCache = Boolean(payload.useCache);
  const reuseSavedSession = Boolean(payload.reuseSession);

  const assertBlock =
    payload.assertionPrompt && payload.assertionPrompt.trim().length > 0
      ? `\n\n  // 5. Semantic & visual verification via agent.assert (or Zero-LLM verification when replayed from cache)
  if (useZeroLlmCache && replayedStepsCount === actionSteps.length && highlightInfo.bestScore >= 2) {
    console.log(\`⚡ [Zero-LLM Assertion Verified] Confirmed "\${${JSON.stringify(payload.assertionPrompt.trim())}}" directly from DOM state ("\${highlightInfo.matchedText.slice(0, 120)}") — 0 LLM calls, $0 cost!\`);
  } else {
    await agent.assert(${JSON.stringify(payload.assertionPrompt.trim())}, { screenshot: true, vision: true, timeout: 60000 });
  }`
      : '';

  const videoOption = payload.recordVideo ? `, video: 'on'` : '';

  const testTitle = payload.testrailCaseId
    ? `[${payload.testrailCaseId}] ${firstLine}`
    : `Prompt Run: ${firstLine}`;

  const autoFillEnabled = payload.autoFillForms !== false;
  let customExtra: Record<string, string | number | boolean> = {};
  if (payload.formData?.customJson?.trim()) {
    try {
      const parsed = JSON.parse(payload.formData.customJson.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        customExtra = parsed;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  const hasRegistrationInPrompt = /\b(sign\s*up|signup|register|create\s+account)\b/i.test(
    payload.prompt
  );
  const configuredEmail = payload.loginUser || payload.formData?.email || 'qa.tester@example.com';
  const defaultSignupEmail =
    hasRegistrationInPrompt &&
    !payload.loginUser &&
    (!payload.formData?.email || payload.formData.email === 'qa.tester@example.com')
      ? `qa.tester.${Date.now().toString().slice(-5)}@example.com`
      : configuredEmail;

  const resolvedFormData = {
    fullName: payload.formData?.fullName || 'Test User',
    firstName: payload.formData?.firstName || 'Test',
    lastName: payload.formData?.lastName || 'User',
    email: defaultSignupEmail,
    phone: payload.loginUser || payload.formData?.phone || '9876543210',
    password: payload.loginPassword || 'TestPassword123!',
    company: payload.formData?.company || 'TesterArmy QA',
    address: payload.formData?.address || '123 Tech Park Road',
    city: payload.formData?.city || 'Bengaluru',
    postalCode: payload.formData?.postalCode || '560001',
    country: payload.formData?.country || 'India',
    message:
      payload.formData?.message ||
      'Automated E2E test form submission verification.',
    ...customExtra,
  };

  const actParamsLine = `\n          params: { ${autoFillEnabled ? `formData: ${JSON.stringify(resolvedFormData)}, ` : ''}...(capturedCreds.hasAppCredentials ? { registeredCredentials: { email: capturedCreds.user, username: capturedCreds.user, password: capturedCreds.password } } : {}), ...(executionContext ? { executionContext } : {}) },`;

  return `import fs from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';

test(
  ${JSON.stringify(testTitle)},
  { timeout: ${totalTimeoutMs}${videoOption} },
  async ({ app, agent, browser }) => {
${adBlockPart}  // 1. Open Target URL and capture initial screenshot
  await app.open(${JSON.stringify(payload.url)});

  // Feature #14: Restore saved login session state (cookies + localStorage + sessionStorage) if enabled
  const reuseSavedSession = ${reuseSavedSession};
  const sessionFilePath = '.e2e/sessions/${sessionFilename}';
  if (reuseSavedSession) {
    try {
      const rawSession = await fs.readFile(sessionFilePath, 'utf-8');
      const parsedSession = JSON.parse(rawSession) as {
        savedAt?: string;
        localStorage?: Record<string, string>;
        sessionStorage?: Record<string, string>;
        cookies?: string;
      };
      const restored = await browser.evaluate((sess) => {
        try {
          let count = 0;
          for (const [k, v] of Object.entries(sess.localStorage || {})) {
            if (!k.startsWith('__e2eCurrentStep')) {
              window.localStorage.setItem(k, String(v));
              count++;
            }
          }
          for (const [k, v] of Object.entries(sess.sessionStorage || {})) {
            window.sessionStorage.setItem(k, String(v));
            count++;
          }
          if (sess.cookies) {
            for (const part of sess.cookies.split(';')) {
              const trimmed = part.trim();
              if (trimmed) {
                document.cookie = trimmed + '; path=/';
                count++;
              }
            }
          }
          if (count > 0) {
            window.location.reload();
            return true;
          }
        } catch {
          // ignore
        }
        return false;
      }, parsedSession);
      if (restored) {
        await new Promise((r) => setTimeout(r, 1200));
        console.log(\`🔐 [Session Reused] Restored authenticated session from \${sessionFilePath} (saved \${parsedSession.savedAt || 'previously'}).\`);
      }
    } catch {
      // No saved session yet for this host
    }
  }

  await app.screenshot('01-initial-page-loaded');
${loginHelpersCode}${loginBlock}

  // Feature #15: Load Zero-LLM Recorded Action Cache (.e2e/action-cache.json)
  const useZeroLlmCache = ${useZeroLlmCache};
  const originKey = ${JSON.stringify(originKey)};
  const actionCachePath = '.e2e/action-cache.json';
  let actionCache: Record<string, Array<Record<string, unknown>>> = {};
  try {
    const rawCache = await fs.readFile(actionCachePath, 'utf-8');
    actionCache = JSON.parse(rawCache);
  } catch {
    actionCache = {};
  }

  const replaySessionEmail = ${JSON.stringify(resolvedFormData.email)};
  let replayedStepsCount = 0;

  const replayRecordedActionsInBrowser = async (
    recordedActions: Array<Record<string, unknown>>,
    useDynamicEmail: boolean
  ): Promise<boolean> => {
    for (const act of recordedActions) {
      let matched = false;
      for (let poll = 0; poll < 10; poll++) {
        matched = await browser.evaluate(
          (arg) => {
            const a = arg.act as {
              kind?: string;
              tag?: string;
              id?: string;
              testId?: string;
              name?: string;
              type?: string;
              placeholder?: string;
              ariaLabel?: string;
              role?: string;
              href?: string;
              text?: string;
              cssPath?: string;
              value?: string;
              isEmail?: boolean;
            };
            (window as unknown as { __e2eReplayingCache?: boolean }).__e2eReplayingCache = true;

            const isVis = (el: Element | null): el is HTMLElement => {
              if (!el) return false;
              const h = el as HTMLElement;
              const st = window.getComputedStyle(h);
              if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
              const r = h.getBoundingClientRect();
              return r.width > 4 && r.height > 4;
            };

            let target: HTMLElement | null = null;
            if (a.testId) {
              const cand = document.querySelector(\`[data-testid="\${CSS.escape(a.testId)}"], [data-test="\${CSS.escape(a.testId)}"], [data-qa="\${CSS.escape(a.testId)}"]\`);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.id) {
              const cand = document.getElementById(a.id);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.name) {
              const cand = document.querySelector(\`\${a.tag || '*'}[name="\${CSS.escape(a.name)}"]\`);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.placeholder) {
              const cand = document.querySelector(\`[placeholder="\${CSS.escape(a.placeholder)}"]\`);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.ariaLabel) {
              const cand = document.querySelector(\`[aria-label="\${CSS.escape(a.ariaLabel)}"]\`);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.text && a.kind === 'click') {
              const needle = a.text.trim().toLowerCase();
              const clickables = Array.from(
                document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], label')
              ).filter(isVis);
              target =
                clickables.find((el) => ((el.innerText || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().toLowerCase()) === needle) ||
                clickables.find((el) => ((el.innerText || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().toLowerCase()).includes(needle)) ||
                null;
            }
            if (!target && a.href && a.tag === 'a') {
              const cand = document.querySelector(\`a[href="\${CSS.escape(a.href)}"]\`);
              if (isVis(cand)) target = cand;
            }
            if (!target && a.cssPath) {
              try {
                const cand = document.querySelector(a.cssPath);
                if (isVis(cand)) target = cand;
              } catch {
                // ignore invalid selector
              }
            }

            if (!target) {
              (window as unknown as { __e2eReplayingCache?: boolean }).__e2eReplayingCache = false;
              return false;
            }

            target.scrollIntoView({ behavior: 'instant', block: 'center' });

            if (a.kind === 'fill') {
              const valToSet = a.isEmail && arg.useDynamicEmail ? arg.dynamicEmail : (a.value ?? '');
              const inp = target as HTMLInputElement | HTMLTextAreaElement;
              inp.focus();
              const proto =
                inp.tagName.toLowerCase() === 'textarea'
                  ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
              const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (nativeSetter) {
                nativeSetter.call(inp, valToSet);
              } else {
                inp.value = valToSet;
              }
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (a.kind === 'select') {
              const sel = target as HTMLSelectElement;
              sel.value = a.value ?? '';
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              target.click();
            }

            (window as unknown as { __e2eReplayingCache?: boolean }).__e2eReplayingCache = false;
            return true;
          },
          {
            act,
            useDynamicEmail,
            dynamicEmail: replaySessionEmail,
          }
        );

        if (matched) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      if (!matched) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 380));
    }
    return true;
  };

  // 2. Execute each action step sequentially with Multi-Platform ([WEB] <-> [MOBILE] <-> [DESKTOP]) Switching + Generic Record Correlation + Zero-LLM Replay (#15)
  const actionSteps: string[] = ${JSON.stringify(actionSteps, null, 2)};
  const configuredDesktopExe = ${JSON.stringify(payload.desktopExePath?.trim() || 'notepad.exe')};
  const isHybridTarget = ${JSON.stringify(payload.targetType === 'hybrid')};
  let sharedHybridContext = '';

  const syncBrowserCorrelationToServer = async (stepNote?: string): Promise<string> => {
    try {
      const browserCorr = await browser.evaluate(() => {
        let enteredFields: Record<string, string> = {};
        let capturedIds: Record<string, string> = {};
        try {
          const raw = window.localStorage.getItem('__e2eRecordCorrelation');
          if (raw) {
            const parsed = JSON.parse(raw);
            enteredFields = parsed.enteredFields || {};
            capturedIds = parsed.capturedIds || {};
          }
        } catch {}

        const uiConfirmations: string[] = [];
        const alertNodes = Array.from(
          document.querySelectorAll(
            '[role="alert"], [role="status"], .toast, .notification, .alert, tbody tr:first-child, ul li:first-child'
          )
        ).slice(0, 6);
        for (const n of alertNodes) {
          const txt = ((n as HTMLElement).innerText || '').replace(/\\s+/g, ' ').trim();
          if (txt.length >= 4 && txt.length <= 220) {
            uiConfirmations.push(txt);
          }
        }
        return {
          enteredFields,
          capturedIds,
          uiConfirmations,
          rawTextToScan: uiConfirmations.join(' '),
        };
      });

      const res = await fetch('http://127.0.0.1:${PORT}/api/correlation/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...browserCorr,
          platformNote: stepNote,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { hint?: string };
        return data.hint || '';
      }
    } catch {}
    return '';
  };

  let hasRegisteredInSession = false;
  for (let stepIdx = 0; stepIdx < actionSteps.length; stepIdx++) {
    const rawStepText = actionSteps[stepIdx];
    const isExplicitDesktopStep =
      /^(\\[(desktop|windows|exe)\\]\\s*[:.-]?\\s*|desktop\\s*[:.-]\\s*)/i.test(rawStepText) ||
      (isHybridTarget &&
        !/^\\[(web|mobile)\\]/i.test(rawStepText) &&
        /\\b(desktop\\s+app|windows\\s+app|exe\\s+app|evv\\s+desktop|evv\\s+windows|from\\s+desktop|in\\s+desktop|on\\s+desktop|launch\\s+desktop)\\b/i.test(
          rawStepText
        ));

    const isExplicitMobileStep =
      /^(\\[(mobile|android|ios)\\]\\s*[:.-]?\\s*|mobile\\s*[:.-]\\s*)/i.test(rawStepText) ||
      (isHybridTarget &&
        !/^\\[(web|desktop)\\]/i.test(rawStepText) &&
        /\\b(mobile\\s+app|from\\s+mobile|in\\s+mobile|on\\s+mobile|mobile\\s+view)\\b/i.test(
          rawStepText
        ));

    if (isExplicitDesktopStep) {
      console.log(
        \`🖥️ [Hybrid Step \${stepIdx + 1}/\${actionSteps.length}] Switching to Windows Desktop App ("\${configuredDesktopExe}"): \${rawStepText}\`
      );
      const corrHint = await syncBrowserCorrelationToServer();

      const hybridRes = await fetch('http://127.0.0.1:${PORT}/api/desktop/hybrid-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exePath: configuredDesktopExe,
          stepNumber: stepIdx + 1,
          stepText: rawStepText,
          sharedContext: [corrHint, sharedHybridContext].filter(Boolean).join(' | '),
        }),
      });
      const hybridData = (await hybridRes.json()) as {
        ok: boolean;
        summary?: string;
        windowTitle?: string;
        visibleValues?: string;
        error?: string;
      };
      if (!hybridRes.ok || !hybridData.ok) {
        throw new Error(hybridData.error || \`Hybrid Desktop Step \${stepIdx + 1} failed.\`);
      }
      sharedHybridContext = \`Desktop Step \${stepIdx + 1} completed on "\${hybridData.windowTitle || configuredDesktopExe}": \${hybridData.summary || ''}\`;
      continue;
    }

    if (isExplicitMobileStep) {
      console.log(
        \`📱 [Hybrid Step \${stepIdx + 1}/\${actionSteps.length}] Switching to Mobile Viewport (390x844 Touch): \${rawStepText}\`
      );
      const corrHint = await syncBrowserCorrelationToServer();

      const mobileRes = await fetch('http://127.0.0.1:${PORT}/api/mobile/hybrid-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mobileTargetUrl: ${JSON.stringify(payload.url)},
          stepNumber: stepIdx + 1,
          stepText: rawStepText,
          sharedContext: [corrHint, sharedHybridContext].filter(Boolean).join(' | '),
        }),
      });
      const mobileData = (await mobileRes.json()) as {
        ok: boolean;
        summary?: string;
        error?: string;
      };
      if (!mobileRes.ok || !mobileData.ok) {
        throw new Error(mobileData.error || \`Hybrid Mobile Step \${stepIdx + 1} failed.\`);
      }
      sharedHybridContext = \`Mobile Step \${stepIdx + 1} completed: \${mobileData.summary || ''}\`;
      continue;
    }

    const currentStepText = rawStepText.replace(/^\\[web\\]\\s*[:.-]?\\s*/i, '').trim();
    const stepCacheKey = \`\${originKey}::\${currentStepText.trim().toLowerCase()}\`;
    const isSignupStep =
      /\\b(sign\\s*up|signup|register|create\\s+account)\\b/i.test(currentStepText) &&
      !/\\b(once\\s+registered|after\\s+register|same\\s+credentials?)\\b/i.test(currentStepText);
    const remainingStepsHaveSignup = actionSteps
      .slice(stepIdx + 1)
      .some(
        (s) =>
          /\\b(sign\\s*up|signup|register|create\\s+account)\\b/i.test(s) &&
          !/\\b(once\\s+registered|after\\s+register|same\\s+credentials?)\\b/i.test(s)
      );
    const nextStepWillLogin =
      stepIdx + 1 < actionSteps.length &&
      /\\b(login|log\\s+in|sign\\s+in|signin|same\\s+credentials?|authenticate)\\b/i.test(
        actionSteps[stepIdx + 1]
      );

    // Clear per-step DOM action buffer before starting this step
    await browser.evaluate(() => {
      try {
        window.localStorage.setItem('__e2eCurrentStepActions', '[]');
      } catch {}
    });

    // Feature #15: Try Zero-LLM Replay first (supports multi-variant paths for different logged-in user views)
    const variantsKey = \`__variants__::\${stepCacheKey}\`;
    const primaryVariant = actionCache[stepCacheKey];
    const storedVariants = (actionCache[variantsKey] as unknown as Array<Array<Record<string, unknown>>>) || [];
    const candidateVariants: Array<Array<Record<string, unknown>>> = [];
    if (Array.isArray(primaryVariant) && primaryVariant.length > 0) {
      candidateVariants.push(primaryVariant);
    }
    if (Array.isArray(storedVariants)) {
      for (const v of storedVariants) {
        if (Array.isArray(v) && v.length > 0 && JSON.stringify(v) !== JSON.stringify(primaryVariant)) {
          candidateVariants.push(v);
        }
      }
    }

    if (useZeroLlmCache && candidateVariants.length > 0) {
      const replayStart = Date.now();
      let replayedVariant: Array<Record<string, unknown>> | null = null;
      for (const variant of candidateVariants) {
        const ok = await replayRecordedActionsInBrowser(
          variant,
          isSignupStep || hasRegisteredInSession
        );
        if (ok) {
          replayedVariant = variant;
          break;
        }
      }
      if (replayedVariant) {
        if (isSignupStep) {
          hasRegisteredInSession = true;
        }
        replayedStepsCount++;
        const replaySec = ((Date.now() - replayStart) / 1000).toFixed(1);
        console.log(
          \`⚡ [Zero-LLM Cache Replay] Step \${stepIdx + 1}/\${actionSteps.length} ("\${currentStepText}") replayed \${replayedVariant.length} recorded DOM action(s) in \${replaySec}s (0 LLM calls, $0 cost)\`
        );
        await app.screenshot(\`0\${stepIdx + 2}-step-\${stepIdx + 1}-zero-llm-replay\`);
        continue;
      } else {
        console.log(
          \`🔄 [Cache Self-Heal / New User View] Recorded selector not visible for current user on Step \${stepIdx + 1}; invoking AI Agent to learn this view...\`
        );
      }
    }

    for (let attempt = 1; attempt <= ${maxAttempts}; attempt++) {
      try {
        const capturedCreds = await getCapturedCredentials(
          hasRegisteredInSession,
          ${JSON.stringify(resolvedFormData.email)},
          ${JSON.stringify(resolvedFormData.password)}
        );
        const otpAlreadyEntered = await isOtpOrPasswordFilledByUser();
        const defaultLoginShownBeforeSignup = isSignupStep && (await isLoginInputVisible());

        const contextHints: string[] = [];
        if (sharedHybridContext) {
          contextHints.push(
            \`Previous Windows Desktop step result: \${sharedHybridContext}. The browser session is still open—if this step asks to verify synced data from the desktop app, refresh or navigate to the relevant page as needed.\`
          );
        }
        if (otpAlreadyEntered) {
          contextHints.push(
            'The user has ALREADY manually entered the dynamic OTP/password into the input field in the browser. Keep that user-entered value intact (do NOT clear or overwrite it, and do NOT report AUTH_CREDENTIAL_UNAVAILABLE), fill any other requested fields, and click the LOGIN / Verify / Submit / Continue / Register button.'
          );
        }
        if (defaultLoginShownBeforeSignup) {
          contextHints.push(
            \`The application is currently showing a Login screen by default, but this step asks to SIGN UP / REGISTER a new user. Do NOT attempt to log in on this screen and do NOT report AUTH_CREDENTIAL_UNAVAILABLE. Click the "Sign up" / "Register" / "Create account" link or button to open the signup form, fill in the registration details (using email "\${${JSON.stringify(resolvedFormData.email)}}" and password "\${${JSON.stringify(resolvedFormData.password)}}" from formData unless specified otherwise), and submit the registration form.\`
          );
        }
        if (capturedCreds.hasAppCredentials && !otpAlreadyEntered && !isSignupStep) {
          contextHints.push(
            \`Credentials registered/entered by the application in this session are Email/Username: "\${capturedCreds.user}" and Password: "\${capturedCreds.password}". When logging in with the same or registered credentials, automatically enter "\${capturedCreds.user}" and password "\${capturedCreds.password}" and click Login / Sign In without waiting for the user.\`
          );
        }
        if (attempt > 1) {
          contextHints.push('Retry attempt: continue from the current page state and complete this step.');
        }

        const executionContext = contextHints.join(' ');
        if (executionContext) {
          console.log(\`[Step \${stepIdx + 1}/\${actionSteps.length} Context (Attempt \${attempt})] \${executionContext}\`);
        }

        await agent.act(currentStepText, {${actParamsLine}
          maxSteps: 50,
          maxModelCalls: 50,
          timeout: ${stepTimeoutMs},
        });

        // Sync Generic Record Correlation (captured IDs, entered form fields, newly added rows/alerts) after each Web step
        const latestCorrHint = await syncBrowserCorrelationToServer(\`[WEB Step \${stepIdx + 1}]: \${currentStepText}\`);
        if (latestCorrHint) {
          sharedHybridContext = latestCorrHint;
        }

        // Feature #15: Save recorded DOM actions for this step into .e2e/action-cache.json
        const recordedForStep = await browser.evaluate(() => {
          try {
            return JSON.parse(window.localStorage.getItem('__e2eCurrentStepActions') || '[]');
          } catch {
            return [];
          }
        });
        if (Array.isArray(recordedForStep) && recordedForStep.length > 0) {
          actionCache[stepCacheKey] = recordedForStep;
          const existingVars = Array.isArray(actionCache[variantsKey])
            ? (actionCache[variantsKey] as unknown as Array<Array<Record<string, unknown>>>)
            : [];
          const sig = JSON.stringify(recordedForStep);
          const filteredVars = existingVars.filter((v) => JSON.stringify(v) !== sig);
          filteredVars.unshift(recordedForStep);
          (actionCache as Record<string, unknown>)[variantsKey] = filteredVars.slice(0, 4);
          await fs.mkdir('.e2e', { recursive: true });
          await fs.writeFile(actionCachePath, JSON.stringify(actionCache, null, 2), 'utf-8');
          console.log(
            \`💾 [Action Recorder] Recorded \${recordedForStep.length} DOM action(s) for Step \${stepIdx + 1} (next run will replay with 0 LLM calls!).\`
          );
        }

        if (isSignupStep) {
          hasRegisteredInSession = true;
        }

        const postStepCreds = await getCapturedCredentials(
          hasRegisteredInSession,
          ${JSON.stringify(resolvedFormData.email)},
          ${JSON.stringify(resolvedFormData.password)}
        );
        const otpVisible = await isOtpInputVisible();
        const loginVisible = await isLoginInputVisible();

        // Rule 1 & 2:
        // - Always wait for user when an OTP / verification code screen is visible (otpVisible)
        // - Wait for user when a login screen is visible AND credentials were NOT provided/registered by the app (!postStepCreds.hasAppCredentials) AND no signup/login step is pending
        // - Never wait on a default login screen when a signup step is running or about to run
        if (
          otpVisible ||
          (loginVisible &&
            !postStepCreds.hasAppCredentials &&
            !isSignupStep &&
            !remainingStepsHaveSignup &&
            !nextStepWillLogin)
        ) {
          console.log('[Login / OTP Wait] OTP or manual login screen detected (not provided by app). Pausing for user input...');
          hasCompletedLoginSession = false;
          await handleLoginAndWaitForCompletion();
          if (stepIdx === actionSteps.length - 1 && (await isOtpOrPasswordFilledByUser())) {
            await agent.act(
              'Click the LOGIN / Verify / Submit / Register button to submit the user-entered OTP/password.',
              {${actParamsLine} maxSteps: 15, maxModelCalls: 15, timeout: 60000 }
            );
          }
        } else if (
          loginVisible &&
          postStepCreds.hasAppCredentials &&
          !nextStepWillLogin &&
          !remainingStepsHaveSignup
        ) {
          console.log(
            \`[Auto-Login] Login screen detected with app-registered credentials ("\${postStepCreds.user}"). Logging in automatically without waiting for user...\`
          );
          await agent.act(
            \`Enter Email/Username "\${postStepCreds.user}" and Password "\${postStepCreds.password}" into the login form and click the Login / Sign In button.\`,
            {${actParamsLine} maxSteps: 15, maxModelCalls: 15, timeout: 45000 }
          );
        }
        break;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Do not retry non-recoverable LLM provider / API key / billing errors
        if (
          /MODEL_PROVIDER_FAILED|credit balance is too low|invalid x-api-key|Incorrect API key|quota exceeded/i.test(
            errMsg
          )
        ) {
          console.log(
            \`[Provider Error] Non-retryable LLM provider error on Step \${stepIdx + 1}/\${actionSteps.length}: \${errMsg}\`
          );
          throw err;
        }

        const isAuthBlocked =
          /AUTH_CREDENTIAL_UNAVAILABLE|AUTHENTICATION_FAILED|AUTH_CREDENTIAL_INVALID/i.test(
            errMsg
          );
        const loginModalOpen = await isLoginInputVisible();
        const otpVisibleOnErr = await isOtpInputVisible();
        const errCreds = await getCapturedCredentials(
          hasRegisteredInSession,
          ${JSON.stringify(resolvedFormData.email)},
          ${JSON.stringify(resolvedFormData.password)}
        );

        // Never pause for manual login credentials during or before a Signup/Registration step unless an OTP screen is visible
        if ((isSignupStep || remainingStepsHaveSignup) && !otpVisibleOnErr) {
          if (attempt >= ${maxAttempts}) {
            throw err;
          }
          console.log(
            \`[Signup Retry] Step \${stepIdx + 1}/\${actionSteps.length} (Attempt \${attempt}/\${${maxAttempts}}) retrying signup step without manual login wait ("\${errMsg.slice(0, 120)}")...\`
          );
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (isAuthBlocked || loginModalOpen) {
          // If credentials were registered by the app and this is NOT an OTP screen, log in automatically instead of waiting for user
          if (errCreds.hasAppCredentials && !otpVisibleOnErr) {
            console.log(
              \`[Auto-Login Recovery] Step \${stepIdx + 1}/\${actionSteps.length} (Attempt \${attempt}/\${${maxAttempts}}) logging in automatically with app-registered credentials ("\${errCreds.user}")...\`
            );
            try {
              await agent.act(
                \`Enter Email/Username "\${errCreds.user}" and Password "\${errCreds.password}" into the login form and click the Login / Sign In button.\`,
                { maxSteps: 15, maxModelCalls: 15, timeout: 45000 }
              );
            } catch {
              // continue to retry step
            }
            if (attempt < ${maxAttempts}) {
              continue;
            }
          } else {
            console.log(
              \`[Retry & OTP/Login Recovery] Step \${stepIdx + 1}/\${actionSteps.length} (Attempt \${attempt}/\${${maxAttempts}}) paused for user OTP/credential entry ("\${errMsg.slice(0, 120)}"). Waiting in browser...\`
            );
            hasCompletedLoginSession = false;
            await handleLoginAndWaitForCompletion();
            if (attempt < ${maxAttempts}) {
              continue;
            }
          }
        }

        if (attempt >= ${maxAttempts}) {
          throw err;
        }

        console.log(
          \`[Retry Handler] Step \${stepIdx + 1}/\${actionSteps.length} (Attempt \${attempt}/\${${maxAttempts}}) encountered transient issue ("\${errMsg.slice(0, 120)}"). Waiting 3s and retrying from current screen...\`
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  // Feature #14 & #28: Automatically save current browser session state + harvested HTTP API endpoints
  try {
    const currentSessionData = await browser.evaluate(() => {
      const ls: Record<string, string> = {};
      const ss: Record<string, string> = {};
      let harvested: unknown[] = [];
      let liveNodes: unknown[] = [];
      try {
        const rawHarvest = window.localStorage.getItem('__e2eHarvestedRequests');
        if (rawHarvest) {
          harvested = JSON.parse(rawHarvest);
        }
        const rawLive = window.localStorage.getItem('__e2eLiveSiteNodes');
        if (rawLive) {
          liveNodes = JSON.parse(rawLive);
        }
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (
            k &&
            !k.startsWith('__e2eCurrentStep') &&
            k !== '__e2eHarvestedRequests' &&
            k !== '__e2eLiveSiteNodes'
          ) {
            ls[k] = window.localStorage.getItem(k) || '';
          }
        }
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k) {
            ss[k] = window.sessionStorage.getItem(k) || '';
          }
        }
      } catch {}
      return {
        savedAt: new Date().toISOString(),
        localStorage: ls,
        sessionStorage: ss,
        cookies: document.cookie || '',
        harvested,
        liveNodes,
      };
    });
    await fs.mkdir('.e2e/sessions', { recursive: true });
    await fs.writeFile(
      sessionFilePath,
      JSON.stringify(
        {
          savedAt: currentSessionData.savedAt,
          localStorage: currentSessionData.localStorage,
          sessionStorage: currentSessionData.sessionStorage,
          cookies: currentSessionData.cookies,
        },
        null,
        2
      ),
      'utf-8'
    );
    if (Array.isArray(currentSessionData.harvested) && currentSessionData.harvested.length > 0) {
      await fs.mkdir('.e2e/harvested-requests', { recursive: true });
      await fs.writeFile(
        '.e2e/harvested-requests/' + ${JSON.stringify(sessionFilename)},
        JSON.stringify(currentSessionData.harvested, null, 2),
        'utf-8'
      );
    }
    if (Array.isArray(currentSessionData.liveNodes) && currentSessionData.liveNodes.length > 0) {
      await fs.writeFile(
        '.e2e/live-site-nodes.json',
        JSON.stringify(currentSessionData.liveNodes, null, 2),
        'utf-8'
      );
    }
  } catch {
    // ignore session save errors
  }
${ensureCartVisibleBlock}
  // 3. Visually highlight the verified elements on the page and extract observation details
  const highlightInfo = await browser.evaluate((arg) => {
    const stopWords = new Set(['step', 'step1', 'step2', 'step3', 'check', 'whether', 'should', 'that', 'page', 'from', 'with', 'have', 'this', 'what', 'when', 'where', 'into', 'menu', 'goto']);
    const keywords = arg.query
      .toLowerCase()
      .replace(/[^a-z0-9\\s]/g, ' ')
      .split(/\\s+/)
      .filter((w) => w.length >= 3 && !stopWords.has(w));

    const candidates = Array.from(
      document.querySelectorAll('[role="alert"], [role="status"], form, tr, li, article, section, h1, h2, h3, h4, td, p, pre, div')
    );

    let bestEl: HTMLElement | null = null;
    let bestScore = 0;
    const matchedSnippets: string[] = [];

    for (const el of candidates) {
      const htmlEl = el as HTMLElement;
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 14 || rect.height > 650) continue;
      const text = (htmlEl.innerText || '').trim();
      if (text.length < 3 || text.length > 600) continue;
      const lower = text.toLowerCase();

      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score += 2;
      }
      if (/\\b(submitted|received|thank you|success|confirmed|completed)\\b/i.test(lower)) {
        score += 3;
      }
      if (score > bestScore) {
        bestScore = score;
        bestEl = htmlEl;
      }
      if (score >= Math.max(2, Math.min(4, keywords.length)) && matchedSnippets.length < 5) {
        const clean = text.replace(/\\s+/g, ' ').slice(0, 180);
        if (!matchedSnippets.includes(clean)) {
          matchedSnippets.push(clean);
        }
      }
    }

    if (!bestEl) {
      bestEl = document.querySelector('h1, h2, [role="alert"], form, main') as HTMLElement | null;
    }

    if (bestEl) {
      bestEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      bestEl.style.setProperty('outline', '4px solid #ef4444', 'important');
      bestEl.style.setProperty('outline-offset', '4px', 'important');
      bestEl.style.setProperty('background-color', 'rgba(254, 240, 138, 0.35)', 'important');
      bestEl.style.setProperty('box-shadow', '0 0 0 8px rgba(239, 68, 68, 0.25)', 'important');
      bestEl.style.setProperty('position', 'relative', 'important');

      const badge = document.createElement('div');
      badge.textContent = '✓ VERIFIED OBSERVATION: ' + arg.query.slice(0, 90);
      badge.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:2147483647;background:#dc2626;color:#ffffff;padding:10px 16px;border-radius:8px;font-family:sans-serif;font-size:14px;font-weight:700;box-shadow:0 8px 24px rgba(0,0,0,0.45);border:2px solid #fef08a;';
      document.body.appendChild(badge);
    }

    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      bestScore,
      matchedText: matchedSnippets.join(' | ') || (bestEl ? (bestEl.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) : 'Page inspected at ' + window.location.href),
    };
  }, { query: ${JSON.stringify(verificationQuery)} });

  await fs.mkdir('.e2e', { recursive: true });
  await fs.writeFile(
    '.e2e/highlighted-observation.json',
    JSON.stringify({
      summary: \`Page "\${highlightInfo.pageTitle}" (\${highlightInfo.pageUrl}) — Highlighted Elements: \${highlightInfo.matchedText}\`,
    }),
    'utf-8'
  );

  // 4. Capture screenshot with the visual highlight box & verification banner
  await app.screenshot('02-verified-observation-highlighted');${assertBlock}
});
`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  // Server-Sent Events (SSE) stream for live logs, status, generated code, and evidence
  if (req.method === 'GET' && parsedUrl.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);

    // Only send in-memory evidence if a test run completed in this session and its report file still exists on disk.
    // Never generate new `.docx` files on app startup before a test is run.
    if (!activeRunnerProcess && latestEvidencePayload && latestDocxFilePath) {
      fs.access(latestDocxFilePath)
        .then(() => {
          if (!res.writableEnded) {
            res.write(
              `event: evidence\ndata: ${JSON.stringify(latestEvidencePayload)}\n\n`
            );
          }
        })
        .catch(() => {
          latestEvidencePayload = null;
          latestDocxFilePath = null;
        });
    }

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // Serve generated Word Document (.docx)
  if (req.method === 'GET' && parsedUrl.pathname === '/api/report/docx') {
    const docxPath =
      latestDocxFilePath ??
      path.join(projectRoot, 'reports', 'e2e-observation-report-latest.docx');
    try {
      const data = await fs.readFile(docxPath);
      res.writeHead(200, {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition':
          'attachment; filename="e2e-observation-report.docx"',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No Word report (.docx) generated yet.' }));
    }
    return;
  }

  // Open generated Word Document (.docx) directly in Microsoft Word on Windows
  if (req.method === 'POST' && parsedUrl.pathname === '/api/report/open-docx') {
    const docxPath =
      latestDocxFilePath ??
      path.join(projectRoot, 'reports', 'e2e-observation-report-latest.docx');
    exec(`start "" "${docxPath}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ opened: true, path: docxPath }));
    return;
  }

  // Open the folder containing the generated Word Document (.docx) in Windows File Explorer
  if (req.method === 'POST' && parsedUrl.pathname === '/api/report/open-folder') {
    const docxPath =
      latestDocxFilePath ??
      path.join(projectRoot, 'reports', 'e2e-observation-report-latest.docx');
    exec(`explorer.exe /select,"${docxPath}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ opened: true, path: docxPath }));
    return;
  }

  // Serve screenshot and video artifacts from `.e2e/results/`
  if (req.method === 'GET' && parsedUrl.pathname === '/api/artifact') {
    const relPath = parsedUrl.searchParams.get('path') ?? '';
    const resultsRoot = path.resolve(projectRoot, '.e2e', 'results');
    const targetPath = path.resolve(resultsRoot, relPath);
    if (!targetPath.startsWith(resultsRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    try {
      const bytes = await fs.readFile(targetPath);
      const isWebm = targetPath.toLowerCase().endsWith('.webm');
      res.writeHead(200, {
        'Content-Type': isWebm ? 'video/webm' : 'image/png',
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end('Artifact not found');
    }
    return;
  }

  // TestRail: Test connection
  if (req.method === 'POST' && parsedUrl.pathname === '/api/testrail/test-connection') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const config = JSON.parse(body) as TestRailConfig;
      const result = await testTestRailConnection(config);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: (err as Error).message }));
    }
    return;
  }

  // TestRail: Fetch test case details
  if (req.method === 'POST' && parsedUrl.pathname === '/api/testrail/case') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { config, caseId } = JSON.parse(body) as {
        config: TestRailConfig;
        caseId: string | number;
      };
      const result = await fetchTestRailCase(config, caseId);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // TestRail: Submit test result
  if (req.method === 'POST' && parsedUrl.pathname === '/api/testrail/submit-result') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { config, runId, caseId, status, comment, elapsed } = JSON.parse(body) as {
        config: TestRailConfig;
        runId: string | number;
        caseId: string | number;
        status: 'passed' | 'failed';
        comment: string;
        elapsed?: string;
      };
      const docxPath =
        latestDocxFilePath ??
        path.join(projectRoot, 'reports', 'e2e-observation-report-latest.docx');
      const result = await submitTestRailResult(config, {
        runId,
        caseId,
        status,
        comment,
        elapsed,
        docxPath,
      });
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Browse for Windows Desktop Executable (.exe) using native file picker
  if (req.method === 'POST' && parsedUrl.pathname === '/api/desktop/browse-exe') {
    const selectedPath = await browseForExeFile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ selectedPath }));
    return;
  }

  // Feature #14 & #15: Query current Action Cache (#15) and Saved Session (#14) status for URL + Prompt
  if (req.method === 'GET' && parsedUrl.pathname === '/api/cache-status') {
    const urlParam = parsedUrl.searchParams.get('url') ?? '';
    const promptParam = parsedUrl.searchParams.get('prompt') ?? '';
    const statusInfo = await getCacheAndSessionStatus(projectRoot, urlParam, promptParam);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusInfo));
    return;
  }

  // Feature #14 & #15: Clear Action Cache or Saved Session for a host
  if (req.method === 'POST' && parsedUrl.pathname === '/api/cache-clear') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { url: targetUrl, clearType } = JSON.parse(body || '{}') as {
        url?: string;
        clearType?: 'cache' | 'session' | 'both';
      };
      await clearCacheOrSession(
        projectRoot,
        targetUrl ?? '',
        clearType ?? 'both'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Feature #17: Open exported standalone Playwright `.spec.ts` in Windows File Explorer
  if (req.method === 'POST' && parsedUrl.pathname === '/api/export/open-playwright') {
    const specPath = path.join(projectRoot, 'tests', 'exported', 'playwright-zero-llm.spec.ts');
    exec(`explorer.exe /select,"${specPath}"`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ opened: true, path: specPath }));
    return;
  }

  // Organization Mode: Test Internal AWS Hosted Model Connection
  if (req.method === 'POST' && parsedUrl.pathname === '/api/org-aws/test-connection') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const config = JSON.parse(body || '{}') as OrgAwsConfig;
      const result = await testOrgAwsConnection(config);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: (err as Error).message }));
    }
    return;
  }

  // Generic Auto-Scanner: Query existing Unified Site Map for URL
  if (req.method === 'GET' && parsedUrl.pathname === '/api/site-map') {
    const urlParam = parsedUrl.searchParams.get('url') ?? '';
    const siteMap = await getSiteMapForUrl(projectRoot, urlParam);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        siteMap,
        pageCount: siteMap ? Object.keys(siteMap.pages).length : 0,
      })
    );
    return;
  }

  // Generic Auto-Scanner: Crawl & Map Website (merges into Unified Site Map)
  if (req.method === 'POST' && parsedUrl.pathname === '/api/site-scan') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { url: targetUrl, maxPages } = JSON.parse(body || '{}') as {
        url?: string;
        maxPages?: number;
      };
      if (!targetUrl?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Target URL is required.' }));
        return;
      }
      const siteMap = await scanWebsiteGeneric(
        projectRoot,
        targetUrl.trim(),
        maxPages ?? 15
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          siteMap,
          pageCount: Object.keys(siteMap.pages).length,
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Generic Record Correlation Sync Endpoint: merges browser-captured IDs, form fields, and UI diffs
  if (req.method === 'POST' && parsedUrl.pathname === '/api/correlation/sync') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const update = JSON.parse(body || '{}');
      const merged = await mergeSharedRecordCorrelation(projectRoot, update);
      const hint = formatRecordCorrelationHint(merged);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, correlation: merged, hint }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Hybrid Mobile Mode: Execute a single `[MOBILE]` step while keeping the Web Browser session alive
  if (req.method === 'POST' && parsedUrl.pathname === '/api/mobile/hybrid-step') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { mobileTargetUrl, stepNumber, stepText, sharedContext } = JSON.parse(body || '{}') as {
        mobileTargetUrl?: string;
        stepNumber?: number;
        stepText?: string;
        sharedContext?: string;
      };
      let savedPayload: RunPromptPayload = {
        url: 'http://localhost:5000/',
        prompt: stepText || '',
        loginMode: 'none',
        browser: 'chromium',
        headed: true,
        useCache: true,
        provider: 'openai',
        model: 'gpt-4o',
      };
      try {
        const rawSaved = await fs.readFile(
          path.join(projectRoot, '.e2e', 'last-run-payload.json'),
          'utf-8'
        );
        savedPayload = { ...savedPayload, ...(JSON.parse(rawSaved) as Partial<RunPromptPayload>) };
      } catch {
        // ignore
      }
      const result = await executeHybridMobileStep({
        projectRoot,
        payload: savedPayload,
        mobileTargetUrl: (mobileTargetUrl || savedPayload.url || 'http://localhost:5000/').trim(),
        stepNumber: stepNumber ?? 1,
        stepText: stepText ?? '',
        sharedContext,
        onLog: (msg) => broadcastEvent('log', msg),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Hybrid Web + Desktop Mode: Execute a single `[DESKTOP]` step while keeping the Web Browser session alive
  if (req.method === 'POST' && parsedUrl.pathname === '/api/desktop/hybrid-step') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    try {
      const { exePath, stepNumber, stepText, sharedContext } = JSON.parse(body || '{}') as {
        exePath?: string;
        stepNumber?: number;
        stepText?: string;
        sharedContext?: string;
      };
      let savedPayload: RunPromptPayload = {
        url: 'http://localhost:5000/',
        prompt: stepText || '',
        loginMode: 'none',
        browser: 'chromium',
        headed: true,
        useCache: true,
        provider: 'openai',
        model: 'gpt-4o',
      };
      try {
        const rawSaved = await fs.readFile(
          path.join(projectRoot, '.e2e', 'last-run-payload.json'),
          'utf-8'
        );
        savedPayload = { ...savedPayload, ...(JSON.parse(rawSaved) as Partial<RunPromptPayload>) };
      } catch {
        // ignore
      }
      const targetExe = (exePath || savedPayload.desktopExePath || 'notepad.exe').trim();
      const result = await executeHybridDesktopStep({
        projectRoot,
        payload: savedPayload,
        exePath: targetExe,
        stepNumber: stepNumber ?? 1,
        stepText: stepText ?? '',
        sharedContext,
        onLog: (msg) => broadcastEvent('log', msg),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return;
  }

  // Run Prompt endpoint
  if (req.method === 'POST' && parsedUrl.pathname === '/api/run-prompt') {
    if (activeRunnerProcess || activeDesktopRunInProgress || activeLoadRunInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'A test run is already in progress. Stop it before starting a new run.',
        })
      );
      return;
    }

    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    const payload = JSON.parse(body) as RunPromptPayload;
    const e2eMetaDir = path.join(projectRoot, '.e2e');
    await fs.mkdir(e2eMetaDir, { recursive: true });
    resetHybridDesktopSession();
    try {
      await fs.unlink(path.join(e2eMetaDir, 'hybrid-desktop-steps.json'));
    } catch {
      // ignore if not present
    }
    try {
      await fs.unlink(path.join(e2eMetaDir, 'record-context.json'));
    } catch {
      // ignore if not present
    }
    await fs.writeFile(
      path.join(e2eMetaDir, 'last-run-payload.json'),
      JSON.stringify(payload, null, 2),
      'utf-8'
    );

    if (payload.targetType === 'load') {
      const loadCfg: LoadTestConfig = {
        virtualUsers: Number(payload.loadConfig?.virtualUsers ?? 25),
        rampUpSeconds: Number(payload.loadConfig?.rampUpSeconds ?? 5),
        durationSeconds: Number(payload.loadConfig?.durationSeconds ?? 15),
        samplerMode: payload.loadConfig?.samplerMode ?? 'http-samplers',
        thinkTimeMs: Number(payload.loadConfig?.thinkTimeMs ?? 100),
        maxAcceptableP95Ms: Number(payload.loadConfig?.maxAcceptableP95Ms ?? 1500),
      };

      const { samplers } = await discoverLoadSamplers(
        projectRoot,
        payload.url,
        payload.prompt
      );

      const generatedDir = path.join(projectRoot, 'tests', 'generated');
      await fs.mkdir(generatedDir, { recursive: true });
      const relativeTestPath = 'tests/generated/jmeter-load.e2e.ts';
      const generatedCode = buildLoadTestCodePreview(payload, samplers, loadCfg);
      await fs.writeFile(
        path.join(generatedDir, 'jmeter-load.e2e.ts'),
        generatedCode,
        'utf-8'
      );

      broadcastEvent('code-generated', {
        filePath: relativeTestPath,
        code: generatedCode,
      });
      broadcastEvent('status', { status: 'running' });

      activeLoadRunInProgress = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true, targetType: 'load' }));

      runJMeterLoadTest(payload, projectRoot, (msg) => broadcastEvent('log', msg))
        .then(async ({ exitCode }) => {
          activeLoadRunInProgress = false;
          const finalStatus = exitCode === 0 ? 'passed' : 'failed';
          const { consoleSummary, evidencePayload } =
            await buildDiagnosticsAndWordReport(payload);
          if (consoleSummary) {
            broadcastEvent('log', consoleSummary);
          }
          if (evidencePayload) {
            latestEvidencePayload = evidencePayload;
            broadcastEvent('evidence', evidencePayload);
          }
          broadcastEvent(
            'log',
            `\n[JMeter Load Engine] Completed with exit code ${exitCode} (${finalStatus.toUpperCase()})\n`
          );
          broadcastEvent('status', { status: finalStatus, exitCode });
        })
        .catch((err) => {
          activeLoadRunInProgress = false;
          broadcastEvent('log', `\n[JMeter Load Error] ${(err as Error).message}\n`);
          broadcastEvent('status', { status: 'failed', exitCode: 1 });
        });

      return;
    }

    const isDesktopExeTarget =
      payload.targetType === 'desktop' ||
      !/^https?:\/\//i.test(payload.url.trim()) ||
      /\.exe(\s|$)/i.test(payload.url.trim());

    if (isDesktopExeTarget) {
      const actionSteps = payload.prompt
        .split('\n')
        .map((line) => line.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim())
        .filter(Boolean);

      const generatedDir = path.join(projectRoot, 'tests', 'generated');
      await fs.mkdir(generatedDir, { recursive: true });
      const relativeTestPath = 'tests/generated/desktop-run.e2e.ts';
      const generatedCode = buildDesktopTestCodePreview(payload, actionSteps);
      await fs.writeFile(
        path.join(generatedDir, 'desktop-run.e2e.ts'),
        generatedCode,
        'utf-8'
      );

      broadcastEvent('code-generated', {
        filePath: relativeTestPath,
        code: generatedCode,
      });
      broadcastEvent('status', { status: 'running' });
      broadcastEvent(
        'log',
        `[Desktop EXE Runner] Target Application: ${payload.url}\n[Desktop EXE Runner] Steps to Execute: ${actionSteps.length}\n\n`
      );

      activeDesktopRunInProgress = true;
      const runStartTime = Date.now();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true, targetType: 'desktop' }));

      runDesktopExeTest(payload, projectRoot, (msg) => broadcastEvent('log', msg))
        .then(async ({ exitCode }) => {
          activeDesktopRunInProgress = false;
          const finalStatus = exitCode === 0 ? 'passed' : 'failed';
          const { consoleSummary, evidencePayload } =
            await buildDiagnosticsAndWordReport(payload);
          if (consoleSummary) {
            broadcastEvent('log', consoleSummary);
          }

          if (
            payload.testrailConfig?.enabled &&
            payload.testrailConfig.autoUpdateResult &&
            payload.testrailCaseId
          ) {
            const targetRunId =
              payload.testrailRunId?.trim() ||
              payload.testrailConfig.defaultRunId?.trim();
            if (targetRunId) {
              const elapsedSec = `${Math.max(1, Math.round((Date.now() - runStartTime) / 1000))}s`;
              const comment = `Automated Desktop EXE E2E run.\nStatus: ${finalStatus.toUpperCase()}\nTarget EXE: ${payload.url}\nCase: ${payload.testrailCaseId}\nAssertion: ${payload.assertionPrompt ?? 'N/A'}${consoleSummary}`;
              const trRes = await submitTestRailResult(payload.testrailConfig, {
                runId: targetRunId,
                caseId: payload.testrailCaseId,
                status: finalStatus,
                comment,
                elapsed: elapsedSec,
                docxPath: evidencePayload?.docxPath,
              });
              if (trRes.ok && evidencePayload) {
                evidencePayload.testrailResult = {
                  caseId: payload.testrailCaseId,
                  runId: String(targetRunId),
                  status: finalStatus,
                  resultId: trRes.resultId,
                };
              }
            }
          }

          if (evidencePayload) {
            latestEvidencePayload = evidencePayload;
            broadcastEvent('evidence', evidencePayload);
          }
          broadcastEvent(
            'log',
            `\n[Desktop EXE Runner] Finished with exit code ${exitCode} (${finalStatus.toUpperCase()})\n`
          );
          broadcastEvent('status', { status: finalStatus, exitCode });
        })
        .catch((err) => {
          activeDesktopRunInProgress = false;
          broadcastEvent('log', `\n[Desktop EXE Error] ${(err as Error).message}\n`);
          broadcastEvent('status', { status: 'failed', exitCode: 1 });
        });

      return;
    }

    const generatedDir = path.join(projectRoot, 'tests', 'generated');
    await fs.mkdir(generatedDir, { recursive: true });

    const generatedTestPath = path.join(generatedDir, 'prompt-run.e2e.ts');
    const relativeTestPath = 'tests/generated/prompt-run.e2e.ts';
    const generatedCode = buildE2ETestCode(payload);

    await fs.writeFile(generatedTestPath, generatedCode, 'utf-8');

    broadcastEvent('code-generated', {
      filePath: relativeTestPath,
      code: generatedCode,
    });
    broadcastEvent('status', { status: 'running' });

    const cliArgs = ['e2e', 'run', relativeTestPath];
    if (payload.headed) {
      cliArgs.push('--headed');
    }
    if (!payload.useCache) {
      cliArgs.push('--no-cache');
    }
    if (payload.recordVideo) {
      cliArgs.push('--video', 'on');
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

    if (payload.orgAws?.enabled) {
      const org = payload.orgAws;
      env.E2E_ORG_AWS_ENABLED = 'true';
      env.E2E_ORG_AWS_CONNECTION_TYPE = org.connectionType || 'aws-gateway-openai';
      env.E2E_ORG_AWS_AUTH_TYPE = org.authType || 'bearer-token';
      env.E2E_ORG_AWS_ENDPOINT_URL = org.endpointUrl?.trim() || '';
      env.E2E_ORG_AWS_MODEL = org.model?.trim() || payload.model;
      env.E2E_LLM_MODEL = org.model?.trim() || payload.model;
      env.E2E_ORG_AWS_TOKEN = org.authToken?.trim() || '';
      env.E2E_ORG_AWS_AUTH_HEADER = org.authHeaderName?.trim() || 'Authorization';
      env.E2E_ORG_AWS_CUSTOM_HEADERS = org.customHeadersJson?.trim() || '';
      env.E2E_ORG_AWS_ALLOW_SELF_SIGNED = org.allowSelfSignedCerts ? 'true' : 'false';
      if (org.allowSelfSignedCerts) {
        env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      }
      if (org.awsRegion?.trim()) {
        env.AWS_REGION = org.awsRegion.trim();
        env.AWS_DEFAULT_REGION = org.awsRegion.trim();
      }
      if (org.awsAccessKeyId?.trim()) {
        env.AWS_ACCESS_KEY_ID = org.awsAccessKeyId.trim();
      }
      if (org.awsSecretAccessKey?.trim()) {
        env.AWS_SECRET_ACCESS_KEY = org.awsSecretAccessKey.trim();
      }
      if (org.awsSessionToken?.trim()) {
        env.AWS_SESSION_TOKEN = org.awsSessionToken.trim();
      }
    } else {
      env.E2E_ORG_AWS_ENABLED = 'false';
    }

    const activeAiSummary = payload.orgAws?.enabled
      ? `🏢 Org AWS (${payload.orgAws.connectionType}: ${payload.orgAws.model})`
      : `🌐 Standard (${payload.provider}: ${payload.model})`;

    broadcastEvent(
      'log',
      `[Desktop Runner] Generated ${relativeTestPath} (AI Mode: ${activeAiSummary}, Step Timeout: ${payload.stepTimeoutSeconds ?? 180}s, Ad-Blocker: ${payload.blockAds !== false ? 'ON' : 'OFF'}, Video Recording: ${payload.recordVideo ? 'ON' : 'OFF'})\n[Desktop Runner] Launching: npx ${cliArgs.join(' ')}\n\n`
    );

    const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const runStartTime = Date.now();
    const child = spawn(npxCmd, cliArgs, {
      cwd: projectRoot,
      env,
      shell: true,
    });

    activeRunnerProcess = child;

    child.stdout.on('data', (chunk: Buffer) => {
      broadcastEvent('log', stripAnsi(chunk.toString()));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      broadcastEvent('log', stripAnsi(chunk.toString()));
    });

    child.on('close', async (code) => {
      activeRunnerProcess = null;
      const finalStatus = code === 0 ? 'passed' : 'failed';
      const { consoleSummary, evidencePayload } =
        await buildDiagnosticsAndWordReport(payload);
      if (consoleSummary) {
        broadcastEvent('log', consoleSummary);
      }

      // If TestRail integration is enabled with auto-update, sync test result
      if (
        payload.testrailConfig?.enabled &&
        payload.testrailConfig.autoUpdateResult &&
        payload.testrailCaseId
      ) {
        const targetRunId =
          payload.testrailRunId?.trim() || payload.testrailConfig.defaultRunId?.trim();
        if (targetRunId) {
          broadcastEvent(
            'log',
            `\n[TestRail] Syncing result for Case ${payload.testrailCaseId} to Run R${targetRunId}...\n`
          );
          const elapsedSec = `${Math.max(1, Math.round((Date.now() - runStartTime) / 1000))}s`;
          const comment = `Automated E2E run by TesterArmy Desktop Runner.\nStatus: ${finalStatus.toUpperCase()}\nTarget URL: ${payload.url}\nCase: ${payload.testrailCaseId}\nAssertion: ${payload.assertionPrompt ?? 'N/A'}${consoleSummary}`;
          const trRes = await submitTestRailResult(payload.testrailConfig, {
            runId: targetRunId,
            caseId: payload.testrailCaseId,
            status: finalStatus,
            comment,
            elapsed: elapsedSec,
            docxPath: evidencePayload?.docxPath,
          });
          if (trRes.ok) {
            broadcastEvent(
              'log',
              `[TestRail] ✓ Result successfully posted to TestRail! Result ID: ${trRes.resultId}\n`
            );
            if (evidencePayload) {
              evidencePayload.testrailResult = {
                caseId: payload.testrailCaseId,
                runId: String(targetRunId),
                status: finalStatus,
                resultId: trRes.resultId,
              };
            }
          } else {
            broadcastEvent(
              'log',
              `[TestRail Error] Failed to update TestRail: ${trRes.error}\n`
            );
          }
        }
      }

      if (evidencePayload) {
        latestEvidencePayload = evidencePayload;
        broadcastEvent('evidence', evidencePayload);
      }
      broadcastEvent(
        'log',
        `\n[Desktop Runner] Process finished with exit code ${code} (${finalStatus.toUpperCase()})\n`
      );
      broadcastEvent('status', { status: finalStatus, exitCode: code });
    });

    child.on('error', (err) => {
      activeRunnerProcess = null;
      broadcastEvent('log', `\n[Desktop Runner Error] ${stripAnsi(err.message)}\n`);
      broadcastEvent('status', { status: 'failed', exitCode: 1 });
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true }));
    return;
  }

  // Stop Run endpoint
  if (req.method === 'POST' && parsedUrl.pathname === '/api/stop-run') {
    if (activeRunnerProcess || activeDesktopRunInProgress || activeLoadRunInProgress) {
      if (activeRunnerProcess) {
        activeRunnerProcess.kill();
        activeRunnerProcess = null;
      }
      if (activeDesktopRunInProgress) {
        stopActiveDesktopRun();
        activeDesktopRunInProgress = false;
      }
      if (activeLoadRunInProgress) {
        stopActiveLoadRun();
        activeLoadRunInProgress = false;
      }
      broadcastEvent('log', '\n[Desktop Runner] Test execution stopped by user.\n');
      broadcastEvent('status', { status: 'stopped' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ stopped: true }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stopped: false }));
    return;
  }

  // Serve Production Frontend (`dist/`) directly when running from compiled QADrive.exe
  if (req.method === 'GET' && !parsedUrl.pathname.startsWith('/api/')) {
    try {
      const distDir = path.join(projectRoot, 'dist');
      const requestedRel =
        parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname.replace(/^\/+/, '');
      const candidatePath = path.resolve(distDir, requestedRel);
      if (candidatePath.startsWith(distDir)) {
        const fileBytes = await fs.readFile(candidatePath);
        const ext = path.extname(candidatePath).toLowerCase();
        const mimeMap: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.json': 'application/json',
        };
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(fileBytes);
        return;
      }
    } catch {
      // Fallback to index.html for SPA routes if dist/index.html exists
      try {
        const indexHtml = await fs.readFile(path.join(projectRoot, 'dist', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexHtml);
        return;
      } catch {
        // ignore if dist not built
      }
    }
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    PORT += 1;
    console.log(`[QA Drive Backend] Port ${PORT - 1} in use, switching to port ${PORT}...`);
    setTimeout(() => {
      server.listen(PORT, '127.0.0.1');
    }, 100);
  } else {
    console.error('[QA Drive Server Error]', err);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[QA Drive Backend] Listening on http://127.0.0.1:${PORT}`);
  const isExeMode = process.env.QA_DRIVE_EXE_MODE === 'true';
  const targetAppUrl = isExeMode
    ? `http://127.0.0.1:${PORT}`
    : `http://127.0.0.1:${UI_PORT}`;

  if (isExeMode && process.platform === 'win32') {
    console.log(`[QA Drive] Opening Desktop Application Window: ${targetAppUrl}`);
    exec(
      `start "" msedge --app=${targetAppUrl} --window-size=1320,860 || start "" chrome --app=${targetAppUrl} --window-size=1320,860 || start "" "${targetAppUrl}"`
    );
  } else if (process.env.OPEN_DESKTOP_WINDOW === 'true' && process.platform === 'win32') {
    setTimeout(() => {
      if (sseClients.size === 0) {
        exec(`start "" msedge --app=${targetAppUrl} --window-size=1320,860`);
      }
    }, 2500);
  }
});
