import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHostSessionFilename } from './cache-and-session.js';

export interface ScannedElementInfo {
  kind: 'link' | 'button' | 'input' | 'select' | 'textarea' | 'form';
  text?: string;
  href?: string;
  id?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  selector: string;
}

export interface ScannedPageEntry {
  url: string;
  pathname: string;
  title: string;
  status: number;
  loadTimeMs: number;
  lastScannedAt: string;
  elements: ScannedElementInfo[];
}

export interface SuggestedSiteScenario {
  title: string;
  prompt: string;
  assertionPrompt: string;
}

export interface UnifiedSiteMap {
  origin: string;
  updatedAt: string;
  pages: Record<string, ScannedPageEntry>;
  suggestedScenarios: SuggestedSiteScenario[];
}

function extractTagAttr(tagHtml: string, attrName: string): string {
  const regex = new RegExp(`\\b${attrName}\\s*=\\s*["']([^"']*)["']`, 'i');
  const match = tagHtml.match(regex);
  return match ? match[1].trim() : '';
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses HTML from a fetched page to extract internal links, forms, inputs, and buttons generically.
 */
function parseHtmlElementsAndLinks(
  html: string,
  pageOrigin: string
): {
  title: string;
  internalUrls: string[];
  elements: ScannedElementInfo[];
} {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtmlTags(titleMatch[1]).slice(0, 120) : '';

  const internalUrls = new Set<string>();
  const elements: ScannedElementInfo[] = [];
  const seenSelectors = new Set<string>();

  const addElement = (el: ScannedElementInfo) => {
    if (seenSelectors.has(el.selector) || elements.length >= 45) return;
    seenSelectors.add(el.selector);
    elements.push(el);
  };

  // 1. Extract `<a ...>text</a>`
  const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = match[1];
    const rawHref = extractTagAttr(attrs, 'href');
    const text = stripHtmlTags(match[2]).slice(0, 60);
    const id = extractTagAttr(attrs, 'id');
    const testId = extractTagAttr(attrs, 'data-testid') || extractTagAttr(attrs, 'data-test');

    if (rawHref && !rawHref.startsWith('#') && !rawHref.startsWith('javascript:') && !rawHref.startsWith('mailto:')) {
      try {
        const resolved = new URL(rawHref, pageOrigin);
        if (
          resolved.origin === pageOrigin &&
          !/\.(png|jpg|jpeg|gif|svg|pdf|zip|css|js|ico|woff2?)$/i.test(resolved.pathname)
        ) {
          internalUrls.add(`${resolved.origin}${resolved.pathname}`);
          const selector = testId
            ? `[data-testid="${testId}"]`
            : id
              ? `#${id}`
              : `a[href="${resolved.pathname}"]`;
          addElement({
            kind: 'link',
            text: text || resolved.pathname,
            href: resolved.pathname,
            id: id || undefined,
            selector,
          });
        }
      } catch {
        // ignore invalid href
      }
    }
  }

  // 2. Extract `<input ...>`
  const inputRegex = /<input\b([^>]*)>/gi;
  while ((match = inputRegex.exec(html)) !== null) {
    const attrs = match[1];
    const type = (extractTagAttr(attrs, 'type') || 'text').toLowerCase();
    if (type === 'hidden') continue;
    const id = extractTagAttr(attrs, 'id');
    const name = extractTagAttr(attrs, 'name');
    const placeholder = extractTagAttr(attrs, 'placeholder');
    const testId = extractTagAttr(attrs, 'data-testid') || extractTagAttr(attrs, 'data-test');

    const selector = testId
      ? `[data-testid="${testId}"]`
      : id
        ? `#${id}`
        : name
          ? `input[name="${name}"]`
          : placeholder
            ? `input[placeholder="${placeholder}"]`
            : `input[type="${type}"]`;

    addElement({
      kind: type === 'submit' || type === 'button' ? 'button' : 'input',
      type,
      id: id || undefined,
      name: name || undefined,
      placeholder: placeholder || undefined,
      text: extractTagAttr(attrs, 'value') || placeholder || name || id || type,
      selector,
    });
  }

  // 3. Extract `<button ...>text</button>`
  const btnRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((match = btnRegex.exec(html)) !== null) {
    const attrs = match[1];
    const text = stripHtmlTags(match[2]).slice(0, 60);
    const id = extractTagAttr(attrs, 'id');
    const testId = extractTagAttr(attrs, 'data-testid') || extractTagAttr(attrs, 'data-test');
    const type = (extractTagAttr(attrs, 'type') || 'button').toLowerCase();

    const selector = testId
      ? `[data-testid="${testId}"]`
      : id
        ? `#${id}`
        : text
          ? `button:has-text("${text.replace(/"/g, '\\"')}")`
          : `button[type="${type}"]`;

    addElement({
      kind: 'button',
      type,
      id: id || undefined,
      text: text || id || 'Button',
      selector,
    });
  }

  return {
    title,
    internalUrls: Array.from(internalUrls),
    elements,
  };
}

/**
 * Generates generic ready-to-run E2E scenarios from the discovered pages & elements in the Unified Site Map.
 */
