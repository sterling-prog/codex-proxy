// Entry point — env validation, startup, graceful shutdown

import express, { Request, Response, NextFunction } from 'express';
import { mkdirSync } from 'fs';
import { AppServerClient } from '../client/app-server.js';
import { buildRouter } from './routes.js';

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = {
  info: (msg: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'info', msg, ...(data ? data as object : {}), timestamp: new Date().toISOString() }));
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...(data ? data as object : {}), timestamp: new Date().toISOString() }));
  },
  error: (msg: string, data?: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg, ...(data ? data as object : {}), timestamp: new Date().toISOString() }));
  },
};

// ─── Environment variable validation ─────────────────────────────────────────

function validateEnv(): {
  port: number;
  appServerUrl: string;
  apiKey: string;
  maxConcurrent: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  proxyTimeoutMs: number;
  rateLimit: number;
  orphanSweepIntervalMs: number;
  degradationThreshold: number;
  defaultModel: string;
  defaultEffort: string;
} {
  const errors: string[] = [];

  // CODEX_PROXY_API_KEY — required
  const apiKey = process.env['CODEX_PROXY_API_KEY'];
  if (!apiKey) {
    errors.push('CODEX_PROXY_API_KEY must be set (non-empty)');
  }

  // CODEX_APP_SERVER_URL — must start with ws:// or wss://
  const appServerUrl = process.env['CODEX_APP_SERVER_URL'] ?? 'ws://127.0.0.1:3461';
  if (!appServerUrl.startsWith('ws://') && !appServerUrl.startsWith('wss://')) {
    errors.push(`CODEX_APP_SERVER_URL must start with ws:// or wss:// (got: ${appServerUrl})`);
  }

  // Numeric vars
  function parsePositiveInt(name: string, defaultVal: number): number {
    const raw = process.env[name];
    if (raw === undefined) return defaultVal;
    const val = parseInt(raw, 10);
    if (isNaN(val) || val <= 0) {
      errors.push(`${name} must be a positive integer (got: ${raw})`);
      return defaultVal;
    }
    return val;
  }

  const port = parsePositiveInt('CODEX_PROXY_PORT', 3460);
  const maxConcurrent = parsePositiveInt('CODEX_MAX_CONCURRENT', 5);
  const maxQueueDepth = parsePositiveInt('CODEX_MAX_QUEUE_DEPTH', 20);
  const queueTimeoutMs = parsePositiveInt('CODEX_QUEUE_TIMEOUT_MS', 120000);
  const proxyTimeoutMs = parsePositiveInt('CODEX_PROXY_TIMEOUT_MS', 900000);
  const rateLimit = parsePositiveInt('CODEX_PROXY_RATE_LIMIT', 60);
  const orphanSweepIntervalMs = parsePositiveInt('CODEX_ORPHAN_SWEEP_INTERVAL_MS', 900000);
  const degradationThreshold = parsePositiveInt('CODEX_DEGRADATION_THRESHOLD', 5);

  if (errors.length > 0) {
    log.error('Environment variable validation failed', { errors });
    process.exit(1);
  }

  const defaultModel = process.env['CODEX_DEFAULT_MODEL'] ?? 'gpt-4o';
  const defaultEffort = process.env['CODEX_DEFAULT_EFFORT'] ?? 'medium';

  return {
    port,
    appServerUrl,
    apiKey: apiKey!,
    maxConcurrent,
    maxQueueDepth,
    queueTimeoutMs,
    proxyTimeoutMs,
    rateLimit,
    orphanSweepIntervalMs,
    degradationThreshold,
    defaultModel,
    defaultEffort,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = validateEnv();

  // Create /tmp/codex-proxy before accepting requests
  mkdirSync('/tmp/codex-proxy', { recursive: true });
  log.info('Ensured /tmp/codex-proxy exists');

  // Create app-server client
  const client = new AppServerClient({
    url: config.appServerUrl,
    maxConcurrent: config.maxConcurrent,
    maxQueueDepth: config.maxQueueDepth,
    queueTimeoutMs: config.queueTimeoutMs,
    degradationThreshold: config.degradationThreshold,
    orphanSweepIntervalMs: config.orphanSweepIntervalMs,
  });

  // Start WebSocket connection
  client.connect();

  // Wait for WebSocket connected AND model/list populated
  log.info('Waiting for app-server connection and model list...');
  await client.readyPromise;
  log.info('App-server ready', { models: client.getModelCache().length });

  // Build Express app
  const app = express();

  // Body parsing with 10MB limit
  app.use(express.json({ limit: '10mb' }));

  // Body parse error handling (must be before routes)
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.status === 400 || err.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: {
          message: 'Invalid JSON in request body',
          type: 'invalid_request_error',
          code: null,
        },
      });
    }
    if (err.status === 413 || err.type === 'entity.too.large') {
      return res.status(413).json({
        error: {
          message: 'Request body too large',
          type: 'invalid_request_error',
          code: null,
        },
      });
    }
    next(err);
  });

  // Mount routes
  const router = buildRouter(client);
  app.use(router);

  // Catch-all error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled error', { error: err.message });
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: 'Internal server error', type: 'server_error', code: null },
      });
    }
  });

  // Start HTTP server
  let shutdownInitiated = false;

  const server = app.listen(config.port, () => {
    log.info('Codex proxy listening', { port: config.port });
    // Signal PM2 that we're ready
    if (process.send) {
      process.send('ready');
      log.info('Sent process.send("ready") to PM2');
    }
  });

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  async function gracefulShutdown(signal: string): Promise<void> {
    if (shutdownInitiated) return;
    shutdownInitiated = true;

    log.info(`Received ${signal} — starting graceful shutdown`);

    // Stop accepting new HTTP connections
    server.close(() => {
      log.info('HTTP server stopped accepting new connections');
    });

    // Drain in-flight requests (up to 30s)
    await client.shutdown(30000);

    log.info('Graceful shutdown complete — exiting');
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM').catch(err => {
    log.error('Shutdown error', { error: String(err) });
    process.exit(1);
  }));

  process.on('SIGINT', () => gracefulShutdown('SIGINT').catch(err => {
    log.error('Shutdown error', { error: String(err) });
    process.exit(1);
  }));

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled promise rejection', { reason: String(reason) });
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
