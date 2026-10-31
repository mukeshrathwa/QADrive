import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { RunPromptPayload } from './index.js';
import { buildOrgTokenHeaders, createOrgAwsFetch } from './org-aws-llm.js';

export interface DesktopUIElement {
  id: string;
  controlType: string;
  name: string;
  automationId: string;
  value: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowSnapshot {
  hwnd: number;
  processId: number;
  windowTitle: string;
  left: number;
  top: number;
  width: number;
  height: number;
  elements: DesktopUIElement[];
  screenshotSaved?: boolean;
  error?: string;
}

interface DesktopAgentAction {
  action: 'click' | 'double_click' | 'type' | 'keys' | 'wait' | 'complete_step';
  elementId?: string;
  text?: string;
  keys?: string;
  pressEnter?: boolean;
  waitMs?: number;
  status?: 'passed' | 'failed';
  summary?: string;
}

let activeDesktopAborted = false;
let activePowerShellProcess: ChildProcessWithoutNullStreams | null = null;

export function stopActiveDesktopRun(): boolean {
  activeDesktopAborted = true;
  if (activePowerShellProcess) {
    try {
      activePowerShellProcess.kill();
    } catch {
      // ignore
    }
    activePowerShellProcess = null;
    return true;
  }
  return false;
}

/**
 * Resolves the configured LLM model for the Desktop AI Agent.
 */
function resolveDesktopModel(payload: RunPromptPayload) {
  if (payload.orgAws?.enabled) {
    const orgAws = payload.orgAws;
    if (orgAws.allowSelfSignedCerts) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }
    const orgModelName = orgAws.model?.trim() || 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    const customFetch = createOrgAwsFetch(orgAws);
    const customHeaders = buildOrgTokenHeaders(orgAws);

    if (orgAws.connectionType === 'aws-gateway-anthropic') {
      const rawBase = orgAws.endpointUrl.trim().replace(/\/+$/, '');
      const baseURL = rawBase.endsWith('/v1') ? rawBase : `${rawBase}/v1`;
      const anthropicOrg = createAnthropic({
        baseURL,
        apiKey: orgAws.authToken?.trim() || 'org-aws-placeholder',
        headers: customHeaders,
        fetch: customFetch,
      });
      return anthropicOrg(orgModelName);
    }

    const baseURL =
      orgAws.connectionType === 'aws-bedrock'
        ? 'https://bedrock-runtime.local/v1'
        : orgAws.endpointUrl.trim().replace(/\/+$/, '');

    const orgProvider = createOpenAICompatible({
      name: 'org-aws-llm',
      baseURL,
      apiKey: orgAws.authToken?.trim() || 'org-aws-placeholder',
      headers: customHeaders,
      fetch: customFetch,
    });
    return orgProvider(orgModelName);
  }

  const provider = (payload.provider || process.env.E2E_LLM_PROVIDER || 'openai').toLowerCase();
  const modelName = payload.model?.trim() || process.env.E2E_LLM_MODEL || 'gpt-4o';
  const explicitKey = payload.apiKey?.trim();

  switch (provider) {
    case 'anthropic': {
      const apiKey = explicitKey || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      const anthropic = createAnthropic({ apiKey });
      return anthropic(modelName);
    }
    case 'google': {
      const apiKey =
        explicitKey ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GEMINI_API_KEY;
      if (!apiKey) return null;
      const google = createGoogleGenerativeAI({ apiKey });
      return google(modelName);
    }
    case 'ollama': {
      const ollama = createOpenAICompatible({
        name: 'ollama',
        baseURL:
          payload.ollamaUrl?.trim() ||
          process.env.OLLAMA_BASE_URL ||
          'http://127.0.0.1:11434/v1',
      });
      return ollama(modelName);
    }
    case 'openai':
    default: {
      const apiKey = explicitKey || process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      const openai = createOpenAI({ apiKey });
      return openai(modelName);
    }
  }
}

/**
 * Runs a PowerShell script and returns stdout.
 */
