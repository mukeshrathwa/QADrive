import fs from 'node:fs/promises';
import path from 'node:path';

export interface TestRailConfig {
  enabled: boolean;
  baseUrl: string;
  username: string;
  apiKey: string;
  defaultRunId?: string;
  defaultProjectId?: string;
  autoUpdateResult: boolean;
}

export interface FetchedTestRailCase {
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

const DEMO_CASES: Record<string, FetchedTestRailCase> = {
  C101: {
    id: 101,
    caseIdFormatted: 'C101',
    title: 'Verify ICC India Team Ranking on Times of India Cricket Section',
    url: 'https://timesofindia.indiatimes.com/',
    prompt:
      'Step 2: Go to cricket menu\nStep 3: Check ICC India team rankings on that page and check whether India team ranking is 4',
    assertionPrompt: 'India team ranking should be 4',
    preconditions: 'Public portal accessible at https://timesofindia.indiatimes.com/',
    priority: 'High',
    section: 'Sports & Rankings',
  },
  C102: {
    id: 102,
    caseIdFormatted: 'C102',
    title: 'Verify Partner Flag ON displays Partner Menu X on Navigation Bar',
    url: 'https://timesofindia.indiatimes.com/',
    prompt:
      'Inspect the top navigation bar and menu items to check if the partner menu link is enabled and visible',
    assertionPrompt:
      'Verify that the Partner Flag is ON by confirming that menu item Cricket is visible in the main navigation bar',
    preconditions: 'Partner Flag is set to ON in the target environment',
    priority: 'High',
    section: 'Partner Feature Flags',
  },
  C103: {
    id: 103,
    caseIdFormatted: 'C103',
    title: 'Verify Partner Flag OFF hides Restricted Partner Link from Navigation',
    url: 'https://timesofindia.indiatimes.com/',
    prompt:
      'Scan the main navigation bar and header links to verify restricted partner links are not exposed when flag is OFF',
    assertionPrompt:
      'Verify that the Partner Flag is OFF by confirming that menu item "RestrictedPartnerPortal" is NOT visible in the navigation bar',
    preconditions: 'Partner Flag is set to OFF in the target environment',
    priority: 'Medium',
    section: 'Partner Feature Flags',
  },
  C104: {
    id: 104,
    caseIdFormatted: 'C104',
    title: 'Verify Web Form Auto-Fill and Form Submission Confirmation',
    url: 'https://www.selenium.dev/selenium/web/web-form.html',
    prompt:
      'Step 1: Fill the Text input, Password, and Textarea fields on the web form\nStep 2: Select "Two" in the Dropdown (select) menu and check the Default checkbox\nStep 3: Click the Submit button to submit the form',
    assertionPrompt:
      'Page displays "Form submitted" heading and confirmation message "Received!"',
    preconditions: 'Web form page is accessible',
    priority: 'High',
    section: 'Web Forms & Submissions',
  },
};

function resolveEffectiveConfig(config: TestRailConfig): TestRailConfig {
  return {
    ...config,
    baseUrl: config.baseUrl?.trim() || process.env.TESTRAIL_URL?.trim() || '',
    username: config.username?.trim() || process.env.TESTRAIL_USER?.trim() || '',
    apiKey: config.apiKey?.trim() || process.env.TESTRAIL_API_KEY?.trim() || '',
    defaultRunId:
      config.defaultRunId?.trim() || process.env.TESTRAIL_RUN_ID?.trim() || '',
  };
}

function getBasicAuthHeader(config: TestRailConfig): string {
  const credentials = `${config.username.trim()}:${config.apiKey.trim()}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

function normalizeUrl(baseUrl: string): string {
  let url = baseUrl.trim();
  if (url.endsWith('/')) {
    url = url.slice(0, -1);
  }
  return url;
}

/**
 * Normalizes case ID string like "C1234", "c1234", or "1234" to pure number.
 */
export function extractCaseNumber(caseId: string | number): number {
  const cleaned = String(caseId).trim().replace(/^[Cc]/, '');
  const parsed = parseInt(cleaned, 10);
  if (isNaN(parsed)) {
    throw new Error(
      `Invalid TestRail Case ID: "${caseId}". Expected format like "C10452" or "10452".`
    );
  }
  return parsed;
}

/**
 * Tests connection to TestRail API
 */
export async function testTestRailConnection(rawConfig: TestRailConfig): Promise<{
  ok: boolean;
  message: string;
  user?: string;
}> {
  const config = resolveEffectiveConfig(rawConfig);

  if (!config.baseUrl) {
    return { ok: false, message: 'TestRail Base URL is required.' };
  }
  if (!config.username || !config.apiKey) {
    return { ok: false, message: 'TestRail Username/Email and API Key are required.' };
  }

  const endpoint = `${normalizeUrl(config.baseUrl)}/index.php?/api/v2/get_user_by_email&email=${encodeURIComponent(config.username)}`;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: getBasicAuthHeader(config),
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message: `Authentication failed (HTTP ${res.status}). Check your TestRail email and API Key.`,
        };
      }
      const projEndpoint = `${normalizeUrl(config.baseUrl)}/index.php?/api/v2/get_projects`;
      const projRes = await fetch(projEndpoint, {
        method: 'GET',
        headers: {
          Authorization: getBasicAuthHeader(config),
          'Content-Type': 'application/json',
        },
      });
      if (projRes.ok) {
        return { ok: true, message: 'Successfully authenticated to TestRail!' };
      }
      return {
        ok: false,
        message: `TestRail API returned HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = (await res.json()) as { name?: string; email?: string };
    return {
      ok: true,
      message: `Connected successfully as ${data.name || data.email || config.username}!`,
      user: data.name || data.email,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Network connection error: ${(err as Error).message}`,
    };
  }
}

/**
 * Fetches test case by ID from TestRail (or built-in demo cases C101/C102/C103)
 */
export async function fetchTestRailCase(
  rawConfig: TestRailConfig,
  caseIdInput: string | number
): Promise<{
  ok: boolean;
  case?: FetchedTestRailCase;
  error?: string;
}> {
  const config = resolveEffectiveConfig(rawConfig);
  const caseStr = String(caseIdInput).trim().toUpperCase();

  // Built-in sample cases when testing without live TestRail server or using demo IDs
  if (caseStr === 'DEMO') {
    return { ok: true, case: DEMO_CASES.C101 };
  }
  if (
    DEMO_CASES[caseStr] &&
    (!config.baseUrl || !config.username || !config.apiKey)
  ) {
    return { ok: true, case: DEMO_CASES[caseStr] };
  }

  if (!config.baseUrl || !config.username || !config.apiKey) {
    return {
      ok: false,
      error:
        'TestRail credentials are not configured in Settings (or .env). Configure your TestRail URL, Email, and API Key in ⚙️ Settings, or try sample Case IDs C101, C102, or C103.',
    };
  }

  let caseNumber: number;
  try {
    caseNumber = extractCaseNumber(caseIdInput);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const endpoint = `${normalizeUrl(config.baseUrl)}/index.php?/api/v2/get_case/${caseNumber}`;

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: getBasicAuthHeader(config),
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      if (res.status === 400 || res.status === 404) {
        return {
          ok: false,
          error: `TestRail case C${caseNumber} was not found. Please verify the Case ID.`,
        };
      }
      return {
        ok: false,
        error: `TestRail API error HTTP ${res.status}: ${res.statusText}`,
      };
    }

    const data = (await res.json()) as {
      id: number;
      title: string;
      custom_url?: string;
      custom_preconds?: string;
      custom_steps?: string;
      custom_expected?: string;
      custom_steps_separated?: Array<{
        content: string;
        expected?: string;
        additional_info?: string;
      }>;
      priority_id?: number;
      section_id?: number;
    };

    let prompt = '';
    let assertionPrompt = data.custom_expected?.trim() || '';

    if (
      Array.isArray(data.custom_steps_separated) &&
      data.custom_steps_separated.length > 0
    ) {
      const stepTexts: string[] = [];
      const expectedTexts: string[] = [];
      data.custom_steps_separated.forEach((step, idx) => {
        if (step.content?.trim()) {
          stepTexts.push(`Step ${idx + 1}: ${step.content.trim()}`);
        }
        if (step.expected?.trim()) {
          expectedTexts.push(step.expected.trim());
        }
      });
      prompt = stepTexts.join('\n');
      if (!assertionPrompt && expectedTexts.length > 0) {
        assertionPrompt = expectedTexts.join('; ');
      }
    } else if (data.custom_steps?.trim()) {
      prompt = data.custom_steps.trim();
    } else {
      prompt = data.title;
    }

    if (!assertionPrompt) {
      assertionPrompt = `Verify ${data.title}`;
    }

    // Extract target URL from custom_url, preconditions, or steps
    let targetUrl = data.custom_url?.trim() || '';
    if (!targetUrl && data.custom_preconds) {
      const match = data.custom_preconds.match(/https?:\/\/[^\s"'<>]+/i);
      if (match) targetUrl = match[0];
    }
    if (!targetUrl && prompt) {
      const match = prompt.match(/https?:\/\/[^\s"'<>]+/i);
      if (match) targetUrl = match[0];
    }

    return {
      ok: true,
      case: {
        id: data.id,
        caseIdFormatted: `C${data.id}`,
        title: data.title,
        url: targetUrl || undefined,
        prompt,
        assertionPrompt,
        preconditions: data.custom_preconds,
        priority: data.priority_id ? `Priority ${data.priority_id}` : undefined,
        section: data.section_id ? `Section ${data.section_id}` : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to fetch TestRail case: ${(err as Error).message}`,
    };
  }
}