export function buildSuggestedScenariosFromSiteMap(
  pages: Record<string, ScannedPageEntry>
): SuggestedSiteScenario[] {
  const pageList = Object.values(pages);
  const scenarios: SuggestedSiteScenario[] = [];

  const paths = pageList.map((p) => p.pathname.toLowerCase());
  const allElements = pageList.flatMap((p) =>
    p.elements.map((e) => ({ ...e, pathname: p.pathname }))
  );

  const hasSignup =
    paths.some((p) => /signup|register|join/i.test(p)) ||
    allElements.some((e) => /sign\s*up|register|create\s+account/i.test(`${e.text} ${e.href}`));
  const hasLogin =
    paths.some((p) => /login|signin|auth/i.test(p)) ||
    allElements.some((e) => /log\s*in|sign\s*in|password/i.test(`${e.text} ${e.href} ${e.name} ${e.type}`));
  const hasCartOrShop =
    paths.some((p) => /cart|product|shop|store|item|catalog/i.test(p)) ||
    allElements.some((e) => /add\s+to\s+cart|cart|checkout|buy|order/i.test(`${e.text} ${e.href}`));
  const hasOrders =
    paths.some((p) => /order|history|purchases/i.test(p)) ||
    allElements.some((e) => /order/i.test(`${e.text} ${e.href}`));

  if (hasSignup && hasLogin && hasCartOrShop) {
    scenarios.push({
      title: 'Full User Journey (Signup → Login → Cart/Order)',
      prompt:
        'Step 1: Go to signup and register user.\nStep 2: Once registered the user. Login with the same credentials.\nStep 3: Add item in the cart any one. And Create order.\nStep 4: Navigate to order listing page',
      assertionPrompt: hasOrders
        ? 'Order should be listed on the order listing page'
        : 'Order confirmation should be visible on the page',
    });
  } else if (hasLogin) {
    scenarios.push({
      title: 'Authentication & Dashboard Verification',
      prompt:
        'Step 1: Navigate to the login page and sign in with valid credentials.\nStep 2: Verify the main dashboard or landing area loads after login.',
      assertionPrompt: 'User should be logged in and dashboard content should be visible',
    });
  }

  // Add a Multi-Page Navigation Smoke Test covering discovered routes
  const topNavPages = pageList
    .filter((p) => p.pathname !== '/' && p.status >= 200 && p.status < 400)
    .slice(0, 4);
  if (topNavPages.length > 0) {
    const stepLines = topNavPages.map(
      (p, i) => `Step ${i + 1}: Navigate to ${p.pathname} (${p.title || 'Page'}) and verify content loads`
    );
    scenarios.push({
      title: `Multi-Page Navigation Smoke Test (${topNavPages.length} Discovered Routes)`,
      prompt: stepLines.join('\n'),
      assertionPrompt: `Page ${topNavPages[topNavPages.length - 1].pathname} should render without errors`,
    });
  }

  return scenarios;
}

/**
 * Loads the existing Unified Site Map for a host (if any).
 */
export async function getSiteMapForUrl(
  projectRoot: string,
  targetUrl: string
): Promise<UnifiedSiteMap | null> {
  const hostFile = getHostSessionFilename(targetUrl);
  const mapPath = path.join(projectRoot, '.e2e', 'site-map', hostFile);
  try {
    const raw = await fs.readFile(mapPath, 'utf-8');
    return JSON.parse(raw) as UnifiedSiteMap;
  } catch {
    return null;
  }
}

/**
 * Incrementally merges live-discovered DOM links/elements from a browser test run into the Unified Site Map
 * so links that only appear for specific logged-in users are automatically added without overwriting existing pages.
 */
export async function mergeLiveDiscoveredNodesIntoSiteMap(
  projectRoot: string,
  targetUrl: string,
  livePages: Array<{
    url: string;
    pathname: string;
    title: string;
    elements: ScannedElementInfo[];
  }>
): Promise<void> {
  if (!Array.isArray(livePages) || livePages.length === 0) return;

  let origin = targetUrl.trim();
  try {
    origin = new URL(targetUrl.trim()).origin;
  } catch {}

  const existing = (await getSiteMapForUrl(projectRoot, targetUrl)) || {
    origin,
    updatedAt: new Date().toISOString(),
    pages: {},
    suggestedScenarios: [],
  };

  for (const lp of livePages) {
    if (!lp?.pathname) continue;
    const prevPage = existing.pages[lp.pathname];
    const mergedElements = [...(prevPage?.elements || [])];
    const seenSel = new Set(mergedElements.map((e) => e.selector));

    for (const el of lp.elements || []) {
      if (el?.selector && !seenSel.has(el.selector) && mergedElements.length < 60) {
        seenSel.add(el.selector);
        mergedElements.push(el);
      }
    }

    existing.pages[lp.pathname] = {
      url: lp.url || `${origin}${lp.pathname}`,
      pathname: lp.pathname,
      title: lp.title || prevPage?.title || lp.pathname,
      status: prevPage?.status || 200,
      loadTimeMs: prevPage?.loadTimeMs || 50,
      lastScannedAt: new Date().toISOString(),
      elements: mergedElements,
    };
  }

  existing.updatedAt = new Date().toISOString();
  existing.suggestedScenarios = buildSuggestedScenariosFromSiteMap(existing.pages);

  const hostFile = getHostSessionFilename(targetUrl);
  const mapDir = path.join(projectRoot, '.e2e', 'site-map');
  await fs.mkdir(mapDir, { recursive: true });
  await fs.writeFile(
    path.join(mapDir, hostFile),
    JSON.stringify(existing, null, 2),
    'utf-8'
  );
}

