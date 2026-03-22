// Module 3: Response Adapter — JSON-RPC → Chat Completions
// This module provides helper functions used by app-server.ts handlers

import type { Response } from 'express';
import type { InFlightRequest, CleanupResult } from '../client/app-server.js';

const log = {
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...(data ? data as object : {}) }));
  },
  debug: (msg: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] === 'debug') {
      console.debug(JSON.stringify({ level: 'debug', msg, ...(data ? data as object : {}) }));
    }
  },
};

// ─── SSE helpers ─────────────────────────────────────────────────────────────

export function writeSSEChunk(res: Response, data: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // ignore write errors
  }
}

export function writeSSEDone(res: Response): void {
  try {
    res.write('data: [DONE]\n\n');
    res.end();
  } catch {
    // ignore
  }
}

export function writeSSEKeepalive(res: Response): void {
  try {
    res.write(': keepalive\n\n');
  } catch {
    // ignore
  }
}

export function commitSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

// ─── Error response helpers ───────────────────────────────────────────────────

export function sendSSEError(inflight: InFlightRequest, httpStatus: number, message: string, errorType: string): void {
  if (inflight.responseSent || inflight.cleanupDone) return;

  // If headers not committed, commit them now (always SSE for stream:true)
  if (!inflight.headersCommitted) {
    commitSSEHeaders(inflight.res);
    inflight.headersCommitted = true;
  }

  const errorChunk = {
    error: {
      message,
      type: errorType,
      code: String(httpStatus),
    },
  };
  writeSSEChunk(inflight.res, errorChunk);
  writeSSEDone(inflight.res);
  inflight.responseSent = true;
}

export function sendHTTPError(
  inflight: InFlightRequest,
  httpStatus: number,
  message: string,
  errorType = 'upstream_error',
  code: string | number | null = null,
): void {
  if (inflight.responseSent || inflight.cleanupDone) return;
  try {
    inflight.res.status(httpStatus).json({
      error: { message, type: errorType, code },
    });
  } catch {
    // ignore
  }
  inflight.responseSent = true;
  inflight.headersCommitted = true;
}

// ─── Response dispatch (used by cleanup function) ─────────────────────────────

export function dispatchCleanupResponse(
  inflight: InFlightRequest,
  result: CleanupResult,
): void {
  if (inflight.responseSent) return;

  if (result.type === 'success') {
    // Success responses are sent by the turn/completed handlers inline
    // If somehow we get here without responseSent, send empty success
    if (inflight.stream) {
      sendSSEError(inflight, 200, 'Response already sent', 'server_error');
    }
    return;
  }

  const { httpStatus, message, errorType, code } = result as {
    type: 'error';
    httpStatus: number;
    message: string;
    errorType?: string;
    code?: string | number | null;
  };

  if (inflight.stream) {
    // For streaming, always use SSE format
    sendSSEError(inflight, httpStatus, message, errorType ?? 'upstream_error');
  } else {
    // For non-streaming, use HTTP status
    sendHTTPError(inflight, httpStatus, message, errorType ?? 'upstream_error', code ?? null);
  }
}

// ─── Retry-After headers ──────────────────────────────────────────────────────

export function addRetryAfterHeader(res: Response, httpStatus: number, seconds = 60): void {
  if (httpStatus === 429 || httpStatus === 503) {
    res.setHeader('Retry-After', String(seconds));
  }
}
