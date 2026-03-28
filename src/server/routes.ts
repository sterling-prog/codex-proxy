// Module 4: Express HTTP handlers

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { rateLimit } from 'express-rate-limit';
import { AppServerClient, InFlightRequest, CleanupResult } from '../client/app-server.js';
import { adaptRequest } from '../adapter/request.js';
import { dispatchCleanupResponse, addRetryAfterHeader } from '../adapter/response.js';
import type { ReasoningEffort } from '../types/codex.js';

const log = {
  debug: (msg: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] === 'debug') {
      console.debug(JSON.stringify({ level: 'debug', msg, ...(data ? data as object : {}) }));
    }
  },
  info: (msg: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'info', msg, ...(data ? data as object : {}) }));
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...(data ? data as object : {}) }));
  },
  error: (msg: string, data?: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg, ...(data ? data as object : {}) }));
  },
};

// ─── Cleanup function (CRITICAL — guards all teardown actions) ───────────────

async function cleanup(
  inflight: InFlightRequest,
  result: CleanupResult,
  client: AppServerClient,
): Promise<void> {
  if (inflight.cleanupDone) {
    log.debug('cleanup already done', { requestId: inflight.requestId });
    return;
  }
  inflight.cleanupDone = true;

  const startTime = inflight.created * 1000;
  const latency = Date.now() - startTime;

  // 1. Send HTTP response (if not already sent)
  if (!inflight.responseSent) {
    if (result.type === 'success') {
      // Success was sent inline by the turn/completed handler — shouldn't reach here
      log.warn('Success cleanup without responseSent', { requestId: inflight.requestId });
    } else {
      const errorResult = result as { type: 'error'; httpStatus: number; message: string; errorType?: string; code?: string | number | null };

      // Add Retry-After for 429/503
      if (errorResult.httpStatus === 429 || errorResult.httpStatus === 503) {
        try {
          addRetryAfterHeader(inflight.res, errorResult.httpStatus);
        } catch {
          // ignore
        }
      }

      dispatchCleanupResponse(inflight, result);
    }
  }

  // 2. Clear all timers
  if (inflight.keepaliveTimer) { clearInterval(inflight.keepaliveTimer); inflight.keepaliveTimer = null; }
  if (inflight.requestTimeout) { clearTimeout(inflight.requestTimeout); inflight.requestTimeout = null; }
  if (inflight.gracePeriodTimer) { clearTimeout(inflight.gracePeriodTimer); inflight.gracePeriodTimer = null; }
  if (inflight.deltaBufferTimeout) { clearTimeout(inflight.deltaBufferTimeout); inflight.deltaBufferTimeout = null; }

  // Log request completion
  const isError = result.type === 'error';
  const errorResult = isError ? result as { type: 'error'; httpStatus: number; message: string } : null;
  log.info('Request completed', {
    requestId: inflight.requestId,
    model: inflight.model,
    prompt_tokens: inflight.promptTokens,
    completion_tokens: inflight.completionTokens,
    latency_ms: latency,
    status: isError ? errorResult!.httpStatus : 200,
    ...(isError ? { error: errorResult!.message } : {}),
  });

  // Check if we should skip archive (thread/closed case)
  const skipArchive = (result as Record<string, unknown>)['_skipArchive'] === true;

  // 3. Archive thread (if threadId exists) — in try/catch
  // 4+5. Remove from in-flight map + release slot — in finally (ALWAYS executes)
  try {
    if (inflight.threadId && !skipArchive) {
      await client.archiveThread(inflight.threadId);
      log.debug('Thread archived', { threadId: inflight.threadId, requestId: inflight.requestId });
    }
  } catch (err) {
    log.warn('Thread archive failed', { threadId: inflight.threadId, requestId: inflight.requestId, error: String(err) });
  } finally {
    // 4. Remove from in-flight map
    client.removeInFlightRequest(inflight.threadId);
    // 5. Release concurrency slot
    client.releaseSlot();
  }
}

// ─── Route builder ────────────────────────────────────────────────────────────

