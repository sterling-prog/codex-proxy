// Codex CLI App-Server JSON-RPC types

// ─── Core JSON-RPC ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  // No id on notifications
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── Initialize ───────────────────────────────────────────────────────────────

export interface InitializeParams {
  clientInfo: {
    name: string;
    title: string | null;
    version: string;
  };
  capabilities: {
    experimentalApi: boolean;
  };
}

export interface InitializeResult {
  serverInfo?: unknown;
  capabilities?: unknown;
}

// ─── Thread/Start ─────────────────────────────────────────────────────────────

export type SandboxMode = 'danger-full-access' | 'read-only' | 'none';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface ThreadStartParams {
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral: boolean;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  cwd: string;
  experimentalRawEvents: false;
  persistExtendedHistory: false;
}

export interface Thread {
  id: string;
}

export interface ThreadStartResult {
  thread: Thread;
  model: string;
}

export type ThreadStartResponse = JsonRpcResponse<ThreadStartResult>;

// ─── Turn ─────────────────────────────────────────────────────────────────────

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// CodexErrorInfo: string literals AND object variants
export type CodexErrorInfoLiteral =
  | 'usageLimitExceeded'
  | 'unauthorized'
  | 'contextWindowExceeded'
  | 'serverOverloaded'
  | 'badRequest'
  | 'internalServerError'
  | 'sandboxError'
  | 'threadRollbackFailed'
  | 'other';

export interface CodexErrorInfoHttpConnectionFailed {
  httpConnectionFailed: { httpStatusCode: number };
}

export interface CodexErrorInfoResponseStreamConnectionFailed {
  responseStreamConnectionFailed: { httpStatusCode: number };
}

export interface CodexErrorInfoResponseStreamDisconnected {
  responseStreamDisconnected: { httpStatusCode: number };
}

export interface CodexErrorInfoResponseTooManyFailedAttempts {
  responseTooManyFailedAttempts: { httpStatusCode: number };
}

export type CodexErrorInfo =
  | CodexErrorInfoLiteral
  | CodexErrorInfoHttpConnectionFailed
  | CodexErrorInfoResponseStreamConnectionFailed
  | CodexErrorInfoResponseStreamDisconnected
  | CodexErrorInfoResponseTooManyFailedAttempts;

export interface TurnError {
  codexErrorInfo: CodexErrorInfo | null;
  message: string;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  error?: TurnError;
}

export interface UserInput {
  type: 'text';
  text: string;
  text_elements: never[];
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  model?: string;
  effort?: ReasoningEffort;
}

export interface TurnStartResult {
  turn: Turn;
}

export type TurnStartResponse = JsonRpcResponse<TurnStartResult>;

// ─── Thread/Archive ───────────────────────────────────────────────────────────

export interface ThreadArchiveParams {
  threadId: string;
}

export interface ThreadArchiveResult {
  success?: boolean;
}

export type ThreadArchiveResponse = JsonRpcResponse<ThreadArchiveResult>;

// ─── Thread/List ──────────────────────────────────────────────────────────────

export interface ThreadListParams {
  archived: boolean;
  sourceKinds: string[];
  cursor?: string;
}

export interface ThreadListItem {
  id: string;
  source: unknown; // Tagged enum: { "custom": "openclaw-proxy" } or similar
  archived: boolean;
}

export interface ThreadListResult {
  data: ThreadListItem[];
  nextCursor: string | null;
}

export type ThreadListResponse = JsonRpcResponse<ThreadListResult>;

// ─── Turn/Interrupt ───────────────────────────────────────────────────────────

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

// ─── Model/List ───────────────────────────────────────────────────────────────

export interface ModelListParams {
  cursor?: string;
}

export interface Model {
  id: string;    // Display identifier
  model: string; // API model string (use this for /v1/models id field)
  name?: string;
  description?: string;
}

export interface ModelListResult {
  data: Model[];
  nextCursor: string | null;
}

export type ModelListResponse = JsonRpcResponse<ModelListResult>;

// ─── Token Usage ─────────────────────────────────────────────────────────────

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface AgentMessageDeltaParams {
  delta: string;
  threadId: string;
  turnId: string;
  itemId: string;
}

export interface TurnCompletedParams {
  thread: { id: string };
  turn: Turn;
}

export interface TurnStartedParams {
  threadId: string;
  turn: Turn;
}

