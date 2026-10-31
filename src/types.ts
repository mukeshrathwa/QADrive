export type RunStatus = 'idle' | 'running' | 'passed' | 'failed' | 'stopped';

export type LoginMode = 'none' | 'wait-manual' | 'auto-credentials';

export interface TestRailConfig {
  enabled: boolean;
  baseUrl: string;
  username: string;
  apiKey: string;
  defaultRunId?: string;
  defaultProjectId?: string;
  autoUpdateResult: boolean;
}

export interface TestRailCase {
  id: number;
  caseIdFormatted: string;
  title: string;
  url?: string;
  prompt: string;
  assertionPrompt: string;
  preconditions?: string;
  priority?: string;
  section?: string;
}

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

export type OrgAwsConnectionType =
  | 'aws-gateway-openai'
  | 'aws-gateway-anthropic'
  | 'aws-bedrock';

export type OrgAwsAuthType = 'bearer-token' | 'aws-iam-sigv4';

export interface OrgAwsConfig {
  enabled: boolean;
  connectionType: OrgAwsConnectionType;
  authType: OrgAwsAuthType;
  endpointUrl: string;
  model: string;
  authToken: string;
  authHeaderName?: string;
  customHeadersJson?: string;
  awsRegion: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  allowSelfSignedCerts?: boolean;
}

export interface PromptTemplate {
  id: string;
  label: string;
  targetType: TargetType;
  url: string;
  desktopExePath?: string;
  prompt: string;
  assertionPrompt: string;
  loginMode: LoginMode;
}

export interface AppSettings {
  // Appearance
  theme: 'light' | 'dark';

  // Saved Scenario Templates
  templates?: PromptTemplate[];

  // Browser & Runner
  browser: 'chromium' | 'firefox' | 'webkit';
  headed: boolean;
  useCache: boolean;
  reuseSession: boolean;
  stepTimeoutSeconds: number;
  maxRetries: number;
  blockAds: boolean;
  recordVideo: boolean;

  // Web Forms Auto-Fill & Submit
  autoFillForms: boolean;
  formData: FormDataProfile;

  // AI Provider (Standard Mode)
  provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'gateway';
  model: string;
  apiKey: string;
  ollamaUrl: string;

  // Organization Mode (Internal AWS Hosted Models)
  orgAws: OrgAwsConfig;

  // Login & Auth (Web + Desktop App)
  loginMode: LoginMode;
  loginUser: string;
  loginPassword: string;
  loginWaitSeconds: number;
  desktopExePath?: string;
  desktopLoginMode?: LoginMode;
  desktopLoginUser?: string;
  desktopLoginPassword?: string;

  // TestRail
  testrail: TestRailConfig;

  // JMeter Load & Stress (#28)
  loadConfig: LoadTestConfig;
}

export type TargetType = 'web' | 'desktop' | 'hybrid' | 'load';

export interface LoadTestConfig {
  virtualUsers: number;
  rampUpSeconds: number;
  durationSeconds: number;
  samplerMode: 'http-samplers' | 'journey-flow';
  thinkTimeMs: number;
  maxAcceptableP95Ms?: number;
}

export interface LoadEndpointSamplerMetric {
  label: string;
  method: string;
  url: string;
  samples: number;
  successCount: number;
  errorCount: number;
  errorRatePct: number;
  minMs: number;
  avgMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  rps: number;
  statusBreakdown: Record<string, number>;
}

export interface LoadTimelinePoint {
  second: number;
  activeUsers: number;
  requests: number;
  rps: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  errors: number;
}

export interface LoadTestSummary {
  virtualUsers: number;
  rampUpSeconds: number;
  durationSeconds: number;
  actualDurationSec: number;
  totalSamples: number;
  successSamples: number;
  failedSamples: number;
  errorRatePct: number;
  avgRps: number;
  peakRps: number;
  minLatencyMs: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  totalBytesTransferred: number;
  slaPassed: boolean;
  slaMessage: string;
  samplers: LoadEndpointSamplerMetric[];
  timeline: LoadTimelinePoint[];
}

export interface RunPromptPayload {
  targetType?: TargetType;
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

export interface StepObservationItem {
  index: number;
  api: string;
  label: string;
  status: string;
  durationSec: string;
  summary?: string;
  locationUrl?: string;
  errorMessage?: string;
}

export interface EvidencePayload {
  docxPath: string;
  timestampedDocxPath: string;
  docxDownloadUrl: string;
  exportedPlaywrightPath?: string;
  exportedPlaywrightCode?: string;
  highlightedSummary?: string;
  loadSummary?: LoadTestSummary;
  observations: StepObservationItem[];
  screenshots: Array<{
    id: string;
    label: string;
    url: string;
  }>;
  videos: Array<{
    id: string;
    label: string;
    url: string;
    savedPath: string;
  }>;
  testrailResult?: {
    caseId: string;
    runId: string;
    status: 'passed' | 'failed';
    resultId?: number;
    error?: string;
  };
}

export interface E2EDesktopAPI {
  runPrompt: (payload: RunPromptPayload) => Promise<{ exitCode: number | null }>;
  stopRun: () => Promise<{ stopped: boolean }>;
  onLog: (callback: (chunk: string) => void) => () => void;
  onStatus: (
    callback: (data: { status: RunStatus; exitCode?: number | null }) => void
  ) => () => void;
  onCodeGenerated: (
    callback: (data: { filePath: string; code: string }) => void
  ) => () => void;
}

declare global {
  interface Window {
    e2eDesktop?: E2EDesktopAPI;
  }
}
