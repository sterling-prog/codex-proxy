// OpenAI Chat Completions API types

// ─── Request ──────────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'function';

export interface ContentPart {
  type: 'text' | 'image_url' | string;
  text?: string;
  image_url?: { url: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: MessageRole;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface StreamOptions {
  include_usage?: boolean;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  stream_options?: StreamOptions;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown;
  tool_choice?: unknown;
  response_format?: unknown;
  functions?: unknown;
  logprobs?: unknown;
  top_p?: number;
  n?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: unknown;
  seed?: number;
  user?: string;
  [key: string]: unknown;
}

// ─── Response ─────────────────────────────────────────────────────────────────

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// Non-streaming response
export interface ChatCompletionMessage {
  role: 'assistant';
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: UsageInfo;
}

// Streaming response chunk
export interface ChatCompletionDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionDelta;
  finish_reason: string | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: UsageInfo;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | number | null;
  };
}

// ─── Models endpoint ─────────────────────────────────────────────────────────

export interface ModelObject {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelObject[];
}