export interface ThreadTokenUsageUpdatedParams {
  threadId: string;
  tokenUsage: ThreadTokenUsage;
}

export interface ModelReroutedParams {
  fromModel: string;
  toModel: string;
  reason?: string;
}

export interface ThreadClosedParams {
  threadId: string;
}

export interface ErrorNotificationParams {
  message: string;
  willRetry: boolean;
  additionalDetails?: string;
}

// ─── ServerRequest (approval/denial) ─────────────────────────────────────────

// Base server request
export interface ServerRequestBase {
  id: number;
  method: string;
  params?: unknown;
}

// item/commandExecution/requestApproval → { decision: "decline" }
export interface CommandExecutionRequestApproval extends ServerRequestBase {
  method: 'item/commandExecution/requestApproval';
}

export interface CommandExecutionDenial {
  decision: 'decline';
}

// item/fileChange/requestApproval → { decision: "decline" }
export interface FileChangeRequestApproval extends ServerRequestBase {
  method: 'item/fileChange/requestApproval';
}

export interface FileChangeDenial {
  decision: 'decline';
}

// item/permissions/requestApproval → { permissions: {}, scope: "turn" }
export interface PermissionsRequestApproval extends ServerRequestBase {
  method: 'item/permissions/requestApproval';
}

export interface PermissionGrantScope {
  fileSystem?: unknown;
  network?: unknown;
}

export interface PermissionsRequestApprovalResponse {
  permissions: PermissionGrantScope;
  scope: 'turn' | 'session';
}

// item/tool/requestUserInput → { answers: {} }
export interface ToolRequestUserInput extends ServerRequestBase {
  method: 'item/tool/requestUserInput';
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, unknown>;
}

// item/tool/call → { success: false, contentItems: [] }
export interface ToolCall extends ServerRequestBase {
  method: 'item/tool/call';
}

export interface ToolCallDenial {
  success: false;
  contentItems: never[];
}

// mcpServer/elicitation/request → { action: "decline", content: null, _meta: null }
export interface McpElicitationRequest extends ServerRequestBase {
  method: 'mcpServer/elicitation/request';
}

export interface McpElicitationDenial {
  action: 'decline';
  content: null;
  _meta: null;
}

// applyPatchApproval (legacy) → { decision: "denied" }
export interface ApplyPatchApproval extends ServerRequestBase {
  method: 'applyPatchApproval';
}

export interface ApplyPatchDenial {
  decision: 'denied';
}

// execCommandApproval (legacy) → { decision: "denied" }
export interface ExecCommandApproval extends ServerRequestBase {
  method: 'execCommandApproval';
}

export interface ExecCommandDenial {
  decision: 'denied';
}

// account/chatgptAuthTokens/refresh
export interface ChatGptAuthTokensRefresh extends ServerRequestBase {
  method: 'account/chatgptAuthTokens/refresh';
}

// ─── Tool approval param types (from Codex JSON schemas) ─────────────────────

export interface NetworkApprovalContext {
  host: string;
  protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp';
}

export type CommandAction =
  | { type: 'read' }
  | { type: 'listFiles' }
  | { type: 'search' }
  | { type: 'unknown' };

export interface CommandExecutionParams {
  itemId: string;
  threadId: string;
  turnId: string;
  command?: string | null;
  cwd?: string | null;
  commandActions?: CommandAction[] | null;
  networkApprovalContext?: NetworkApprovalContext | null;
  reason?: string | null;
}

export interface FileChangeParams {
  itemId: string;
  threadId: string;
  turnId: string;
  grantRoot?: string | null;
  reason?: string | null;
}

// Approval response types
export interface CommandExecutionApproval {
  decision: 'accept';
}

export interface FileChangeApproval {
  decision: 'accept';
}

export interface PermissionsGrant {
  permissions: {
    network?: { enabled: boolean };
    fileSystem?: { read: string[]; write: string[] };
  };
  scope: 'session' | 'turn';
}

// Legacy approval response types (distinct from denial types above)
export interface ApplyPatchApprovalResult {
  decision: 'approved';
}

export interface ExecCommandApprovalResult {
  decision: 'approved';
}

export type AnyServerRequest =
  | CommandExecutionRequestApproval
  | FileChangeRequestApproval
  | PermissionsRequestApproval
  | ToolRequestUserInput
  | ToolCall
  | McpElicitationRequest
  | ApplyPatchApproval
  | ExecCommandApproval
  | ChatGptAuthTokensRefresh;
