// Policy-gated tool approval — pure functions, no I/O

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import type { CommandExecutionParams, FileChangeParams } from '../types/codex.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface PolicyConfig {
  version: 1;
  enabled: boolean;
  commandDenyPatterns: string[];
  commandAllowPrefixes: string[];
  protectedPaths: string[];
  protectedFiles: string[];
  allowedWritePaths: string[];
  denyNetwork: boolean;
}

export interface PolicyDecision {
  approved: boolean;
  reason: string;
}

// ─── Tilde resolution ─────────────────────────────────────────────────────────

function resolveTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function resolvePaths(paths: string[]): string[] {
  return paths.map(resolveTilde);
}

// ─── Config loader ────────────────────────────────────────────────────────────

const DEFAULT_POLICY_PATH = join(homedir(), 'codex-proxy', 'tool-policy.json');

// All-deny config used when file is missing or unparseable
const ALL_DENY_CONFIG: PolicyConfig = {
  version: 1,
  enabled: true,
  commandDenyPatterns: ['.*'],
  commandAllowPrefixes: [],
  protectedPaths: [],
  protectedFiles: [],
  allowedWritePaths: [],
  denyNetwork: true,
};

function resolveConfigPaths(raw: PolicyConfig): PolicyConfig {
  return {
    ...raw,
    protectedPaths: resolvePaths(raw.protectedPaths),
    allowedWritePaths: resolvePaths(raw.allowedWritePaths),
  };
}

function loadConfig(path: string): PolicyConfig {
  try {
    const text = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(text) as PolicyConfig;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported policy version: ${parsed.version}`);
    }
    return resolveConfigPaths(parsed);
  } catch {
    return ALL_DENY_CONFIG;
  }
}

// Module-level config reference — swapped atomically on SIGHUP
let _policyPath = process.env['CODEX_TOOL_POLICY_PATH'] ?? DEFAULT_POLICY_PATH;
let _config: PolicyConfig = loadConfig(_policyPath);

const log = {
  info: (msg: string, data?: unknown) => {
    console.log(JSON.stringify({ level: 'info', msg, ...flattenData(data) }));
  },
  warn: (msg: string, data?: unknown) => {
    console.warn(JSON.stringify({ level: 'warn', msg, ...flattenData(data) }));
  },
};

function flattenData(data?: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  return data as Record<string, unknown>;
}

export function getConfig(): PolicyConfig {
  return _config;
}

export function reloadConfig(): void {
  try {
    const text = readFileSync(_policyPath, 'utf-8');
    const parsed = JSON.parse(text) as PolicyConfig;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported policy version: ${parsed.version}`);
    }
    _config = resolveConfigPaths(parsed);
    log.info('Tool policy reloaded', { path: _policyPath });
  } catch (err) {
    log.warn('Tool policy reload failed — retaining old config', {
      path: _policyPath,
      error: String(err),
    });
  }
}

// Register SIGHUP handler once
process.on('SIGHUP', reloadConfig);

// ─── Command chaining: split on ;  &&  ||  | ─────────────────────────────────

function splitCommandChain(command: string): string[] {
  // Split on ; && || | — but we want to keep the sub-commands, not the operators
  // Use a regex that matches the delimiters
  return command.split(/\s*(?:;|&&|\|\||(?<!\|)\|(?!\|))\s*/).map(s => s.trim()).filter(Boolean);
}

// ─── Word-boundary-aware prefix match ────────────────────────────────────────

function matchesPrefix(command: string, prefix: string): boolean {
  if (command === prefix) return true;
  if (command.startsWith(prefix + ' ')) return true;
  if (command.startsWith(prefix + '\t')) return true;
  return false;
}

// ─── Protected path check ─────────────────────────────────────────────────────

