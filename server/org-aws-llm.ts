import crypto from 'node:crypto';
import type { OrgAwsConfig } from '../src/types.js';

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Signs an HTTP request using AWS Signature Version 4 (SigV4).
 * Works with permanent IAM keys or temporary SSO / STS credentials (with SessionToken).
 */
export function signAwsSigV4Request(params: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}): Record<string, string> {
  const parsedUrl = new URL(params.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(params.headers)) {
    if (v !== undefined && v !== null) {
      outHeaders[k.toLowerCase()] = String(v).trim();
    }
  }

  outHeaders['host'] = parsedUrl.host;
  outHeaders['x-amz-date'] = amzDate;
  if (params.sessionToken?.trim()) {
    outHeaders['x-amz-security-token'] = params.sessionToken.trim();
  }

  const payloadHash = sha256Hex(params.body || '');
  outHeaders['x-amz-content-sha256'] = payloadHash;

  const sortedHeaderKeys = Object.keys(outHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${outHeaders[k].replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  // AWS Bedrock model IDs in path may contain colons (e.g. anthropic.claude-3-5-sonnet-20241022-v2:0)
  const canonicalUri = parsedUrl.pathname
    .split('/')
    .map((seg) => encodeRfc3986(decodeURIComponent(seg)))
    .join('/');

  const queryPairs: Array<[string, string]> = [];
  parsedUrl.searchParams.forEach((v, k) => {
    queryPairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
  });
  queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQueryString = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const canonicalRequest = [
    params.method.toUpperCase(),
    canonicalUri || '/',
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${params.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  outHeaders['authorization'] =
    `${algorithm} Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return outHeaders;
}

/**
 * Parses optional custom headers JSON from the UI/env safely.
 */
export function parseCustomHeaders(customHeadersJson?: string): Record<string, string> {
  if (!customHeadersJson?.trim()) return {};
  try {
    const parsed = JSON.parse(customHeadersJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== undefined && v !== null) {
          headers[String(k).trim()] = String(v);
        }
      }
      return headers;
    }
  } catch {
    // ignore malformed JSON
  }
  return {};
}

/**
 * Builds authentication headers for Token/Bearer mode.
 */
export function buildOrgTokenHeaders(config: {
  authToken?: string;
  authHeaderName?: string;
  customHeadersJson?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    ...parseCustomHeaders(config.customHeadersJson),
  };
  const token = config.authToken?.trim() || '';
  if (token) {
    const headerName = (config.authHeaderName || 'Authorization').trim();
    if (headerName.toLowerCase() === 'authorization') {
      headers['Authorization'] = /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
    } else {
      headers[headerName] = token;
    }
  }
  return headers;
}

/**
 * Converts an OpenAI `/v1/chat/completions` request payload into an AWS Bedrock Converse API payload,
 * supporting system messages, user/assistant messages, base64 images (vision), and tool definitions.
 */
function convertOpenAiBodyToBedrockConverse(openAiBody: Record<string, any>): Record<string, any> {
  const messages = Array.isArray(openAiBody.messages) ? openAiBody.messages : [];
  const systemPrompts: Array<{ text: string }> = [];
  const converseMessages: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === 'system' || msg.role === 'developer') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((p: any) => p.text || '').join('\n')
            : '';
      if (text.trim()) {
        systemPrompts.push({ text: text.trim() });
      }
      continue;
    }

    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user';
    const contentBlocks: any[] = [];

    if (typeof msg.content === 'string') {
      if (msg.content.trim()) {
        contentBlocks.push({ text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part) continue;
        if (part.type === 'text' && part.text) {
          contentBlocks.push({ text: String(part.text) });
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const urlStr = String(part.image_url.url);
          const match = urlStr.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i);
          if (match) {
            const rawFormat = match[1].toLowerCase();
            const format = rawFormat === 'jpg' ? 'jpeg' : rawFormat;
            const bytesBase64 = match[2];
            contentBlocks.push({
              image: {
                format,
                source: {
                  bytes: Array.from(Buffer.from(bytesBase64, 'base64')),
                },
              },
            });
          }
        }
      }
    }

    if (msg.role === 'tool' && msg.content) {
      contentBlocks.push({
        text: `[Tool Result ${msg.tool_call_id || ''}]: ${typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}`,
      });
    }

    if (contentBlocks.length > 0) {
      // Merge consecutive messages of the same role as required by Bedrock Converse
      const prev = converseMessages[converseMessages.length - 1];
      if (prev && prev.role === role) {
        prev.content.push(...contentBlocks);
      } else {
        converseMessages.push({ role, content: contentBlocks });
      }
    }
  }

  const inferenceConfig: Record<string, any> = {};
  if (typeof openAiBody.max_tokens === 'number') {
    inferenceConfig.maxTokens = openAiBody.max_tokens;
  } else if (typeof openAiBody.max_completion_tokens === 'number') {
    inferenceConfig.maxTokens = openAiBody.max_completion_tokens;
  } else {
    inferenceConfig.maxTokens = 2048;
  }
  if (typeof openAiBody.temperature === 'number') {
    inferenceConfig.temperature = openAiBody.temperature;
  }

  const payload: Record<string, any> = {
    messages:
      converseMessages.length > 0
        ? converseMessages
        : [{ role: 'user', content: [{ text: 'Hello' }] }],
    inferenceConfig,
  };

  if (systemPrompts.length > 0) {
    payload.system = systemPrompts;
  }

  return payload;
}

/**
 * Custom `fetch` implementation for `@ai-sdk/openai-compatible` or `@ai-sdk/anthropic`
 * that handles:
 * 1. AWS SigV4 signing (when `authType === 'aws-iam-sigv4'`)
 * 2. Custom Organization Bearer/API tokens & headers
 * 3. Direct AWS Bedrock Converse API translation (when `connectionType === 'aws-bedrock'`)
 */
export function createOrgAwsFetch(config: OrgAwsConfig): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || 'POST').toUpperCase();
    const rawBody =
      typeof init?.body === 'string'
        ? init.body
        : init?.body
          ? Buffer.from(init.body as ArrayBuffer).toString('utf-8')
          : '';

    const baseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      ...buildOrgTokenHeaders(config),
    };

    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        // Don't overwrite custom auth header with dummy 'org-aws-token' placeholder
        if (k.toLowerCase() === 'authorization' && v.includes('org-aws-placeholder')) {
          return;
        }
        baseHeaders[k.toLowerCase()] = v;
      });
    }

    // Mode C: Direct AWS Bedrock Runtime (Converse API)
    if (config.connectionType === 'aws-bedrock' && rawUrl.includes('/chat/completions')) {
      const region = (config.awsRegion || 'us-east-1').trim();
      const parsedBody = rawBody ? JSON.parse(rawBody) : {};
      const modelId = (parsedBody.model || config.model || 'anthropic.claude-3-5-sonnet-20241022-v2:0').trim();

      const bedrockBase = config.endpointUrl?.trim()
        ? config.endpointUrl.trim().replace(/\/+$/, '')
        : `https://bedrock-runtime.${region}.amazonaws.com`;

      const bedrockUrl = `${bedrockBase}/model/${encodeURIComponent(modelId)}/converse`;

      // Convert byte arrays in image blocks to base64 strings for JSON serialization over HTTP
      const converseObj = convertOpenAiBodyToBedrockConverse(parsedBody);
      for (const m of converseObj.messages || []) {
        for (const c of m.content || []) {
          if (c.image?.source?.bytes && Array.isArray(c.image.source.bytes)) {
            c.image.source.bytes = Buffer.from(c.image.source.bytes).toString('base64');
          }
        }
      }
      const bedrockBodyStr = JSON.stringify(converseObj);

      let finalHeaders = { ...baseHeaders };
      if (config.authType === 'aws-iam-sigv4') {
        delete finalHeaders['authorization'];
        finalHeaders = signAwsSigV4Request({
          method: 'POST',
          url: bedrockUrl,
          headers: finalHeaders,
          body: bedrockBodyStr,
          accessKeyId: (config.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '').trim(),
          secretAccessKey: (config.awsSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
          sessionToken: (config.awsSessionToken || process.env.AWS_SESSION_TOKEN || '').trim() || undefined,
          region,
          service: 'bedrock',
        });
      }

      const bedrockRes = await globalThis.fetch(bedrockUrl, {
        method: 'POST',
        headers: finalHeaders,
        body: bedrockBodyStr,
      });

      if (!bedrockRes.ok) {
        const errText = await bedrockRes.text();
        return new Response(
          JSON.stringify({
            error: {
              message: `AWS Bedrock Error (${bedrockRes.status}): ${errText}`,
              type: 'aws_bedrock_error',
              code: String(bedrockRes.status),
            },
          }),
          {
            status: bedrockRes.status,
            headers: { 'content-type': 'application/json' },
          }
        );
      }

      const bedrockData = (await bedrockRes.json()) as Record<string, any>;
      const contentParts = bedrockData?.output?.message?.content || [];
      const textOut = contentParts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');

      const openAiCompatResponse = {
        id: `bedrock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: textOut,
            },
            finish_reason: bedrockData.stopReason === 'max_tokens' ? 'length' : 'stop',
          },
        ],
        usage: {
          prompt_tokens: bedrockData?.usage?.inputTokens ?? 0,
          completion_tokens: bedrockData?.usage?.outputTokens ?? 0,
          total_tokens: bedrockData?.usage?.totalTokens ?? 0,
        },
      };

      return new Response(JSON.stringify(openAiCompatResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Mode A or B: Internal AWS Gateway (OpenAI-Compatible or Anthropic-Compatible)
    let requestHeaders = { ...baseHeaders };
    if (config.authType === 'aws-iam-sigv4') {
      const region = (config.awsRegion || process.env.AWS_REGION || 'us-east-1').trim();
      const service = rawUrl.includes('bedrock')
        ? 'bedrock'
        : rawUrl.includes('sagemaker')
          ? 'sagemaker'
          : 'execute-api';
      delete requestHeaders['authorization'];
      requestHeaders = signAwsSigV4Request({
        method,
        url: rawUrl,
        headers: requestHeaders,
        body: rawBody,
        accessKeyId: (config.awsAccessKeyId || process.env.AWS_ACCESS_KEY_ID || '').trim(),
        secretAccessKey: (config.awsSecretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
        sessionToken: (config.awsSessionToken || process.env.AWS_SESSION_TOKEN || '').trim() || undefined,
        region,
        service,
      });
    }

    return globalThis.fetch(rawUrl, {
      ...init,
      method,
      headers: requestHeaders,
      body: rawBody || undefined,
    });
  };
}

/**
 * Reads `OrgAwsConfig` from environment variables passed into the child runner process (`e2e.config.ts`).
 */
export function getOrgAwsConfigFromEnv(): OrgAwsConfig | null {
  if (process.env.E2E_ORG_AWS_ENABLED !== 'true') {
    return null;
  }
  return {
    enabled: true,
    connectionType:
      (process.env.E2E_ORG_AWS_CONNECTION_TYPE as OrgAwsConfig['connectionType']) ||
      'aws-gateway-openai',
    authType:
      (process.env.E2E_ORG_AWS_AUTH_TYPE as OrgAwsConfig['authType']) || 'bearer-token',
    endpointUrl: process.env.E2E_ORG_AWS_ENDPOINT_URL || '',
    model: process.env.E2E_ORG_AWS_MODEL || process.env.E2E_LLM_MODEL || '',
    authToken: process.env.E2E_ORG_AWS_TOKEN || '',
    authHeaderName: process.env.E2E_ORG_AWS_AUTH_HEADER || 'Authorization',
    customHeadersJson: process.env.E2E_ORG_AWS_CUSTOM_HEADERS || '',
    awsRegion: process.env.AWS_REGION || 'us-east-1',
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    awsSessionToken: process.env.AWS_SESSION_TOKEN || '',
    allowSelfSignedCerts: process.env.E2E_ORG_AWS_ALLOW_SELF_SIGNED === 'true',
  };
}

/**
 * Tests the Organization AWS Hosted Model connection with a fast ping prompt.
 */
export async function testOrgAwsConnection(
  config: OrgAwsConfig
): Promise<{ ok: boolean; message: string; model?: string; reply?: string }> {
  if (config.allowSelfSignedCerts) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const modelName = config.model?.trim();
  if (!modelName) {
    return { ok: false, message: 'Model ID / Deployment Name is required.' };
  }

  if (
    config.connectionType !== 'aws-bedrock' &&
    !config.endpointUrl?.trim()
  ) {
    return {
      ok: false,
      message: 'Internal AWS Endpoint Base URL is required for Gateway mode.',
    };
  }

  try {
    const customFetch = createOrgAwsFetch(config);

    if (config.connectionType === 'aws-gateway-anthropic') {
      const base = config.endpointUrl.trim().replace(/\/+$/, '');
      const url = base.endsWith('/messages')
        ? base
        : base.endsWith('/v1')
          ? `${base}/messages`
          : `${base}/v1/messages`;

      const res = await customFetch(url, {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 24,
          messages: [{ role: 'user', content: 'Reply with: ORG_AWS_OK' }],
        }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        return {
          ok: false,
          message: `HTTP ${res.status}: ${errBody.slice(0, 240)}`,
        };
      }
      const data = (await res.json()) as any;
      const reply = data?.content?.[0]?.text || 'Connected';
      return {
        ok: true,
        model: modelName,
        reply: String(reply).trim().slice(0, 80),
        message: `Connected to "${modelName}" (${String(reply).trim().slice(0, 50)})`,
      };
    }

    // OpenAI-Compatible Gateway OR Direct AWS Bedrock (translated via customFetch)
    const base =
      config.connectionType === 'aws-bedrock'
        ? 'https://bedrock-runtime.local/v1'
        : config.endpointUrl.trim().replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;

    const res = await customFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        max_tokens: 24,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with: ORG_AWS_OK' }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return {
        ok: false,
        message: `HTTP ${res.status}: ${errBody.slice(0, 240)}`,
      };
    }

    const data = (await res.json()) as any;
    const reply = data?.choices?.[0]?.message?.content || 'Connected';
    return {
      ok: true,
      model: modelName,
      reply: String(reply).trim().slice(0, 80),
      message: `Connected to "${modelName}" (${String(reply).trim().slice(0, 50)})`,
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message,
    };
  }
}
