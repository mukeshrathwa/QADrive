import 'dotenv/config';
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { gateway } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  buildOrgTokenHeaders,
  createOrgAwsFetch,
  getOrgAwsConfigFromEnv,
} from './server/org-aws-llm.js';

/**
 * Resolves the AI SDK model instance based on environment variables.
 * Supports:
 * - Organization Mode (Internal AWS Gateway OpenAI/Anthropic & Direct AWS Bedrock Runtime)
 * - Standard Mode (OpenAI, Anthropic, Google Gemini, local Ollama, and AI Gateway)
 */
function resolveAgentModel() {
  const orgAws = getOrgAwsConfigFromEnv();
  if (orgAws && orgAws.enabled) {
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

    // Both `aws-gateway-openai` and `aws-bedrock` (translated via `customFetch`) use OpenAI-compatible interface
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

  const provider = (process.env.E2E_LLM_PROVIDER ?? 'openai').toLowerCase();
  const modelName = process.env.E2E_LLM_MODEL ?? 'gpt-4o';

  switch (provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return anthropic(modelName);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
      });
      return google(modelName);
    }
    case 'ollama': {
      const ollama = createOpenAICompatible({
        name: 'ollama',
        baseURL: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1',
      });
      return ollama(modelName);
    }
    case 'gateway': {
      return gateway(modelName);
    }
    case 'openai':
    default: {
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return openai(modelName);
    }
  }
}

const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browserName = (process.env.E2E_BROWSER ?? 'chromium') as
  | 'chromium'
  | 'firefox'
  | 'webkit';
const viewportWidth = Number(process.env.E2E_VIEWPORT_WIDTH ?? 1440);
const viewportHeight = Number(process.env.E2E_VIEWPORT_HEIGHT ?? 900);

const testTimeout = Number(process.env.E2E_TEST_TIMEOUT_MS ?? 300_000);
const actionTimeout = Number(process.env.E2E_ACTION_TIMEOUT_MS ?? 30_000);
const launchTimeout = Number(process.env.E2E_NAVIGATION_TIMEOUT_MS ?? 60_000);

