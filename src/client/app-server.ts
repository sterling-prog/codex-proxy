// Module 1: App-Server WebSocket JSON-RPC Client

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import type { Request, Response } from 'express';
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcError,
  InitializeParams,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  TurnStartResult,
  Turn,
  ThreadArchiveParams,
  ThreadListParams,
  ThreadListResult,
  ModelListResult,
  Model,
  AgentMessageDeltaParams,
  TurnCompletedParams,
  TurnStartedParams,
  ThreadTokenUsageUpdatedParams,
  ModelReroutedParams,
  ThreadClosedParams,
  ErrorNotificationParams,
  AnyServerRequest,
  CommandExecutionDenial,
  FileChangeDenial,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputResponse,
  ToolCallDenial,
  McpElicitationDenial,
  ApplyPatchDenial,
  ExecCommandDenial,
  TurnInterruptParams,
  UserInput,
} from '../types/codex.js';

// ─── Module-level ID counter (NEVER resets) ──────────────────────────────────
let nextId = 1;

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = {
  debug: (msg: string, data?: unknown) => {
    if (process.env['LOG_LEVEL'] === 'debug') {
      console.debug(JSON.stringify({ level: 'debug', msg, ...flattenData(data) }));
    }
  },
  info: (msg: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'info', msg, ...flattenData(data) }));
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...flattenData(data) }));
  },
  error: (msg: string, data?: unknown) => {
    console.error(JSON.stringify({ level: 'error', msg, ...flattenData(data) }));
  },
};

function flattenData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return data ? { data } : {};
  return data as Record<string, unknown>;
}

// ─── Per-request in-flight state ─────────────────────────────────────────────

export interface InFlightRequest {
  threadId: string;
  turnId: string | null;
  req: Request;
  res: Response;
  stream: boolean;
  cleanupDone: boolean;
  responseSent: boolean;
  deltaBuffer: string[];
  deltaBufferSize: number;
  deltaBufferTimeout: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
  requestTimeout: NodeJS.Timeout | null;
  gracePeriodTimer: NodeJS.Timeout | null;
  dequeued: boolean;
  headersCommitted: boolean;
  requestId: string;
  model: string;
  completionId: string;
  created: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  accumulatedContent: string;
  accumulatedSize: number;
  consecutiveFailures_ref?: { count: number };
}

export type CleanupResult =
  | { type: 'success' }
  | { type: 'error'; httpStatus: number; message: string; errorType?: string; code?: string | number | null }
  | { type: 'disconnect' };

// ─── AppServerClient ──────────────────────────────────────────────────────────

export class AppServerClient {
  private ws: WebSocket | null = null;
  private readonly url: string;

  // JSON-RPC response correlation: id → {resolve, reject}
  private pendingRequests: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();

  // In-flight HTTP requests: threadId → InFlightRequest
  private inFlightRequests: Map<string, InFlightRequest> = new Map();

  // Model cache
  private modelCache: Model[] = [];
  private modelCacheLastRefresh = 0;
  private readonly MODEL_CACHE_TTL_MS = 3600000; // 1 hour
  private modelCacheRefreshTimer: NodeJS.Timeout | null = null;

  // Auth degradation
  private authDegraded = false;

  // Backend degradation
  private consecutiveFailures = 0;
  private readonly degradationThreshold: number;
  private backendDegraded = false;

  // Orphan sweep
  private sweepInProgress = false;
  private orphanSweepTimer: NodeJS.Timeout | null = null;
  private readonly orphanSweepIntervalMs: number;

  // Reconnect
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30000;
  private connected = false;

  // ready signal
  private readyResolver: (() => void) | null = null;
  public readyPromise: Promise<void>;

  // Concurrency
  private readonly maxConcurrent: number;
  private activeConcurrent = 0;
  private queue: Array<{
    run: () => void;
    cancel: (reason: string) => void;
    dequeued: boolean;
    queueTimer: NodeJS.Timeout | null;
  }> = [];
  private readonly maxQueueDepth: number;
  private readonly queueTimeoutMs: number;

  // cleanup callback (set by routes.ts)
  public onCleanup?: (req: InFlightRequest, result: CleanupResult) => Promise<void>;

  constructor(options: {
    url: string;
    maxConcurrent: number;
    maxQueueDepth: number;
    queueTimeoutMs: number;
    degradationThreshold: number;
    orphanSweepIntervalMs: number;
  }) {
    this.url = options.url;
    this.maxConcurrent = options.maxConcurrent;
    this.maxQueueDepth = options.maxQueueDepth;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.degradationThreshold = options.degradationThreshold;
    this.orphanSweepIntervalMs = options.orphanSweepIntervalMs;

    this.readyPromise = new Promise(resolve => {
      this.readyResolver = resolve;
    });
  }

  // ─── Connection ────────────────────────────────────────────────────────────

  public connect(): void {
    this.createWebSocket();
  }

