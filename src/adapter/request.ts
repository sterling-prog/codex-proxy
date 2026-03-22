// Module 2: Request Adapter — Chat Completions → JSON-RPC

import type {
  ThreadStartParams,
  TurnStartParams,
  UserInput,
  ReasoningEffort,
} from '../types/codex.js';
import type { ChatMessage, ChatCompletionRequest } from '../types/openai.js';

const log = {
  debug: (msg: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] === 'debug') {
      console.debug(JSON.stringify({ level: 'debug', msg, ...(data ? data as object : {}) }));
    }
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...(data ? data as object : {}) }));
  },
};

// ─── Known fields (others are silently dropped) ───────────────────────────────

const KNOWN_FIELDS = new Set([
  'model', 'messages', 'stream', 'stream_options', 'temperature', 'max_tokens',
]);

const DROPPED_FIELDS_LOG = new Set([
  'tools', 'tool_choice', 'response_format', 'functions', 'logprobs', 'top_p',
  'n', 'presence_penalty', 'frequency_penalty', 'stop', 'seed', 'user',
]);

// ─── Transcript injection mitigation ─────────────────────────────────────────
// Replace \nAssistant: and \nTool ( in user/tool content to break fake role prefix patterns

function mitigateInjection(content: string): string {
  // Insert zero-width space after the colon in role prefixes found in user content
  return content
    .replace(/\nAssistant:/g, '\nAssistant\u200B:')
    .replace(/\nTool \(/g, '\nTool\u200B (');
}

// ─── Content serialization ────────────────────────────────────────────────────

function serializeContent(content: string | Array<{ type: string; text?: string; image_url?: unknown }> | null): string {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  // Array (multimodal)
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text !== undefined) {
      parts.push(part.text);
    } else if (part.type === 'image_url') {
      parts.push('[image]');
      log.warn('Image content in message — substituting [image] placeholder');
    } else {
      parts.push('[unsupported content type]');
      log.warn('Unsupported content type in message', { type: part.type });
    }
  }
  return parts.join('\n');
}

// ─── Main adapter ────────────────────────────────────────────────────────────

export interface AdaptedRequest {
  threadParams: ThreadStartParams;
  turnParams: Omit<TurnStartParams, 'threadId'>;
  stream: boolean;
}

export function adaptRequest(
  body: ChatCompletionRequest,
  modelCache: string[],
  defaultModel: string,
  defaultEffort: ReasoningEffort,
): AdaptedRequest {
  // Log dropped fields
  for (const key of Object.keys(body)) {
    if (!KNOWN_FIELDS.has(key)) {
      if (DROPPED_FIELDS_LOG.has(key)) {
        log.debug('Dropping unknown request field', { field: key });
      } else {
        log.debug('Dropping unrecognized request field', { field: key });
      }
    }
  }

  if (body.temperature !== undefined) {
    log.debug('Dropping temperature (not supported by TurnStartParams)');
  }
  if (body.max_tokens !== undefined) {
    log.debug('Dropping max_tokens (not supported by TurnStartParams)');
  }

  const messages: ChatMessage[] = body.messages ?? [];

  // Validate
  if (messages.length === 0) {
    throw Object.assign(new Error('messages must contain at least one non-system message'), { httpStatus: 400 });
  }

  const nonSystemMessages = messages.filter(m => m.role !== 'system');
  if (nonSystemMessages.length === 0) {
    throw Object.assign(new Error('messages must contain at least one non-system message'), { httpStatus: 400 });
  }

  // Extract system messages → baseInstructions
  const systemMessages = messages.filter(m => m.role === 'system');
  const baseInstructions = systemMessages.length > 0
    ? systemMessages.map(m => serializeContent(m.content as string | null)).join('\n\n')
    : undefined;

  // Resolve model
  const requestedModel = body.model ?? defaultModel;
  if (modelCache.length > 0 && !modelCache.includes(requestedModel)) {
    throw Object.assign(
      new Error(`Model '${requestedModel}' is not available. Available models: ${modelCache.join(', ')}`),
      { httpStatus: 400 },
    );
  }

  // Build transcript from non-system messages
  const transcript = buildTranscript(nonSystemMessages);

  const input: UserInput[] = [{
    type: 'text',
    text: transcript,
    text_elements: [],
  }];

  const stream = body.stream ?? false;

  const threadParams: ThreadStartParams = {
    ephemeral: true,
    approvalPolicy: 'untrusted',
    sandbox: 'danger-full-access',
    cwd: '/tmp/codex-proxy',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    ...(baseInstructions !== undefined ? { baseInstructions } : {}),
  };

  const turnParams: Omit<TurnStartParams, 'threadId'> = {
    input,
    model: requestedModel,
    effort: defaultEffort,
  };

  return { threadParams, turnParams, stream };
}

// ─── Transcript builder ───────────────────────────────────────────────────────

function buildTranscript(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  const lastIndex = messages.length - 1;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === lastIndex;

    if (i === 0) {
      if (messages.length === 1) {
        lines.push('[Current request]');
      } else {
        lines.push('[Previous conversation context]');
      }
    } else if (isLast && messages.length > 1) {
      lines.push('[Current request]');
    }

    const role = msg.role;

    if (role === 'assistant') {
      // Handle tool_calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          lines.push(`Assistant: [called tool: ${tc.function.name}(${tc.function.arguments})]`);
        }
        // content may be null when tool_calls is present — omit if null/empty
        if (msg.content !== null && msg.content !== '') {
          const text = serializeContent(msg.content as string | null);
          if (text) lines.push(`Assistant: ${text}`);
        }
      } else {
        const text = serializeContent(msg.content as string | null);
        lines.push(`Assistant: ${text}`);
      }
    } else if (role === 'tool' || role === 'function') {
      const toolName = msg.name ?? 'unknown';
      const rawContent = serializeContent(msg.content as string | null);
      const content = mitigateInjection(rawContent);
      lines.push(`Tool (${toolName}): ${content}`);
    } else if (role === 'user') {
      const rawContent = serializeContent(msg.content as string | null);
      const content = mitigateInjection(rawContent);
      lines.push(`User: ${content}`);
    } else {
      // Unknown role — skip with debug log
      log.debug('Unknown message role in transcript, skipping', { role });
    }
  }

  return lines.join('\n');
}