export default {
  // Test file globs relative to the project root
  tests: 'tests/**/*.e2e.ts',

  // Global timeouts
  timeout: testTimeout,
  actionTimeout,
  launchTimeout,

  // Configure AI Agents for `agent.act(...)` and `agent.assert(...)`
  agents: {
    default: {
      model: resolveAgentModel(),
      maxSteps: 50,
      maxModelCalls: 50,
      judgmentTimeout: 60_000,
      // Keep observation payload compact on content-heavy sites so LLM turns stay fast
      maxObservationBytes: 96_000,
      maxInputTokens: 32_000,
      system: [
        'You are a fast, accurate QA automation agent testing a web application.',
        'Execute every requirement of the current instruction completely before calling complete_step. Never call complete_step early while part of the instruction remains unfinished.',
        'If the user prompt mentions opening the initial URL that is already loaded, skip re-navigating to it and proceed directly to the next action.',
        'Prefer direct clicks on visible links, menus, or tabs rather than hovering unless a dropdown requires hover.',
        'NEVER click "Logout" or "Sign Out" under any circumstances unless the prompt explicitly instructs you to log out. NEVER click on a logged-in user’s name or account/profile menu (e.g. "My Account", user profile link) when the instruction is to navigate to a product category, section, or search.',
        'When a step asks to go to a category or section (e.g., "Go to mobile section", "Go to electronics"): click the matching category navigation link, icon, or menu item on the page (such as "Mobiles", "Mobiles & Tablets", etc.) and wait for that section page to load.',
        'When a step asks to add a product matching a price condition (e.g. "Add first mobile with price greater than 25000 into cart" or between a price range): if the current category landing page only shows promotional banners without individual product prices, click into a product list/view-all or use the search bar/price filters so individual products and prices are visible, select the first matching product whose price satisfies the condition, open its product page, and click "Add to cart" so the item is actually in the shopping cart before finishing the step.',
        'Never enter dummy formData values (such as 9876543210 or qa.tester@example.com) into an OTP or password field, and never click the close (✕) button on a login/OTP modal when login or registration is required.',
        'IMPORTANT — Dynamic OTP / Password Entered by User in Browser: Because OTPs are dynamic and sent to the user’s mobile/email, the user enters the OTP directly into the browser input field. If an OTP, verification code, or password input field on screen ALREADY contains a value (e.g. digits like "098180" typed by the user), treat that existing value as the valid user-provided OTP! NEVER clear or overwrite a non-empty OTP field, and NEVER report AUTH_CREDENTIAL_UNAVAILABLE when the OTP field already has a value—instead, fill any other requested fields (like name or email if present on screen) and click the LOGIN / Verify / Submit / Continue / Register button immediately.',
        'If a step only asks to click Get Started / Login, enter a mobile number or email, and click submit/continue: once you have entered that mobile number/email and clicked submit/continue so the next screen (such as the OTP screen) loads, conclude the current step as PASSED (complete_step with status "passed").',
        'If a step asks to enter details (like name, email) along with an OTP provided by the user: if the user is ALREADY logged in (because logging in with OTP completed registration/login), conclude the step as PASSED; if name/email fields are visible, fill them first; if an OTP field is visible and still EMPTY, report AUTH_CREDENTIAL_UNAVAILABLE so the runner pauses for the user to type the OTP; if the OTP field is already filled by the user, click the LOGIN / Submit / Register button to finish.',
        'When a non-login web form (such as contact, registration, checkout address, feedback, or inquiry) is present on the page and the task involves filling, testing, or submitting it: fill all visible form fields (text inputs, email, phone, number, date, textarea), select valid options in dropdowns (<select> or comboboxes), select radio buttons, check required consent/terms checkboxes, and click the Submit / Send / Continue / Save / Create account button to submit the form.',
        'If the application opens on a Login / Sign In screen by default and the instruction asks to Sign Up / Register / Create Account, NEVER attempt to log in on the login screen and NEVER report AUTH_CREDENTIAL_UNAVAILABLE—instead, click the "Sign up" / "Register" / "Create account" link or button to open the signup form, fill in the registration details using formData (including formData.email and formData.password), and submit the signup form.',
        'Use exact field values from the prompt first; for any form fields not explicitly given in the prompt, use the provided params (executionContext, registeredCredentials, and formData, including formData.email and formData.password) so that any credentials registered during a signup step match the exact credentials used in a subsequent login step. Always follow any guidance provided in params.executionContext. If a step asks to log in with the same or registered credentials, automatically fill the email/username and password from registeredCredentials (or formData) and click Login / Sign In without reporting AUTH_CREDENTIAL_UNAVAILABLE. If a signup form reports that the email is already registered, either modify the email to a unique address (e.g. adding a random number before @) and submit the signup form again, or proceed to log in with those credentials.',
      ].join(' '),
    },
  },

  // Define Target Environments (Web via Playwright / @e2e-dev/web)
  targets: [
    {
      name: `web-${browserName}`,
      engine: web({
        browser: browserName,
        viewport: {
          width: viewportWidth,
          height: viewportHeight,
        },
        initScripts: [
          () => {
            // Keep product/external links in the active tab so multi-page e-commerce flows never lose page context
            document.addEventListener(
              'click',
              (e) => {
                const targetEl = e.target as Element | null;
                const link =
                  targetEl && typeof targetEl.closest === 'function'
                    ? targetEl.closest('a[target="_blank"]')
                    : null;
                if (link) {
                  link.removeAttribute('target');
                }
              },
              true
            );
            const origOpen = window.open;
            window.open = function (url, target, features) {
              if (url && typeof url === 'string' && !url.startsWith('javascript:')) {
                window.location.href = url;
                return window;
              }
              return origOpen ? origOpen.call(window, url, target, features) : null;
            };

            // Automatically track credentials (email/username/phone & password) entered during signup or form fills across navigations
            const recordInputCredential = (el: EventTarget | null) => {
              if (!el || !(el as HTMLElement).tagName) return;
              const inp = el as HTMLInputElement;
              if (inp.tagName.toUpperCase() !== 'INPUT') return;
              const val = (inp.value || '').trim();
              if (!val) return;

              const type = (inp.getAttribute('type') || 'text').toLowerCase();
              const attrs = [
                type,
                inp.getAttribute('name'),
                inp.getAttribute('id'),
                inp.getAttribute('placeholder'),
                inp.getAttribute('aria-label'),
                inp.getAttribute('autocomplete'),
                inp.closest('label')?.innerText,
                inp.parentElement?.innerText,
              ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

              const pageContext = (
                window.location.pathname +
                ' ' +
                (document.querySelector('h1, h2, h3')?.textContent || '')
              ).toLowerCase();
              const isSignupPage = /\b(signup|sign-up|sign\s+up|register|registration|create\s+account)\b/i.test(
                pageContext
              );

              try {
                if (type === 'password' || /\b(password|passcode|new-password|current-password)\b/i.test(attrs)) {
                  window.localStorage.setItem('__e2eCapturedPassword', val);
                  if (isSignupPage) {
                    window.localStorage.setItem('__e2eRegisteredByApp', 'true');
                  }
                } else if (
                  type === 'email' ||
                  /\b(email|username|user\s*id|user\s*name|login)\b/i.test(attrs) ||
                  val.includes('@')
                ) {
                  window.localStorage.setItem('__e2eCapturedUser', val);
                  if (isSignupPage) {
                    window.localStorage.setItem('__e2eRegisteredByApp', 'true');
                  }
                }
              } catch {
                // ignore storage errors on restricted origins
              }
            };

            document.addEventListener('input', (e) => recordInputCredential(e.target), true);
            document.addEventListener('change', (e) => recordInputCredential(e.target), true);

            // Feature #15 & #17: Record all DOM actions (click, input, select) per step for Zero-LLM Replay & Playwright .spec.ts export
            const buildElementSelectorInfo = (rawEl: Element) => {
              const el =
                rawEl.closest('button, a, input, textarea, select, [role="button"], [role="link"], [role="menuitem"], [role="tab"], label') ||
                rawEl;
              const htmlEl = el as HTMLElement;
              const tag = el.tagName.toLowerCase();
              const id = el.id || '';
              const testId =
                el.getAttribute('data-testid') ||
                el.getAttribute('data-test') ||
                el.getAttribute('data-qa') ||
                '';
              const name = el.getAttribute('name') || '';
              const type = (el.getAttribute('type') || '').toLowerCase();
              const placeholder = el.getAttribute('placeholder') || '';
              const ariaLabel = el.getAttribute('aria-label') || '';
              const role = el.getAttribute('role') || '';
              const href = el.getAttribute('href') || '';
              const text = ((htmlEl.innerText || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim()).slice(0, 80);

              // Build a fallback CSS selector path
              const parts: string[] = [];
              let cur: Element | null = el;
              let depth = 0;
              while (cur && cur !== document.body && depth < 4) {
                const cTag = cur.tagName.toLowerCase();
                if (cur.id) {
                  parts.unshift(`#${CSS.escape(cur.id)}`);
                  break;
                }
                const parentEl: Element | null = cur.parentElement;
                if (parentEl) {
                  const sameTagSiblings = Array.from(parentEl.children).filter(
                    (s: Element) => s.tagName === cur!.tagName
                  );
                  if (sameTagSiblings.length > 1) {
                    const idx = sameTagSiblings.indexOf(cur) + 1;
                    parts.unshift(`${cTag}:nth-of-type(${idx})`);
                  } else {
                    parts.unshift(cTag);
                  }
                } else {
                  parts.unshift(cTag);
                }
                cur = parentEl;
                depth++;
              }

              return {
                tag,
                id,
                testId,
                name,
                type,
                placeholder,
                ariaLabel,
                role,
                href,
                text,
                cssPath: parts.join(' > '),
              };
            };

            const appendStepAction = (actionObj: Record<string, unknown>) => {
              try {
                if ((window as unknown as { __e2eReplayingCache?: boolean }).__e2eReplayingCache) {
                  return;
                }
                const rawList = window.localStorage.getItem('__e2eCurrentStepActions') || '[]';
                const list = JSON.parse(rawList) as Array<Record<string, unknown>>;
                const last = list[list.length - 1];

                // Coalesce consecutive input events on the same field into a single final value
                if (
                  actionObj.kind === 'fill' &&
                  last &&
                  last.kind === 'fill' &&
                  last.cssPath === actionObj.cssPath &&
                  last.name === actionObj.name &&
                  last.id === actionObj.id
                ) {
                  list[list.length - 1] = actionObj;
                } else {
                  list.push(actionObj);
                }
                window.localStorage.setItem('__e2eCurrentStepActions', JSON.stringify(list.slice(-40)));
              } catch {
                // ignore storage errors
              }
            };

            document.addEventListener(
              'click',
              (e) => {
                const target = e.target as Element | null;
                if (!target || target.id === 'e2e-login-wait-banner' || target.closest('#e2e-login-wait-banner')) {
                  return;
                }
                const info = buildElementSelectorInfo(target);
                if (info.tag === 'input' && !['submit', 'button', 'checkbox', 'radio'].includes(info.type)) {
                  // Focusing a text input before typing doesn't need a separate click entry
                  return;
                }
                appendStepAction({
                  kind: 'click',
                  ...info,
                  pageUrl: window.location.pathname,
                });
              },
              true
            );

            const recordFillOrSelect = (e: Event) => {
              const target = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
              if (!target || !target.tagName) return;
              const tag = target.tagName.toLowerCase();
              if (!['input', 'textarea', 'select'].includes(tag)) return;
              const type = (target.getAttribute('type') || 'text').toLowerCase();
              if (['submit', 'button', 'hidden'].includes(type)) return;

              const info = buildElementSelectorInfo(target);
              const val = target.value ?? '';
              const isEmail =
                type === 'email' ||
                /\b(email)\b/i.test(`${info.name} ${info.id} ${info.placeholder} ${info.ariaLabel}`) ||
                val.includes('@');

              appendStepAction({
                kind: tag === 'select' ? 'select' : 'fill',
                ...info,
                value: val,
                isEmail,
                pageUrl: window.location.pathname,
              });

              // Generic Record Correlation Tracker: capture non-password field label -> value pairs across any domain
              if (type !== 'password' && val && val.trim().length > 0 && val.trim().length <= 120) {
                try {
                  const explicitLabel =
                    (target.closest('label')?.textContent || '')
                      .replace(/\s+/g, ' ')
                      .trim() ||
                    (info.id
                      ? (
                          document.querySelector(`label[for="${info.id}"]`)?.textContent ||
                          ''
                        )
                          .replace(/\s+/g, ' ')
                          .trim()
                      : '');
                  const fieldKey = (
                    explicitLabel ||
                    info.placeholder ||
                    info.ariaLabel ||
                    info.name ||
                    info.id ||
                    tag
                  )
                    .replace(/[*:\n\r]+/g, '')
                    .trim()
                    .slice(0, 50);
                  if (fieldKey) {
                    const rawCorr = window.localStorage.getItem('__e2eRecordCorrelation');
                    const corr = rawCorr
                      ? JSON.parse(rawCorr)
                      : { enteredFields: {}, capturedIds: {}, uiConfirmations: [] };
                    corr.enteredFields = corr.enteredFields || {};
                    corr.enteredFields[fieldKey] = val.trim();
                    window.localStorage.setItem(
                      '__e2eRecordCorrelation',
                      JSON.stringify(corr)
                    );
                  }
                } catch {
                  // ignore
                }
              }
            };

            document.addEventListener('input', recordFillOrSelect, true);
            document.addEventListener('change', recordFillOrSelect, true);

            // Feature #28: Auto-Harvest HTTP API Requests (fetch & XHR) for JMeter Load Testing
            const recordHarvestedRequest = (entry: {
              method: string;
              url: string;
              body?: string;
              contentType?: string;
            }) => {
              try {
                if (!entry.url || entry.url.startsWith('data:') || entry.url.startsWith('blob:')) {
                  return;
                }
                const resolved = new URL(entry.url, window.location.origin).toString();
                if (!resolved.startsWith(window.location.origin)) {
                  return;
                }
                if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|css|map)(\?|$)/i.test(resolved)) {
                  return;
                }
                const raw = window.localStorage.getItem('__e2eHarvestedRequests');
                const list = raw ? JSON.parse(raw) : [];
                const key = `${entry.method.toUpperCase()} ${resolved}`;
                if (!list.some((x: any) => `${x.method} ${x.url}` === key)) {
                  list.push({
                    method: entry.method.toUpperCase(),
                    url: resolved,
                    body: entry.body ? String(entry.body).slice(0, 1500) : undefined,
                    contentType: entry.contentType || 'application/json',
                  });
                  window.localStorage.setItem(
                    '__e2eHarvestedRequests',
                    JSON.stringify(list.slice(-30))
                  );
                }
              } catch {
                // ignore
              }
            };

            // Always record current page navigation URL
            recordHarvestedRequest({ method: 'GET', url: window.location.href });

            // Generic Incremental Live Site Map Recorder: captures visible links, inputs & buttons for the active user
            const snapshotVisibleSiteNodes = () => {
              try {
                const pathname = window.location.pathname || '/';
                const elements: Array<{
                  kind: string;
                  text?: string;
                  href?: string;
                  id?: string;
                  name?: string;
                  type?: string;
                  placeholder?: string;
                  selector: string;
                }> = [];
                const seen = new Set<string>();
                const nodes = Array.from(
                  document.querySelectorAll('a[href], button, input:not([type="hidden"]), select')
                ).slice(0, 50);

                for (const node of nodes) {
                  const htmlEl = node as HTMLElement;
                  const rect = htmlEl.getBoundingClientRect();
                  if (rect.width < 4 || rect.height < 4) continue;
                  const info = buildElementSelectorInfo(node);
                  const selector = info.testId
                    ? `[data-testid="${info.testId}"]`
                    : info.id
                      ? `#${info.id}`
                      : info.href
                        ? `a[href="${info.href}"]`
                        : info.name
                          ? `${info.tag}[name="${info.name}"]`
                          : info.cssPath;
                  if (!selector || seen.has(selector)) continue;
                  seen.add(selector);
                  elements.push({
                    kind:
                      info.tag === 'a'
                        ? 'link'
                        : info.tag === 'button' || info.type === 'submit'
                          ? 'button'
                          : 'input',
                    text: info.text || undefined,
                    href: info.href || undefined,
                    id: info.id || undefined,
                    name: info.name || undefined,
                    type: info.type || undefined,
                    placeholder: info.placeholder || undefined,
                    selector,
                  });
                }

                const rawPages = window.localStorage.getItem('__e2eLiveSiteNodes');
                const pageList = rawPages ? JSON.parse(rawPages) : [];
                const existingIdx = pageList.findIndex((p: any) => p.pathname === pathname);
                const pageEntry = {
                  url: window.location.href,
                  pathname,
                  title: document.title || pathname,
                  elements,
                };
                if (existingIdx >= 0) {
                  pageList[existingIdx] = pageEntry;
                } else {
                  pageList.push(pageEntry);
                }
                window.localStorage.setItem(
                  '__e2eLiveSiteNodes',
                  JSON.stringify(pageList.slice(-25))
                );
              } catch {
                // ignore
              }
            };

            window.addEventListener('load', () => setTimeout(snapshotVisibleSiteNodes, 500));
            setTimeout(snapshotVisibleSiteNodes, 1200);

            const extractGenericIdsFromObject = (
              obj: any,
              out: Record<string, string>,
              depth = 0
            ) => {
              if (!obj || typeof obj !== 'object' || depth > 3) return;
              for (const [k, v] of Object.entries(obj)) {
                if (
                  (typeof v === 'string' || typeof v === 'number') &&
                  String(v).trim().length > 0 &&
                  String(v).trim().length <= 64
                ) {
                  if (
                    /^(id|uuid|code|number|ref|reference|key)$/i.test(k) ||
                    /(^|_|-)(id|code|number|no|ref|reference|key)$/i.test(k) ||
                    /[a-z](Id|Code|Number|No|Ref)$/.test(k)
                  ) {
                    out[k] = String(v).trim();
                  }
                } else if (v && typeof v === 'object' && !Array.isArray(v)) {
                  extractGenericIdsFromObject(v, out, depth + 1);
                }
              }
            };

            const origFetch = window.fetch;
            if (typeof origFetch === 'function') {
              window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
                let method = 'GET';
                try {
                  const reqUrl =
                    typeof input === 'string'
                      ? input
                      : input instanceof URL
                        ? input.toString()
                        : input.url;
                  method = (
                    init?.method ||
                    (typeof input === 'object' && 'method' in input ? input.method : 'GET') ||
                    'GET'
                  ).toUpperCase();
                  const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
                  recordHarvestedRequest({
                    method,
                    url: reqUrl,
                    body: bodyStr,
                  });
                } catch {}
                const response = await origFetch.apply(this, arguments as any);
                if (['POST', 'PUT', 'PATCH'].includes(method)) {
                  try {
                    const cloned = response.clone();
                    cloned
                      .json()
                      .then((data) => {
                        const extracted: Record<string, string> = {};
                        extractGenericIdsFromObject(data, extracted);
                        if (Object.keys(extracted).length > 0) {
                          const rawCorr = window.localStorage.getItem(
                            '__e2eRecordCorrelation'
                          );
                          const corr = rawCorr
                            ? JSON.parse(rawCorr)
                            : { enteredFields: {}, capturedIds: {}, uiConfirmations: [] };
                          corr.capturedIds = { ...(corr.capturedIds || {}), ...extracted };
                          window.localStorage.setItem(
                            '__e2eRecordCorrelation',
                            JSON.stringify(corr)
                          );
                        }
                      })
                      .catch(() => {});
                  } catch {}
                }
                return response;
              };
            }
          },
        ],
      }),
      app: {
        url: baseUrl,
      },
    },
  ],
} satisfies E2EConfig;
