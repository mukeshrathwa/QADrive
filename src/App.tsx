import React, { useEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  EvidencePayload,
  LoadTestConfig,
  LoginMode,
  OrgAwsAuthType,
  OrgAwsConnectionType,
  PromptTemplate,
  RunPromptPayload,
  RunStatus,
  TargetType,
  TestRailCase,
} from './types';

const SETTINGS_STORAGE_KEY = 'e2e_desktop_runner_settings_v2';

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'signup-order-flow',
    label: 'Signup & Order Flow',
    targetType: 'web',
    url: 'http://localhost:5000/',
    prompt:
      'Step 1: Go to signup and register user.\nStep 2: Once registered the user. Login with the same credentials.\nStep 3: Add item in the cart any one. And  Create order.\nStep 4. Navigate to order listing  page',
    assertionPrompt: 'Order should be listed on the order listing page',
    loginMode: 'none',
  },
];

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  templates: DEFAULT_TEMPLATES,
  browser: 'chromium',
  headed: true,
  useCache: true,
  reuseSession: false,
  stepTimeoutSeconds: 180,
  maxRetries: 2,
  blockAds: true,
  recordVideo: false,
  autoFillForms: true,
  formData: {
    fullName: 'Test User',
    firstName: 'Test',
    lastName: 'User',
    email: 'qa.tester@example.com',
    phone: '9876543210',
    company: 'TesterArmy QA',
    address: '123 Tech Park Road',
    city: 'Bengaluru',
    postalCode: '560001',
    country: 'India',
    message: 'Automated E2E test form submission verification.',
    customJson: '',
  },
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: '',
  ollamaUrl: 'http://127.0.0.1:11434/v1',
  orgAws: {
    enabled: false,
    connectionType: 'aws-gateway-openai',
    authType: 'bearer-token',
    endpointUrl: '',
    model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    authToken: '',
    authHeaderName: 'Authorization',
    customHeadersJson: '',
    awsRegion: 'us-east-1',
    awsAccessKeyId: '',
    awsSecretAccessKey: '',
    awsSessionToken: '',
    allowSelfSignedCerts: false,
  },
  loginMode: 'none',
  loginUser: '',
  loginPassword: '',
  loginWaitSeconds: 180,
  desktopExePath: 'notepad.exe',
  desktopLoginMode: 'none',
  desktopLoginUser: '',
  desktopLoginPassword: '',
  testrail: {
    enabled: false,
    baseUrl: '',
    username: '',
    apiKey: '',
    defaultRunId: '',
    defaultProjectId: '',
    autoUpdateResult: true,
  },
  loadConfig: {
    virtualUsers: 25,
    rampUpSeconds: 5,
    durationSeconds: 15,
    samplerMode: 'http-samplers',
    thinkTimeMs: 100,
    maxAcceptableP95Ms: 1500,
  },
};