function containsProtectedPath(command: string, config: PolicyConfig): string | null {
  for (const p of config.protectedPaths) {
    if (command.includes(p)) return p;
  }
  for (const f of config.protectedFiles) {
    // word-boundary-ish check: filename appears in command
    const re = new RegExp(`(?:^|[/\\s])${escapeRegex(f)}(?:[\\s$]|$)`);
    if (re.test(command) || command.endsWith('/' + f) || command.includes('/' + f + ' ') || command.includes('/' + f + '\t')) return f;
    // also plain filename at start or after whitespace
    if (command === f || command.startsWith(f + ' ') || command.includes(' ' + f + ' ') || command.endsWith(' ' + f)) return f;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Command execution policy ─────────────────────────────────────────────────

export function evaluateCommandExecution(
  params: CommandExecutionParams | undefined | null,
  config: PolicyConfig,
): PolicyDecision {
  // Kill switch
  if (process.env['CODEX_TOOL_APPROVAL'] === 'deny') {
    return { approved: false, reason: 'kill switch: CODEX_TOOL_APPROVAL=deny' };
  }

  // Policy disabled → deny (fail-safe)
  if (!config.enabled) {
    return { approved: false, reason: 'policy disabled' };
  }

  // Null/missing params → deny
  if (!params) {
    return { approved: false, reason: 'null params' };
  }

  const command = params.command;

  // Null/missing/empty command → deny
  if (command == null || command === '') {
    return { approved: false, reason: 'null or empty command' };
  }

  // Step 1: Network deny
  if (params.networkApprovalContext != null && config.denyNetwork) {
    return { approved: false, reason: `network denied: ${params.networkApprovalContext.host}` };
  }

  // Split for chaining checks
  const subCommands = splitCommandChain(command);
  const denyPatterns = config.commandDenyPatterns.map(p => new RegExp(p));

  // Step 2: Deny list — check full command AND each sub-command
  const toCheck = [command, ...subCommands];
  for (const part of toCheck) {
    for (const re of denyPatterns) {
      if (re.test(part)) {
        return { approved: false, reason: `deny pattern: ${re.source}` };
      }
    }
  }

  // Step 3: Protected path check — scan full command string
  const hitPath = containsProtectedPath(command, config);
  if (hitPath) {
    return { approved: false, reason: `protected path: ${hitPath}` };
  }

  // Step 4: commandActions — if all are read-only types, approve
  if (params.commandActions != null && params.commandActions.length > 0) {
    const readOnlyTypes = new Set(['read', 'listFiles', 'search']);
    const allReadOnly = params.commandActions.every(a => readOnlyTypes.has(a.type));
    if (allReadOnly) {
      return { approved: true, reason: 'commandActions: all read-only' };
    }
  }

  // Step 5: Allow list — check first sub-command
  const firstSubCommand = subCommands[0] ?? command;
  for (const prefix of config.commandAllowPrefixes) {
    if (matchesPrefix(firstSubCommand, prefix)) {
      return { approved: true, reason: `allow prefix: ${prefix}` };
    }
  }

  // Step 6: Default deny
  return { approved: false, reason: 'not in allowlist' };
}

// ─── File change policy ───────────────────────────────────────────────────────

export function evaluateFileChange(
  params: FileChangeParams | undefined | null,
  config: PolicyConfig,
): PolicyDecision {
  // Kill switch
  if (process.env['CODEX_TOOL_APPROVAL'] === 'deny') {
    return { approved: false, reason: 'kill switch: CODEX_TOOL_APPROVAL=deny' };
  }

  // Policy disabled → deny (fail-safe)
  if (!config.enabled) {
    return { approved: false, reason: 'policy disabled' };
  }

  // Null/missing params → deny
  if (!params) {
    return { approved: false, reason: 'null params' };
  }

  const grantRoot = params.grantRoot;

  // Null/missing/empty grantRoot → deny
  if (grantRoot == null || grantRoot === '') {
    return { approved: false, reason: 'null or empty grantRoot' };
  }

  const resolvedPath = isAbsolute(grantRoot) ? grantRoot : join(process.cwd(), grantRoot);

  // Protected path check
  for (const p of config.protectedPaths) {
    if (resolvedPath.startsWith(p) || resolvedPath === p) {
      return { approved: false, reason: `protected path: ${p}` };
    }
  }

  // Protected file check — filename in path
  for (const f of config.protectedFiles) {
    const basename = resolvedPath.split('/').pop() ?? '';
    if (basename === f) {
      return { approved: false, reason: `protected file: ${f}` };
    }
    if (resolvedPath.includes('/' + f + '/') || resolvedPath.endsWith('/' + f)) {
      return { approved: false, reason: `protected file in path: ${f}` };
    }
  }

  // Allowed write paths
  for (const ap of config.allowedWritePaths) {
    if (resolvedPath.startsWith(ap) || resolvedPath === ap) {
      return { approved: true, reason: `allowed write path: ${ap}` };
    }
  }

  // Default deny
  return { approved: false, reason: 'not in allowed write paths' };
}
