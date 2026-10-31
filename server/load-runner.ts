import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type {
  LoadEndpointSamplerMetric,
  LoadTestConfig,
  LoadTestSummary,
  LoadTimelinePoint,
  RunPromptPayload,
} from '../src/types.js';
import {
  getHostSessionFilename,
  normalizeOriginKey,
  type ActionCacheMap,
} from './cache-and-session.js';

export interface HttpSamplerDefinition {
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  body?: string;
  contentType?: string;
}

interface RawSampleResult {
  samplerIndex: number;
  label: string;
  method: string;
  url: string;
  elapsedMs: number;
  status: number;
  ok: boolean;
  bytes: number;
  secondBucket: number;
  errorText?: string;
}

let activeLoadAborted = false;

export function stopActiveLoadRun(): boolean {
  activeLoadAborted = true;
  return true;
}

function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1)
  );
  return Math.round(sortedValues[idx]);
}

/**
 * Discovers HTTP Samplers for the target URL from:
 * 1. Harvested API requests (`.e2e/harvested-requests/<host>.json`)
 * 2. Cached DOM action page paths (`.e2e/action-cache.json`)
 * 3. Paths or step intents in the user's prompt
 * 4. Primary target URL (`GET <url>`)
 */
export async function discoverLoadSamplers(
  projectRoot: string,
  targetUrl: string,
  prompt: string
): Promise<{
  samplers: HttpSamplerDefinition[];
  authHeaders: Record<string, string>;
  harvestedCount: number;
}> {
  let baseOrigin = targetUrl.trim();
  try {
    const u = new URL(targetUrl.trim());
    baseOrigin = u.origin;
  } catch {
    // keep as-is
  }

  const samplers: HttpSamplerDefinition[] = [];
  const seenKeys = new Set<string>();

  const addSampler = (s: HttpSamplerDefinition) => {
    const key = `${s.method} ${s.url}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    samplers.push(s);
  };

  // Always add primary entry URL as Sampler #1
  addSampler({
    label: `GET ${ (() => { try { return new URL(targetUrl).pathname || '/'; } catch { return '/'; } })() } (Landing Page)`,
    method: 'GET',
    url: targetUrl.trim(),
  });

  // 1. Load harvested requests from `.e2e/harvested-requests/<host>.json`
  const hostFile = getHostSessionFilename(targetUrl);
  let harvestedCount = 0;
  try {
    const rawHarvest = await fs.readFile(
      path.join(projectRoot, '.e2e', 'harvested-requests', hostFile),
      'utf-8'
    );
    const list = JSON.parse(rawHarvest) as Array<{
      method: string;
      url: string;
      body?: string;
      contentType?: string;
    }>;
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item?.url) continue;
        // Skip POST /signup during high-concurrency flood if it would fail with duplicate user unless dynamic
        const method = (item.method || 'GET').toUpperCase() as HttpSamplerDefinition['method'];
        let pathname = item.url;
        try {
          pathname = new URL(item.url).pathname;
        } catch {}
        harvestedCount++;
        addSampler({
          label: `${method} ${pathname}`,
          method,
          url: item.url,
          body: item.body,
          contentType: item.contentType,
        });
      }
    }
  } catch {
    // no harvested requests file yet
  }

  // 2. Discover page routes from `.e2e/action-cache.json` for this origin
  try {
    const rawCache = await fs.readFile(
      path.join(projectRoot, '.e2e', 'action-cache.json'),
      'utf-8'
    );
    const cacheMap = JSON.parse(rawCache) as ActionCacheMap;
    const prefix = `${normalizeOriginKey(targetUrl)}::`;
    for (const [k, actions] of Object.entries(cacheMap)) {
      if (!k.startsWith(prefix) || !Array.isArray(actions)) continue;
      for (const act of actions) {
        if (act.pageUrl && act.pageUrl.startsWith('/')) {
          const fullUrl = `${baseOrigin}${act.pageUrl}`;
          addSampler({
            label: `GET ${act.pageUrl}`,
            method: 'GET',
            url: fullUrl,
          });
        }
        if (act.href && act.href.startsWith('/')) {
          const fullUrl = `${baseOrigin}${act.href}`;
          addSampler({
            label: `GET ${act.href}`,
            method: 'GET',
            url: fullUrl,
          });
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Parse explicit URL paths (e.g. `/api/products`, `/orders`, `/login`) from the prompt text
  const pathMatches = prompt.match(/(?:^|\s)(\/[a-zA-Z0-9_\-/]+)(?=\s|$|[,.;])/g) || [];
  for (const rawMatch of pathMatches) {
    const cleanPath = rawMatch.trim();
    if (cleanPath.length > 1) {
      addSampler({
        label: `GET ${cleanPath}`,
        method: 'GET',
        url: `${baseOrigin}${cleanPath}`,
      });
    }
  }

  // 4. Load saved session cookies & bearer tokens from `.e2e/sessions/<host>.json`
  const authHeaders: Record<string, string> = {};
  try {
    const rawSess = await fs.readFile(
      path.join(projectRoot, '.e2e', 'sessions', hostFile),
      'utf-8'
    );
    const sess = JSON.parse(rawSess) as {
      cookies?: string;
      localStorage?: Record<string, string>;
    };
    if (sess.cookies?.trim()) {
      authHeaders['cookie'] = sess.cookies.trim();
    }
    if (sess.localStorage) {
      for (const [k, v] of Object.entries(sess.localStorage)) {
        if (/token|jwt|auth/i.test(k) && v && v.length > 10 && !v.startsWith('{')) {
          authHeaders['authorization'] = /^bearer\s+/i.test(v) ? v : `Bearer ${v}`;
          break;
        }
      }
    }
  } catch {
    // no session headers
  }

  return { samplers: samplers.slice(0, 12), authHeaders, harvestedCount };
}

/**
 * Generates a readable JMeter Load Plan code preview for the "Generated Code" tab.
 */
export function buildLoadTestCodePreview(
  payload: RunPromptPayload,
  samplers: HttpSamplerDefinition[],
  config: LoadTestConfig
): string {
  return `// @ts-nocheck
// QDrive JMeter-Style Load & Stress Test Plan (#28)
// Target Origin: ${payload.url}
// Virtual Users (Threads): ${config.virtualUsers} VUs | Ramp-Up: ${config.rampUpSeconds}s | Duration: ${config.durationSeconds}s
import { runLoadTestPlan, expect } from '@qdrive/load-engine';

export default runLoadTestPlan({
  threadGroup: {
    virtualUsers: ${config.virtualUsers},
    rampUpSeconds: ${config.rampUpSeconds},
    durationSeconds: ${config.durationSeconds},
    samplerMode: ${JSON.stringify(config.samplerMode)},
    thinkTimeMs: ${config.thinkTimeMs},
  },
  samplers: ${JSON.stringify(
    samplers.map((s) => ({ label: s.label, method: s.method, url: s.url })),
    null,
    2
  )},
  slaAssertions: {
    maxP95LatencyMs: ${config.maxAcceptableP95Ms ?? 1500},
    maxErrorRatePct: 5,
    customAssertion: ${JSON.stringify(payload.assertionPrompt ?? 'p95 latency within SLA and 0% server errors')},
  },
});
`;
}

/**
 * Executes the JMeter-Style Load & Stress test, streaming 1-second telemetry to `onLog`,
 * writing `.e2e/load-summary.json` and `.e2e/report.json` for `.docx` Word Report generation.
 */
export async function runJMeterLoadTest(
  payload: RunPromptPayload,
  projectRoot: string,
  onLog: (msg: string) => void
): Promise<{ exitCode: number; summary: LoadTestSummary }> {
  activeLoadAborted = false;
  const startedAtIso = new Date().toISOString();

  const config: LoadTestConfig = {
    virtualUsers: Math.min(500, Math.max(1, Number(payload.loadConfig?.virtualUsers ?? 25))),
    rampUpSeconds: Math.min(120, Math.max(0, Number(payload.loadConfig?.rampUpSeconds ?? 5))),
    durationSeconds: Math.min(300, Math.max(5, Number(payload.loadConfig?.durationSeconds ?? 15))),
    samplerMode: payload.loadConfig?.samplerMode ?? 'http-samplers',
    thinkTimeMs: Math.min(5000, Math.max(20, Number(payload.loadConfig?.thinkTimeMs ?? 100))),
    maxAcceptableP95Ms: Number(payload.loadConfig?.maxAcceptableP95Ms ?? 1500),
  };

  const { samplers, authHeaders } = await discoverLoadSamplers(
    projectRoot,
    payload.url,
    payload.prompt
  );

  onLog(
    `╔════════════════════════════════════════════════════════════════════════╗\n` +
      `║ QDrive JMeter Load & Stress Engine (#28)                               ║\n` +
      `╠════════════════════════════════════════════════════════════════════════╣\n` +
      `║ Target URL       : ${payload.url.padEnd(51).slice(0, 51)} ║\n` +
      `║ Thread Group     : ${`${config.virtualUsers} Virtual Users (VUs) | Ramp-Up: ${config.rampUpSeconds}s | Duration: ${config.durationSeconds}s`.padEnd(51).slice(0, 51)} ║\n` +
      `║ Active Samplers  : ${`${samplers.length} HTTP Endpoints (${Object.keys(authHeaders).length > 0 ? 'Authenticated Session Attached' : 'Public Session'})`.padEnd(51).slice(0, 51)} ║\n` +
      `╚════════════════════════════════════════════════════════════════════════╝\n\n`
  );

  for (let i = 0; i < samplers.length; i++) {
    onLog(`  Sampler #${i + 1}: [${samplers[i].method}] ${samplers[i].url}\n`);
  }
  onLog(`\n[JMeter Engine] Starting ${config.virtualUsers} Virtual Users...\n`);

  const allSamples: RawSampleResult[] = [];
  const timeline: LoadTimelinePoint[] = [];
  const startTimePerf = performance.now();
  const durationMs = config.durationSeconds * 1000;
  const rampUpMs = config.rampUpSeconds * 1000;

  let activeUsersCount = 0;
  let lastLoggedSecond = 0;

  const progressInterval = setInterval(() => {
    const elapsedMs = performance.now() - startTimePerf;
    const currentSec = Math.max(1, Math.floor(elapsedMs / 1000));
    if (currentSec <= lastLoggedSecond || currentSec > config.durationSeconds) return;
    lastLoggedSecond = currentSec;

    const bucketSamples = allSamples.filter((s) => s.secondBucket === currentSec);
    const reqCount = bucketSamples.length;
    const errCount = bucketSamples.filter((s) => !s.ok).length;
    const sortedLat = bucketSamples.map((s) => s.elapsedMs).sort((a, b) => a - b);
    const avgLat =
      sortedLat.length > 0
        ? Math.round(sortedLat.reduce((a, b) => a + b, 0) / sortedLat.length)
        : 0;
    const p95Lat = computePercentile(sortedLat, 95);

    const point: LoadTimelinePoint = {
      second: currentSec,
      activeUsers: activeUsersCount,
      requests: reqCount,
      rps: reqCount,
      avgLatencyMs: avgLat,
      p95LatencyMs: p95Lat,
      errors: errCount,
    };
    timeline.push(point);

    const totalSoFar = allSamples.length;
    const totalErrSoFar = allSamples.filter((s) => !s.ok).length;
    const errPct = totalSoFar > 0 ? ((totalErrSoFar / totalSoFar) * 100).toFixed(1) : '0.0';

    onLog(
      `  [JMeter t=${String(currentSec).padStart(2, '0')}s/${String(config.durationSeconds).padStart(2, '0')}s] ` +
        `Active VUs: ${String(activeUsersCount).padStart(3, ' ')}/${config.virtualUsers} | ` +
        `RPS: ${String(reqCount).padStart(4, ' ')}/s | ` +
        `Total: ${String(totalSoFar).padStart(5, ' ')} | ` +
        `Avg: ${String(avgLat).padStart(4, ' ')}ms | ` +
        `p95: ${String(p95Lat).padStart(4, ' ')}ms | ` +
        `Errors: ${errPct}%\n`
    );
  }, 1000);

  // Spawn Virtual User worker loops
  const vuPromises: Array<Promise<void>> = [];
  for (let vu = 0; vu < config.virtualUsers; vu++) {
    const startDelayMs =
      config.virtualUsers > 1 && rampUpMs > 0
        ? Math.floor((vu / config.virtualUsers) * rampUpMs)
        : 0;

    const workerPromise = (async () => {
      if (startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, startDelayMs));
      }
      if (activeLoadAborted || performance.now() - startTimePerf >= durationMs) {
        return;
      }

      activeUsersCount++;
      let samplerCursor = vu % samplers.length;

      try {
        while (!activeLoadAborted && performance.now() - startTimePerf < durationMs) {
          const samplerIdx = samplerCursor % samplers.length;
          samplerCursor++;
          const sampler = samplers[samplerIdx];

          const reqStart = performance.now();
          const secBucket = Math.min(
            config.durationSeconds,
            Math.max(1, Math.ceil((reqStart - startTimePerf) / 1000))
          );

          let status = 0;
          let ok = false;
          let bytes = 0;
          let errorText: string | undefined;

          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const headers: Record<string, string> = {
              ...authHeaders,
              'user-agent': `QDrive-JMeter-LoadEngine/1.0 (VU-${vu + 1})`,
            };
            if (sampler.body && sampler.contentType) {
              headers['content-type'] = sampler.contentType;
            }

            const res = await fetch(sampler.url, {
              method: sampler.method,
              headers,
              body:
                sampler.method !== 'GET' && sampler.body ? sampler.body : undefined,
              signal: controller.signal,
            });
            clearTimeout(timeoutId);

            status = res.status;
            ok = res.status >= 200 && res.status < 400;
            const buf = await res.arrayBuffer();
            bytes = buf.byteLength;
            if (!ok) {
              errorText = `HTTP ${status}`;
            }
          } catch (err) {
            status = 0;
            ok = false;
            errorText = (err as Error).name === 'AbortError' ? 'Timeout (10s)' : (err as Error).message;
          }

          const elapsedMs = Math.max(1, Math.round(performance.now() - reqStart));
          allSamples.push({
            samplerIndex: samplerIdx,
            label: sampler.label,
            method: sampler.method,
            url: sampler.url,
            elapsedMs,
            status,
            ok,
            bytes,
            secondBucket: secBucket,
            errorText,
          });

          if (config.thinkTimeMs > 0 && performance.now() - startTimePerf < durationMs) {
            await new Promise((r) => setTimeout(r, config.thinkTimeMs));
          }
        }
      } finally {
        activeUsersCount = Math.max(0, activeUsersCount - 1);
      }
    })();

    vuPromises.push(workerPromise);
  }

  await Promise.all(vuPromises);
  clearInterval(progressInterval);

  const actualDurationSec = Math.max(
    1,
    Number(((performance.now() - startTimePerf) / 1000).toFixed(1))
  );

  // Aggregate overall metrics
  const totalSamples = allSamples.length;
  const successSamples = allSamples.filter((s) => s.ok).length;
  const failedSamples = totalSamples - successSamples;
  const errorRatePct =
    totalSamples > 0 ? Number(((failedSamples / totalSamples) * 100).toFixed(2)) : 0;

  const sortedAllLat = allSamples.map((s) => s.elapsedMs).sort((a, b) => a - b);
  const minLatencyMs = sortedAllLat.length > 0 ? sortedAllLat[0] : 0;
  const maxLatencyMs =
    sortedAllLat.length > 0 ? sortedAllLat[sortedAllLat.length - 1] : 0;
  const avgLatencyMs =
    sortedAllLat.length > 0
      ? Math.round(sortedAllLat.reduce((a, b) => a + b, 0) / sortedAllLat.length)
      : 0;
  const p50LatencyMs = computePercentile(sortedAllLat, 50);
  const p90LatencyMs = computePercentile(sortedAllLat, 90);
  const p95LatencyMs = computePercentile(sortedAllLat, 95);
  const p99LatencyMs = computePercentile(sortedAllLat, 99);

  const avgRps = Number((totalSamples / actualDurationSec).toFixed(1));
  const peakRps =
    timeline.length > 0
      ? Math.max(...timeline.map((t) => t.rps), Math.ceil(avgRps))
      : Math.ceil(avgRps);
  const totalBytesTransferred = allSamples.reduce((sum, s) => sum + s.bytes, 0);

  // Aggregate per-sampler metrics (JMeter Aggregate Report table)
  const samplerMetrics: LoadEndpointSamplerMetric[] = samplers.map((sampler, idx) => {
    const group = allSamples.filter((s) => s.samplerIndex === idx);
    const count = group.length;
    const succ = group.filter((s) => s.ok).length;
    const err = count - succ;
    const errRate = count > 0 ? Number(((err / count) * 100).toFixed(2)) : 0;
    const sorted = group.map((s) => s.elapsedMs).sort((a, b) => a - b);
    const avg =
      sorted.length > 0
        ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
        : 0;
    const statusBreakdown: Record<string, number> = {};
    for (const item of group) {
      const codeKey = item.status > 0 ? String(item.status) : 'ERR';
      statusBreakdown[codeKey] = (statusBreakdown[codeKey] || 0) + 1;
    }

    return {
      label: sampler.label,
      method: sampler.method,
      url: sampler.url,
      samples: count,
      successCount: succ,
      errorCount: err,
      errorRatePct: errRate,
      minMs: sorted[0] ?? 0,
      avgMs: avg,
      p50Ms: computePercentile(sorted, 50),
      p90Ms: computePercentile(sorted, 90),
      p95Ms: computePercentile(sorted, 95),
      p99Ms: computePercentile(sorted, 99),
      maxMs: sorted[sorted.length - 1] ?? 0,
      rps: Number((count / actualDurationSec).toFixed(1)),
      statusBreakdown,
    };
  });

  // Evaluate SLA / Performance Assertion
  let slaThresholdMs = config.maxAcceptableP95Ms ?? 1500;
  const assertText = payload.assertionPrompt?.trim() || '';
  const msMatch = assertText.match(/(\d+)\s*ms/i);
  const secMatch = assertText.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|seconds)\b/i);
  if (msMatch) {
    slaThresholdMs = Number(msMatch[1]);
  } else if (secMatch) {
    slaThresholdMs = Math.round(Number(secMatch[1]) * 1000);
  }

  const slaPassed =
    totalSamples > 0 && errorRatePct <= 10 && p95LatencyMs <= slaThresholdMs;
  const slaMessage = slaPassed
    ? `PASSED SLA: ${totalSamples} samples across ${config.virtualUsers} VUs | Avg: ${avgLatencyMs}ms | p95: ${p95LatencyMs}ms (<= ${slaThresholdMs}ms SLA) | Throughput: ${avgRps} req/s (Peak ${peakRps} req/s) | Error Rate: ${errorRatePct}%`
    : `SLA VIOLATION: p95 Latency ${p95LatencyMs}ms (Threshold: ${slaThresholdMs}ms) or Error Rate ${errorRatePct}% across ${totalSamples} samples (${config.virtualUsers} VUs).`;

  const summary: LoadTestSummary = {
    virtualUsers: config.virtualUsers,
    rampUpSeconds: config.rampUpSeconds,
    durationSeconds: config.durationSeconds,
    actualDurationSec,
    totalSamples,
    successSamples,
    failedSamples,
    errorRatePct,
    avgRps,
    peakRps,
    minLatencyMs,
    avgLatencyMs,
    p50LatencyMs,
    p90LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
    maxLatencyMs,
    totalBytesTransferred,
    slaPassed,
    slaMessage,
    samplers: samplerMetrics,
    timeline,
  };

  onLog(
    `\n╔════════════════════════════════════════════════════════════════════════╗\n` +
      `║ JMETER AGGREGATE PERFORMANCE SUMMARY                                   ║\n` +
      `╠════════════════════════════════════════════════════════════════════════╣\n` +
      `║ Total Samples    : ${String(totalSamples).padEnd(12)} | Throughput (Avg/Peak): ${`${avgRps}/s (Peak ${peakRps}/s)`.padEnd(21)} ║\n` +
      `║ Latency (Avg/p50): ${`${avgLatencyMs}ms / ${p50LatencyMs}ms`.padEnd(12)} | Latency (p90/p95/p99): ${`${p90LatencyMs}ms / ${p95LatencyMs}ms / ${p99LatencyMs}ms`.padEnd(21)} ║\n` +
      `║ Min / Max Latency: ${`${minLatencyMs}ms / ${maxLatencyMs}ms`.padEnd(12)} | Error Rate           : ${`${errorRatePct}% (${failedSamples} failed)`.padEnd(21)} ║\n` +
      `║ SLA Verdict      : ${slaMessage.slice(0, 51).padEnd(51)} ║\n` +
      `╚════════════════════════════════════════════════════════════════════════╝\n`
  );

  // Persist `.e2e/load-summary.json` and `.e2e/report.json` so `.docx` Word Report & Evidence tab work seamlessly
  await fs.mkdir(path.join(projectRoot, '.e2e'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.e2e', 'load-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8'
  );
  await fs.writeFile(
    path.join(projectRoot, '.e2e', 'highlighted-observation.json'),
    JSON.stringify({ summary: slaMessage }),
    'utf-8'
  );

  const reportSteps = samplerMetrics.map((sm, idx) => ({
    id: `step-${idx + 1}`,
    index: idx + 1,
    api: 'jmeter.sampler',
    label: `${sm.label} (${sm.samples} samples @ ${sm.rps} req/s)`,
    status: sm.errorRatePct <= 10 ? 'passed' : 'failed',
    durationMs: sm.avgMs,
    summary: `Samples: ${sm.samples} | Avg: ${sm.avgMs}ms | p50: ${sm.p50Ms}ms | p90: ${sm.p90Ms}ms | p95: ${sm.p95Ms}ms | p99: ${sm.p99Ms}ms | Max: ${sm.maxMs}ms | Errors: ${sm.errorRatePct}% | Throughput: ${sm.rps} req/s`,
    screen: { location: sm.url },
    error:
      sm.errorRatePct > 10
        ? {
            code: 'HIGH_ERROR_RATE',
            message: `Error rate ${sm.errorRatePct}% (${sm.errorCount}/${sm.samples} failed)`,
          }
        : undefined,
  }));

  reportSteps.push({
    id: `step-${reportSteps.length + 1}`,
    index: reportSteps.length + 1,
    api: 'jmeter.sla',
    label: payload.assertionPrompt?.trim() || `p95 Latency <= ${slaThresholdMs}ms & Error Rate <= 10%`,
    status: slaPassed ? 'passed' : 'failed',
    durationMs: Math.round(actualDurationSec * 1000),
    summary: slaMessage,
    screen: { location: payload.url },
    error: slaPassed ? undefined : { code: 'SLA_FAILED', message: slaMessage },
  });

  const reportJson = {
    run: {
      startedAt: startedAtIso,
      targets: [{ baseOrigin: payload.url }],
      results: [
        {
          selected: true,
          status: slaPassed ? 'passed' : 'failed',
          attempts: [
            {
              status: slaPassed ? 'passed' : 'failed',
              startedAt: startedAtIso,
              durationMs: Math.round(actualDurationSec * 1000),
              artifacts: [],
              steps: reportSteps,
            },
          ],
        },
      ],
    },
  };

  await fs.writeFile(
    path.join(projectRoot, '.e2e', 'report.json'),
    JSON.stringify(reportJson, null, 2),
    'utf-8'
  );

  return { exitCode: slaPassed ? 0 : 1, summary };
}
