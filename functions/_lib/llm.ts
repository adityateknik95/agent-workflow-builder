// LLM provider for `llm_call` steps.
//
// Three real providers are supported, all of which have a usable free tier, plus
// a stub for running the project with no API key at all. The stub is deliberately
// honest: it waits, and it marks its result `stubbed: true`, which the UI shows
// on the step. Nothing silently pretends a model was called.
import { config } from './config';
import { fetchWithTimeout, HandlerError } from './http';

export interface LlmRequest {
  prompt: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
}

export interface LlmResult {
  text: string;
  provider: string;
  model: string;
  stubbed: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** 4xx from a provider is a bad request; 429 and 5xx are worth retrying. */
export class LlmError extends HandlerError {
  constructor(message: string, readonly retryable: boolean) {
    super(message, 'llm-call-failed', 502);
    this.name = 'LlmError';
  }
}

const CHAT_COMPLETION_ENDPOINTS: Record<string, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

export async function callLlm(request: LlmRequest): Promise<LlmResult> {
  const provider = config.llm.provider;
  const model = request.model || config.llm.model;

  if (provider === 'stub' || !config.llm.apiKey) {
    return stubCompletion(request, model);
  }
  if (provider === 'gemini') {
    return callGemini(request, model);
  }
  if (provider in CHAT_COMPLETION_ENDPOINTS) {
    return callOpenAiCompatible(provider, CHAT_COMPLETION_ENDPOINTS[provider] as string, request, model);
  }
  throw new HandlerError(`unknown LLM_PROVIDER "${provider}"`, 'misconfigured', 500);
}

// Groq and OpenRouter both speak the OpenAI chat-completions shape.
async function callOpenAiCompatible(
  provider: string,
  endpoint: string,
  request: LlmRequest,
  model: string
): Promise<LlmResult> {
  const messages: { role: string; content: string }[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  messages.push({ role: 'user', content: request.prompt });

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.2,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    },
    30_000
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new LlmError(
      `${provider} returned ${response.status}: ${detail}`,
      response.status === 429 || response.status >= 500
    );
  }

  const body = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = body.choices?.[0]?.message?.content ?? '';
  if (!text) throw new LlmError(`${provider} returned an empty completion`, true);

  return { text, provider, model, stubbed: false, usage: body.usage };
}

async function callGemini(request: LlmRequest, model: string): Promise<LlmResult> {
  const geminiModel = model.startsWith('gemini') ? model : 'gemini-2.0-flash';
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent` +
    `?key=${encodeURIComponent(config.llm.apiKey)}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 512,
          temperature: request.temperature ?? 0.2,
          ...(request.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    },
    30_000
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new LlmError(
      `gemini returned ${response.status}: ${detail}`,
      response.status === 429 || response.status >= 500
    );
  }

  const body = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) throw new LlmError('gemini returned an empty completion', true);

  return { text, provider: 'gemini', model: geminiModel, stubbed: false };
}

/**
 * Offline stand-in. It classifies on keywords so the conditional_branch in the
 * demo workflow has something real to branch on, and it sleeps for ~1.2s so the
 * live subscription visibly shows the step in flight.
 */
async function stubCompletion(request: LlmRequest, model: string): Promise<LlmResult> {
  await new Promise((resolve) => setTimeout(resolve, 900 + Math.floor(Math.random() * 500)));

  const haystack = request.prompt.toLowerCase();
  const urgentSignals = ['urgent', 'asap', 'immediately', 'outage', 'down', 'critical', 'churn', 'escalate'];
  const urgency = urgentSignals.some((signal) => haystack.includes(signal)) ? 'high' : 'low';

  const summary =
    urgency === 'high'
      ? 'Sender reports a blocking problem and expects a same-day response.'
      : 'General enquiry with no time pressure indicated.';

  const payload = {
    urgency,
    summary,
    recommended_action: urgency === 'high' ? 'escalate_to_human' : 'queue_for_digest',
    confidence: urgency === 'high' ? 0.91 : 0.72,
  };

  return {
    text: request.json === false ? summary : JSON.stringify(payload),
    provider: 'stub',
    model: `${model} (stubbed)`,
    stubbed: true,
  };
}