/**
 * Crawls the website starting at `targetUrl` (up to `maxPages`), automatically attaching any saved
 * login session cookies/tokens so user-specific links are discovered, and merges results into `.e2e/site-map/<host>.json`.
 */
export async function scanWebsiteGeneric(
  projectRoot: string,
  targetUrl: string,
  maxPages = 15
): Promise<UnifiedSiteMap> {
  const parsedRoot = new URL(targetUrl.trim());
  const origin = parsedRoot.origin;
  const hostFile = getHostSessionFilename(targetUrl);

  // Load existing site map so we incrementally merge rather than overwrite routes from other user sessions
  const existing = (await getSiteMapForUrl(projectRoot, targetUrl)) || {
    origin,
    updatedAt: new Date().toISOString(),
    pages: {},
    suggestedScenarios: [],
  };

  // Attach any saved session cookies/auth token so authenticated pages are scanned too
  const authHeaders: Record<string, string> = {
    'user-agent': 'QDrive-AutoScanner/1.0',
  };
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
    // scan as public/guest if no saved session yet
  }

  const queue: string[] = [targetUrl.trim()];
  // Also seed queue with any known hrefs already in the site map
  for (const p of Object.values(existing.pages)) {
    for (const el of p.elements) {
      if (el.kind === 'link' && el.href?.startsWith('/')) {
        queue.push(`${origin}${el.href}`);
      }
    }
  }

  const visited = new Set<string>();

  while (queue.length > 0 && visited.size < maxPages) {
    const nextUrl = queue.shift()!;
    let cleanUrl = nextUrl;
    let pathname = '/';
    try {
      const u = new URL(nextUrl, origin);
      if (u.origin !== origin) continue;
      pathname = u.pathname || '/';
      cleanUrl = `${u.origin}${pathname}`;
    } catch {
      continue;
    }

    if (visited.has(cleanUrl)) continue;
    visited.add(cleanUrl);

    const t0 = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(cleanUrl, {
        headers: authHeaders,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const loadTimeMs = Math.max(1, Math.round(performance.now() - t0));
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        continue;
      }

      const html = await res.text();
      const { title, internalUrls, elements } = parseHtmlElementsAndLinks(html, origin);

      for (const discoveredUrl of internalUrls) {
        if (!visited.has(discoveredUrl) && queue.length < maxPages * 2) {
          queue.push(discoveredUrl);
        }
      }

      // Merge with any previously discovered elements on this pathname (e.g., from another logged-in user)
      const prevElements = existing.pages[pathname]?.elements || [];
      const mergedElements = [...prevElements];
      const seenSel = new Set(mergedElements.map((e) => e.selector));
      for (const el of elements) {
        if (!seenSel.has(el.selector) && mergedElements.length < 60) {
          seenSel.add(el.selector);
          mergedElements.push(el);
        }
      }

      existing.pages[pathname] = {
        url: cleanUrl,
        pathname,
        title: title || existing.pages[pathname]?.title || pathname,
        status: res.status,
        loadTimeMs,
        lastScannedAt: new Date().toISOString(),
        elements: mergedElements,
      };
    } catch {
      // ignore unreachable route
    }
  }

  existing.updatedAt = new Date().toISOString();
  existing.suggestedScenarios = buildSuggestedScenariosFromSiteMap(existing.pages);

  const mapDir = path.join(projectRoot, '.e2e', 'site-map');
  await fs.mkdir(mapDir, { recursive: true });
  await fs.writeFile(
    path.join(mapDir, hostFile),
    JSON.stringify(existing, null, 2),
    'utf-8'
  );

  // Also seed harvested-requests with discovered routes so JMeter Load Test (#28) has all site pages ready!
  try {
    const harvestDir = path.join(projectRoot, '.e2e', 'harvested-requests');
    await fs.mkdir(harvestDir, { recursive: true });
    const harvestFile = path.join(harvestDir, hostFile);
    let currentHarvest: Array<{ method: string; url: string }> = [];
    try {
      const rawH = await fs.readFile(harvestFile, 'utf-8');
      currentHarvest = JSON.parse(rawH);
    } catch {}
    const seenH = new Set(currentHarvest.map((x) => `${x.method} ${x.url}`));
    for (const p of Object.values(existing.pages)) {
      const key = `GET ${p.url}`;
      if (!seenH.has(key)) {
        seenH.add(key);
        currentHarvest.push({ method: 'GET', url: p.url });
      }
    }
    await fs.writeFile(harvestFile, JSON.stringify(currentHarvest.slice(-40), null, 2), 'utf-8');
  } catch {
    // ignore
  }

  return existing;
}