export function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          templates:
            Array.isArray(parsed.templates) && parsed.templates.length > 0
              ? parsed.templates.filter(
                  (t: PromptTemplate) =>
                    t.id === 'signup-order-flow' ||
                    t.label === 'Signup & Order Flow' ||
                    t.id?.startsWith('custom-')
                )
              : DEFAULT_TEMPLATES,
          formData: {
            ...DEFAULT_SETTINGS.formData,
            ...(parsed.formData || {}),
          },
          orgAws: {
            ...DEFAULT_SETTINGS.orgAws,
            ...(parsed.orgAws || {}),
          },
          testrail: {
            ...DEFAULT_SETTINGS.testrail,
            ...(parsed.testrail || {}),
          },
          loadConfig: {
            ...DEFAULT_SETTINGS.loadConfig,
            ...(parsed.loadConfig || {}),
          },
        };
      }
    } catch {
      // fallback to defaults
    }
    return DEFAULT_SETTINGS;
  });

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    'browser' | 'forms' | 'ai' | 'login' | 'templates' | 'testrail' | 'jmeter'
  >('browser');

  const [trTestStatus, setTrTestStatus] = useState<{
    testing: boolean;
    success?: boolean;
    message?: string;
  }>({ testing: false });

  const [orgTestStatus, setOrgTestStatus] = useState<{
    testing: boolean;
    success?: boolean;
    message?: string;
  }>({ testing: false });

  const handleTestOrgAwsConnection = async () => {
    setOrgTestStatus({ testing: true });
    try {
      const res = await fetch('/api/org-aws/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.orgAws),
      });
      const data = (await res.json()) as {
        ok: boolean;
        message: string;
        model?: string;
      };
      setOrgTestStatus({
        testing: false,
        success: data.ok,
        message:
          data.message ||
          (data.ok
            ? 'Organization AWS model connected!'
            : 'Connection failed'),
      });
    } catch (err) {
      setOrgTestStatus({
        testing: false,
        success: false,
        message: (err as Error).message,
      });
    }
  };

  // Main screen inputs
  const [targetType, setTargetType] = useState<TargetType>('web');
  const [url, setUrl] = useState('http://localhost:5000/');
  const [isScanningSite, setIsScanningSite] = useState(false);
  const [siteMapInfo, setSiteMapInfo] = useState<{
    pageCount: number;
    routes: string[];
    suggestedScenarios: Array<{
      title: string;
      prompt: string;
      assertionPrompt: string;
    }>;
  }>({ pageCount: 0, routes: [], suggestedScenarios: [] });

  const refreshSiteMapInfo = async (targetUrl = url) => {
    if (targetType === 'desktop' || !/^https?:\/\//i.test(targetUrl.trim())) {
      return;
    }
    try {
      const res = await fetch(
        `/api/site-map?url=${encodeURIComponent(targetUrl.trim())}`
      );
      if (res.ok) {
        const data = await res.json();
        const pagesObj = data.siteMap?.pages || {};
        setSiteMapInfo({
          pageCount: Object.keys(pagesObj).length,
          routes: Object.keys(pagesObj),
          suggestedScenarios: data.siteMap?.suggestedScenarios || [],
        });
      }
    } catch {
      // ignore
    }
  };

  const handleScanWebsite = async () => {
    if (!url.trim() || !/^https?:\/\//i.test(url.trim())) return;
    setIsScanningSite(true);
    try {
      const res = await fetch('/api/site-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), maxPages: 15 }),
      });
      if (res.ok) {
        const data = await res.json();
        const pagesObj = data.siteMap?.pages || {};
        setSiteMapInfo({
          pageCount: Object.keys(pagesObj).length,
          routes: Object.keys(pagesObj),
          suggestedScenarios: data.siteMap?.suggestedScenarios || [],
        });
        await refreshCacheStatus(url, prompt);
      }
    } catch {
      // ignore
    } finally {
      setIsScanningSite(false);
    }
  };
  const [prompt, setPrompt] = useState(
    'Step 1: Go to signup and register user.\nStep 2: Once registered the user. Login with the same credentials.\nStep 3: Add item in the cart any one. And  Create order.\nStep 4. Navigate to order listing  page'
  );
  const [assertionPrompt, setAssertionPrompt] = useState(
    'Order should be listed on the order listing page'
  );

  // TestRail main screen inputs
  const [caseIdInput, setCaseIdInput] = useState('C101');
  const [runIdOverride, setRunIdOverride] = useState('');
  const [isFetchingCase, setIsFetchingCase] = useState(false);
  const [caseFetchError, setCaseFetchError] = useState<string | null>(null);
  const [loadedCase, setLoadedCase] = useState<TestRailCase | null>(null);

  // Execution & Diagnostics state
  const [status, setStatus] = useState<RunStatus>('idle');
  const [logs, setLogs] = useState<string>('');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [generatedPath, setGeneratedPath] = useState<string>(
    'tests/generated/prompt-run.e2e.ts'
  );
  const [evidence, setEvidence] = useState<EvidencePayload | null>(null);
  const [activeTab, setActiveTab] = useState<'console' | 'evidence' | 'code'>('console');
  const [codeViewMode, setCodeViewMode] = useState<'e2e' | 'playwright'>('e2e');
  const [cacheStatus, setCacheStatus] = useState<{
    cachedStepsCount: number;
    totalStepsCount: number;
    totalCachedActions: number;
    hasSession: boolean;
    sessionSavedAt?: string;
    exportedPlaywrightExists: boolean;
  }>({
    cachedStepsCount: 0,
    totalStepsCount: 0,
    totalCachedActions: 0,
    hasSession: false,
    exportedPlaywrightExists: false,
  });

  const refreshCacheStatus = async (targetUrl = url, targetPrompt = prompt) => {
    if (targetType === 'desktop' || !/^https?:\/\//i.test(targetUrl.trim())) {
      return;
    }
    try {
      const params = new URLSearchParams({
        url: targetUrl.trim(),
        prompt: targetPrompt.trim(),
      });
      const res = await fetch(`/api/cache-status?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setCacheStatus(data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      refreshCacheStatus(url, prompt);
      refreshSiteMapInfo(url);
    }, 250);
    return () => clearTimeout(timer);
  }, [url, prompt, status, targetType]);

  const handleClearCacheOrSession = async (clearType: 'cache' | 'session' | 'both') => {
    try {
      await fetch('/api/cache-clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), clearType }),
      });
      await refreshCacheStatus(url, prompt);
    } catch {
      // ignore
    }
  };

  const handleOpenPlaywrightSpec = async () => {
    await fetch('/api/export/open-playwright', { method: 'POST' });
  };

  const logContainerRef = useRef<HTMLPreElement | null>(null);

  const updateSettings = (updater: (prev: AppSettings) => AppSettings) => {
    setSettings((prev) => {
      const next = updater(prev);
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  useEffect(() => {
    const api = window.e2eDesktop;
    if (api) {
      const unsubLog = api.onLog((chunk) => {
        setLogs((prev) => prev + chunk);
      });
      const unsubStatus = api.onStatus((data) => {
        setStatus(data.status);
      });
      const unsubCode = api.onCodeGenerated((data) => {
        setGeneratedPath(data.filePath);
        setGeneratedCode(data.code);
      });
      return () => {
        unsubLog();
        unsubStatus();
        unsubCode();
      };
    }

    const eventSource = new EventSource('/api/events');

    eventSource.addEventListener('log', (e) => {
      const chunk = JSON.parse((e as MessageEvent).data) as string;
      setLogs((prev) => prev + chunk);
    });

    eventSource.addEventListener('status', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { status: RunStatus };
      setStatus(data.status);
    });

    eventSource.addEventListener('code-generated', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        filePath: string;
        code: string;
      };
      setGeneratedPath(data.filePath);
      setGeneratedCode(data.code);
    });

    eventSource.addEventListener('evidence', (e) => {
      const data = JSON.parse((e as MessageEvent).data) as EvidencePayload;
      setEvidence(data);
    });

    return () => {
      eventSource.close();
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme || 'light');
  }, [settings.theme]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const handleTestConnection = async () => {
    setTrTestStatus({ testing: true });
    try {
      const res = await fetch('/api/testrail/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings.testrail),
      });
      const data = (await res.json()) as { ok: boolean; message: string; user?: string };
      setTrTestStatus({
        testing: false,
        success: data.ok,
        message:
          data.message || (data.ok ? 'Connection successful!' : 'Connection failed'),
      });
    } catch (err) {
      setTrTestStatus({
        testing: false,
        success: false,
        message: (err as Error).message,
      });
    }
  };

  const handleFetchCase = async (overrideId?: string): Promise<TestRailCase | null> => {
    const idToFetch = (overrideId ?? caseIdInput).trim();
    if (!idToFetch) return null;

    setIsFetchingCase(true);
    setCaseFetchError(null);

    try {
      const res = await fetch('/api/testrail/case', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: settings.testrail,
          caseId: idToFetch,
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        case?: TestRailCase;
        error?: string;
      };

      if (!res.ok || !data.ok || !data.case) {
        throw new Error(data.error || `Failed to fetch case ${idToFetch}`);
      }

      setLoadedCase(data.case);
      if (data.case.url) {
        setUrl(data.case.url);
      }
      setPrompt(data.case.prompt);
      setAssertionPrompt(data.case.assertionPrompt);
      return data.case;
    } catch (err) {
      setCaseFetchError((err as Error).message);
      return null;
    } finally {
      setIsFetchingCase(false);
    }
  };

  const handleRunTest = async (e: React.FormEvent) => {
    e.preventDefault();

    let runUrl = url.trim();
    let runPrompt = prompt.trim();
    let runAssertion = assertionPrompt.trim();
    let activeCaseId = loadedCase?.caseIdFormatted || caseIdInput.trim();

    // In TestRail mode, if the user changed Case ID or hasn't clicked Fetch yet, auto-fetch first
    if (settings.testrail.enabled && caseIdInput.trim()) {
      const normalizedInput = caseIdInput.trim().toUpperCase().replace(/^C?/, 'C');
      if (!loadedCase || loadedCase.caseIdFormatted.toUpperCase() !== normalizedInput) {
        const fetched = await handleFetchCase(caseIdInput.trim());
        if (!fetched) {
          return;
        }
        if (fetched.url) runUrl = fetched.url;
        runPrompt = fetched.prompt;
        runAssertion = fetched.assertionPrompt;
        activeCaseId = fetched.caseIdFormatted;
      }
    }

    if (!runUrl || !runPrompt) return;

    setLogs('');
    setEvidence(null);
    setStatus('running');
    setActiveTab('console');

    const effectiveRunId =
      runIdOverride.trim() || settings.testrail.defaultRunId?.trim() || undefined;

    const payload: RunPromptPayload = {
      targetType,
      loadConfig: targetType === 'load' ? settings.loadConfig : undefined,
      url: runUrl,
      prompt: runPrompt,
      assertionPrompt: runAssertion || undefined,
      loginMode: settings.loginMode,
      loginUser: settings.loginUser.trim() || undefined,
      loginPassword: settings.loginPassword || undefined,
      loginWaitSeconds: settings.loginWaitSeconds,
      desktopExePath: settings.desktopExePath?.trim() || 'notepad.exe',
      desktopLoginMode: settings.desktopLoginMode || 'none',
      desktopLoginUser: settings.desktopLoginUser?.trim() || undefined,
      desktopLoginPassword: settings.desktopLoginPassword || undefined,
      stepTimeoutSeconds: settings.stepTimeoutSeconds,
      maxRetries: settings.maxRetries,
      blockAds: settings.blockAds,
      recordVideo: settings.recordVideo,
      autoFillForms: settings.autoFillForms,
      formData: settings.formData,
      browser: settings.browser,
      headed: settings.headed,
      useCache: settings.useCache,
      reuseSession: settings.reuseSession,
      provider: settings.provider,
      model: settings.model.trim(),
      apiKey: settings.apiKey.trim() || undefined,
      ollamaUrl: settings.ollamaUrl.trim() || undefined,
      orgAws: settings.orgAws,

      testrailCaseId: settings.testrail.enabled ? activeCaseId || undefined : undefined,
      testrailRunId: settings.testrail.enabled ? effectiveRunId : undefined,
      testrailConfig: settings.testrail.enabled ? settings.testrail : undefined,
    };

    try {
      if (window.e2eDesktop) {
        await window.e2eDesktop.runPrompt(payload);
      } else {
        const res = await fetch('/api/run-prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error ?? `HTTP ${res.status}`);
        }
      }
    } catch (err) {
      setLogs((prev) => prev + `\n[Error] ${(err as Error).message}\n`);
      setStatus('failed');
    }
  };

  const handleStopTest = async () => {
    if (window.e2eDesktop) {
      await window.e2eDesktop.stopRun();
    } else {
      await fetch('/api/stop-run', { method: 'POST' });
    }
  };

  const handleOpenWordDoc = async () => {
    await fetch('/api/report/open-docx', { method: 'POST' });
  };

  const handleOpenReportFolder = async () => {
    await fetch('/api/report/open-folder', { method: 'POST' });
  };

  const [copiedPath, setCopiedPath] = useState(false);
  const handleCopyReportPath = async (pathText: string) => {
    try {
      await navigator.clipboard.writeText(pathText);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  };

  const applySample = (sample: PromptTemplate) => {
    setTargetType(sample.targetType);
    setUrl(sample.url);
    setPrompt(sample.prompt);
    setAssertionPrompt(sample.assertionPrompt);
    updateSettings((s) => ({
      ...s,
      loginMode: sample.loginMode,
      desktopExePath: sample.desktopExePath || s.desktopExePath || 'notepad.exe',
    }));
  };

  const handleBrowseExe = async () => {
    try {
      const res = await fetch('/api/desktop/browse-exe', { method: 'POST' });
      const data = (await res.json()) as { selectedPath?: string | null };
      if (data.selectedPath) {
        if (targetType === 'hybrid') {
          updateSettings((s) => ({ ...s, desktopExePath: data.selectedPath! }));
        } else {
          setTargetType('desktop');
          setUrl(data.selectedPath);
        }
      }
    } catch {
      // ignore if dialog canceled
    }
  };

  return (
    <div className="app-shell">
      {/* Top Header Bar — Simple & Sober Navigation */}
      <header className="top-bar">
        <div className="brand">
          <span className="brand-badge">QA Drive</span>
          <div>
            <h1>QA Drive</h1>
            <p>Automated Web, Desktop &amp; Performance Test Studio</p>
          </div>
        </div>

        <div className="top-actions">
          {evidence?.testrailResult && (
            <div className="badge-testrail-synced">
              TestRail: R{evidence.testrailResult.runId} / {evidence.testrailResult.caseId} (
              {evidence.testrailResult.status.toUpperCase()})
            </div>
          )}

          {/* Sober Top Menu Bar */}
          <div className="top-menu-group">
            <button
              type="button"
              className={`top-menu-btn ${settings.orgAws?.enabled ? 'active' : ''}`}
              onClick={() =>
                updateSettings((s) => ({
                  ...s,
                  orgAws: { ...s.orgAws, enabled: !s.orgAws?.enabled },
                }))
              }
              title="Toggle between Standard AI Provider and Organization AWS Model"
            >
              {settings.orgAws?.enabled ? 'AI: Org AWS' : `AI: ${settings.provider}`}
            </button>

            <button
              type="button"
              className="top-menu-btn"
              onClick={() =>
                updateSettings((s) => ({
                  ...s,
                  theme: s.theme === 'dark' ? 'light' : 'dark',
                }))
              }
              title="Switch appearance theme"
            >
              {settings.theme === 'dark' ? 'Theme: Dark' : 'Theme: Light'}
            </button>

            <button
              type="button"
              className="top-menu-btn"
              onClick={() => {
                setTrTestStatus({ testing: false });
                setIsSettingsOpen(true);
              }}
            >
              Settings
            </button>
          </div>

          <div className={`status-pill status-${status}`}>
            <strong>{status.toUpperCase()}</strong>
          </div>
        </div>
      </header>

      {/* Main Workspace Grid */}
      <main className="workspace-grid">
        {/* Left Column: Logically Grouped Test Configuration */}
        <section className="panel form-panel">
          {/* GROUP 1: Test Mode & Target */}
          <div className="ui-group-card">
            <div className="ui-group-header">
              <span className="ui-group-title">1. Mode &amp; Target</span>
              <div className="sober-mode-nav">
                <button
                  type="button"
                  className={`sober-nav-item ${
                    !settings.testrail.enabled &&
                    (targetType === 'web' || targetType === 'hybrid')
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => {
                    updateSettings((s) => ({
                      ...s,
                      testrail: { ...s.testrail, enabled: false },
                    }));
                    setTargetType('web');
                    if (!/^https?:\/\//i.test(url)) {
                      setUrl('http://localhost:5000/');
                    }
                  }}
                >
                  Web
                </button>
                <button
                  type="button"
                  className={`sober-nav-item ${
                    !settings.testrail.enabled && targetType === 'desktop' ? 'active' : ''
                  }`}
                  onClick={() => {
                    updateSettings((s) => ({
                      ...s,
                      testrail: { ...s.testrail, enabled: false },
                    }));
                    setTargetType('desktop');
                    if (/^https?:\/\//i.test(url)) {
                      setUrl('notepad.exe');
                    }
                  }}
                >
                  Desktop
                </button>
                <button
                  type="button"
                  className={`sober-nav-item ${settings.testrail.enabled ? 'active' : ''}`}
                  onClick={() => {
                    updateSettings((s) => ({
                      ...s,
                      testrail: { ...s.testrail, enabled: true },
                    }));
                    if (!/^https?:\/\//i.test(url)) {
                      setUrl('http://localhost:5000/');
                    }
                  }}
                >
                  TestRail
                </button>
                <button
                  type="button"
                  className={`sober-nav-item ${
                    !settings.testrail.enabled && targetType === 'load' ? 'active' : ''
                  }`}
                  onClick={() => {
                    updateSettings((s) => ({
                      ...s,
                      testrail: { ...s.testrail, enabled: false },
                    }));
                    setTargetType('load');
                    if (!/^https?:\/\//i.test(url)) {
                      setUrl('http://localhost:5000/');
                    }
                  }}
                >
                  Load Test
                </button>
              </div>
            </div>

            <label className="field">
              <span>
                {!settings.testrail.enabled && targetType === 'desktop'
                  ? 'Desktop Application (.exe Path or Command)'
                  : 'Target Application URL'}
              </span>
              <div className="target-input-row">
                <input
                  type={
                    !settings.testrail.enabled && targetType === 'desktop' ? 'text' : 'url'
                  }
                  required
                  placeholder={
                    !settings.testrail.enabled && targetType === 'desktop'
                      ? 'e.g. notepad.exe, calc.exe, or C:\\Program Files\\App.exe'
                      : 'http://localhost:5000/'
                  }
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                {!settings.testrail.enabled && targetType === 'desktop' ? (
                  <button
                    type="button"
                    className="btn-browse-exe"
                    onClick={handleBrowseExe}
                    title="Browse for a Windows executable (.exe)"
                  >
                    Browse .exe
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-browse-exe"
                    disabled={isScanningSite}
                    onClick={handleScanWebsite}
                    title="Scan internal pages, links, and forms to map routes and suggest scenarios"
                  >
                    {isScanningSite
                      ? 'Scanning...'
                      : siteMapInfo.pageCount > 0
                        ? `Scan Site (${siteMapInfo.pageCount})`
                        : 'Scan Site'}
                  </button>
                )}
              </div>
            </label>

            {!settings.testrail.enabled &&
              (targetType === 'web' || targetType === 'hybrid') && (
                <label className="zero-llm-toggle" style={{ marginTop: '2px' }}>
                  <input
                    type="checkbox"
                    checked={targetType === 'hybrid'}
                    onChange={(e) =>
                      setTargetType(e.target.checked ? 'hybrid' : 'web')
                    }
                  />
                  <span>
                    Include Desktop Application (<code>.exe</code>) for Hybrid Web + Desktop flow
                  </span>
                </label>
              )}

            {!settings.testrail.enabled && targetType === 'hybrid' && (
              <label className="field">
                <span>Desktop Application (.exe Path or Command)</span>
                <div className="target-input-row">
                  <input
                    type="text"
                    required
                    placeholder="e.g. C:\EVV\EVVClient.exe or notepad.exe"
                    value={settings.desktopExePath ?? 'notepad.exe'}
                    onChange={(e) =>
                      updateSettings((s) => ({ ...s, desktopExePath: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className="btn-browse-exe"
                    onClick={handleBrowseExe}
                    title="Browse for the Windows Desktop (.exe) application"
                  >
                    Browse .exe
                  </button>
                </div>
              </label>
            )}

            {!settings.testrail.enabled && (
              <div className="preset-row" style={{ justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span>Templates:</span>
                  {(settings.templates && settings.templates.length > 0
                    ? settings.templates
                    : DEFAULT_TEMPLATES
                  ).map((sample) => (
                    <button
                      key={sample.id || sample.label}
                      type="button"
                      className="preset-btn"
                      onClick={() => applySample(sample)}
                    >
                      {sample.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setSettingsTab('templates');
                    setIsSettingsOpen(true);
                  }}
                >
                  Manage in Settings
                </button>
              </div>
            )}

            {targetType !== 'desktop' && siteMapInfo.pageCount > 0 && (
              <div className="preset-row">
                <span>
                  Mapped ({siteMapInfo.pageCount} routes):
                </span>
                {siteMapInfo.suggestedScenarios.map((sc, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="preset-btn"
                    onClick={() => {
                      setPrompt(sc.prompt);
                      setAssertionPrompt(sc.assertionPrompt);
                    }}
                    title={`Routes: ${siteMapInfo.routes.join(', ')}`}
                  >
                    {sc.title}
                  </button>
                ))}
              </div>
            )}
          </div>

          {settings.testrail.enabled ? (
            /* ==========================================================
               TESTRAIL MODE: GROUP 2 (CASE & SCENARIO) + GROUP 3 (EXECUTION)
               ========================================================== */
            <form onSubmit={handleRunTest} className="prompt-form">
              <div className="ui-group-card">
                <div className="ui-group-header">
                  <span className="ui-group-title">2. TestRail Case &amp; Scenario</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setSettingsTab('testrail');
                      setIsSettingsOpen(true);
                    }}
                  >
                    Connection Settings
                  </button>
                </div>

                <div className="row-2">
                  <label className="field">
                    <span>Case ID</span>
                    <div className="target-input-row">
                      <input
                        type="text"
                        placeholder="e.g. C101"
                        value={caseIdInput}
                        onChange={(e) => setCaseIdInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-browse-exe"
                        disabled={isFetchingCase || !caseIdInput.trim()}
                        onClick={() => handleFetchCase()}
                      >
                        {isFetchingCase ? 'Fetching...' : 'Fetch'}
                      </button>
                    </div>
                  </label>

                  <label className="field">
                    <span>Run ID (Optional)</span>
                    <input
                      type="text"
                      placeholder={
                        settings.testrail.defaultRunId
                          ? `Default: R${settings.testrail.defaultRunId}`
                          : 'e.g. R204'
                      }
                      value={runIdOverride}
                      onChange={(e) => setRunIdOverride(e.target.value)}
                    />
                  </label>
                </div>

                <div className="preset-row">
                  <span>Samples:</span>
                  {['C101', 'C102', 'C103', 'C104'].map((cid) => (
                    <button
                      key={cid}
                      type="button"
                      className="preset-btn"
                      onClick={() => {
                        setCaseIdInput(cid);
                        handleFetchCase(cid);
                      }}
                    >
                      {cid}
                    </button>
                  ))}
                </div>

                {caseFetchError && (
                  <div className="fetch-error">{caseFetchError}</div>
                )}

                {loadedCase && (
                  <div className="loaded-case-badge">
                    <div className="case-title-row">
                      <span className="case-tag">{loadedCase.caseIdFormatted}</span>
                      <h4>{loadedCase.title}</h4>
                    </div>
                    {(loadedCase.section || loadedCase.priority) && (
                      <div className="case-meta-line">
                        {loadedCase.section ? `Section: ${loadedCase.section}` : ''}
                        {loadedCase.section && loadedCase.priority ? ' • ' : ''}
                        {loadedCase.priority ? `${loadedCase.priority}` : ''}
                      </div>
                    )}
                  </div>
                )}

                <label className="field">
                  <span>Test Steps</span>
                  <textarea
                    rows={4}
                    required
                    placeholder="Fetch a TestRail case above or enter steps directly..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>

                <label className="field">
                  <span>Expected Verification</span>
                  <input
                    type="text"
                    placeholder="Expected outcome to verify..."
                    value={assertionPrompt}
                    onChange={(e) => setAssertionPrompt(e.target.value)}
                  />
                </label>
              </div>

              <div className="ui-group-card">
                <div className="ui-group-header">
                  <span className="ui-group-title">3. Execution &amp; Environment</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => setIsSettingsOpen(true)}
                  >
                    Configure
                  </button>
                </div>

                <div className="summary-tags">
                  <span className="summary-chip">{settings.browser}</span>
                  <span className="summary-chip">
                    {settings.orgAws?.enabled
                      ? `Org AWS: ${settings.orgAws.model}`
                      : `${settings.provider}: ${settings.model}`}
                  </span>
                  <span className="summary-chip">
                    Timeout: {settings.stepTimeoutSeconds}s
                  </span>
                  <span className="summary-chip">Login: {settings.loginMode}</span>
                  {settings.recordVideo && (
                    <span className="summary-chip chip-rec">Video ON</span>
                  )}
                </div>

                <div className="action-buttons">
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={status === 'running'}
                  >
                    {status === 'running'
                      ? 'Running TestRail Case...'
                      : `Run Case ${caseIdInput.trim() || ''}`}
                  </button>

                  {status === 'running' && (
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={handleStopTest}
                    >
                      Stop
                    </button>
                  )}
                </div>
              </div>
            </form>
          ) : (
            /* ==========================================================
               STANDARD MODE: GROUP 2 (SCENARIO) + GROUP 3 (EXECUTION)
               ========================================================== */
            <form onSubmit={handleRunTest} className="prompt-form">
              {/* GROUP 2: Test Scenario & Expected Verification */}
              <div className="ui-group-card">
                <div className="ui-group-header">
                  <span className="ui-group-title">2. Test Scenario</span>
                  {targetType === 'hybrid' ? (
                    <div className="fetch-shortcuts">
                      <button
                        type="button"
                        className="preset-btn"
                        onClick={() =>
                          setPrompt((p) =>
                            `${p.trim()}\nStep ${p.trim().split('\n').length + 1} [WEB]: `
                          )
                        }
                        title="Append a Web Browser step"
                      >
                        + [WEB] Step
                      </button>
                      <button
                        type="button"
                        className="preset-btn"
                        onClick={() =>
                          setPrompt((p) =>
                            `${p.trim()}\nStep ${p.trim().split('\n').length + 1} [MOBILE]: `
                          )
                        }
                        title="Append a Mobile Viewport (390x844 Touch) step"
                      >
                        + [MOBILE] Step
                      </button>
                      <button
                        type="button"
                        className="preset-btn"
                        onClick={() =>
                          setPrompt((p) =>
                            `${p.trim()}\nStep ${p.trim().split('\n').length + 1} [DESKTOP]: `
                          )
                        }
                        title="Append a Windows Desktop (.exe) step"
                      >
                        + [DESKTOP] Step
                      </button>
                    </div>
                  ) : (
                    <span className="ui-group-subtitle">
                      {targetType === 'desktop'
                        ? 'Windows UI Automation'
                        : targetType === 'load'
                          ? 'Concurrent HTTP & Endpoint Samplers'
                          : 'Browser Step Execution'}
                    </span>
                  )}
                </div>

                <label className="field">
                  <span>
                    {targetType === 'hybrid'
                      ? 'Test Steps (Prefix with [WEB], [MOBILE], or [DESKTOP] in any combination)'
                      : 'Test Steps'}
                  </span>
                  <textarea
                    rows={5}
                    required
                    placeholder={
                      targetType === 'desktop'
                        ? 'Enter step-by-step instructions for the desktop application...'
                        : 'Enter step-by-step instructions for the web application...'
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>

                <label className="field">
                  <span>Expected Result</span>
                  <input
                    type="text"
                    placeholder={
                      targetType === 'desktop'
                        ? 'e.g. Window displays expected text or calculation'
                        : 'e.g. Order should be listed on the order listing page'
                    }
                    value={assertionPrompt}
                    onChange={(e) => setAssertionPrompt(e.target.value)}
                  />
                </label>
              </div>

              {/* GROUP 3: Execution Options & Environment */}
              <div className="ui-group-card">
                <div className="ui-group-header">
                  <span className="ui-group-title">3. Execution &amp; Environment</span>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      if (targetType === 'load') {
                        setSettingsTab('jmeter');
                      }
                      setIsSettingsOpen(true);
                    }}
                  >
                    Configure
                  </button>
                </div>

                {targetType === 'load' && (
                  <div className="zero-llm-bar">
                    <div className="zero-llm-row" style={{ justifyContent: 'space-between' }}>
                      <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
                        <strong>Profile:</strong>{' '}
                        {settings.loadConfig?.virtualUsers ?? 25} VUs •{' '}
                        {settings.loadConfig?.rampUpSeconds ?? 5}s Ramp •{' '}
                        {settings.loadConfig?.durationSeconds ?? 15}s Duration • p95 &le;{' '}
                        {settings.loadConfig?.maxAcceptableP95Ms ?? 1500}ms
                      </span>
                      <div className="fetch-shortcuts">
                        {[10, 25, 50, 100, 250].map((vu) => (
                          <button
                            key={vu}
                            type="button"
                            className={`shortcut-chip ${
                              (settings.loadConfig?.virtualUsers ?? 25) === vu
                                ? 'active'
                                : ''
                            }`}
                            onClick={() =>
                              updateSettings((s) => ({
                                ...s,
                                loadConfig: {
                                  ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                                  virtualUsers: vu,
                                },
                              }))
                            }
                          >
                            {vu} VUs
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {targetType === 'web' && (
                  <div className="zero-llm-bar">
                    <div className="zero-llm-row">
                      <label
                        className="zero-llm-toggle"
                        title="Record DOM selectors on first run and replay identical steps with zero LLM calls"
                      >
                        <input
                          type="checkbox"
                          checked={settings.useCache}
                          onChange={(e) =>
                            updateSettings((s) => ({ ...s, useCache: e.target.checked }))
                          }
                        />
                        <span>Zero-LLM Replay Cache</span>
                      </label>
                      <span
                        className={`cache-pill ${
                          cacheStatus.cachedStepsCount > 0 ? 'cached-ready' : ''
                        }`}
                      >
                        {cacheStatus.cachedStepsCount}/{cacheStatus.totalStepsCount || 0} cached
                      </span>
                      {cacheStatus.cachedStepsCount > 0 && (
                        <button
                          type="button"
                          className="btn-mini-clear"
                          onClick={() => handleClearCacheOrSession('cache')}
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <div className="zero-llm-row">
                      <label
                        className="zero-llm-toggle"
                        title="Restore saved cookies and storage before Step 1"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(settings.reuseSession)}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              reuseSession: e.target.checked,
                            }))
                          }
                        />
                        <span>Reuse Saved Session</span>
                      </label>
                      <span
                        className={`cache-pill ${
                          cacheStatus.hasSession ? 'cached-ready' : ''
                        }`}
                      >
                        {cacheStatus.hasSession ? 'Saved' : 'Auto-saves on run'}
                      </span>
                      {cacheStatus.hasSession && (
                        <button
                          type="button"
                          className="btn-mini-clear"
                          onClick={() => handleClearCacheOrSession('session')}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <div className="summary-tags">
                  <span className="summary-chip">
                    {targetType === 'desktop'
                      ? 'Windows UIA'
                      : targetType === 'hybrid'
                        ? `${settings.browser} + Windows UIA`
                        : settings.browser}
                  </span>
                  <span className="summary-chip">
                    {settings.orgAws?.enabled
                      ? `Org AWS: ${settings.orgAws.model}`
                      : `${settings.provider}: ${settings.model}`}
                  </span>
                  <span className="summary-chip">
                    Timeout: {settings.stepTimeoutSeconds}s
                  </span>
                  {(targetType === 'web' || targetType === 'hybrid') && (
                    <>
                      <span className="summary-chip">Web Auth: {settings.loginMode}</span>
                      {targetType === 'hybrid' && (
                        <span className="summary-chip">
                          Desktop Auth: {settings.desktopLoginMode || 'none'}
                        </span>
                      )}
                      <span className="summary-chip">
                        AdBlock: {settings.blockAds ? 'ON' : 'OFF'}
                      </span>
                    </>
                  )}
                  {settings.recordVideo && (
                    <span className="summary-chip chip-rec">Video ON</span>
                  )}
                </div>

                <div className="action-buttons">
                  <button
                    type="submit"
                    className="btn-primary"
                    disabled={status === 'running'}
                  >
                    {status === 'running'
                      ? targetType === 'desktop'
                        ? 'Running Desktop Test...'
                        : targetType === 'hybrid'
                          ? 'Running Hybrid (Web + Desktop) Test...'
                          : targetType === 'load'
                            ? `Running Load Test (${settings.loadConfig?.virtualUsers ?? 25} VUs)...`
                            : 'Running Web Test...'
                      : targetType === 'desktop'
                        ? 'Run Desktop Test'
                        : targetType === 'hybrid'
                          ? 'Run Hybrid (Web + Desktop) Test'
                          : targetType === 'load'
                            ? `Run Load Test (${settings.loadConfig?.virtualUsers ?? 25} VUs)`
                            : 'Run Web Test'}
                  </button>

                  {status === 'running' && (
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={handleStopTest}
                    >
                      Stop
                    </button>
                  )}
                </div>
              </div>
            </form>
          )}
        </section>

        {/* Right Column: Simple & Sober Output Tabs */}
        <section className="panel output-panel">
          <div className="tab-header">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'console' ? 'active' : ''}`}
              onClick={() => setActiveTab('console')}
            >
              Console
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'evidence' ? 'active' : ''}`}
              onClick={() => setActiveTab('evidence')}
            >
              Report &amp; Evidence
              {evidence && <span className="tab-badge-ready">Ready</span>}
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'code' ? 'active' : ''}`}
              onClick={() => setActiveTab('code')}
            >
              Test Code
            </button>
          </div>

          {activeTab === 'console' && (
            <div className="console-wrapper">
              <pre ref={logContainerRef} className="terminal-box">
                {logs ||
                  'No test run yet.\n\n1. Enter Target URL & Prompt (or enable TestRail in ⚙️ Settings to fetch by Case ID).\n2. Click Run to launch the browser, highlight verified observations, and generate a Word (.docx) report.'}
              </pre>
              {evidence && status !== 'running' && (
                <div className="console-report-footer">
                  <div className="console-footer-left">
                    <span className="footer-dot" />
                    <span>
                      Word Report saved to{' '}
                      <code>{evidence.timestampedDocxPath || evidence.docxPath}</code>
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn-switch-report"
                    onClick={() => setActiveTab('evidence')}
                  >
                    View Report &amp; Evidence →
                  </button>
                </div>
              )}
            </div>
          )}

          {activeTab === 'evidence' && (
            <div className="evidence-box">
              {!evidence ? (
                <div className="empty-evidence">
                  <p>
                    Run a test first to view the stored Word (`.docx`) report location,
                    step-by-step observations, and highlighted screenshots.
                  </p>
                </div>
              ) : (
                <>
                  {evidence.testrailResult && (
                    <div className="evidence-tr-banner">
                      <span>🚆 TestRail Sync Status:</span>
                      <strong>
                        Run R{evidence.testrailResult.runId} → Case{' '}
                        {evidence.testrailResult.caseId} (Result ID #
                        {evidence.testrailResult.resultId ?? 'Synced'})
                      </strong>
                    </div>
                  )}

                  {/* MODULE 1: Stored Report File Location & Direct Actions */}
                  <div className="report-module-card">
                    <div className="module-header">
                      <div>
                        <span className="module-step-tag">1. Stored Report File</span>
                        <h3>Microsoft Word Observation Report (`.docx`)</h3>
                      </div>
                      <div className="docx-actions">
                        <button
                          type="button"
                          className="btn-word-outline"
                          onClick={() =>
                            handleCopyReportPath(
                              evidence.timestampedDocxPath || evidence.docxPath
                            )
                          }
                        >
                          {copiedPath ? '✓ Copied' : '📋 Copy Path'}
                        </button>
                        <button
                          type="button"
                          className="btn-word-outline"
                          onClick={handleOpenReportFolder}
                        >
                          📁 Open Folder
                        </button>
                        <button
                          type="button"
                          className="btn-word"
                          onClick={handleOpenWordDoc}
                        >
                          📂 Open in Word
                        </button>
                      </div>
                    </div>

                    <div className="stored-paths-box">
                      <div className="stored-path-row">
                        <span className="path-label">Report Location:</span>
                        <code className="path-value">
                          {evidence.timestampedDocxPath || evidence.docxPath}
                        </code>
                      </div>
                      {evidence.videos && evidence.videos.length > 0 && (
                        <div className="stored-path-row">
                          <span className="path-label">Video Location:</span>
                          <code className="path-value">
                            {evidence.videos[0].savedPath}
                          </code>
                        </div>
                      )}
                      {evidence.exportedPlaywrightPath && (
                        <div className="stored-path-row">
                          <span className="path-label">Playwright Spec (#17):</span>
                          <code className="path-value">
                            {evidence.exportedPlaywrightPath}
                          </code>
                          <button
                            type="button"
                            className="btn-mini-clear"
                            onClick={handleOpenPlaywrightSpec}
                          >
                            📁 Reveal .spec.ts
                          </button>
                          <button
                            type="button"
                            className="btn-mini-clear"
                            onClick={() => {
                              setCodeViewMode('playwright');
                              setActiveTab('code');
                            }}
                          >
                            &lt;/&gt; View Code
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* MODULE 1.5: JMeter Load & Stress Performance Dashboard (#28) */}
                  {evidence.loadSummary && (
                    <div className="report-module-card">
                      <div className="module-header">
                        <div>
                          <span className="module-step-tag">
                            🔥 JMeter Performance Dashboard (#28)
                          </span>
                          <h3>
                            Load &amp; Stress Aggregate Report ({evidence.loadSummary.virtualUsers}{' '}
                            Virtual Users • {evidence.loadSummary.actualDurationSec}s)
                          </h3>
                        </div>
                        <span
                          className={`obs-badge ${
                            evidence.loadSummary.slaPassed ? 'pass' : 'fail'
                          }`}
                        >
                          {evidence.loadSummary.slaPassed ? 'SLA PASSED' : 'SLA VIOLATION'}
                        </span>
                      </div>

                      <div className="jmeter-kpi-grid">
                        <div className="jmeter-kpi-card">
                          <span className="kpi-label">Total Samples</span>
                          <strong className="kpi-value">
                            {evidence.loadSummary.totalSamples.toLocaleString()}
                          </strong>
                          <span className="kpi-sub">
                            {evidence.loadSummary.successSamples.toLocaleString()} OK •{' '}
                            {evidence.loadSummary.failedSamples} Failed
                          </span>
                        </div>

                        <div className="jmeter-kpi-card">
                          <span className="kpi-label">Throughput (RPS)</span>
                          <strong className="kpi-value">
                            {evidence.loadSummary.avgRps} req/s
                          </strong>
                          <span className="kpi-sub">
                            Peak: {evidence.loadSummary.peakRps} req/s
                          </span>
                        </div>

                        <div className="jmeter-kpi-card">
                          <span className="kpi-label">Avg / Median (p50)</span>
                          <strong className="kpi-value">
                            {evidence.loadSummary.avgLatencyMs}ms
                          </strong>
                          <span className="kpi-sub">
                            p50: {evidence.loadSummary.p50LatencyMs}ms • Min:{' '}
                            {evidence.loadSummary.minLatencyMs}ms
                          </span>
                        </div>

                        <div className="jmeter-kpi-card">
                          <span className="kpi-label">Tail Latency (p90 / p95 / p99)</span>
                          <strong className="kpi-value">
                            {evidence.loadSummary.p95LatencyMs}ms
                          </strong>
                          <span className="kpi-sub">
                            p90: {evidence.loadSummary.p90LatencyMs}ms • p99:{' '}
                            {evidence.loadSummary.p99LatencyMs}ms • Max:{' '}
                            {evidence.loadSummary.maxLatencyMs}ms
                          </span>
                        </div>

                        <div className="jmeter-kpi-card">
                          <span className="kpi-label">Error Rate</span>
                          <strong
                            className={`kpi-value ${
                              evidence.loadSummary.errorRatePct > 5 ? 'kpi-danger' : 'kpi-ok'
                            }`}
                          >
                            {evidence.loadSummary.errorRatePct}%
                          </strong>
                          <span className="kpi-sub">
                            Data:{' '}
                            {(evidence.loadSummary.totalBytesTransferred / 1024).toFixed(1)} KB
                          </span>
                        </div>
                      </div>

                      {evidence.loadSummary.timeline.length > 0 && (
                        <div className="jmeter-timeline-box">
                          <h4>Throughput (RPS) &amp; p95 Latency Over Time</h4>
                          <div className="jmeter-bars-row">
                            {evidence.loadSummary.timeline.map((pt) => {
                              const maxRps = Math.max(1, evidence.loadSummary?.peakRps || 1);
                              const heightPct = Math.max(8, Math.round((pt.rps / maxRps) * 100));
                              return (
                                <div
                                  key={pt.second}
                                  className="jmeter-bar-col"
                                  title={`t=${pt.second}s | Active VUs: ${pt.activeUsers} | RPS: ${pt.rps}/s | Avg: ${pt.avgLatencyMs}ms | p95: ${pt.p95LatencyMs}ms | Errors: ${pt.errors}`}
                                >
                                  <span className="bar-top-val">{pt.rps}</span>
                                  <div className="bar-track">
                                    <div
                                      className={`bar-fill ${pt.errors > 0 ? 'bar-err' : ''}`}
                                      style={{ height: `${heightPct}%` }}
                                    />
                                  </div>
                                  <span className="bar-sec-label">{pt.second}s</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      <div className="jmeter-table-wrap">
                        <table className="jmeter-table">
                          <thead>
                            <tr>
                              <th>JMeter Sampler / Endpoint</th>
                              <th>Samples</th>
                              <th>Avg (ms)</th>
                              <th>p50 (ms)</th>
                              <th>p90 (ms)</th>
                              <th>p95 (ms)</th>
                              <th>p99 (ms)</th>
                              <th>Max (ms)</th>
                              <th>Error %</th>
                              <th>Throughput</th>
                            </tr>
                          </thead>
                          <tbody>
                            {evidence.loadSummary.samplers.map((sm) => (
                              <tr key={sm.label}>
                                <td>
                                  <strong>{sm.label}</strong>
                                </td>
                                <td>{sm.samples}</td>
                                <td>{sm.avgMs}</td>
                                <td>{sm.p50Ms}</td>
                                <td>{sm.p90Ms}</td>
                                <td>
                                  <strong>{sm.p95Ms}</strong>
                                </td>
                                <td>{sm.p99Ms}</td>
                                <td>{sm.maxMs}</td>
                                <td className={sm.errorRatePct > 0 ? 'kpi-danger' : 'kpi-ok'}>
                                  {sm.errorRatePct}%
                                </td>
                                <td>{sm.rps} req/s</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* MODULE 2: Verification & Step Execution Summary */}
                  <div className="report-module-card">
                    <div className="module-header">
                      <div>
                        <span className="module-step-tag">2. Execution Summary</span>
                        <h3>Verification &amp; Step Observations ({evidence.observations.length})</h3>
                      </div>
                    </div>

                    {evidence.highlightedSummary && (
                      <div className="highlight-summary-card">
                        <h4>✓ Highlighted Verification Element on Page</h4>
                        <p>{evidence.highlightedSummary}</p>
                      </div>
                    )}

                    <div className="obs-list">
                      {evidence.observations.map((obs) => (
                        <div key={obs.index} className="obs-item">
                          <div className="obs-title">
                            <span
                              className={`obs-badge ${
                                obs.status === 'passed' ? 'pass' : 'fail'
                              }`}
                            >
                              {obs.status.toUpperCase()}
                            </span>
                            <strong>
                              Step {obs.index} [{obs.api}]
                            </strong>
                            <span className="obs-meta">
                              ({obs.durationSec}s) {obs.label ? `— ${obs.label}` : ''}
                            </span>
                          </div>
                          {obs.summary && (
                            <div className="obs-summary">{obs.summary}</div>
                          )}
                          {obs.errorMessage && (
                            <div className="obs-error">Error: {obs.errorMessage}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* MODULE 3: Visual Evidence (Screenshots & Video Preview) */}
                  <div className="report-module-card">
                    <div className="module-header">
                      <div>
                        <span className="module-step-tag">3. Visual Evidence</span>
                        <h3>
                          Captured Screenshots ({evidence.screenshots.length})
                          {evidence.videos && evidence.videos.length > 0
                            ? ` & Video (${evidence.videos.length})`
                            : ''}
                        </h3>
                      </div>
                    </div>

                    {evidence.videos && evidence.videos.length > 0 && (
                      <div className="screenshot-grid">
                        {evidence.videos.map((v) => (
                          <div key={v.id} className="screenshot-card">
                            <div className="screenshot-caption">
                              <span>🎥 {v.label}</span>
                              <code className="caption-path">{v.savedPath}</code>
                            </div>
                            <video
                              src={v.url}
                              controls
                              preload="metadata"
                              style={{
                                width: '100%',
                                maxHeight: '440px',
                                background: '#000',
                                display: 'block',
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="screenshot-grid">
                      {evidence.screenshots.map((s) => (
                        <div key={s.id} className="screenshot-card">
                          <div className="screenshot-caption">
                            <span>📸 {s.label}</span>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                              className="link-open-img"
                            >
                              Open Full Size ↗
                            </a>
                          </div>
                          <img src={s.url} alt={s.label} />
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'code' && (
            <div className="code-tab-wrapper">
              <div className="code-subtab-bar">
                <div className="code-subtab-buttons">
                  <button
                    type="button"
                    className={`code-subtab-btn ${codeViewMode === 'e2e' ? 'active' : ''}`}
                    onClick={() => setCodeViewMode('e2e')}
                  >
                    Runner Spec ({generatedPath})
                  </button>
                  <button
                    type="button"
                    className={`code-subtab-btn ${codeViewMode === 'playwright' ? 'active' : ''}`}
                    onClick={() => setCodeViewMode('playwright')}
                  >
                    Playwright Spec (Zero-LLM)
                  </button>
                </div>

                <div className="code-subtab-actions">
                  {codeViewMode === 'playwright' && evidence?.exportedPlaywrightPath && (
                    <button
                      type="button"
                      className="btn-word-outline"
                      onClick={handleOpenPlaywrightSpec}
                    >
                      Open in Explorer
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-word-outline"
                    onClick={() =>
                      handleCopyReportPath(
                        codeViewMode === 'playwright'
                          ? evidence?.exportedPlaywrightCode || ''
                          : generatedCode
                      )
                    }
                  >
                    {copiedPath ? 'Copied' : 'Copy Code'}
                  </button>
                </div>
              </div>

              <pre className="terminal-box">
                {codeViewMode === 'playwright'
                  ? evidence?.exportedPlaywrightCode ||
                    '// Run a web test first to automatically export a pure standalone @playwright/test script (tests/exported/playwright-zero-llm.spec.ts) with 0 AI dependencies.'
                  : generatedCode ||
                    '// Generated Playwright + QA Drive test file will appear here when you run a prompt.'}
              </pre>
            </div>
          )}
        </section>
      </main>

      {/* ==========================================================
          SETTINGS MODAL — SIMPLE & SOBER MENU ITEMS
          ========================================================== */}
      {isSettingsOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setIsSettingsOpen(false);
          }}
        >
          <div className="modal-dialog">
            <div className="modal-header">
              <div className="modal-title">
                <h2>QA Drive Settings</h2>
                <p>
                  Configure browser execution, AI models, authentication, form defaults, load testing, and TestRail
                </p>
              </div>
              <button
                type="button"
                className="btn-modal-close"
                onClick={() => setIsSettingsOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal-tabs">
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'browser' ? 'active' : ''}`}
                onClick={() => setSettingsTab('browser')}
              >
                General
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'ai' ? 'active' : ''}`}
                onClick={() => setSettingsTab('ai')}
              >
                AI Models
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'login' ? 'active' : ''}`}
                onClick={() => setSettingsTab('login')}
              >
                Authentication
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'forms' ? 'active' : ''}`}
                onClick={() => setSettingsTab('forms')}
              >
                Form Data
                {settings.autoFillForms && <span className="tab-active-dot" />}
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'templates' ? 'active' : ''}`}
                onClick={() => setSettingsTab('templates')}
              >
                Templates
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'testrail' ? 'active' : ''}`}
                onClick={() => setSettingsTab('testrail')}
              >
                TestRail
                {settings.testrail.enabled && <span className="tab-active-dot" />}
              </button>
              <button
                type="button"
                className={`modal-tab-btn ${settingsTab === 'jmeter' ? 'active' : ''}`}
                onClick={() => setSettingsTab('jmeter')}
              >
                Load Testing
              </button>
            </div>

            <div className="modal-body">
              {settingsTab === 'browser' && (
                <div className="settings-section">
                  <div className="row-2">
                    <label className="field">
                      <span>Appearance Theme</span>
                      <select
                        value={settings.theme || 'light'}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            theme: e.target.value as 'light' | 'dark',
                          }))
                        }
                      >
                        <option value="light">☀️ Light (Claude Code — Default)</option>
                        <option value="dark">🌙 Dark Slate</option>
                      </select>
                    </label>

                    <label className="field">
                      <span>Browser Engine</span>
                      <select
                        value={settings.browser}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            browser: e.target.value as 'chromium' | 'firefox' | 'webkit',
                          }))
                        }
                      >
                        <option value="chromium">Chromium</option>
                        <option value="firefox">Firefox</option>
                        <option value="webkit">WebKit</option>
                      </select>
                    </label>
                  </div>

                  <div className="row-2">

                    <label className="field">
                      <span>Step Timeout (seconds)</span>
                      <input
                        type="number"
                        min={30}
                        max={900}
                        value={settings.stepTimeoutSeconds}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            stepTimeoutSeconds: Number(e.target.value),
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Max Step / Login Retries</span>
                      <input
                        type="number"
                        min={0}
                        max={5}
                        value={settings.maxRetries ?? 2}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            maxRetries: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="checkbox-stack">
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.blockAds}
                        onChange={(e) =>
                          updateSettings((s) => ({ ...s, blockAds: e.target.checked }))
                        }
                      />
                      <span>
                        Block 3rd-Party Ads &amp; Trackers (Fixes 60s hang on news sites like
                        TOI)
                      </span>
                    </label>

                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.recordVideo}
                        onChange={(e) =>
                          updateSettings((s) => ({ ...s, recordVideo: e.target.checked }))
                        }
                      />
                      <span>
                        🎥 Record Video of Test Execution (`--video on` → saves `.webm` to
                        `reports/`)
                      </span>
                    </label>

                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.headed}
                        onChange={(e) =>
                          updateSettings((s) => ({ ...s, headed: e.target.checked }))
                        }
                      />
                      <span>Open Visible Browser Window (`--headed`)</span>
                    </label>

                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={settings.useCache}
                        onChange={(e) =>
                          updateSettings((s) => ({ ...s, useCache: e.target.checked }))
                        }
                      />
                      <span>
                        ⚡ Smart Action Recording &amp; Zero-LLM Replay Cache (#15 — $0 Repeat Runs)
                      </span>
                    </label>

                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(settings.reuseSession)}
                        onChange={(e) =>
                          updateSettings((s) => ({ ...s, reuseSession: e.target.checked }))
                        }
                      />
                      <span>
                        🔐 Save &amp; Reuse Login Session State (`storageState` in `.e2e/sessions/` — #14)
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {settingsTab === 'forms' && (
                <div className="settings-section">
                  <div className="enable-banner">
                    <label className="checkbox-label large">
                      <input
                        type="checkbox"
                        checked={settings.autoFillForms}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            autoFillForms: e.target.checked,
                          }))
                        }
                      />
                      <span>
                        <strong>Auto-Detect, Fill &amp; Submit Web Forms</strong> (Automatically
                        fills visible form fields, dropdowns, checkboxes &amp; submits any web
                        form encountered on the page)
                      </span>
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>Default Full Name</span>
                      <input
                        type="text"
                        value={settings.formData.fullName}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, fullName: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Default Email Address</span>
                      <input
                        type="email"
                        value={settings.formData.email}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, email: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>Default Phone / Mobile</span>
                      <input
                        type="text"
                        value={settings.formData.phone}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, phone: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Default Company / Organization</span>
                      <input
                        type="text"
                        value={settings.formData.company}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, company: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="row-3">
                    <label className="field">
                      <span>City</span>
                      <input
                        type="text"
                        value={settings.formData.city}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, city: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Postal / ZIP Code</span>
                      <input
                        type="text"
                        value={settings.formData.postalCode}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, postalCode: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Country</span>
                      <input
                        type="text"
                        value={settings.formData.country}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, country: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>Street Address</span>
                      <input
                        type="text"
                        value={settings.formData.address}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, address: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Default Message / Textarea Content</span>
                      <input
                        type="text"
                        value={settings.formData.message}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            formData: { ...s.formData, message: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="field">
                    <span>
                      Custom Form Fields JSON (optional, e.g.{' '}
                      <code>{`{"department": "Engineering", "age": 28}`}</code>)
                    </span>
                    <input
                      type="text"
                      placeholder='{"customField": "value"}'
                      value={settings.formData.customJson ?? ''}
                      onChange={(e) =>
                        updateSettings((s) => ({
                          ...s,
                          formData: { ...s.formData, customJson: e.target.value },
                        }))
                      }
                    />
                  </label>
                </div>
              )}

              {settingsTab === 'ai' && (
                <div className="settings-section">
                  {/* Mode Switcher: Standard Mode (Current) vs Organization Mode (Internal AWS) */}
                  <div className="ai-mode-switcher-card">
                    <div className="ai-mode-switcher-header">
                      <div>
                        <strong>Active AI Execution Mode</strong>
                        <p>
                          Switch anytime between your current Standard AI providers and your
                          Organization&apos;s internal AWS-hosted models &amp; tokens. Both profiles
                          are saved independently.
                        </p>
                      </div>
                      <div className="target-type-tabs">
                        <button
                          type="button"
                          className={`target-type-btn ${!settings.orgAws?.enabled ? 'active' : ''}`}
                          onClick={() =>
                            updateSettings((s) => ({
                              ...s,
                              orgAws: { ...s.orgAws, enabled: false },
                            }))
                          }
                        >
                          🌐 Standard Mode (Current)
                        </button>
                        <button
                          type="button"
                          className={`target-type-btn ${settings.orgAws?.enabled ? 'active' : ''}`}
                          onClick={() =>
                            updateSettings((s) => ({
                              ...s,
                              orgAws: { ...s.orgAws, enabled: true },
                            }))
                          }
                        >
                          🏢 Organization Mode (AWS Hosted)
                        </button>
                      </div>
                    </div>
                  </div>

                  {!settings.orgAws?.enabled ? (
                    /* ==========================================================
                       CURRENT MODE: STANDARD AI PROVIDERS (OpenAI, Anthropic, Gemini, Ollama)
                       ========================================================== */
                    <>
                      <div className="row-2">
                        <label className="field">
                          <span>LLM Provider (Standard Mode)</span>
                          <select
                            value={settings.provider}
                            onChange={(e) => {
                              const next = e.target.value as
                                | 'openai'
                                | 'anthropic'
                                | 'google'
                                | 'ollama'
                                | 'gateway';
                              updateSettings((s) => {
                                let defaultModel = s.model;
                                if (next === 'openai') defaultModel = 'gpt-4o';
                                if (next === 'anthropic') defaultModel = 'claude-sonnet-4-5';
                                if (next === 'google') defaultModel = 'gemini-2.5-flash';
                                if (next === 'ollama') defaultModel = 'llama3.2';
                                if (next === 'gateway') defaultModel = 'openai/gpt-4o';
                                return { ...s, provider: next, model: defaultModel };
                              });
                            }}
                          >
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="google">Google Gemini</option>
                            <option value="ollama">Ollama (Local)</option>
                            <option value="gateway">AI Gateway</option>
                          </select>
                        </label>

                        <label className="field">
                          <span>Model Name</span>
                          <input
                            type="text"
                            value={settings.model}
                            onChange={(e) =>
                              updateSettings((s) => ({ ...s, model: e.target.value }))
                            }
                          />
                        </label>
                      </div>

                      {settings.provider === 'ollama' ? (
                        <label className="field">
                          <span>Ollama Base URL</span>
                          <input
                            type="url"
                            value={settings.ollamaUrl}
                            onChange={(e) =>
                              updateSettings((s) => ({ ...s, ollamaUrl: e.target.value }))
                            }
                          />
                        </label>
                      ) : (
                        <label className="field">
                          <span>API Key (leave blank to use `.env`)</span>
                          <input
                            type="password"
                            placeholder="Enter your OpenAI / Anthropic / Gemini API Key..."
                            value={settings.apiKey}
                            onChange={(e) =>
                              updateSettings((s) => ({ ...s, apiKey: e.target.value }))
                            }
                          />
                        </label>
                      )}
                    </>
                  ) : (
                    /* ==========================================================
                       ORGANIZATION MODE: INTERNAL AWS HOSTED MODELS & TOKENS
                       ========================================================== */
                    <div className="org-aws-config-box">
                      <div className="row-2">
                        <label className="field">
                          <span>AWS Hosting / Endpoint Type</span>
                          <select
                            value={settings.orgAws.connectionType}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                orgAws: {
                                  ...s.orgAws,
                                  connectionType: e.target.value as OrgAwsConnectionType,
                                },
                              }))
                            }
                          >
                            <option value="aws-gateway-openai">
                              Internal AWS Gateway / Proxy / LiteLLM / vLLM (OpenAI-Compatible)
                            </option>
                            <option value="aws-gateway-anthropic">
                              Internal AWS Gateway (Anthropic Messages Compatible)
                            </option>
                            <option value="aws-bedrock">
                              Direct AWS Bedrock Runtime (Converse API — Claude / Nova / Llama)
                            </option>
                          </select>
                        </label>

                        <label className="field">
                          <span>Authentication Method</span>
                          <select
                            value={settings.orgAws.authType}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                orgAws: {
                                  ...s.orgAws,
                                  authType: e.target.value as OrgAwsAuthType,
                                },
                              }))
                            }
                          >
                            <option value="bearer-token">
                              Organization Token / Bearer API Key / Custom Header
                            </option>
                            <option value="aws-iam-sigv4">
                              AWS IAM / SSO Credentials (SigV4: AccessKey + Secret + SessionToken)
                            </option>
                          </select>
                        </label>
                      </div>

                      <div className="row-2">
                        <label className="field">
                          <span>
                            {settings.orgAws.connectionType === 'aws-bedrock'
                              ? 'Custom Bedrock VPC Endpoint URL (optional — leave blank for standard regional Bedrock)'
                              : 'Internal AWS Endpoint Base URL'}
                          </span>
                          <input
                            type="url"
                            placeholder={
                              settings.orgAws.connectionType === 'aws-bedrock'
                                ? 'https://bedrock-runtime.us-east-1.amazonaws.com (optional)'
                                : 'https://llm-gateway.internal.organization.com/v1'
                            }
                            value={settings.orgAws.endpointUrl}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                orgAws: { ...s.orgAws, endpointUrl: e.target.value },
                              }))
                            }
                          />
                        </label>

                        <label className="field">
                          <span>Organization Model ID / Deployment Name</span>
                          <input
                            type="text"
                            placeholder="e.g. anthropic.claude-3-5-sonnet-20241022-v2:0 or internal-gpt-4o"
                            value={settings.orgAws.model}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                orgAws: { ...s.orgAws, model: e.target.value },
                              }))
                            }
                          />
                        </label>
                      </div>

                      <div className="fetch-shortcuts">
                        <span>Common AWS Model IDs:</span>
                        {[
                          'anthropic.claude-3-5-sonnet-20241022-v2:0',
                          'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
                          'amazon.nova-pro-v1:0',
                          'meta.llama3-3-70b-instruct-v1:0',
                          'gpt-4o',
                        ].map((mId) => (
                          <button
                            key={mId}
                            type="button"
                            className="shortcut-chip"
                            onClick={() =>
                              updateSettings((s) => ({
                                ...s,
                                orgAws: { ...s.orgAws, model: mId },
                              }))
                            }
                          >
                            {mId}
                          </button>
                        ))}
                      </div>

                      {settings.orgAws.authType === 'bearer-token' ? (
                        <div className="row-2">
                          <label className="field">
                            <span>Organization Auth Token / API Key</span>
                            <input
                              type="password"
                              placeholder="Enter your internal organization token / Bedrock API key..."
                              value={settings.orgAws.authToken}
                              onChange={(e) =>
                                updateSettings((s) => ({
                                  ...s,
                                  orgAws: { ...s.orgAws, authToken: e.target.value },
                                }))
                              }
                            />
                          </label>

                          <label className="field">
                            <span>
                              Token Header Name (<code>Authorization</code> sends{' '}
                              <code>Bearer &lt;token&gt;</code>, or e.g. <code>x-api-key</code>)
                            </span>
                            <input
                              type="text"
                              placeholder="Authorization"
                              value={settings.orgAws.authHeaderName || 'Authorization'}
                              onChange={(e) =>
                                updateSettings((s) => ({
                                  ...s,
                                  orgAws: { ...s.orgAws, authHeaderName: e.target.value },
                                }))
                              }
                            />
                          </label>
                        </div>
                      ) : (
                        <>
                          <div className="row-3">
                            <label className="field">
                              <span>AWS Region</span>
                              <input
                                type="text"
                                placeholder="us-east-1"
                                value={settings.orgAws.awsRegion || 'us-east-1'}
                                onChange={(e) =>
                                  updateSettings((s) => ({
                                    ...s,
                                    orgAws: { ...s.orgAws, awsRegion: e.target.value },
                                  }))
                                }
                              />
                            </label>

                            <label className="field">
                              <span>AWS Access Key ID (or leave blank for `.env`)</span>
                              <input
                                type="text"
                                placeholder="ASIA... or AKIA..."
                                value={settings.orgAws.awsAccessKeyId || ''}
                                onChange={(e) =>
                                  updateSettings((s) => ({
                                    ...s,
                                    orgAws: { ...s.orgAws, awsAccessKeyId: e.target.value },
                                  }))
                                }
                              />
                            </label>

                            <label className="field">
                              <span>AWS Secret Access Key</span>
                              <input
                                type="password"
                                placeholder="••••••••••••••••••••••••"
                                value={settings.orgAws.awsSecretAccessKey || ''}
                                onChange={(e) =>
                                  updateSettings((s) => ({
                                    ...s,
                                    orgAws: { ...s.orgAws, awsSecretAccessKey: e.target.value },
                                  }))
                                }
                              />
                            </label>
                          </div>

                          <label className="field">
                            <span>
                              AWS Session Token (for temporary Organization SSO / STS credentials)
                            </span>
                            <input
                              type="password"
                              placeholder="IQoJb3JpZ2luX2VjE..."
                              value={settings.orgAws.awsSessionToken || ''}
                              onChange={(e) =>
                                updateSettings((s) => ({
                                  ...s,
                                  orgAws: { ...s.orgAws, awsSessionToken: e.target.value },
                                }))
                              }
                            />
                          </label>
                        </>
                      )}

                      {settings.orgAws.connectionType === 'aws-bedrock' &&
                        settings.orgAws.authType === 'bearer-token' && (
                          <label className="field">
                            <span>AWS Region (for Bedrock Runtime Endpoint)</span>
                            <input
                              type="text"
                              placeholder="us-east-1"
                              value={settings.orgAws.awsRegion || 'us-east-1'}
                              onChange={(e) =>
                                updateSettings((s) => ({
                                  ...s,
                                  orgAws: { ...s.orgAws, awsRegion: e.target.value },
                                }))
                              }
                            />
                          </label>
                        )}

                      <label className="field">
                        <span>
                          Optional Custom Organization Headers JSON (e.g.{' '}
                          <code>{`{"x-org-id": "qa-team", "x-env": "staging"}`}</code>)
                        </span>
                        <input
                          type="text"
                          placeholder='{"x-org-id": "my-org"}'
                          value={settings.orgAws.customHeadersJson || ''}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              orgAws: { ...s.orgAws, customHeadersJson: e.target.value },
                            }))
                          }
                        />
                      </label>

                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={Boolean(settings.orgAws.allowSelfSignedCerts)}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              orgAws: {
                                ...s.orgAws,
                                allowSelfSignedCerts: e.target.checked,
                              },
                            }))
                          }
                        />
                        <span>
                          Allow Internal Corporate Self-Signed SSL/TLS Certificates (
                          <code>NODE_TLS_REJECT_UNAUTHORIZED=0</code>)
                        </span>
                      </label>

                      <div className="tr-test-row">
                        <button
                          type="button"
                          className="btn-test-conn"
                          disabled={orgTestStatus.testing}
                          onClick={handleTestOrgAwsConnection}
                        >
                          {orgTestStatus.testing
                            ? 'Testing Organization AWS Model...'
                            : '🔌 Test Organization AWS Model Connection'}
                        </button>

                        {orgTestStatus.message && (
                          <span
                            className={`conn-status ${
                              orgTestStatus.success ? 'conn-ok' : 'conn-err'
                            }`}
                          >
                            {orgTestStatus.success ? '✓ ' : '✗ '}
                            {orgTestStatus.message}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {settingsTab === 'login' && (
                <div className="settings-section">
                  <div className="row-2">
                    <label className="field">
                      <span>Authentication / Login Mode</span>
                      <select
                        value={settings.loginMode}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loginMode: e.target.value as LoginMode,
                          }))
                        }
                      >
                        <option value="none">No Login Needed (Public Page)</option>
                        <option value="wait-manual">
                          Wait for Login / OTP in Browser
                        </option>
                        <option value="auto-credentials">
                          Auto-Login with Email &amp; Password
                        </option>
                      </select>
                    </label>

                    <label className="field">
                      <span>Max Wait for Login / OTP (seconds)</span>
                      <input
                        type="number"
                        min={30}
                        max={600}
                        value={settings.loginWaitSeconds}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loginWaitSeconds: Number(e.target.value),
                          }))
                        }
                      />
                    </label>
                  </div>

                  {(settings.loginMode === 'auto-credentials' ||
                    settings.loginMode === 'wait-manual') && (
                    <div className="row-2">
                      <label className="field">
                        <span>
                          Login Email / Phone{' '}
                          {settings.loginMode === 'wait-manual'
                            ? '(optional pre-fill)'
                            : ''}
                        </span>
                        <input
                          type="text"
                          placeholder="user@example.com"
                          value={settings.loginUser}
                          onChange={(e) =>
                            updateSettings((s) => ({ ...s, loginUser: e.target.value }))
                          }
                        />
                      </label>

                      <label className="field">
                        <span>
                          Login Password{' '}
                          {settings.loginMode === 'wait-manual'
                            ? '(optional pre-fill)'
                            : ''}
                        </span>
                        <input
                          type="password"
                          placeholder="••••••••"
                          value={settings.loginPassword}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              loginPassword: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                  )}

                  <div className="ui-group-card" style={{ marginTop: '8px' }}>
                    <div className="ui-group-header">
                      <span className="ui-group-title">
                        Windows Desktop App (.exe) Authentication
                      </span>
                      <span className="ui-group-subtitle">
                        Used in Desktop &amp; Hybrid (Web + Desktop) modes
                      </span>
                    </div>

                    <div className="row-2">
                      <label className="field">
                        <span>Desktop App Login Mode</span>
                        <select
                          value={settings.desktopLoginMode || 'none'}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              desktopLoginMode: e.target.value as LoginMode,
                            }))
                          }
                        >
                          <option value="none">
                            No Separate Desktop Login (or Use Web Credentials)
                          </option>
                          <option value="auto-credentials">
                            Auto-Login with Desktop Username &amp; Password
                          </option>
                          <option value="wait-manual">
                            Wait for Manual Login / MFA in Windows App
                          </option>
                        </select>
                      </label>

                      <label className="field">
                        <span>Default Desktop Companion (.exe)</span>
                        <input
                          type="text"
                          placeholder="e.g. C:\EVV\EVVClient.exe or notepad.exe"
                          value={settings.desktopExePath ?? 'notepad.exe'}
                          onChange={(e) =>
                            updateSettings((s) => ({
                              ...s,
                              desktopExePath: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>

                    {settings.desktopLoginMode === 'auto-credentials' && (
                      <div className="row-2">
                        <label className="field">
                          <span>Desktop Username / Caregiver ID</span>
                          <input
                            type="text"
                            placeholder="e.g. caregiver.john"
                            value={settings.desktopLoginUser ?? ''}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                desktopLoginUser: e.target.value,
                              }))
                            }
                          />
                        </label>

                        <label className="field">
                          <span>Desktop Password / PIN</span>
                          <input
                            type="password"
                            placeholder="••••••••"
                            value={settings.desktopLoginPassword ?? ''}
                            onChange={(e) =>
                              updateSettings((s) => ({
                                ...s,
                                desktopLoginPassword: e.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {settingsTab === 'testrail' && (
                <div className="settings-section">
                  <div className="enable-banner">
                    <label className="checkbox-label large">
                      <input
                        type="checkbox"
                        checked={settings.testrail.enabled}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            testrail: { ...s.testrail, enabled: e.target.checked },
                          }))
                        }
                      />
                      <span>
                        <strong>Enable TestRail Integration</strong> (When enabled, the main
                        screen switches to TestRail Case ID inputs)
                      </span>
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>TestRail Base URL (or set `TESTRAIL_URL` in `.env`)</span>
                      <input
                        type="url"
                        placeholder="https://yourcompany.testrail.io"
                        value={settings.testrail.baseUrl}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            testrail: { ...s.testrail, baseUrl: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>TestRail Username / Email (`TESTRAIL_USER`)</span>
                      <input
                        type="email"
                        placeholder="qa@company.com"
                        value={settings.testrail.username}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            testrail: { ...s.testrail, username: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>TestRail API Key / Token (`TESTRAIL_API_KEY`)</span>
                      <input
                        type="password"
                        placeholder="Enter TestRail API Key..."
                        value={settings.testrail.apiKey}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            testrail: { ...s.testrail, apiKey: e.target.value },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Default Test Run ID (optional, e.g. `204` or `R204`)</span>
                      <input
                        type="text"
                        placeholder="e.g. 204"
                        value={settings.testrail.defaultRunId ?? ''}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            testrail: { ...s.testrail, defaultRunId: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={settings.testrail.autoUpdateResult}
                      onChange={(e) =>
                        updateSettings((s) => ({
                          ...s,
                          testrail: { ...s.testrail, autoUpdateResult: e.target.checked },
                        }))
                      }
                    />
                    <span>
                      Auto-sync test execution result &amp; Word `.docx` report to TestRail
                      when a Run ID is provided
                    </span>
                  </label>

                  <div className="tr-test-bar">
                    <button
                      type="button"
                      className="btn-test-conn"
                      disabled={trTestStatus.testing}
                      onClick={handleTestConnection}
                    >
                      {trTestStatus.testing
                        ? 'Testing Connection...'
                        : '🔌 Test TestRail Connection'}
                    </button>

                    {trTestStatus.message && (
                      <div
                        className={`tr-conn-status ${
                          trTestStatus.success ? 'status-ok' : 'status-err'
                        }`}
                      >
                        {trTestStatus.success ? '✓ ' : '✗ '}
                        {trTestStatus.message}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {settingsTab === 'jmeter' && (
                <div className="settings-section">
                  <div className="tr-enable-banner">
                    <div>
                      <strong>🔥 JMeter Load &amp; Stress Defaults (#28)</strong>
                      <p>
                        Configure default Virtual Users (Threads), Ramp-Up period, test
                        duration, think time, and p95 latency SLA thresholds. Persisted
                        across runs in your local profile.
                      </p>
                    </div>
                    <div className="fetch-shortcuts">
                      {[10, 25, 50, 100, 250].map((vu) => (
                        <button
                          key={vu}
                          type="button"
                          className="shortcut-chip"
                          onClick={() =>
                            updateSettings((s) => ({
                              ...s,
                              loadConfig: {
                                ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                                virtualUsers: vu,
                              },
                            }))
                          }
                        >
                          {vu} VUs
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="row-3">
                    <label className="field">
                      <span>Virtual Users (Threads / VUs)</span>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={settings.loadConfig?.virtualUsers ?? 25}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loadConfig: {
                              ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                              virtualUsers: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Ramp-Up Period (sec)</span>
                      <input
                        type="number"
                        min={0}
                        max={120}
                        value={settings.loadConfig?.rampUpSeconds ?? 5}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loadConfig: {
                              ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                              rampUpSeconds: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Load Duration (sec)</span>
                      <input
                        type="number"
                        min={5}
                        max={300}
                        value={settings.loadConfig?.durationSeconds ?? 15}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loadConfig: {
                              ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                              durationSeconds: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="row-2">
                    <label className="field">
                      <span>Think Time Between Requests (ms)</span>
                      <input
                        type="number"
                        min={20}
                        max={5000}
                        value={settings.loadConfig?.thinkTimeMs ?? 200}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loadConfig: {
                              ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                              thinkTimeMs: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>

                    <label className="field">
                      <span>Max Acceptable p95 Latency SLA (ms)</span>
                      <input
                        type="number"
                        min={50}
                        max={30000}
                        value={settings.loadConfig?.maxAcceptableP95Ms ?? 1500}
                        onChange={(e) =>
                          updateSettings((s) => ({
                            ...s,
                            loadConfig: {
                              ...(s.loadConfig || DEFAULT_SETTINGS.loadConfig),
                              maxAcceptableP95Ms: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </label>
                  </div>
                </div>
              )}

              {settingsTab === 'templates' && (
                <div className="settings-section">
                  <div className="tr-enable-banner">
                    <div>
                      <strong>Scenario Templates</strong>
                      <p>
                        Manage quick-load templates shown on the main workspace. By default,
                        only <strong>Signup &amp; Order Flow</strong> is active. Add or edit
                        custom Web, Desktop, Hybrid, or Load templates below.
                      </p>
                    </div>
                    <div className="fetch-shortcuts">
                      <button
                        type="button"
                        className="shortcut-chip"
                        onClick={() => {
                          const newTemplate: PromptTemplate = {
                            id: `custom-${Date.now()}`,
                            label: `Template ${(settings.templates?.length || 1) + 1}`,
                            targetType,
                            url,
                            desktopExePath: settings.desktopExePath,
                            prompt,
                            assertionPrompt,
                            loginMode: settings.loginMode,
                          };
                          updateSettings((s) => ({
                            ...s,
                            templates: [...(s.templates || DEFAULT_TEMPLATES), newTemplate],
                          }));
                        }}
                      >
                        + Save Current Main Screen as Template
                      </button>
                      <button
                        type="button"
                        className="shortcut-chip"
                        onClick={() => {
                          const blank: PromptTemplate = {
                            id: `custom-${Date.now()}`,
                            label: 'New Custom Template',
                            targetType: 'web',
                            url: 'http://localhost:5000/',
                            prompt: 'Step 1: ',
                            assertionPrompt: '',
                            loginMode: 'none',
                          };
                          updateSettings((s) => ({
                            ...s,
                            templates: [...(s.templates || DEFAULT_TEMPLATES), blank],
                          }));
                        }}
                      >
                        + Add Blank Template
                      </button>
                    </div>
                  </div>

                  {(settings.templates && settings.templates.length > 0
                    ? settings.templates
                    : DEFAULT_TEMPLATES
                  ).map((tpl, idx) => (
                    <div key={tpl.id || idx} className="ui-group-card">
                      <div className="ui-group-header">
                        <span className="ui-group-title">
                          Template #{idx + 1}: {tpl.label}
                        </span>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button
                            type="button"
                            className="preset-btn"
                            onClick={() => {
                              applySample(tpl);
                              setIsSettingsOpen(false);
                            }}
                          >
                            Load into Workspace
                          </button>
                          {(settings.templates?.length || 1) > 1 && (
                            <button
                              type="button"
                              className="btn-mini-clear"
                              onClick={() =>
                                updateSettings((s) => ({
                                  ...s,
                                  templates: (s.templates || DEFAULT_TEMPLATES).filter(
                                    (_, i) => i !== idx
                                  ),
                                }))
                              }
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="row-3">
                        <label className="field">
                          <span>Template Name</span>
                          <input
                            type="text"
                            value={tpl.label}
                            onChange={(e) =>
                              updateSettings((s) => {
                                const list = [...(s.templates || DEFAULT_TEMPLATES)];
                                list[idx] = { ...list[idx], label: e.target.value };
                                return { ...s, templates: list };
                              })
                            }
                          />
                        </label>

                        <label className="field">
                          <span>Mode</span>
                          <select
                            value={tpl.targetType}
                            onChange={(e) =>
                              updateSettings((s) => {
                                const list = [...(s.templates || DEFAULT_TEMPLATES)];
                                list[idx] = {
                                  ...list[idx],
                                  targetType: e.target.value as TargetType,
                                };
                                return { ...s, templates: list };
                              })
                            }
                          >
                            <option value="web">Web</option>
                            <option value="desktop">Desktop</option>
                            <option value="hybrid">Hybrid (Web + Desktop)</option>
                            <option value="load">Load Test</option>
                          </select>
                        </label>

                        <label className="field">
                          <span>Target URL / .exe</span>
                          <input
                            type="text"
                            value={tpl.url}
                            onChange={(e) =>
                              updateSettings((s) => {
                                const list = [...(s.templates || DEFAULT_TEMPLATES)];
                                list[idx] = { ...list[idx], url: e.target.value };
                                return { ...s, templates: list };
                              })
                            }
                          />
                        </label>
                      </div>

                      <label className="field">
                        <span>Test Steps</span>
                        <textarea
                          rows={3}
                          value={tpl.prompt}
                          onChange={(e) =>
                            updateSettings((s) => {
                              const list = [...(s.templates || DEFAULT_TEMPLATES)];
                              list[idx] = { ...list[idx], prompt: e.target.value };
                              return { ...s, templates: list };
                            })
                          }
                        />
                      </label>

                      <label className="field">
                        <span>Expected Result</span>
                        <input
                          type="text"
                          value={tpl.assertionPrompt}
                          onChange={(e) =>
                            updateSettings((s) => {
                              const list = [...(s.templates || DEFAULT_TEMPLATES)];
                              list[idx] = { ...list[idx], assertionPrompt: e.target.value };
                              return { ...s, templates: list };
                            })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-primary"
                style={{ flex: '0 0 auto', minWidth: '160px' }}
                onClick={() => setIsSettingsOpen(false)}
              >
                ✓ Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