/**
 * Submits the test execution result back to TestRail
 */
export async function submitTestRailResult(
  rawConfig: TestRailConfig,
  result: {
    runId: string | number;
    caseId: string | number;
    status: 'passed' | 'failed';
    comment: string;
    elapsed?: string;
    docxPath?: string;
  }
): Promise<{
  ok: boolean;
  resultId?: number;
  error?: string;
}> {
  const config = resolveEffectiveConfig(rawConfig);

  if (!config.baseUrl || !config.username || !config.apiKey) {
    return {
      ok: false,
      error: 'TestRail credentials not configured (skipping live result upload).',
    };
  }

  const runNumber = parseInt(String(result.runId).replace(/^[Rr]/, ''), 10);
  const caseNumber = extractCaseNumber(result.caseId);

  if (isNaN(runNumber)) {
    return {
      ok: false,
      error: `Invalid TestRail Run ID: "${result.runId}". Expected format like "R204" or "204".`,
    };
  }

  // TestRail Status IDs: 1 = Passed, 5 = Failed
  const statusId = result.status === 'passed' ? 1 : 5;
  const endpoint = `${normalizeUrl(config.baseUrl)}/index.php?/api/v2/add_result_for_case/${runNumber}/${caseNumber}`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: getBasicAuthHeader(config),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        status_id: statusId,
        comment: result.comment,
        elapsed: result.elapsed || '15s',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        error: `TestRail API error HTTP ${res.status}: ${errText}`,
      };
    }

    const data = (await res.json()) as { id: number };

    // Attach Word docx report if available
    if (result.docxPath && data.id) {
      try {
        await uploadTestRailAttachment(config, data.id, result.docxPath);
      } catch (attachErr) {
        console.warn('[TestRail] Failed to upload Word attachment:', attachErr);
      }
    }

    return { ok: true, resultId: data.id };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to submit result to TestRail: ${(err as Error).message}`,
    };
  }
}

/**
 * Uploads an attachment file to a TestRail test result
 */
async function uploadTestRailAttachment(
  config: TestRailConfig,
  resultId: number,
  filePath: string
): Promise<void> {
  const fileBuffer = await fs.readFile(filePath);
  const fileName = path.basename(filePath);

  const endpoint = `${normalizeUrl(config.baseUrl)}/index.php?/api/v2/add_attachment_to_result/${resultId}`;

  const formData = new FormData();
  const blob = new Blob([fileBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  formData.append('attachment', blob, fileName);

  await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: getBasicAuthHeader(config),
    },
    body: formData,
  });
}