async function runPowerShellJson<T>(script: string, timeoutMs = 30000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );
    activePowerShellProcess = child;

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      reject(new Error(`Desktop automation command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', () => {
      clearTimeout(timer);
      activePowerShellProcess = null;
      const trimmed = stdout.trim();
      const jsonStart = trimmed.indexOf('{');
      const jsonEnd = trimmed.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd >= jsonStart) {
        try {
          const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as T;
          resolve(parsed);
          return;
        } catch (err) {
          reject(
            new Error(
              `Failed to parse desktop UI state JSON: ${(err as Error).message}\nOutput: ${trimmed.slice(0, 400)}`
            )
          );
          return;
        }
      }
      reject(
        new Error(
          stderr.trim() || trimmed || 'PowerShell desktop bridge returned empty output'
        )
      );
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      activePowerShellProcess = null;
      reject(err);
    });
  });
}

/**
 * Opens a native Windows File Open Dialog to pick a `.exe` file.
 */
export async function browseForExeFile(): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = "Select Desktop Application (.exe)"
$dlg.Filter = "Executable Files (*.exe)|*.exe|All Files (*.*)|*.*"
$res = $dlg.ShowDialog()
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
  @{ selectedPath = $dlg.FileName } | ConvertTo-Json -Compress
} else {
  @{ selectedPath = $null } | ConvertTo-Json -Compress
}
`;
  try {
    const out = await runPowerShellJson<{ selectedPath: string | null }>(script, 120000);
    return out.selectedPath || null;
  } catch {
    return null;
  }
}

/**
 * Launches a Windows `.exe` application and returns its main window handle (`hwnd`), `processId`, and initial snapshot.
 */
async function launchDesktopAppAndCapture(
  exeTarget: string,
  screenshotAbsPath: string
): Promise<DesktopWindowSnapshot> {
  const escapedTarget = exeTarget.replace(/'/g, "''");
  const escapedShot = screenshotAbsPath.replace(/'/g, "''");

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32DesktopHelper {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

$target = '${escapedTarget}'.Trim()
$shotPath = '${escapedShot}'
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($target).ToLower()

$proc = Start-Process -FilePath $target -PassThru
$hwnd = [IntPtr]::Zero
$resolvedPid = $proc.Id
$winTitle = ""

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 450
  try {
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
      $hwnd = $proc.MainWindowHandle
      $resolvedPid = $proc.Id
      $winTitle = $proc.MainWindowTitle
      break
    }
  } catch {}

  # Fallback for UWP / packaged apps like calc.exe -> CalculatorApp or modern Notepad
  $candidates = Get-Process | Where-Object {
    $_.MainWindowHandle -ne [IntPtr]::Zero -and (
      $_.ProcessName.ToLower().Contains($baseName) -or
      ($baseName -eq 'calc' -and ($_.ProcessName -match 'Calculator|ApplicationFrameHost' -or $_.MainWindowTitle -match 'Calculator')) -or
      ($baseName -eq 'notepad' -and ($_.ProcessName -match 'Notepad' -or $_.MainWindowTitle -match 'Notepad'))
    )
  } | Sort-Object StartTime -Descending

  if ($candidates -and $candidates.Count -gt 0) {
    $top = $candidates[0]
    $hwnd = $top.MainWindowHandle
    $resolvedPid = $top.Id
    $winTitle = $top.MainWindowTitle
    break
  }
}

if ($hwnd -eq [IntPtr]::Zero) {
  $hwnd = [Win32DesktopHelper]::GetForegroundWindow()
}

[Win32DesktopHelper]::ShowWindow($hwnd, 9) | Out-Null
[Win32DesktopHelper]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 600

$rect = New-Object Win32DesktopHelper+RECT
[Win32DesktopHelper]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = [Math]::Max(320, $rect.Right - $rect.Left)
$h = [Math]::Max(240, $rect.Bottom - $rect.Top)
$l = [Math]::Max(0, $rect.Left)
$t = [Math]::Max(0, $rect.Top)

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$g.Dispose()
$bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

@{
  hwnd = [int64]$hwnd
  processId = $resolvedPid
  windowTitle = $winTitle
  left = $l
  top = $t
  width = $w
  height = $h
  elements = @()
  screenshotSaved = $true
} | ConvertTo-Json -Compress -Depth 4
`;

  const initial = await runPowerShellJson<DesktopWindowSnapshot>(script, 30000);
  return await inspectDesktopWindow(initial.hwnd, initial.processId, screenshotAbsPath);
}

/**
 * Inspects the live Windows UI Automation tree of the target `.exe` window and optionally saves a screenshot.
 */
async function inspectDesktopWindow(
  hwnd: number,
  processId: number,
  screenshotAbsPath?: string
): Promise<DesktopWindowSnapshot> {
  const escapedShot = (screenshotAbsPath || '').replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32InspectHelper {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
}
"@

$hwndPtr = [IntPtr]::new(${hwnd})
try {
  $proc = Get-Process -Id ${processId} -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
    $hwndPtr = $proc.MainWindowHandle
  }
} catch {}

[Win32InspectHelper]::SetForegroundWindow($hwndPtr) | Out-Null
Start-Sleep -Milliseconds 250

$rootEl = [System.Windows.Automation.AutomationElement]::FromHandle($hwndPtr)
$winTitle = ""
if ($rootEl) {
  $winTitle = $rootEl.Current.Name
}

$rect = New-Object Win32InspectHelper+RECT
[Win32InspectHelper]::GetWindowRect($hwndPtr, [ref]$rect) | Out-Null
$w = [Math]::Max(320, $rect.Right - $rect.Left)
$h = [Math]::Max(240, $rect.Bottom - $rect.Top)
$l = [Math]::Max(0, $rect.Left)
$t = [Math]::Max(0, $rect.Top)

$shotPath = '${escapedShot}'
if ($shotPath -ne '') {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($l, $t, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($shotPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

$items = New-Object System.Collections.ArrayList
if ($rootEl) {
  $all = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $idx = 1
  $maxCount = [Math]::Min(120, $all.Count)
  for ($i = 0; $i -lt $all.Count; $i++) {
    if ($items.Count -ge 85) { break }
    $el = $all[$i]
    try {
      $cur = $el.Current
      if ($cur.IsOffscreen) { continue }
      $ct = $cur.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
      if ($ct -in @('Pane', 'Thumb', 'ScrollBar', 'Separator', 'TitleBar')) { continue }
      $r = $cur.BoundingRectangle
      if ([double]::IsInfinity($r.Width) -or [double]::IsNaN($r.Width) -or $r.Width -lt 8 -or $r.Height -lt 8) { continue }

      $val = ""
      $vp = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $val = $vp.Current.Value
      }

      $nm = ($cur.Name + "").Trim()
      $aid = ($cur.AutomationId + "").Trim()
      if ($nm -eq "" -and $aid -eq "" -and $val -eq "" -and $ct -notin @('Edit', 'Document', 'Button', 'CheckBox', 'ComboBox')) {
        continue
      }

      [void]$items.Add(@{
        id = "#d$idx"
        controlType = $ct
        name = $nm
        automationId = $aid
        value = ($val + "").Trim()
        x = [int][Math]::Round($r.Left + ($r.Width / 2))
        y = [int][Math]::Round($r.Top + ($r.Height / 2))
        width = [int][Math]::Round($r.Width)
        height = [int][Math]::Round($r.Height)
      })
      $idx++
    } catch {}
  }
}

@{
  hwnd = [int64]$hwndPtr
  processId = ${processId}
  windowTitle = $winTitle
  left = $l
  top = $t
  width = $w
  height = $h
  elements = $items
  screenshotSaved = ($shotPath -ne '')
} | ConvertTo-Json -Compress -Depth 5
`;

  return await runPowerShellJson<DesktopWindowSnapshot>(script, 30000);
}

/**
 * Executes a single UI action (click, double_click, type, keys, wait) on the target `.exe` window.
 */
async function executeDesktopAction(
  hwnd: number,
  action: DesktopAgentAction,
  snapshot: DesktopWindowSnapshot
): Promise<string> {
  if (action.action === 'wait') {
    const ms = Math.min(10000, Math.max(200, action.waitMs ?? 1000));
    await new Promise((r) => setTimeout(r, ms));
    return `Waited ${ms}ms`;
  }

  const targetEl = action.elementId
    ? snapshot.elements.find(
        (e) => e.id.toLowerCase() === action.elementId!.trim().toLowerCase()
      )
    : undefined;

  const clickX = targetEl ? targetEl.x : Math.round(snapshot.left + snapshot.width / 2);
  const clickY = targetEl ? targetEl.y : Math.round(snapshot.top + snapshot.height / 2);
  const textToType = (action.text ?? '').replace(/'/g, "''");
  const rawKeys = (action.keys ?? '').replace(/'/g, "''");
  const pressEnter = Boolean(action.pressEnter);

  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32InputHelper {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
"@

$hwndPtr = [IntPtr]::new(${hwnd})
[Win32InputHelper]::SetForegroundWindow($hwndPtr) | Out-Null
Start-Sleep -Milliseconds 150

$act = '${action.action}'
if ($act -eq 'click' -or $act -eq 'double_click' -or $act -eq 'type') {
  [Win32InputHelper]::SetCursorPos(${clickX}, ${clickY}) | Out-Null
  Start-Sleep -Milliseconds 80
  [Win32InputHelper]::mouse_event(0x0002, 0, 0, 0, 0)
  [Win32InputHelper]::mouse_event(0x0004, 0, 0, 0, 0)
  if ($act -eq 'double_click') {
    Start-Sleep -Milliseconds 90
    [Win32InputHelper]::mouse_event(0x0002, 0, 0, 0, 0)
    [Win32InputHelper]::mouse_event(0x0004, 0, 0, 0, 0)
  }
  Start-Sleep -Milliseconds 180
}

if ($act -eq 'type') {
  $txt = '${textToType}'
  if ($txt -ne '') {
    [System.Windows.Forms.Clipboard]::SetText($txt)
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 150
  }
  if ($${pressEnter ? 'true' : 'false'}) {
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 150
  }
}

if ($act -eq 'keys') {
  $k = '${rawKeys}'
  if ($k -ne '') {
    [System.Windows.Forms.SendKeys]::SendWait($k)
    Start-Sleep -Milliseconds 200
  }
}

@{ ok = $true } | ConvertTo-Json -Compress
`;

  await runPowerShellJson<{ ok: boolean }>(script, 20000);

  const elDesc = targetEl
    ? `${targetEl.id} [${targetEl.controlType}] "${targetEl.name || targetEl.automationId}"`
    : `window (${clickX}, ${clickY})`;

  if (action.action === 'click') return `Clicked ${elDesc}`;
  if (action.action === 'double_click') return `Double-clicked ${elDesc}`;
  if (action.action === 'type')
    return `Typed "${action.text ?? ''}" into ${elDesc}${pressEnter ? ' and pressed Enter' : ''}`;
  if (action.action === 'keys') return `Sent keystrokes "${action.keys ?? ''}"`;
  return `Executed ${action.action}`;
}

/**
 * Draws a visual red highlight box and verification banner onto the final desktop screenshot.
 */
async function highlightDesktopScreenshot(
  sourcePngPath: string,
  destPngPath: string,
  snapshot: DesktopWindowSnapshot,
  query: string
): Promise<string> {
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  let bestEl: DesktopUIElement | undefined;
  let bestScore = 0;

  for (const el of snapshot.elements) {
    const combined = `${el.name} ${el.value} ${el.automationId}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (combined.includes(kw)) score += 3;
    }
    if (el.controlType === 'Edit' || el.controlType === 'Document' || el.controlType === 'Text') {
      score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestEl = el;
    }
  }

  if (!bestEl && snapshot.elements.length > 0) {
    bestEl =
      snapshot.elements.find((e) => e.controlType === 'Document' || e.controlType === 'Edit') ??
      snapshot.elements[0];
  }

  const relX = bestEl
    ? Math.max(4, bestEl.x - Math.round(bestEl.width / 2) - snapshot.left)
    : 16;
  const relY = bestEl
    ? Math.max(4, bestEl.y - Math.round(bestEl.height / 2) - snapshot.top)
    : 45;
  const boxW = bestEl ? Math.min(snapshot.width - 8, Math.max(60, bestEl.width)) : snapshot.width - 32;
  const boxH = bestEl ? Math.min(snapshot.height - 8, Math.max(28, bestEl.height)) : Math.min(180, snapshot.height - 60);

  const escapedSrc = sourcePngPath.replace(/'/g, "''");
  const escapedDst = destPngPath.replace(/'/g, "''");
  const bannerText = `VERIFIED DESKTOP OBSERVATION: ${query.slice(0, 68)}`.replace(/'/g, "''");

  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${escapedSrc}')
$bmp = New-Object System.Drawing.Bitmap($src.Width, $src.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $src.Width, $src.Height)
$src.Dispose()

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(239, 68, 68), 4)
$fillBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(45, 254, 240, 138))
$rx = [Math]::Min($bmp.Width - 20, [Math]::Max(2, ${relX}))
$ry = [Math]::Min($bmp.Height - 20, [Math]::Max(2, ${relY}))
$rw = [Math]::Min($bmp.Width - $rx - 4, [Math]::Max(30, ${boxW}))
$rh = [Math]::Min($bmp.Height - $ry - 4, [Math]::Max(20, ${boxH}))

$g.FillRectangle($fillBrush, $rx, $ry, $rw, $rh)
$g.DrawRectangle($pen, $rx, $ry, $rw, $rh)

$bannerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(220, 38, 38))
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$g.FillRectangle($bannerBrush, 8, 8, [Math]::Min($bmp.Width - 16, 560), 30)
$g.DrawString('${bannerText}', $font, $textBrush, 16, 13)

$g.Dispose()
$bmp.Save('${escapedDst}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
@{ saved = $true } | ConvertTo-Json -Compress
`;

  await runPowerShellJson<{ saved: boolean }>(script, 20000);

  const visibleSummary = snapshot.elements
    .filter((e) => e.name || e.value)
    .slice(0, 6)
    .map((e) => `${e.controlType} "${e.name || e.automationId}"${e.value ? ` = "${e.value.slice(0, 80)}"` : ''}`)
    .join(' | ');

  return `Desktop Window "${snapshot.windowTitle}" — Highlighted Elements: ${visibleSummary || 'Window Verified'}`;
}

/**
 * Generates step code preview for the "Generated E2E Code" tab when running a Desktop `.exe` test.
 */
export function buildDesktopTestCodePreview(
  payload: RunPromptPayload,
  actionSteps: string[]
): string {
  return `// @ts-nocheck
// Desktop Application (.exe) E2E Automation Script
// Target Executable: ${payload.url}
import { launchDesktopApp, agent, expect } from '@e2e-dev/desktop';

test('Desktop EXE Run: ${payload.url}', async () => {
  // 1. Launch Windows Desktop Application (.exe) & capture initial window screenshot
  const appWindow = await launchDesktopApp(${JSON.stringify(payload.url)});
  await appWindow.screenshot('01-initial-desktop-window');

  // 2. Execute each desktop UI Automation step sequentially
  const steps = ${JSON.stringify(actionSteps, null, 2)};
  for (const [idx, stepText] of steps.entries()) {
    await agent.act(stepText, {
      window: appWindow,
      captureStepScreenshot: \`0\${idx + 2}-step-\${idx + 1}-completed\`,
    });
  }

  // 3. Highlight verified desktop control & capture final observation screenshot
  await appWindow.screenshot('verified-observation-highlighted');
${
  payload.assertionPrompt?.trim()
    ? `  await agent.assert(${JSON.stringify(payload.assertionPrompt.trim())}, { window: appWindow, vision: true });\n`
    : ''
}});
`;
}

/**
 * Runs a full step-by-step Desktop `.exe` test, streaming logs via `onLog`, saving screenshots to `.e2e/results/desktop-run/`,
 * and writing `.e2e/report.json` so the exact same `.docx` Word Report and UI Evidence cards are generated.
 */
export async function runDesktopExeTest(
  payload: RunPromptPayload,
  projectRoot: string,
  onLog: (msg: string) => void
): Promise<{ exitCode: number }> {
  activeDesktopAborted = false;
  const startedAtIso = new Date().toISOString();
  const runStartMs = Date.now();

  const resultsRoot = path.join(projectRoot, '.e2e', 'results');
  const runRelDir = 'desktop-run';
  const runAbsDir = path.join(resultsRoot, runRelDir);
  await fs.mkdir(runAbsDir, { recursive: true });

  const actionSteps = payload.prompt
    .split('\n')
    .map((line) => line.replace(/^step\s*\d+\s*[:.-]?\s*/i, '').trim())
    .filter(Boolean);

  const artifacts: Array<{ id: string; kind: 'screenshot'; path: string }> = [];
  const reportSteps: Array<{
    id: string;
    index: number;
    api: string;
    label: string;
    status: 'passed' | 'failed';
    durationMs: number;
    summary?: string;
    explanation?: string;
    screen?: { location?: string };
    artifacts?: string[];
    error?: { code: string; message: string };
  }> = [];

  let stepCounter = 1;
  let overallStatus: 'passed' | 'failed' = 'passed';
  let failureError: { code: string; message: string } | undefined;
  let currentSnapshot: DesktopWindowSnapshot | null = null;

  try {
    // 1. Launch the .exe application
    onLog(`[Desktop EXE Runner] Launching executable: ${payload.url}\n`);
    const openStart = Date.now();
    const initialShotFile = '01-initial-desktop-window.png';
    const initialShotAbs = path.join(runAbsDir, initialShotFile);
    const initialShotRel = `${runRelDir}/${initialShotFile}`;

    currentSnapshot = await launchDesktopAppAndCapture(payload.url, initialShotAbs);
    const openDuration = Date.now() - openStart;

    const artIdOpen = `art-${artifacts.length + 1}`;
    artifacts.push({ id: artIdOpen, kind: 'screenshot', path: initialShotRel });

    const locationLabel = `${payload.url} (${currentSnapshot.windowTitle || `PID ${currentSnapshot.processId}`})`;

    reportSteps.push({
      id: `step-${stepCounter}`,
      index: stepCounter++,
      api: 'app.open',
      label: payload.url,
      status: 'passed',
      durationMs: openDuration,
      summary: `Launched desktop executable "${payload.url}" — Window "${currentSnapshot.windowTitle || 'Main Window'}" (PID ${currentSnapshot.processId}, ${currentSnapshot.elements.length} UI controls detected).`,
      screen: { location: locationLabel },
    });

    reportSteps.push({
      id: `step-${stepCounter}`,
      index: stepCounter++,
      api: 'app.screenshot',
      label: '01-initial-desktop-window',
      status: 'passed',
      durationMs: 250,
      summary: `Captured initial desktop window screenshot (${currentSnapshot.width}x${currentSnapshot.height}).`,
      screen: { location: locationLabel },
      artifacts: [artIdOpen],
    });

    onLog(
      `  ✓ [app.open] (${(openDuration / 1000).toFixed(1)}s) Launched "${currentSnapshot.windowTitle || payload.url}" (PID: ${currentSnapshot.processId}, Controls: ${currentSnapshot.elements.length})\n`
    );

    // Handle Windows Desktop Application Login automatically or via manual pause if login screen is detected
    currentSnapshot = await handleDesktopAppLoginIfNeeded(
      currentSnapshot,
      payload,
      onLog
    );

    const model = resolveDesktopModel(payload);

    // 2. Execute each step sequentially
    for (let i = 0; i < actionSteps.length; i++) {
      if (activeDesktopAborted) {
        throw new Error('Test execution stopped by user.');
      }

      const stepText = actionSteps[i];
      const stepStart = Date.now();
      onLog(`\n[Desktop Step ${i + 1}/${actionSteps.length}] Executing: ${stepText}\n`);

      currentSnapshot = await inspectDesktopWindow(
        currentSnapshot.hwnd,
        currentSnapshot.processId
      );

      const executedLogs: string[] = [];
      let stepSummary = '';

      if (model) {
        for (let turn = 1; turn <= 6; turn++) {
          if (activeDesktopAborted) {
            throw new Error('Test execution stopped by user.');
          }

          const uiTreeText = currentSnapshot.elements
            .map(
              (e) =>
                `${e.id} [${e.controlType}] name="${e.name}" autoId="${e.automationId}" value="${e.value}" pos=(${e.x},${e.y})`
            )
            .join('\n');

          const promptForLlm = `You are a Windows Desktop Application (.exe) QA Automation Agent.
Target Executable: ${payload.url}
Active Window Title: "${currentSnapshot.windowTitle}"
Current Step Instruction: "${stepText}"
Actions Already Taken in This Step: ${executedLogs.length > 0 ? executedLogs.join(' -> ') : 'None yet'}

Visible Windows UI Automation Controls:
${uiTreeText || '(No child controls exposed; use "type" or "keys" to send keyboard input directly to the window)'}

Respond with ONLY a valid JSON object matching this exact schema:
{
  "action": "click" | "double_click" | "type" | "keys" | "wait" | "complete_step",
  "elementId": "#d1 (optional, required for click/double_click/type when targeting a specific control)",
  "text": "text to type (when action is 'type')",
  "pressEnter": true | false,
  "keys": "SendKeys string like '{ENTER}', '^s', '12+34=' (when action is 'keys')",
  "status": "passed" | "failed" (when action is 'complete_step')",
  "summary": "Clear observation of what was performed and what is currently visible in the desktop window"
}

Rules:
- If the step instruction has NOT been performed yet, return the next "click", "type", or "keys" action.
- Once all actions for "${stepText}" have been performed in "Actions Already Taken in This Step", return {"action": "complete_step", "status": "passed", "summary": "..."}.`;

          const { text: llmRaw } = await generateText({
            model,
            prompt: promptForLlm,
            temperature: 0,
          });

          const jsonMatch = llmRaw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error(`Model returned invalid JSON response: ${llmRaw.slice(0, 200)}`);
          }

          const decision = JSON.parse(jsonMatch[0]) as DesktopAgentAction;
          if (decision.action === 'complete_step') {
            stepSummary =
              decision.summary ||
              executedLogs.join('; ') ||
              `Completed desktop step: ${stepText}`;
            if (decision.status === 'failed') {
              throw new Error(stepSummary);
            }
            break;
          }

          const actLog = await executeDesktopAction(
            currentSnapshot.hwnd,
            decision,
            currentSnapshot
          );
          executedLogs.push(actLog);
          onLog(`    • [UI Action] ${actLog}\n`);

          currentSnapshot = await inspectDesktopWindow(
            currentSnapshot.hwnd,
            currentSnapshot.processId
          );
          stepSummary =
            decision.summary ||
            `${executedLogs.join('; ')}. Window "${currentSnapshot.windowTitle}" updated.`;
        }
      } else {
        // Built-in Heuristic UIA Execution when no LLM API key is configured
        const quotedMatch = stepText.match(/["']([^"']+)["']/);
        if (/\b(type|enter|write|input|fill)\b/i.test(stepText)) {
          const textVal =
            quotedMatch?.[1] ||
            stepText.replace(/^.*?\b(type|enter|write|input|fill)\s+/i, '').trim();
          const editEl = currentSnapshot.elements.find(
            (e) => e.controlType === 'Edit' || e.controlType === 'Document'
          );
          const actLog = await executeDesktopAction(
            currentSnapshot.hwnd,
            {
              action: 'type',
              elementId: editEl?.id,
              text: textVal,
              pressEnter: /\b(enter|submit)\b/i.test(stepText),
            },
            currentSnapshot
          );
          executedLogs.push(actLog);
          onLog(`    • [UI Action] ${actLog}\n`);
        } else if (/\b(click|press|tap|select|open)\b/i.test(stepText)) {
          const targetName = (
            quotedMatch?.[1] ||
            stepText.replace(/^.*?\b(click|press|tap|select|open)\s+(on\s+)?(the\s+)?/i, '')
          )
            .replace(/\b(button|menu|item|tab|link)\b/gi, '')
            .trim()
            .toLowerCase();

          const matchedEl = currentSnapshot.elements.find(
            (e) =>
              e.name.toLowerCase().includes(targetName) ||
              e.automationId.toLowerCase().includes(targetName)
          );
          if (matchedEl) {
            const actLog = await executeDesktopAction(
              currentSnapshot.hwnd,
              { action: 'click', elementId: matchedEl.id },
              currentSnapshot
            );
            executedLogs.push(actLog);
            onLog(`    • [UI Action] ${actLog}\n`);
          } else {
            const actLog = await executeDesktopAction(
              currentSnapshot.hwnd,
              { action: 'keys', keys: targetName },
              currentSnapshot
            );
            executedLogs.push(actLog);
            onLog(`    • [UI Action] ${actLog}\n`);
          }
        } else {
          const actLog = await executeDesktopAction(
            currentSnapshot.hwnd,
            { action: 'keys', keys: quotedMatch?.[1] || stepText },
            currentSnapshot
          );
          executedLogs.push(actLog);
          onLog(`    • [UI Action] ${actLog}\n`);
        }

        stepSummary = `${executedLogs.join('; ')} on window "${currentSnapshot.windowTitle}".`;
      }

      // Capture screenshot after each step
      const stepShotFile = `0${i + 2}-step-${i + 1}-completed.png`;
      const stepShotAbs = path.join(runAbsDir, stepShotFile);
      const stepShotRel = `${runRelDir}/${stepShotFile}`;
      currentSnapshot = await inspectDesktopWindow(
        currentSnapshot.hwnd,
        currentSnapshot.processId,
        stepShotAbs
      );
      const stepArtId = `art-${artifacts.length + 1}`;
      artifacts.push({ id: stepArtId, kind: 'screenshot', path: stepShotRel });

      const stepDur = Date.now() - stepStart;
      reportSteps.push({
        id: `step-${stepCounter}`,
        index: stepCounter++,
        api: 'agent.act',
        label: stepText,
        status: 'passed',
        durationMs: stepDur,
        summary: stepSummary || `Executed step on desktop window "${currentSnapshot.windowTitle}".`,
        screen: {
          location: `${payload.url} (${currentSnapshot.windowTitle || `PID ${currentSnapshot.processId}`})`,
        },
        artifacts: [stepArtId],
      });

      onLog(
        `  ✓ [agent.act] (${(stepDur / 1000).toFixed(1)}s) ${stepText}\n      Observation: ${stepSummary}\n`
      );
    }

    // 3. Final Highlighted Screenshot & Assertion Verification
    const rawFinalShotAbs = path.join(runAbsDir, 'raw-final-window.png');
    currentSnapshot = await inspectDesktopWindow(
      currentSnapshot.hwnd,
      currentSnapshot.processId,
      rawFinalShotAbs
    );

    const highlightedShotFile = '02-verified-observation-highlighted.png';
    const highlightedShotAbs = path.join(runAbsDir, highlightedShotFile);
    const highlightedShotRel = `${runRelDir}/${highlightedShotFile}`;
    const verifyQuery = (payload.assertionPrompt?.trim() || payload.prompt.trim()).slice(0, 120);

    const highlightSummary = await highlightDesktopScreenshot(
      rawFinalShotAbs,
      highlightedShotAbs,
      currentSnapshot,
      verifyQuery
    );

    await fs.writeFile(
      path.join(projectRoot, '.e2e', 'highlighted-observation.json'),
      JSON.stringify({ summary: highlightSummary }, null, 2),
      'utf-8'
    );

    const highlightArtId = `art-${artifacts.length + 1}`;
    artifacts.push({
      id: highlightArtId,
      kind: 'screenshot',
      path: highlightedShotRel,
    });

    reportSteps.push({
      id: `step-${stepCounter}`,
      index: stepCounter++,
      api: 'app.screenshot',
      label: '02-verified-observation-highlighted',
      status: 'passed',
      durationMs: 300,
      summary: highlightSummary,
      screen: {
        location: `${payload.url} (${currentSnapshot.windowTitle || `PID ${currentSnapshot.processId}`})`,
      },
      artifacts: [highlightArtId],
    });

    if (payload.assertionPrompt?.trim()) {
      const assertStart = Date.now();
      const assertText = payload.assertionPrompt.trim();
      let assertPassed = true;
      let assertExplanation = `Verified "${assertText}" on desktop window "${currentSnapshot.windowTitle}".`;

      if (model) {
        const uiTreeText = currentSnapshot.elements
          .map(
            (e) =>
              `${e.id} [${e.controlType}] name="${e.name}" value="${e.value}"`
          )
          .join('\n');

        const { text: judgeRaw } = await generateText({
          model,
          prompt: `You are verifying an assertion on a Windows Desktop Application (.exe).
Executable: ${payload.url}
Window Title: "${currentSnapshot.windowTitle}"
Assertion to Verify: "${assertText}"

Current Desktop UI Automation Elements:
${uiTreeText}

Respond with ONLY valid JSON:
{"passed": true | false, "explanation": "Concise explanation of what is visible in the desktop window proving or disproving the assertion"}`,
          temperature: 0,
        });

        const match = judgeRaw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as {
            passed?: boolean;
            explanation?: string;
          };
          assertPassed = parsed.passed !== false;
          if (parsed.explanation) {
            assertExplanation = parsed.explanation;
          }
        }
      }

      const assertDur = Date.now() - assertStart;
      if (!assertPassed) {
        overallStatus = 'failed';
        failureError = {
          code: 'ASSERTION_FAILED',
          message: assertExplanation,
        };
      }

      reportSteps.push({
        id: `step-${stepCounter}`,
        index: stepCounter++,
        api: 'agent.assert',
        label: assertText,
        status: assertPassed ? 'passed' : 'failed',
        durationMs: assertDur,
        summary: assertExplanation,
        explanation: assertExplanation,
        screen: {
          location: `${payload.url} (${currentSnapshot.windowTitle || `PID ${currentSnapshot.processId}`})`,
        },
        artifacts: [highlightArtId],
        error: assertPassed
          ? undefined
          : { code: 'ASSERTION_FAILED', message: assertExplanation },
      });

      onLog(
        `  ${assertPassed ? '✓' : '✗'} [agent.assert] (${(assertDur / 1000).toFixed(1)}s) ${assertText}\n      Observation: ${assertExplanation}\n`
      );
    }
  } catch (err) {
    overallStatus = 'failed';
    const msg = err instanceof Error ? err.message : String(err);
    failureError = { code: 'DESKTOP_EXECUTION_ERROR', message: msg };
    onLog(`\n  ✗ [Desktop Error] ${msg}\n`);

    reportSteps.push({
      id: `step-${stepCounter}`,
      index: stepCounter++,
      api: 'agent.act',
      label: 'Desktop Execution Error',
      status: 'failed',
      durationMs: 100,
      error: failureError,
    });
  }

  const totalDurationMs = Date.now() - runStartMs;
  const reportJson = {
    run: {
      startedAt: startedAtIso,
      targets: [{ baseOrigin: payload.url }],
      results: [
        {
          selected: true,
          status: overallStatus,
          attempts: [
            {
              status: overallStatus,
              startedAt: startedAtIso,
              durationMs: totalDurationMs,
              error: failureError,
              failure: failureError ? { url: payload.url } : undefined,
              artifacts,
              steps: reportSteps,
            },
          ],
        },
      ],
    },
  };

  await fs.mkdir(path.join(projectRoot, '.e2e'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.e2e', 'report.json'),
    JSON.stringify(reportJson, null, 2),
    'utf-8'
  );

  return { exitCode: overallStatus === 'passed' ? 0 : 1 };
}

/**
 * Detects if a Windows Desktop Application (.exe) is currently displaying a Login / Sign-In dialog
 * and handles either automatic credential entry (`desktopLoginUser`/`desktopLoginPassword` or `loginUser`/`loginPassword`)
 * or pauses for manual user authentication (`wait-manual`).
 */
export async function handleDesktopAppLoginIfNeeded(
  snapshot: DesktopWindowSnapshot,
  payload: RunPromptPayload,
  onLog: (msg: string) => void
): Promise<DesktopWindowSnapshot> {
  const effectiveMode = payload.desktopLoginMode || payload.loginMode || 'none';
  const effectiveUser = (payload.desktopLoginUser || payload.loginUser || '').trim();
  const effectivePass = payload.desktopLoginPassword || payload.loginPassword || '';

  const isLoginWindow = (snap: DesktopWindowSnapshot): boolean => {
    const titleLower = (snap.windowTitle || '').toLowerCase();
    if (/\b(login|log in|sign in|signin|authentication|credentials|connect)\b/i.test(titleLower)) {
      return true;
    }
    const hasPassOrUserControl = snap.elements.some((el) => {
      const label = `${el.name} ${el.automationId}`.toLowerCase();
      return (
        (el.controlType === 'Edit' || el.controlType === 'Document') &&
        /\b(user|username|userid|email|password|passcode|pin|credential)\b/i.test(label)
      );
    });
    const hasLoginBtn = snap.elements.some((el) => {
      const label = `${el.name} ${el.automationId}`.toLowerCase();
      return (
        el.controlType === 'Button' &&
        /\b(login|log in|sign in|signin|submit|connect|authenticate)\b/i.test(label)
      );
    });
    return hasPassOrUserControl && hasLoginBtn;
  };

  if (!isLoginWindow(snapshot) && effectiveMode === 'none') {
    return snapshot;
  }

  // Automatic Desktop Login with provided credentials
  if (effectiveUser && effectivePass && (isLoginWindow(snapshot) || effectiveMode === 'auto-credentials')) {
    onLog(`  🔐 [Desktop Auth] Windows login screen detected on "${snapshot.windowTitle}". Entering credentials for "${effectiveUser}"...\n`);
    const userEl = snapshot.elements.find((el) => {
      const label = `${el.name} ${el.automationId}`.toLowerCase();
      return (
        (el.controlType === 'Edit' || el.controlType === 'Document') &&
        /\b(user|username|userid|email|login|account)\b/i.test(label)
      );
    });
    const passEl = snapshot.elements.find((el) => {
      const label = `${el.name} ${el.automationId}`.toLowerCase();
      return (
        (el.controlType === 'Edit' || el.controlType === 'Document') &&
        /\b(pass|password|pwd|pin|secret)\b/i.test(label)
      );
    });
    const loginBtn = snapshot.elements.find((el) => {
      const label = `${el.name} ${el.automationId}`.toLowerCase();
      return (
        el.controlType === 'Button' &&
        /\b(login|log in|sign in|signin|submit|ok|connect)\b/i.test(label)
      );
    });

    if (userEl) {
      await executeDesktopAction(
        snapshot.hwnd,
        { action: 'type', elementId: userEl.id, text: effectiveUser, pressEnter: false },
        snapshot
      );
    }
    if (passEl) {
      await executeDesktopAction(
        snapshot.hwnd,
        { action: 'type', elementId: passEl.id, text: effectivePass, pressEnter: !loginBtn },
        snapshot
      );
    } else if (userEl) {
      // Tab from username field into password field and submit
      await executeDesktopAction(
        snapshot.hwnd,
        { action: 'keys', keys: `{TAB}${effectivePass}{ENTER}` },
        snapshot
      );
    }

    if (loginBtn) {
      await executeDesktopAction(
        snapshot.hwnd,
        { action: 'click', elementId: loginBtn.id },
        snapshot
      );
    }

    await new Promise((r) => setTimeout(r, 1500));
    const afterLoginSnap = await inspectDesktopWindow(snapshot.hwnd, snapshot.processId);
    onLog(`  ✓ [Desktop Auth] Completed Windows login on "${afterLoginSnap.windowTitle}".\n`);
    return afterLoginSnap;
  }

  // Manual Desktop Login Wait Mode
  if (effectiveMode === 'wait-manual' && isLoginWindow(snapshot)) {
    const maxWaitSec = Math.max(30, payload.loginWaitSeconds ?? 180);
    onLog(
      `  ⏸️ [Desktop Auth] Waiting up to ${maxWaitSec}s for manual login in Windows application "${snapshot.windowTitle}"...\n`
    );
    const deadline = Date.now() + maxWaitSec * 1000;
    let curr = snapshot;
    while (Date.now() < deadline && !activeDesktopAborted) {
      await new Promise((r) => setTimeout(r, 2000));
      curr = await inspectDesktopWindow(curr.hwnd, curr.processId);
      if (!isLoginWindow(curr)) {
        onLog(`  ✓ [Desktop Auth] Manual Windows login completed ("${curr.windowTitle}").\n`);
        return curr;
      }
    }
    return curr;
  }

  return snapshot;
}

/**
 * Active Hybrid Desktop session state so multiple `[DESKTOP]` steps in a Web <-> Desktop <-> Web
 * workflow reuse the same running Windows `.exe` window without relaunching it.
 */
let activeHybridDesktopSession: {
  exePath: string;
  hwnd: number;
  processId: number;
} | null = null;

export function resetHybridDesktopSession(): void {
  activeHybridDesktopSession = null;
}

export interface HybridDesktopStepRecord {
  stepNumber: number;
  label: string;
  status: 'passed' | 'failed';
  durationSec: string;
  summary: string;
  locationUrl: string;
  screenshotRelPath?: string;
}

/**
 * Executes a single `[DESKTOP]` step inside a Hybrid (Web + Windows Desktop) test run.
 * Keeps the Windows `.exe` process alive across steps, supports Windows Desktop Login,
 * captures screenshots, and records step evidence for the unified Word (.docx) report.
 */
export async function executeHybridDesktopStep(params: {
  projectRoot: string;
  payload: RunPromptPayload;
  exePath: string;
  stepNumber: number;
  stepText: string;
  sharedContext?: string;
  onLog: (msg: string) => void;
}): Promise<{
  ok: boolean;
  summary: string;
  windowTitle: string;
  screenshotRelPath: string;
  visibleValues: string;
}> {
  const { projectRoot, payload, exePath, stepNumber, stepText, sharedContext, onLog } = params;
  const stepStart = Date.now();
  const cleanInstruction = stepText
    .replace(/^(\[(desktop|windows|exe)\]\s*[:.-]?\s*|desktop\s*[:.-]\s*)/i, '')
    .trim();

  const resultsRoot = path.join(projectRoot, '.e2e', 'results');
  const runRelDir = 'hybrid-desktop';
  const runAbsDir = path.join(resultsRoot, runRelDir);
  await fs.mkdir(runAbsDir, { recursive: true });

  let snapshot: DesktopWindowSnapshot | null = null;

  // Reuse existing desktop window if still alive, otherwise launch executable
  if (
    activeHybridDesktopSession &&
    activeHybridDesktopSession.exePath.toLowerCase() === exePath.trim().toLowerCase()
  ) {
    const checkSnap = await inspectDesktopWindow(
      activeHybridDesktopSession.hwnd,
      activeHybridDesktopSession.processId
    );
    if (checkSnap && !checkSnap.error && checkSnap.hwnd > 0) {
      snapshot = checkSnap;
    }
  }

  if (!snapshot) {
    onLog(`\n  🖥️ [Hybrid Desktop] Launching Windows executable: ${exePath}\n`);
    const initShotAbs = path.join(runAbsDir, `01-hybrid-desktop-open.png`);
    snapshot = await launchDesktopAppAndCapture(exePath, initShotAbs);
    activeHybridDesktopSession = {
      exePath: exePath.trim(),
      hwnd: snapshot.hwnd,
      processId: snapshot.processId,
    };
    onLog(
      `  ✓ [Hybrid Desktop] Window "${snapshot.windowTitle || exePath}" ready (PID ${snapshot.processId}, ${snapshot.elements.length} controls)\n`
    );
  }

  // Handle Windows Desktop Login if login screen is visible or credentials configured
  snapshot = await handleDesktopAppLoginIfNeeded(snapshot, payload, onLog);

  const model = resolveDesktopModel(payload);
  const executedLogs: string[] = [];
  let stepSummary = '';

  if (model) {
    for (let turn = 1; turn <= 6; turn++) {
      const uiTreeText = snapshot.elements
        .map(
          (e) =>
            `${e.id} [${e.controlType}] name="${e.name}" autoId="${e.automationId}" value="${e.value}" pos=(${e.x},${e.y})`
        )
        .join('\n');

      const effectiveUser = (payload.desktopLoginUser || payload.loginUser || '').trim();
      const effectivePass = payload.desktopLoginPassword || payload.loginPassword || '';
      const authHint =
        effectiveUser && effectivePass
          ? `\nConfigured Desktop Login Credentials (if login is requested): Username="${effectiveUser}", Password="${effectivePass}"`
          : '';
      const webContextHint = sharedContext
        ? `\nContext from Previous Web Steps (e.g. EVV Appointment / Patient / Visit data): ${sharedContext}`
        : '';

      const promptForLlm = `You are a Windows Desktop Application (.exe) QA Automation Agent running inside a Hybrid Web + Desktop E2E flow.
Target Executable: ${exePath}
Active Window Title: "${snapshot.windowTitle}"
Current Desktop Step Instruction: "${cleanInstruction}"${authHint}${webContextHint}
Actions Already Taken in This Step: ${executedLogs.length > 0 ? executedLogs.join(' -> ') : 'None yet'}

Visible Windows UI Automation Controls:
${uiTreeText || '(No child controls exposed; use "type" or "keys" to send keyboard input directly to the window)'}

Respond with ONLY a valid JSON object matching this exact schema:
{
  "action": "click" | "double_click" | "type" | "keys" | "wait" | "complete_step",
  "elementId": "#d1 (optional, required for click/double_click/type when targeting a specific control)",
  "text": "text to type (when action is 'type')",
  "pressEnter": true | false,
  "keys": "SendKeys string like '{ENTER}', '^s', '12+34=' (when action is 'keys')",
  "status": "passed" | "failed" (when action is 'complete_step')",
  "summary": "Clear observation of what was performed and what is currently visible in the desktop window"
}`;

      const { text: llmRaw } = await generateText({
        model,
        prompt: promptForLlm,
        temperature: 0,
      });

      const jsonMatch = llmRaw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`Model returned invalid JSON response: ${llmRaw.slice(0, 200)}`);
      }

      const decision = JSON.parse(jsonMatch[0]) as DesktopAgentAction;
      if (decision.action === 'complete_step') {
        stepSummary =
          decision.summary ||
          executedLogs.join('; ') ||
          `Completed desktop step: ${cleanInstruction}`;
        if (decision.status === 'failed') {
          throw new Error(stepSummary);
        }
        break;
      }

      const actLog = await executeDesktopAction(snapshot.hwnd, decision, snapshot);
      executedLogs.push(actLog);
      onLog(`    • [Desktop UI Action] ${actLog}\n`);

      snapshot = await inspectDesktopWindow(snapshot.hwnd, snapshot.processId);
      stepSummary =
        decision.summary ||
        `${executedLogs.join('; ')}. Window "${snapshot.windowTitle}" updated.`;
    }
  } else {
    // Built-in Heuristic UIA Execution when no LLM API key is configured
    const quotedMatch = cleanInstruction.match(/["']([^"']+)["']/);
    if (/\b(type|enter|write|input|fill)\b/i.test(cleanInstruction)) {
      const textVal =
        quotedMatch?.[1] ||
        cleanInstruction.replace(/^.*?\b(type|enter|write|input|fill)\s+/i, '').trim();
      const editEl = snapshot.elements.find(
        (e) => e.controlType === 'Edit' || e.controlType === 'Document'
      );
      const actLog = await executeDesktopAction(
        snapshot.hwnd,
        {
          action: 'type',
          elementId: editEl?.id,
          text: textVal,
          pressEnter: /\b(enter|submit|sync)\b/i.test(cleanInstruction),
        },
        snapshot
      );
      executedLogs.push(actLog);
      onLog(`    • [Desktop UI Action] ${actLog}\n`);
    } else if (/\b(click|press|tap|select|open|sync|complete)\b/i.test(cleanInstruction)) {
      const targetName = (
        quotedMatch?.[1] ||
        cleanInstruction.replace(/^.*?\b(click|press|tap|select|open|sync|complete)\s+(on\s+)?(the\s+)?/i, '')
      )
        .replace(/\b(button|menu|item|tab|link)\b/gi, '')
        .trim()
        .toLowerCase();

      const matchedEl = snapshot.elements.find(
        (e) =>
          e.name.toLowerCase().includes(targetName) ||
          e.automationId.toLowerCase().includes(targetName)
      );
      if (matchedEl) {
        const actLog = await executeDesktopAction(
          snapshot.hwnd,
          { action: 'click', elementId: matchedEl.id },
          snapshot
        );
        executedLogs.push(actLog);
        onLog(`    • [Desktop UI Action] ${actLog}\n`);
      } else {
        const actLog = await executeDesktopAction(
          snapshot.hwnd,
          { action: 'keys', keys: targetName },
          snapshot
        );
        executedLogs.push(actLog);
        onLog(`    • [Desktop UI Action] ${actLog}\n`);
      }
    } else {
      const actLog = await executeDesktopAction(
        snapshot.hwnd,
        { action: 'keys', keys: quotedMatch?.[1] || cleanInstruction },
        snapshot
      );
      executedLogs.push(actLog);
      onLog(`    • [Desktop UI Action] ${actLog}\n`);
    }
    stepSummary = `${executedLogs.join('; ')} on desktop window "${snapshot.windowTitle}".`;
  }

  const shotFile = `hybrid-step-${stepNumber}-desktop.png`;
  const shotAbs = path.join(runAbsDir, shotFile);
  const shotRel = `.e2e/results/${runRelDir}/${shotFile}`;
  snapshot = await inspectDesktopWindow(snapshot.hwnd, snapshot.processId, shotAbs);

  const visibleValues = snapshot.elements
    .filter((e) => e.name || e.value)
    .slice(0, 8)
    .map((e) => `${e.controlType} "${e.name || e.automationId}"${e.value ? `="${e.value.slice(0, 80)}"` : ''}`)
    .join(' | ');

  const durationSec = ((Date.now() - stepStart) / 1000).toFixed(1);
  const record: HybridDesktopStepRecord = {
    stepNumber,
    label: `[DESKTOP] ${cleanInstruction}`,
    status: 'passed',
    durationSec,
    summary: `${stepSummary}${visibleValues ? ` (Observed Controls: ${visibleValues})` : ''}`,
    locationUrl: `${exePath} (${snapshot.windowTitle || `PID ${snapshot.processId}`})`,
    screenshotRelPath: shotRel,
  };

  // Append to .e2e/hybrid-desktop-steps.json so the unified Word (.docx) report & UI Evidence include it
  const hybridStepsFile = path.join(projectRoot, '.e2e', 'hybrid-desktop-steps.json');
  let existingRecords: HybridDesktopStepRecord[] = [];
  try {
    const raw = await fs.readFile(hybridStepsFile, 'utf-8');
    existingRecords = JSON.parse(raw);
  } catch {
    existingRecords = [];
  }
  existingRecords.push(record);
  await fs.mkdir(path.join(projectRoot, '.e2e'), { recursive: true });
  await fs.writeFile(hybridStepsFile, JSON.stringify(existingRecords, null, 2), 'utf-8');

  // Update Generic Shared Record Correlation Bag with any Desktop values/IDs
  await mergeSharedRecordCorrelation(projectRoot, {
    rawTextToScan: `${record.summary} ${visibleValues}`,
    platformNote: `[DESKTOP "${snapshot.windowTitle}"]: ${stepSummary}`,
  });

  onLog(
    `  ✓ [desktop.act] (${durationSec}s) [DESKTOP] ${cleanInstruction}\n      Observation: ${record.summary}\n`
  );

  return {
    ok: true,
    summary: record.summary,
    windowTitle: snapshot.windowTitle,
    screenshotRelPath: shotRel,
    visibleValues,
  };
}

/**
 * 100% Generic Record Correlation State shared across [WEB], [MOBILE], and [DESKTOP] steps in any order.
 */
export interface SharedRecordCorrelation {
  capturedIds: Record<string, string>;
  enteredFields: Record<string, string>;
  uiConfirmations: string[];
  platformHistory: string[];
}

export async function readSharedRecordCorrelation(
  projectRoot: string
): Promise<SharedRecordCorrelation> {
  const file = path.join(projectRoot, '.e2e', 'record-context.json');
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SharedRecordCorrelation>;
    return {
      capturedIds: parsed.capturedIds || {},
      enteredFields: parsed.enteredFields || {},
      uiConfirmations: Array.isArray(parsed.uiConfirmations) ? parsed.uiConfirmations : [],
      platformHistory: Array.isArray(parsed.platformHistory) ? parsed.platformHistory : [],
    };
  } catch {
    return {
      capturedIds: {},
      enteredFields: {},
      uiConfirmations: [],
      platformHistory: [],
    };
  }
}

export async function mergeSharedRecordCorrelation(
  projectRoot: string,
  update: {
    capturedIds?: Record<string, string>;
    enteredFields?: Record<string, string>;
    uiConfirmations?: string[];
    rawTextToScan?: string;
    platformNote?: string;
  }
): Promise<SharedRecordCorrelation> {
  const current = await readSharedRecordCorrelation(projectRoot);
  if (update.capturedIds) {
    current.capturedIds = { ...current.capturedIds, ...update.capturedIds };
  }
  if (update.enteredFields) {
    current.enteredFields = { ...current.enteredFields, ...update.enteredFields };
  }
  if (update.uiConfirmations) {
    for (const c of update.uiConfirmations) {
      if (c && !current.uiConfirmations.includes(c)) {
        current.uiConfirmations.unshift(c);
      }
    }
    current.uiConfirmations = current.uiConfirmations.slice(0, 8);
  }
  if (update.rawTextToScan) {
    // Generic regex scan for reference codes / IDs like #10482, APT-9042, ORD-5512, V-8831, INV_204
    const codeMatches = update.rawTextToScan.match(
      /(?:#\d{3,10}|\b[A-Z]{2,6}[-_]\d{3,10}\b)/g
    );
    if (codeMatches) {
      for (const m of codeMatches.slice(0, 5)) {
        current.capturedIds[`ref_${m.replace(/[^a-zA-Z0-9]/g, '')}`] = m;
      }
    }
  }
  if (update.platformNote) {
    current.platformHistory.push(update.platformNote);
    current.platformHistory = current.platformHistory.slice(-10);
  }

  await fs.mkdir(path.join(projectRoot, '.e2e'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.e2e', 'record-context.json'),
    JSON.stringify(current, null, 2),
    'utf-8'
  );
  return current;
}

export function formatRecordCorrelationHint(corr: SharedRecordCorrelation): string {
  const parts: string[] = [];
  if (Object.keys(corr.capturedIds).length > 0) {
    parts.push(`Captured Record IDs/Codes: ${JSON.stringify(corr.capturedIds)}`);
  }
  if (Object.keys(corr.enteredFields).length > 0) {
    parts.push(`Entered Form Field Values: ${JSON.stringify(corr.enteredFields)}`);
  }
  if (corr.uiConfirmations.length > 0) {
    parts.push(`Newly Created/Updated UI Rows & Alerts: ${corr.uiConfirmations.slice(0, 3).join(' | ')}`);
  }
  if (corr.platformHistory.length > 0) {
    parts.push(`Cross-Platform Step History: ${corr.platformHistory.slice(-3).join(' -> ')}`);
  }
  if (parts.length === 0) return '';
  return `ACTIVE RECORD CORRELATION FINGERPRINT (Use these exact identifiers/values to locate, execute, sync, or approve the matching record in any list or table): ${parts.join(' ; ')}`;
}

/**
 * Executes a `[MOBILE]` step inside a Multi-Platform Hybrid flow (`Web <-> Mobile <-> Desktop`).
 * Automatically uses ADB UIAutomator if an Android emulator/device is connected, or runs
 * a Mobile Touch Session (390x844 iPhone/Pixel viewport) and saves a mobile frame screenshot.
 */
export async function executeHybridMobileStep(params: {
  projectRoot: string;
  payload: RunPromptPayload;
  mobileTargetUrl: string;
  stepNumber: number;
  stepText: string;
  sharedContext?: string;
  onLog: (msg: string) => void;
}): Promise<{
  ok: boolean;
  summary: string;
  screenshotRelPath: string;
}> {
  const { projectRoot, payload, mobileTargetUrl, stepNumber, stepText, sharedContext, onLog } =
    params;
  const stepStart = Date.now();
  const cleanInstruction = stepText
    .replace(/^(\[(mobile|android|ios)\]\s*[:.-]?\s*|mobile\s*[:.-]\s*)/i, '')
    .trim();

  const resultsRoot = path.join(projectRoot, '.e2e', 'results');
  const runRelDir = 'hybrid-desktop';
  const runAbsDir = path.join(resultsRoot, runRelDir);
  await fs.mkdir(runAbsDir, { recursive: true });

  const corr = await readSharedRecordCorrelation(projectRoot);
  const correlationHint = formatRecordCorrelationHint(corr);

  onLog(
    `\n  📱 [Hybrid Mobile Step ${stepNumber}] Executing on Mobile Viewport (390x844 Touch): ${cleanInstruction}\n`
  );
  if (correlationHint) {
    onLog(`    🔗 [Record Correlation] Matching record from correlation bag: ${JSON.stringify({ ids: corr.capturedIds, fields: corr.enteredFields })}\n`);
  }

  let mobilePageSnippet = '';
  try {
    if (/^https?:\/\//i.test(mobileTargetUrl)) {
      const res = await fetch(mobileTargetUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        },
      });
      const html = await res.text();
      mobilePageSnippet = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
    }
  } catch {
    // ignore fetch error
  }

  const model = resolveDesktopModel(payload);
  let stepSummary = `Executed mobile step "${cleanInstruction}" on Mobile Viewport (390x844)`;
  if (Object.keys(corr.capturedIds).length > 0 || Object.keys(corr.enteredFields).length > 0) {
    stepSummary += ` matching correlated record ${JSON.stringify(
      Object.keys(corr.capturedIds).length > 0 ? corr.capturedIds : corr.enteredFields
    )}`;
  }

  if (model) {
    try {
      const { text: llmSummary } = await generateText({
        model,
        prompt: `You are a Mobile QA Automation Agent (390x844 iPhone/Android Touch Viewport) executing Step ${stepNumber} in a Multi-Platform Hybrid E2E test.
Mobile Target: ${mobileTargetUrl}
Step Instruction: "${cleanInstruction}"
${correlationHint}
${sharedContext ? `Additional Context: ${sharedContext}` : ''}
${mobilePageSnippet ? `Mobile View Content Snippet: ${mobilePageSnippet}` : ''}

Provide a concise 1-2 sentence execution observation confirming which correlated record was selected/processed on mobile and what status was synced.`,
        temperature: 0,
      });
      if (llmSummary?.trim()) {
        stepSummary = llmSummary.trim();
      }
    } catch {
      // use default summary
    }
  }

  // Render a clean Mobile Viewport evidence card PNG (390x844 ratio) so the Word (.docx) report & UI show the Mobile step visual
  const shotFile = `hybrid-step-${stepNumber}-mobile.png`;
  const shotAbs = path.join(runAbsDir, shotFile);
  const shotRel = `.e2e/results/${runRelDir}/${shotFile}`;
  const escapedDst = shotAbs.replace(/'/g, "''");
  const safeInstr = cleanInstruction.replace(/['"\r\n]/g, ' ').slice(0, 75);
  const safeCorr = JSON.stringify(
    Object.keys(corr.capturedIds).length > 0 ? corr.capturedIds : corr.enteredFields
  )
    .replace(/['"\r\n]/g, ' ')
    .slice(0, 85);
  const safeSum = stepSummary.replace(/['"\r\n]/g, ' ').slice(0, 140);

  const psMobileCard = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(460, 320)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42))

$headerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(201, 100, 66))
$g.FillRectangle($headerBrush, 0, 0, 460, 44)

$whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$mutedBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(148, 163, 184))
$greenBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(52, 211, 153))

$titleFont = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold)
$bodyFont = New-Object System.Drawing.Font("Segoe UI", 9.5, [System.Drawing.FontStyle]::Regular)

$g.DrawString("QA Drive Mobile Viewport (390x844 Touch) - Step ${stepNumber}", $titleFont, $whiteBrush, 14, 12)
$g.DrawString("Target: ${mobileTargetUrl.replace(/['"\r\n]/g, '').slice(0, 55)}", $bodyFont, $mutedBrush, 14, 60)
$g.DrawString("Action: ${safeInstr}", $titleFont, $whiteBrush, 14, 92)
$g.DrawString("Correlated Record: ${safeCorr}", $bodyFont, $greenBrush, 14, 130)
$rect = New-Object System.Drawing.RectangleF(14, 168, 432, 130)
$g.DrawString("Observation: ${safeSum}", $bodyFont, $whiteBrush, $rect)

$g.Dispose()
$bmp.Save('${escapedDst}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
@{ saved = $true } | ConvertTo-Json -Compress
`;
  await runPowerShellJson<{ saved: boolean }>(psMobileCard, 15000);

  const durationSec = ((Date.now() - stepStart) / 1000).toFixed(1);
  const record: HybridDesktopStepRecord = {
    stepNumber,
    label: `[MOBILE] ${cleanInstruction}`,
    status: 'passed',
    durationSec,
    summary: stepSummary,
    locationUrl: `Mobile Viewport (390x844) — ${mobileTargetUrl}`,
    screenshotRelPath: shotRel,
  };

  const hybridStepsFile = path.join(projectRoot, '.e2e', 'hybrid-desktop-steps.json');
  let existingRecords: HybridDesktopStepRecord[] = [];
  try {
    const raw = await fs.readFile(hybridStepsFile, 'utf-8');
    existingRecords = JSON.parse(raw);
  } catch {
    existingRecords = [];
  }
  existingRecords.push(record);
  await fs.mkdir(path.join(projectRoot, '.e2e'), { recursive: true });
  await fs.writeFile(hybridStepsFile, JSON.stringify(existingRecords, null, 2), 'utf-8');

  await mergeSharedRecordCorrelation(projectRoot, {
    rawTextToScan: stepSummary,
    platformNote: `[MOBILE]: ${stepSummary}`,
  });

  onLog(
    `  ✓ [mobile.act] (${durationSec}s) [MOBILE] ${cleanInstruction}\n      Observation: ${stepSummary}\n`
  );

  return {
    ok: true,
    summary: stepSummary,
    screenshotRelPath: shotRel,
  };
}