export function buildRouter(client: AppServerClient): Router {
  const router = Router();

  // Wire cleanup callback
  client.onCleanup = (inflight: InFlightRequest, result: CleanupResult) =>
    cleanup(inflight, result, client);

  const defaultModel = process.env['CODEX_DEFAULT_MODEL'] ?? 'gpt-4o';
  const defaultEffort = (process.env['CODEX_DEFAULT_EFFORT'] ?? 'medium') as ReasoningEffort;
  const proxyApiKey = process.env['CODEX_PROXY_API_KEY']!;
  const proxyTimeoutMs = parseInt(process.env['CODEX_PROXY_TIMEOUT_MS'] ?? '900000', 10);
  const rateLimitMax = parseInt(process.env['CODEX_PROXY_RATE_LIMIT'] ?? '60', 10);

  // ─── Rate limiter (global, not per-IP) ─────────────────────────────────────
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    // No keyGenerator — global limit
    keyGenerator: () => 'global',
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_error',
          code: '429',
        },
      });
    },
  });

  router.use(limiter);

  // ─── CORS ──────────────────────────────────────────────────────────────────
  // Restrict to localhost origins only — this proxy is local-only
  router.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    next();
  });

  router.options('*', (_req: Request, res: Response) => {
    res.sendStatus(204);
  });

  // ─── x-request-id on every response ──────────────────────────────────────
  router.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = (req.headers['x-request-id'] as string) ?? uuidv4();
    res.setHeader('x-request-id', requestId);
    (req as Request & { requestId?: string }).requestId = requestId;
    next();
  });

  // ─── Bearer token auth ────────────────────────────────────────────────────
  router.use((req: Request, res: Response, next: NextFunction) => {
    // Skip auth for health endpoints
    if (req.path === '/healthz' || req.path === '/readyz' || req.path === '/health') {
      return next();
    }
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: { message: 'Missing Bearer token', type: 'auth_error', code: null } });
    }
    const token = authHeader.slice(7);
    if (token !== proxyApiKey) {
      return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error', code: null } });
    }
    next();
  });

  // ─── GET /healthz — liveness (always 200) ────────────────────────────────
  router.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // ─── GET /readyz and /health — readiness ─────────────────────────────────
  const readinessHandler = (_req: Request, res: Response) => {
    const stats = client.stats();
    const ready = stats.connected && !stats.authDegraded && !stats.backendDegraded;

    if (!ready) {
      const reasons: string[] = [];
      if (!stats.connected) reasons.push('WebSocket disconnected');
      if (stats.authDegraded) reasons.push('Auth degraded — manual re-auth required');
      if (stats.backendDegraded) reasons.push('Backend degraded — too many consecutive failures');
      return res.status(503).json({ status: 'not_ready', reasons, stats });
    }

    res.status(200).json({ status: 'ready', stats });
  };

  router.get('/readyz', readinessHandler);
  router.get('/health', readinessHandler);

  // ─── GET /v1/models ───────────────────────────────────────────────────────
  router.get('/v1/models', (_req: Request, res: Response) => {
    const models = client.getModelCache();
    const data = models.map(m => ({
      id: m.model, // Use Model.model (NOT Model.id)
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'openai',
    }));
    res.json({ object: 'list', data });
  });

  // ─── POST /v1/chat/completions ────────────────────────────────────────────
  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const requestId = (req as Request & { requestId?: string }).requestId ?? uuidv4();

    // Check readiness
    const stats = client.stats();
    if (stats.authDegraded) {
      return res.status(503).json({
        error: {
          message: 'Auth expired — manual re-auth required',
          type: 'auth_error',
          code: '503',
        },
      });
    }

    // Try to acquire a concurrency slot immediately
    const hasSlot = client.tryAcquireSlot();

    if (!hasSlot) {
      // Try to queue
      const queueEntry = client.enqueue(
        () => processRequest(req, res, requestId),
        (reason: string) => {
          // Queue timeout or cancelled
          if (!res.headersSent) {
            res.setHeader('Retry-After', '10');
            res.status(503).json({
              error: {
                message: reason,
                type: 'server_error',
                code: '503',
              },
            });
          }
        },
      );

      if (!queueEntry) {
        // Queue full
        res.setHeader('Retry-After', '5');
        return res.status(503).json({
          error: {
            message: 'Queue full — retry later',
            type: 'server_error',
            code: '503',
          },
        });
      }

      // Handle client disconnect while queued
      req.on('close', () => {
        if (!queueEntry.dequeued) {
          queueEntry.removeFromQueue();
          log.debug('Queued request cancelled due to client disconnect', { requestId });
        }
      });

      return; // Will be processed when dequeued
    }

    // Has slot — process immediately
    processRequest(req, res, requestId);
  });

  // ─── Inner request processor ──────────────────────────────────────────────
  const consecutiveFailures_ref = { count: 0 };

  async function processRequest(req: Request, res: Response, requestId: string): Promise<void> {
    let inflight: InFlightRequest | null = null;

    try {
      // Parse and validate request
      const body = req.body as Record<string, unknown>;
      const modelCache = client.getModelCache().map(m => m.model);

      let adapted: ReturnType<typeof adaptRequest>;
      try {
        adapted = adaptRequest(body as Parameters<typeof adaptRequest>[0], modelCache, defaultModel, defaultEffort);
      } catch (err) {
        const e = err as Error & { httpStatus?: number };
        const status = e.httpStatus ?? 400;
        client.releaseSlot();
        return res.status(status).json({
          error: { message: e.message, type: 'invalid_request_error', code: null },
        }) as unknown as void;
      }

      const { threadParams, turnParams, stream } = adapted;

      // thread/start
      let threadId: string;
      let threadModel: string;
      try {
        const result = await client.startThread(threadParams);
        threadId = result.threadId;
        threadModel = result.model;
      } catch (err) {
        const e = err as Error & { code?: number };
        let httpStatus = 502;
        if (e.code === -32602) httpStatus = 400;
        client.releaseSlot();

        if (stream) {
          // Still use SSE format for consistency
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('x-request-id', requestId);
          res.flushHeaders();
          const errChunk = { error: { message: e.message, type: 'upstream_error', code: String(httpStatus) } };
          res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.status(httpStatus).json({ error: { message: e.message, type: 'upstream_error', code: null } });
        }
        return;
      }

      // Create in-flight request
      inflight = client.createInFlightRequest({
        threadId,
        req,
        res,
        stream,
        model: threadModel,
        requestId,
        consecutiveFailures_ref,
      });

      // Set response headers
      res.setHeader('x-request-id', requestId);

      // Start request timeout (starts on dequeue, not arrival)
      inflight.requestTimeout = setTimeout(() => {
        if (!inflight!.cleanupDone) {
          log.warn('Request timeout', { requestId, threadId });
          cleanup(inflight!, {
            type: 'error',
            httpStatus: 504,
            message: 'Request timeout',
            errorType: 'timeout_error',
          }, client).catch(err => log.error('Cleanup error on timeout', { error: String(err) }));
        }
      }, proxyTimeoutMs);

      // Handle client disconnect
      req.on('close', () => {
        if (inflight && !inflight.cleanupDone) {
          log.debug('Client disconnected', { requestId, threadId });
          // Interrupt if we have a turnId
          const doInterrupt = async () => {
            if (inflight!.turnId) {
              try {
                await client.interruptTurn(threadId, inflight!.turnId);
              } catch (err) {
                log.warn('turn/interrupt failed on client disconnect', { error: String(err) });
              }
            }
            cleanup(inflight!, { type: 'disconnect' }, client).catch(err =>
              log.error('Cleanup error on client disconnect', { error: String(err) })
            );
          };
          doInterrupt().catch(err => log.error('Interrupt error', { error: String(err) }));
        }
      });

      // If streaming, set up keepalive
      if (stream) {
        // Keepalive will be started on first delta in app-server.ts
        // But we set up the structure here
      }

      // turn/start (threadId registered BEFORE this call in startTurn)
      await client.startTurn(inflight, {
        threadId,
        ...turnParams,
      });

    } catch (err) {
      // Unexpected error in processing
      if (inflight) {
        cleanup(inflight, {
          type: 'error',
          httpStatus: 502,
          message: (err as Error).message,
          errorType: 'upstream_error',
        }, client).catch(e => log.error('Cleanup error', { error: String(e) }));
      } else {
        // No inflight created yet — release slot and respond
        client.releaseSlot();
        if (!res.headersSent) {
          res.status(502).json({ error: { message: (err as Error).message, type: 'upstream_error', code: null } });
        }
      }
    }
  }

  return router;
}