  private createWebSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      log.info('WebSocket connected', { url: this.url });
      this.reconnectDelay = 1000; // reset backoff
      this.handleConnect();
    });

    ws.on('message', (data: Buffer | string) => {
      this.handleMessage(data.toString());
    });

    ws.on('close', () => {
      log.warn('WebSocket closed');
      this.handleDisconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('WebSocket error', { error: err.message });
      // close event fires after error
    });
  }

  private async handleConnect(): Promise<void> {
    this.connected = true;
    try {
      // Initialize handshake
      await this.sendRequest<unknown>('initialize', {
        clientInfo: { name: 'codex-proxy', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: false },
      } as InitializeParams);

      // Send initialized notification (no id)
      this.sendNotification('initialized', {});

      // Fetch model list (must succeed before ready)
      await this.refreshModelList();

      log.info('App-server initialized', { models: this.modelCache.length });

      // Clear auth degradation on successful reconnect + model/list success
      if (this.authDegraded) {
        log.info('Auth degradation cleared after successful reconnect and model/list fetch');
        this.authDegraded = false;
      }

      // Schedule periodic model refresh
      if (this.modelCacheRefreshTimer) clearInterval(this.modelCacheRefreshTimer);
      this.modelCacheRefreshTimer = setInterval(() => {
        this.refreshModelList().catch(err =>
          log.warn('Periodic model list refresh failed', { error: String(err) })
        );
      }, this.MODEL_CACHE_TTL_MS);

      // Start orphan sweep
      this.runOrphanSweep().catch(err =>
        log.warn('Initial orphan sweep failed', { error: String(err) })
      );

      // Schedule periodic orphan sweeps
      if (this.orphanSweepTimer) clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = setInterval(() => {
        this.runOrphanSweep().catch(err =>
          log.warn('Periodic orphan sweep failed', { error: String(err) })
        );
      }, this.orphanSweepIntervalMs);

      // Signal ready (only fires once — first connect)
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
      }
    } catch (err) {
      log.error('App-server initialization failed', { error: String(err) });
      // Will reconnect via disconnect handler
      this.ws?.close();
    }
  }

  private handleDisconnect(): void {
    if (!this.connected && !this.ws) return;

    this.connected = false;

    // Stop periodic timers
    if (this.modelCacheRefreshTimer) {
      clearInterval(this.modelCacheRefreshTimer);
      this.modelCacheRefreshTimer = null;
    }
    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = null;
    }

    // Remove listeners from old socket and null it
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }

    // Reject ALL pending JSON-RPC response promises
    const pendingCount = this.pendingRequests.size;
    for (const [, { reject }] of this.pendingRequests) {
      reject(new Error('WebSocket disconnected'));
    }
    this.pendingRequests.clear();
    if (pendingCount > 0) {
      log.warn('Rejected pending JSON-RPC promises on disconnect', { count: pendingCount });
    }

    // Fail all in-flight HTTP requests
    const inFlightCount = this.inFlightRequests.size;
    const toFail = Array.from(this.inFlightRequests.values());
    // Clear the map BEFORE failing requests (so handlers don't see stale entries)
    this.inFlightRequests.clear();

    for (const inflight of toFail) {
      if (!inflight.cleanupDone && this.onCleanup) {
        this.onCleanup(inflight, {
          type: 'error',
          httpStatus: 502,
          message: 'Upstream WebSocket disconnected',
          errorType: 'upstream_error',
        }).catch(err => log.error('Cleanup error on disconnect', { error: String(err) }));
      }
    }
    if (inFlightCount > 0) {
      log.warn('Failed in-flight requests on disconnect', { count: inFlightCount });
    }

    // Schedule reconnect
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    log.info(`Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.createWebSocket();
    }, delay);
  }

  // ─── Message handling ──────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Received invalid JSON from app-server', { raw: raw.slice(0, 200) });
      return;
    }

    if (!msg || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;

    // Is it a response to a pending request? (has id + result or error)
    if ('id' in m && typeof m['id'] === 'number' && ('result' in m || 'error' in m)) {
      const resp = m as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          const err = new Error(resp.error.message) as Error & { code?: number; rpcError?: JsonRpcError };
          err.code = resp.error.code;
          err.rpcError = resp.error;
          pending.reject(err);
        } else {
          pending.resolve(resp.result);
        }
      } else {
        log.debug('Received response for unknown id', { id: resp.id });
      }
      return;
    }

    // Is it a server request? (has id + method, but no result/error)
    if ('id' in m && typeof m['id'] === 'number' && 'method' in m && typeof m['method'] === 'string'
        && !('result' in m) && !('error' in m)) {
      this.handleServerRequest(m as unknown as AnyServerRequest);
      return;
    }

    // It's a notification (no id, has method)
    if ('method' in m && typeof m['method'] === 'string' && !('id' in m)) {
      this.handleNotification(m['method'] as string, m['params']);
      return;
    }

    log.debug('Unrecognized message from app-server', { method: m['method'], hasId: 'id' in m });
  }

  // ─── Server requests (approval/denial) ────────────────────────────────────

  private handleServerRequest(req: AnyServerRequest): void {
    const { id, method } = req;

    if (method === 'account/chatgptAuthTokens/refresh') {
      log.error('Auth token refresh requested — proxy is headless, cannot perform browser OAuth');
      // Set auth degradation IMMEDIATELY
      this.authDegraded = true;
      // Respond with JSON-RPC error
      this.sendRaw({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: 'Headless proxy cannot perform browser OAuth',
        },
      });
      return;
    }

    let result: unknown;

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const denial: CommandExecutionDenial = { decision: 'decline' };
        result = denial;
        break;
      }
      case 'item/fileChange/requestApproval': {
        const denial: FileChangeDenial = { decision: 'decline' };
        result = denial;
        break;
      }
      case 'item/permissions/requestApproval': {
        const denial: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        result = denial;
        break;
      }
      case 'item/tool/requestUserInput': {
        const denial: ToolRequestUserInputResponse = { answers: {} };
        result = denial;
        break;
      }
      case 'item/tool/call': {
        const denial: ToolCallDenial = { success: false, contentItems: [] };
        result = denial;
        break;
      }
      case 'mcpServer/elicitation/request': {
        const denial: McpElicitationDenial = { action: 'decline', content: null, _meta: null };
        result = denial;
        break;
      }
      case 'applyPatchApproval': {
        const denial: ApplyPatchDenial = { decision: 'denied' };
        result = denial;
        break;
      }
      case 'execCommandApproval': {
        const denial: ExecCommandDenial = { decision: 'denied' };
        result = denial;
        break;
      }
      default:
        log.debug('Unknown server request method, sending generic decline', { method });
        result = { decision: 'decline' };
        break;
    }

    this.sendRaw({ jsonrpc: '2.0', id, result });
  }

  // ─── Notifications ─────────────────────────────────────────────────────────

  private handleNotification(method: string, params: unknown): void {
    switch (method) {
      case 'item/agentMessage/delta':
        this.onAgentMessageDelta(params as AgentMessageDeltaParams);
        break;
      case 'turn/completed':
        this.onTurnCompleted(params as TurnCompletedParams);
        break;
      case 'turn/started':
        this.onTurnStarted(params as TurnStartedParams);
        break;
      case 'thread/tokenUsage/updated':
        this.onTokenUsageUpdated(params as ThreadTokenUsageUpdatedParams);
        break;
      case 'model/rerouted':
        this.onModelRerouted(params as ModelReroutedParams);
        break;
      case 'thread/closed':
        this.onThreadClosed(params as ThreadClosedParams);
        break;
      case 'error':
        this.onErrorNotification(params as ErrorNotificationParams);
        break;
      default:
        log.debug('Unhandled notification type', { method });
        break;
    }
  }

  private onAgentMessageDelta(params: AgentMessageDeltaParams): void {
    const { threadId, turnId, delta } = params;
    const inflight = this.inFlightRequests.get(threadId);
    if (!inflight) {
      log.debug('Delta for unknown threadId (dropped)', { threadId });
      return;
    }
    if (inflight.cleanupDone) return;

    // If turnId not yet set, try to resolve from delta params before buffering
    if (!inflight.turnId) {
      if (turnId) {
        // Delta carries turnId — resolve it now and flush buffer
        inflight.turnId = turnId;
        this.flushDeltaBuffer(inflight);
        // Fall through to emit current delta normally (turnId is now set)
      }
    }

    // If turnId still not set after attempting resolution, buffer the delta
    if (!inflight.turnId) {
      // Check buffer limits
      inflight.deltaBufferSize += delta.length;
      if (inflight.deltaBufferSize > 1024 * 1024) {
        // >1MB before turnId resolved
        log.warn('Delta buffer exceeded 1MB before turnId resolved', { threadId, requestId: inflight.requestId });
        this.triggerCleanup(inflight, {
          type: 'error',
          httpStatus: 502,
          message: 'Delta buffer overflow before turn ID resolved',
          errorType: 'upstream_error',
        });
        return;
      }
      inflight.deltaBuffer.push(delta);

      // Start buffer timeout if not already started
      if (!inflight.deltaBufferTimeout) {
        inflight.deltaBufferTimeout = setTimeout(() => {
          if (!inflight.turnId && !inflight.cleanupDone) {
            log.warn('Delta buffer timeout — turnId not resolved within 30s', { threadId, requestId: inflight.requestId });
            this.triggerCleanup(inflight, {
              type: 'error',
              httpStatus: 502,
              message: 'Turn ID not resolved within 30 seconds',
              errorType: 'upstream_error',
            });
          }
        }, 30000);
      }
      return;
    }

    // Flush buffered deltas first (should only happen once)
    if (inflight.deltaBuffer.length > 0) {
      const buffered = inflight.deltaBuffer.splice(0);
      inflight.deltaBuffer = [];
      inflight.deltaBufferSize = 0;
      if (inflight.deltaBufferTimeout) {
        clearTimeout(inflight.deltaBufferTimeout);
        inflight.deltaBufferTimeout = null;
      }
      for (const bufferedDelta of buffered) {
        this.emitDelta(inflight, bufferedDelta);
      }
    }

    this.emitDelta(inflight, delta);
  }

  private emitDelta(inflight: InFlightRequest, delta: string): void {
    if (inflight.cleanupDone || inflight.responseSent) return;

    if (inflight.stream) {
      // Reset keepalive timer
      if (inflight.keepaliveTimer) {
        clearInterval(inflight.keepaliveTimer);
        inflight.keepaliveTimer = setInterval(() => {
          if (!inflight.cleanupDone && !inflight.responseSent) {
            try {
              inflight.res.write(': keepalive\n\n');
            } catch {
              // ignore write errors
            }
          }
        }, 15000);
      }

      // Commit headers on first delta
      if (!inflight.headersCommitted) {
        inflight.res.setHeader('Content-Type', 'text/event-stream');
        inflight.res.setHeader('Cache-Control', 'no-cache');
        inflight.res.setHeader('Connection', 'keep-alive');
        inflight.res.flushHeaders();
        inflight.headersCommitted = true;

        // Start keepalive
        inflight.keepaliveTimer = setInterval(() => {
          if (!inflight.cleanupDone && !inflight.responseSent) {
            try {
              inflight.res.write(': keepalive\n\n');
            } catch {
              // ignore
            }
          }
        }, 15000);
      }

      const chunk = {
        id: inflight.completionId,
        object: 'chat.completion.chunk',
        created: inflight.created,
        model: inflight.model,
        choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
      };
      try {
        inflight.res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      } catch {
        // ignore write errors — client may have disconnected
      }
    } else {
      // Non-streaming: accumulate
      inflight.accumulatedContent += delta;
      inflight.accumulatedSize += delta.length;

      const maxSize = parseInt(process.env['CODEX_MAX_RESPONSE_SIZE'] ?? '5242880', 10);
      if (inflight.accumulatedSize > maxSize) {
        log.warn('Non-streaming response exceeded max size', { threadId: inflight.threadId, size: inflight.accumulatedSize });
        this.triggerCleanup(inflight, {
          type: 'error',
          httpStatus: 500,
          message: 'Response too large',
          errorType: 'server_error',
        });
        return;
      }
    }
  }

  private onTurnStarted(params: TurnStartedParams): void {
    const { threadId, turn } = params;
    const inflight = this.inFlightRequests.get(threadId);
    if (!inflight) {
      log.debug('turn/started for unknown threadId', { threadId });
      return;
    }
    if (inflight.cleanupDone) return;

    // Set turnId if not already set
    if (!inflight.turnId) {
      inflight.turnId = turn.id;
      this.flushDeltaBuffer(inflight);
    }
  }

  private flushDeltaBuffer(inflight: InFlightRequest): void {
    if (inflight.deltaBuffer.length === 0) return;
    if (inflight.deltaBufferTimeout) {
      clearTimeout(inflight.deltaBufferTimeout);
      inflight.deltaBufferTimeout = null;
    }
    const buffered = inflight.deltaBuffer.splice(0);
    inflight.deltaBufferSize = 0;
    for (const delta of buffered) {
      this.emitDelta(inflight, delta);
    }
  }

  private onTokenUsageUpdated(params: ThreadTokenUsageUpdatedParams): void {
    const { threadId, tokenUsage } = params;
    const inflight = this.inFlightRequests.get(threadId);
    if (!inflight) {
      log.debug('tokenUsage/updated for unknown threadId', { threadId });
      return;
    }
    if (inflight.cleanupDone) return;

    // Use `last` breakdown for current turn usage
    const last = tokenUsage.last;
    inflight.promptTokens = last.inputTokens;
    inflight.completionTokens = last.outputTokens;
    inflight.totalTokens = last.totalTokens;

    // If we're in non-streaming mode and there's a grace period timer waiting,
    // cancel it and send the response now
    if (!inflight.stream && inflight.gracePeriodTimer) {
      clearTimeout(inflight.gracePeriodTimer);
      inflight.gracePeriodTimer = null;
      // Send the non-streaming response now, then release the slot and archive
      this.sendNonStreamingResponse(inflight);
      this.triggerCleanup(inflight, { type: 'success' });
    }
  }

  private onModelRerouted(params: ModelReroutedParams): void {
    const { fromModel, toModel, reason } = params;
    log.warn('Model rerouted', { fromModel, toModel, reason });

    // Find inflight requests using the old model (can't do by threadId since notification isn't keyed by threadId)
    // Actually model/rerouted notifications DO arrive with threadId? Let's check spec...
    // Spec says: "{ fromModel, toModel, reason? }" — no threadId. We must update by model name.
    // Update all in-flight requests that have fromModel
    for (const inflight of this.inFlightRequests.values()) {
      if (inflight.model === fromModel) {
        inflight.model = toModel;
      }
    }
  }

  private onThreadClosed(params: ThreadClosedParams): void {
    const { threadId } = params;
    const inflight = this.inFlightRequests.get(threadId);
    if (!inflight) {
      log.debug('thread/closed for unknown threadId', { threadId });
      return;
    }
    if (inflight.cleanupDone) return;

    log.warn('Thread closed unexpectedly', { threadId, requestId: inflight.requestId });
    // Skip archive (thread already closed)
    // We handle this by passing a special type that skips archive
    this.triggerCleanup(inflight, {
      type: 'error',
      httpStatus: 502,
      message: 'Upstream thread closed unexpectedly',
      errorType: 'upstream_error',
    }, true /* skipArchive */);
  }

  private onErrorNotification(params: ErrorNotificationParams): void {
    const { message, willRetry, additionalDetails } = params;

    if (willRetry) {
      log.warn('App-server error (retrying)', { message, additionalDetails });
      // Do NOT fail the HTTP request — wait for turn/completed
      return;
    }

    log.error('App-server error (not retrying)', { message, additionalDetails });
    // Fail all in-flight requests? The notification isn't threadId-scoped in the spec's generic form.
    // We'll fail all non-done in-flight requests.
    for (const inflight of this.inFlightRequests.values()) {
      if (!inflight.cleanupDone) {
        this.triggerCleanup(inflight, {
          type: 'error',
          httpStatus: 500,
          message: additionalDetails ? `${message}: ${additionalDetails}` : message,
          errorType: 'upstream_error',
        });
      }
    }
  }

  private onTurnCompleted(params: TurnCompletedParams): void {
    const threadId = params.thread.id;
    const turn = params.turn;
    const inflight = this.inFlightRequests.get(threadId);

    if (!inflight) {
      log.debug('turn/completed for unknown threadId', { threadId });
      return;
    }
    if (inflight.cleanupDone) return;

    // Set turnId from turn/completed if not yet set (handles race where turn/start response lost)
    if (!inflight.turnId && turn.id) {
      inflight.turnId = turn.id;
      this.flushDeltaBuffer(inflight);
    }

    // Clear delta buffer timeout if still running
    if (inflight.deltaBufferTimeout) {
      clearTimeout(inflight.deltaBufferTimeout);
      inflight.deltaBufferTimeout = null;
    }

    if (turn.status === 'failed') {
      // Synchronously update consecutive failures
      this.consecutiveFailures++;
      if (inflight.consecutiveFailures_ref) {
        inflight.consecutiveFailures_ref.count = this.consecutiveFailures;
      }
      if (this.consecutiveFailures >= this.degradationThreshold) {
        this.backendDegraded = true;
        log.error('Backend degraded: consecutive failure threshold reached', { count: this.consecutiveFailures });
      }

      const { httpStatus, message } = this.mapTurnError(turn);

      // Check if unauthorized → set auth degradation
      if (turn.error?.codexErrorInfo === 'unauthorized') {
        this.authDegraded = true;
        log.error('Unauthorized error from app-server — auth degraded');
      }

      this.triggerCleanup(inflight, {
        type: 'error',
        httpStatus,
        message,
        errorType: httpStatus >= 500 ? 'upstream_error' : 'invalid_request_error',
        code: String(httpStatus),
      });
      return;
    }

    if (turn.status === 'inProgress') {
      log.error('Unexpected inProgress status on turn/completed', { threadId, requestId: inflight.requestId });
      this.triggerCleanup(inflight, {
        type: 'error',
        httpStatus: 502,
        message: 'Unexpected inProgress status on turn/completed',
        errorType: 'upstream_error',
      });
      return;
    }

    // completed or interrupted — reset consecutive failures
    this.consecutiveFailures = 0;
    this.backendDegraded = false;

    if (inflight.stream) {
      // Streaming: send final chunk(s) and DONE
      this.sendStreamingFinalChunk(inflight);
      this.triggerCleanup(inflight, { type: 'success' });
    } else {
      // Non-streaming: wait for tokenUsage if not received yet
      if (inflight.promptTokens === 0 && inflight.completionTokens === 0) {
        // Wait up to 2s for tokenUsage/updated
        inflight.gracePeriodTimer = setTimeout(() => {
          if (!inflight.cleanupDone) {
            log.warn('Token usage notification not received within grace period', { requestId: inflight.requestId });
            inflight.gracePeriodTimer = null;
            this.sendNonStreamingResponse(inflight);
            this.triggerCleanup(inflight, { type: 'success' });
          }
        }, 2000);
      } else {
        this.sendNonStreamingResponse(inflight);
        this.triggerCleanup(inflight, { type: 'success' });
      }
    }
  }

  private mapTurnError(turn: Turn): { httpStatus: number; message: string } {
    if (!turn.error) {
      return { httpStatus: 502, message: 'Turn failed with no error details' };
    }
    const { codexErrorInfo, message } = turn.error;
    if (codexErrorInfo === null) {
      return { httpStatus: 502, message };
    }
    if (typeof codexErrorInfo === 'string') {
      switch (codexErrorInfo) {
        case 'usageLimitExceeded': return { httpStatus: 429, message: 'Usage limit exceeded' };
        case 'unauthorized': return { httpStatus: 401, message: 'Unauthorized' };
        case 'contextWindowExceeded': return { httpStatus: 400, message: 'Context window exceeded — reduce conversation history' };
        case 'serverOverloaded': return { httpStatus: 503, message: 'Server overloaded — please retry' };
        case 'badRequest': return { httpStatus: 400, message };
        case 'internalServerError': return { httpStatus: 502, message: 'Internal server error' };
        case 'sandboxError': return { httpStatus: 500, message: 'Sandbox error' };
        case 'threadRollbackFailed': return { httpStatus: 500, message: 'Thread rollback failed' };
        case 'other': return { httpStatus: 502, message };
        default: return { httpStatus: 502, message };
      }
    }
    // Object variant
    if ('httpConnectionFailed' in codexErrorInfo) {
      return { httpStatus: 502, message: `HTTP connection failed (upstream: ${codexErrorInfo.httpConnectionFailed.httpStatusCode})` };
    }
    if ('responseStreamConnectionFailed' in codexErrorInfo) {
      return { httpStatus: 502, message: `Response stream connection failed (upstream: ${codexErrorInfo.responseStreamConnectionFailed.httpStatusCode})` };
    }
    if ('responseStreamDisconnected' in codexErrorInfo) {
      return { httpStatus: 502, message: `Response stream disconnected (upstream: ${codexErrorInfo.responseStreamDisconnected.httpStatusCode})` };
    }
    if ('responseTooManyFailedAttempts' in codexErrorInfo) {
      return { httpStatus: 502, message: `Too many failed attempts (upstream: ${codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode})` };
    }
    return { httpStatus: 502, message: turn.error.message };
  }

  private sendStreamingFinalChunk(inflight: InFlightRequest): void {
    if (inflight.responseSent || inflight.cleanupDone) return;

    // Commit headers if not yet done (zero-delta response)
    if (!inflight.headersCommitted) {
      inflight.res.setHeader('Content-Type', 'text/event-stream');
      inflight.res.setHeader('Cache-Control', 'no-cache');
      inflight.res.setHeader('Connection', 'keep-alive');
      inflight.res.flushHeaders();
      inflight.headersCommitted = true;
      // Synthetic role delta for zero-content response
      log.warn('Zero-content response — synthetic role delta emitted', { requestId: inflight.requestId });
      const syntheticChunk = {
        id: inflight.completionId,
        object: 'chat.completion.chunk',
        created: inflight.created,
        model: inflight.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      };
      try {
        inflight.res.write(`data: ${JSON.stringify(syntheticChunk)}\n\n`);
      } catch {
        // ignore
      }
    }

    // Final chunk
    const req = inflight.req as Request & { body?: { stream_options?: { include_usage?: boolean } } };
    const includeUsage = req.body?.stream_options?.include_usage === true;

    const finalChunk: Record<string, unknown> = {
      id: inflight.completionId,
      object: 'chat.completion.chunk',
      created: inflight.created,
      model: inflight.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };

    if (includeUsage) {
      finalChunk['usage'] = {
        prompt_tokens: inflight.promptTokens,
        completion_tokens: inflight.completionTokens,
        total_tokens: inflight.totalTokens,
      };
    }

    try {
      inflight.res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      inflight.res.write('data: [DONE]\n\n');
      inflight.res.end();
    } catch {
      // ignore
    }
    inflight.responseSent = true;
  }

  private sendNonStreamingResponse(inflight: InFlightRequest): void {
    if (inflight.responseSent || inflight.cleanupDone) return;

    const response = {
      id: inflight.completionId,
      object: 'chat.completion',
      created: inflight.created,
      model: inflight.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: inflight.accumulatedContent,
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: inflight.promptTokens,
        completion_tokens: inflight.completionTokens,
        total_tokens: inflight.totalTokens,
      },
    };

    try {
      inflight.res.setHeader('Content-Type', 'application/json');
      inflight.res.status(200).json(response);
    } catch {
      // ignore
    }
    inflight.responseSent = true;
    inflight.headersCommitted = true;
  }

  private triggerCleanup(inflight: InFlightRequest, result: CleanupResult, skipArchive = false): void {
    if (this.onCleanup) {
      // Attach skipArchive to the result for the cleanup function
      const resultWithSkip = skipArchive
        ? { ...result, _skipArchive: true } as CleanupResult & { _skipArchive?: boolean }
        : result;
      this.onCleanup(inflight, resultWithSkip).catch(err =>
        log.error('Cleanup callback error', { error: String(err) })
      );
    }
  }

  // ─── JSON-RPC primitives ───────────────────────────────────────────────────

  private sendRaw(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify(msg));
  }

  public sendRequest<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method };
      if (params !== undefined) req.params = params;
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      try {
        this.sendRaw(req);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err as Error);
      }
    });
  }

  public sendNotification(method: string, params?: unknown): void {
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method };
    if (params !== undefined) notif.params = params;
    try {
      this.sendRaw(notif);
    } catch (err) {
      log.warn('Failed to send notification', { method, error: String(err) });
    }
  }

  // ─── Thread/Turn lifecycle ────────────────────────────────────────────────

  public async startThread(params: ThreadStartParams): Promise<{ threadId: string; model: string }> {
    const result = await this.sendRequest<ThreadStartResult>('thread/start', params);
    return { threadId: result.thread.id, model: result.model };
  }

  public async startTurn(
    inflight: InFlightRequest,
    params: TurnStartParams,
  ): Promise<{ turn: Turn }> {
    // Register threadId BEFORE sending turn/start (race prevention)
    this.inFlightRequests.set(inflight.threadId, inflight);

    const result = await this.sendRequest<TurnStartResult>('turn/start', params);
    // Set turnId if not already set by turn/started notification
    if (!inflight.turnId) {
      inflight.turnId = result.turn.id;
      this.flushDeltaBuffer(inflight);
    }
    return { turn: result.turn };
  }

  public async archiveThread(threadId: string): Promise<void> {
    const archiveParams: ThreadArchiveParams = { threadId };

    const archivePromise = this.sendRequest<unknown>('thread/archive', archiveParams);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('thread/archive timeout')), 10000)
    );

    await Promise.race([archivePromise, timeoutPromise]);
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const params: TurnInterruptParams = { threadId, turnId };
    const interruptPromise = this.sendRequest<unknown>('turn/interrupt', params);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('turn/interrupt timeout')), 10000)
    );
    await Promise.race([interruptPromise, timeoutPromise]);
  }

  // ─── Model list ───────────────────────────────────────────────────────────

  private async refreshModelList(): Promise<void> {
    const models: Model[] = [];
    let cursor: string | undefined;

    do {
      const params: { cursor?: string } = {};
      if (cursor) params.cursor = cursor;

      const result = await this.sendRequest<ModelListResult>('model/list', params);
      models.push(...result.models);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    // Only update on success
    this.modelCache = models;
    this.modelCacheLastRefresh = Date.now();
    log.info('Model list refreshed', { count: models.length });
  }

  public getModelCache(): Model[] {
    return this.modelCache;
  }

  // ─── Orphan sweep ────────────────────────────────────────────────────────

  private async runOrphanSweep(): Promise<void> {
    if (this.sweepInProgress) {
      log.debug('Orphan sweep already in progress, skipping');
      return;
    }
    this.sweepInProgress = true;

    try {
      let cursor: string | undefined;
      let orphanCount = 0;

      do {
        // Check WS before each page
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          log.debug('WebSocket disconnected mid-sweep, aborting');
          return;
        }

        const params: ThreadListParams = {
          archived: false,
          sourceKinds: ['custom'],
          ...(cursor ? { cursor } : {}),
        };

        const result = await this.sendRequest<ThreadListResult>('thread/list', params);
        cursor = result.nextCursor ?? undefined;

        for (const thread of result.threads) {
          // Check in-flight map immediately before each archive
          if (this.inFlightRequests.has(thread.id)) {
            log.debug('Skipping active thread in orphan sweep', { threadId: thread.id });
            continue;
          }

          // Check WS before each archive
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            log.debug('WebSocket disconnected during sweep archive, aborting');
            return;
          }

          log.warn('Orphaned thread found, archiving', { threadId: thread.id });
          orphanCount++;

          try {
            await this.archiveThread(thread.id);
            log.debug('Orphaned thread archived', { threadId: thread.id });
          } catch (err) {
            // Per-thread error resilience — log and continue
            log.warn('Failed to archive orphaned thread', { threadId: thread.id, error: String(err) });
          }
        }
      } while (cursor);

      if (orphanCount > 0) {
        log.info('Orphan sweep complete', { orphanCount });
      }
    } finally {
      // MUST clear in finally block
      this.sweepInProgress = false;
    }
  }

  // ─── Concurrency ─────────────────────────────────────────────────────────

  public tryAcquireSlot(): boolean {
    if (this.activeConcurrent < this.maxConcurrent) {
      this.activeConcurrent++;
      return true;
    }
    return false;
  }

  public releaseSlot(): void {
    this.activeConcurrent--;
    // Dequeue next if any
    this.dequeueNext();
  }

  private dequeueNext(): void {
    if (this.queue.length === 0) return;
    if (this.activeConcurrent >= this.maxConcurrent) return;

    const next = this.queue.shift();
    if (!next) return;
    if (next.dequeued) {
      // Already dequeued (cancelled)
      this.dequeueNext();
      return;
    }

    next.dequeued = true;
    if (next.queueTimer) {
      clearTimeout(next.queueTimer);
      next.queueTimer = null;
    }
    this.activeConcurrent++;
    next.run();
  }

  public enqueue(
    run: () => void,
    cancel: (reason: string) => void,
  ): { dequeued: boolean; queueTimer: NodeJS.Timeout | null; removeFromQueue: () => void } | null {
    if (this.queue.length >= this.maxQueueDepth) {
      return null; // Queue full
    }

    const entry: {
      run: () => void;
      cancel: (reason: string) => void;
      dequeued: boolean;
      queueTimer: NodeJS.Timeout | null;
    } = {
      run,
      cancel,
      dequeued: false,
      queueTimer: null,
    };

    entry.queueTimer = setTimeout(() => {
      if (!entry.dequeued) {
        entry.dequeued = true;
        // Remove from queue
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) this.queue.splice(idx, 1);
        cancel('Queue wait timeout — all slots busy');
      }
    }, this.queueTimeoutMs);

    this.queue.push(entry);

    return {
      get dequeued() { return entry.dequeued; },
      get queueTimer() { return entry.queueTimer; },
      removeFromQueue: () => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          if (entry.queueTimer) {
            clearTimeout(entry.queueTimer);
            entry.queueTimer = null;
          }
        }
      },
    };
  }

  // ─── Health / stats ───────────────────────────────────────────────────────

  public stats() {
    return {
      connected: this.connected,
      authDegraded: this.authDegraded,
      backendDegraded: this.backendDegraded,
      activeConcurrent: this.activeConcurrent,
      queueDepth: this.queue.length,
      inFlightCount: this.inFlightRequests.size,
      pendingRpcCount: this.pendingRequests.size,
      modelCount: this.modelCache.length,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  public isReady(): boolean {
    return this.connected && !this.authDegraded && !this.backendDegraded;
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  public async shutdown(drainTimeoutMs = 30000): Promise<void> {
    log.info('Starting graceful shutdown');

    // Stop accepting new connections (caller should stop route handler)
    if (this.orphanSweepTimer) { clearInterval(this.orphanSweepTimer); this.orphanSweepTimer = null; }
    if (this.modelCacheRefreshTimer) { clearInterval(this.modelCacheRefreshTimer); this.modelCacheRefreshTimer = null; }

    // Wait for in-flight to drain
    const deadline = Date.now() + drainTimeoutMs;
    while (this.inFlightRequests.size > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    // Force-fail remaining
    if (this.inFlightRequests.size > 0) {
      log.warn('Graceful shutdown timeout — force-failing remaining requests', { count: this.inFlightRequests.size });
      const toFail = Array.from(this.inFlightRequests.values());
      // Clear map first
      this.inFlightRequests.clear();
      for (const inflight of toFail) {
        if (!inflight.cleanupDone && this.onCleanup) {
          // Interrupt the turn first
          if (inflight.turnId) {
            try {
              await this.interruptTurn(inflight.threadId, inflight.turnId);
            } catch (err) {
              log.warn('turn/interrupt failed during shutdown', { error: String(err) });
            }
          }
          await this.onCleanup(inflight, {
            type: 'error',
            httpStatus: 502,
            message: 'Server shutting down',
            errorType: 'server_error',
          }).catch(err => log.error('Cleanup error during shutdown', { error: String(err) }));
        }
      }
    }

    // Disconnect WebSocket
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    log.info('Graceful shutdown complete');
  }

  // ─── InFlightRequest factory ──────────────────────────────────────────────

  public createInFlightRequest(params: {
    threadId: string;
    req: Request;
    res: Response;
    stream: boolean;
    model: string;
    requestId: string;
    consecutiveFailures_ref: { count: number };
  }): InFlightRequest {
    return {
      threadId: params.threadId,
      turnId: null,
      req: params.req,
      res: params.res,
      stream: params.stream,
      cleanupDone: false,
      responseSent: false,
      deltaBuffer: [],
      deltaBufferSize: 0,
      deltaBufferTimeout: null,
      keepaliveTimer: null,
      requestTimeout: null,
      gracePeriodTimer: null,
      dequeued: false,
      headersCommitted: false,
      requestId: params.requestId,
      model: params.model,
      completionId: `chatcmpl-${uuidv4()}`,
      created: Math.floor(Date.now() / 1000),
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      accumulatedContent: '',
      accumulatedSize: 0,
      consecutiveFailures_ref: params.consecutiveFailures_ref,
    };
  }

  public getInFlightRequest(threadId: string): InFlightRequest | undefined {
    return this.inFlightRequests.get(threadId);
  }

  public removeInFlightRequest(threadId: string): void {
    this.inFlightRequests.delete(threadId);
  }
}
