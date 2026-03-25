// Tool policy unit tests — plain Node.js, no test framework required
// Run: node tests/tool-policy.test.mjs

import { homedir } from 'os';
import { join } from 'path';

// Import compiled output
const { evaluateCommandExecution, evaluateFileChange } = await import('../dist/policy/tool-policy.js');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

function makeConfig(overrides = {}) {
  const home = homedir();
  return {
    version: 1,
    enabled: true,
    commandDenyPatterns: [
      '^bash\\b', '^sh\\b', '^zsh\\b',
      '^/bin/bash\\b', '^/bin/sh\\b', '^/bin/zsh\\b',
      '^sudo\\b', '^docker\\b', '^ssh\\b', '^scp\\b', '^rsync\\b', '^env\\b',
      '^curl\\b', '^wget\\b', '^nc\\b', '^ncat\\b', '^socat\\b',
      'rm\\s+-rf\\s+/',
      '\\|\\s*sh\\b', '\\|\\s*bash\\b', '\\|\\s*zsh\\b',
    ],
    commandAllowPrefixes: [
      'ls', 'cat', 'head', 'tail', 'find', 'grep', 'rg', 'wc', 'file', 'stat', 'tree', 'diff',
      'node', 'npm', 'npx', 'tsc', 'jest', 'vitest', 'eslint', 'prettier',
      'git status', 'git log', 'git diff', 'git show', 'git branch',
      'git add', 'git commit', 'git checkout', 'git stash',
      'echo', 'printf', 'date', 'which', 'pwd', 'cd', 'mkdir', 'cp', 'mv', 'touch',
      'sed', 'awk',
    ],
    protectedPaths: [
      `${home}/.openclaw`,
      `${home}/.ssh`,
      `${home}/.pm2`,
      `${home}/.config`,
      '/etc',
      '/var',
    ],
    protectedFiles: [
      'tool-policy.json', 'openclaw.json', 'SOUL.md', 'MEMORY.md', 'AGENTS.md', 'IDENTITY.md',
    ],
    allowedWritePaths: [
      `${home}/codex-proxy`,
      '/tmp',
    ],
    denyNetwork: true,
    ...overrides,
  };
}

const cfg = makeConfig();
const home = homedir();

// ─── Command execution tests ──────────────────────────────────────────────────

console.log('\nCommand execution — allowlist:');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'ls' }, cfg).approved, 'ls approved');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'ls -la' }, cfg).approved, 'ls -la approved');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'cat file.txt' }, cfg).approved, 'cat file.txt approved');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'git diff HEAD' }, cfg).approved, 'git diff HEAD approved');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'node index.js' }, cfg).approved, 'node index.js approved');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'npm install' }, cfg).approved, 'npm install approved');

console.log('\nCommand execution — word boundary:');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'catalog' }, cfg).approved, 'catalog NOT approved (prefix boundary)');
assert(evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'cat' }, cfg).approved, 'cat exact match approved');

console.log('\nCommand execution — denylist:');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'bash' }, cfg).approved, 'bash denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'sudo rm file' }, cfg).approved, 'sudo denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'docker run ubuntu' }, cfg).approved, 'docker denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'curl https://example.com' }, cfg).approved, 'curl denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'rm -rf /' }, cfg).approved, 'rm -rf / denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'cat file | bash' }, cfg).approved, 'pipe to bash denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'env sudo rm file' }, cfg).approved, 'env prefix denied');

console.log('\nCommand execution — denylist wins over allowlist:');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'ls && sudo rm -rf /' }, cfg).approved, 'chained: ls && sudo → denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'cat file; sudo something' }, cfg).approved, 'chained: cat; sudo → denied');

console.log('\nCommand execution — protected paths:');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:`cat ${home}/.ssh/id_rsa` }, cfg).approved, 'cat ~/.ssh/id_rsa denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:`ls ${home}/.openclaw` }, cfg).approved, 'ls ~/.openclaw denied');

console.log('\nCommand execution — network denial:');
assert(!evaluateCommandExecution({
  itemId:'', threadId:'', turnId:'', command:'git clone https://github.com/foo',
  networkApprovalContext: { host: 'github.com', protocol: 'https' },
}, cfg).approved, 'network context denied when denyNetwork=true');
assert(evaluateCommandExecution({
  itemId:'', threadId:'', turnId:'', command:'git status',
  networkApprovalContext: { host: 'github.com', protocol: 'https' },
}, makeConfig({ denyNetwork: false })).approved, 'network allowed when denyNetwork=false');

console.log('\nCommand execution — null/missing:');
assert(!evaluateCommandExecution(null, cfg).approved, 'null params denied');
assert(!evaluateCommandExecution(undefined, cfg).approved, 'undefined params denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command: null }, cfg).approved, 'null command denied');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command: '' }, cfg).approved, 'empty command denied');

console.log('\nCommand execution — commandActions read-only:');
assert(evaluateCommandExecution({
  itemId:'', threadId:'', turnId:'', command:'arbitrary-cmd',
  commandActions: [{ type: 'read' }, { type: 'listFiles' }],
}, cfg).approved, 'all-read commandActions approved');
assert(!evaluateCommandExecution({
  itemId:'', threadId:'', turnId:'', command:'arbitrary-cmd',
  commandActions: [{ type: 'read' }, { type: 'unknown' }],
}, cfg).approved, 'unknown commandAction not auto-approved');

console.log('\nCommand execution — default deny:');
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'unknowncmd foo' }, cfg).approved, 'unlisted command denied by default');

// ─── File change tests ────────────────────────────────────────────────────────

console.log('\nFile change — allowed paths:');
assert(evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/codex-proxy/src/foo.ts` }, cfg).approved, '~/codex-proxy/ write approved');
assert(evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:'/tmp/output.txt' }, cfg).approved, '/tmp write approved');

console.log('\nFile change — protected paths:');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/.openclaw/config` }, cfg).approved, '~/.openclaw denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/.ssh/id_rsa` }, cfg).approved, '~/.ssh denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:'/etc/passwd' }, cfg).approved, '/etc denied');

console.log('\nFile change — protected files:');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/codex-proxy/tool-policy.json` }, cfg).approved, 'tool-policy.json denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/codex-proxy/SOUL.md` }, cfg).approved, 'SOUL.md denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/codex-proxy/MEMORY.md` }, cfg).approved, 'MEMORY.md denied');

console.log('\nFile change — null/missing:');
assert(!evaluateFileChange(null, cfg).approved, 'null params denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot: null }, cfg).approved, 'null grantRoot denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot: '' }, cfg).approved, 'empty grantRoot denied');

console.log('\nFile change — default deny:');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/some-other-project/file.ts` }, cfg).approved, 'unlisted path denied by default');

// ─── Kill switch ──────────────────────────────────────────────────────────────

console.log('\nKill switch (CODEX_TOOL_APPROVAL=deny):');
process.env['CODEX_TOOL_APPROVAL'] = 'deny';
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'ls' }, cfg).approved, 'kill switch: ls denied');
assert(!evaluateFileChange({ itemId:'', threadId:'', turnId:'', grantRoot:`${home}/codex-proxy/foo.ts` }, cfg).approved, 'kill switch: write denied');
delete process.env['CODEX_TOOL_APPROVAL'];

// ─── Fail-safe ────────────────────────────────────────────────────────────────

console.log('\nFail-safe (disabled policy):');
const disabledCfg = makeConfig({ enabled: false });
assert(!evaluateCommandExecution({ itemId:'', threadId:'', turnId:'', command:'ls' }, disabledCfg).approved, 'disabled policy denies ls');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
