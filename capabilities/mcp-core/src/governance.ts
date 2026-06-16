/**
 * Agent governance gate — an IL5-friendly integration point for the Microsoft
 * Agent Governance Toolkit (AGT, https://microsoft.github.io/agent-governance-toolkit/).
 *
 * Two chokepoints in this repo's self-hosted agent pattern carry every tool call:
 *   1. the agent loop's `callTool` (agent-side gate)         — see agent-loop.ts
 *   2. the MCP server's `tools/call` handler (server-side gate) — see mcp-server.ts
 * Wrapping those with a policy decision + audit log is exactly AGT's "govern any tool"
 * model. This module adopts AGT's policy schema (`governance.toolkit/v1`: default_action
 * + ordered rules, deny / require_approval) and decision/denial semantics, and runs the
 * evaluation **in-process** so it stays inside the IL5 boundary (app code only — never an
 * external control plane; the audit sink should target IL5 Monitor/Storage in production).
 *
 * Posture (matches mvp_architecture.md §7):
 *  - Disabled by default (`GOVERNANCE_ENABLED` unset/`false`) → every wrapper is a
 *    pass-through, so local dev and existing capability servers are unchanged.
 *  - `GOVERNANCE_PROVIDER=local` (default) uses the dependency-light evaluator below.
 *  - A clearly marked seam lets you swap in the official SDK
 *    (`@microsoft/agent-governance-sdk`) once it is vendored and IL5-reviewed — the same
 *    "swap in the official SDK later" pattern used by mcp-server.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { McpServerDef, McpTool, ToolCallContext, ToolResult } from './types';
import { mcpToolCaller } from './agent-loop';

/** Inputs evaluated for a single tool invocation (agent-side or server-side). */
export interface GovernanceInput {
  /** Tool/function name the agent is trying to call. */
  toolName: string;
  /** Coarse action verb. Derived from `args.action` or the tool name when omitted. */
  actionType?: string;
  /** The tool arguments (used for pattern rules, e.g. PII detection). */
  args: unknown;
  /** Workload/agent identity ("which agent did this"). Defaults to env `AGENT_ID`. */
  agentId?: string;
  tenantId?: string;
  traceId?: string;
}

export type GovernanceAction = 'allow' | 'deny' | 'require_approval';

/** Outcome of a policy evaluation (mirrors AGT's `decision.allowed` / `decision.reason`). */
export interface GovernanceDecision {
  allowed: boolean;
  action: GovernanceAction;
  /** Name of the rule that decided, or `default` when no rule matched. */
  rule: string;
  reason?: string;
}

/** A pluggable policy engine. The default is {@link LocalPolicyProvider}; the AGT SDK can back this. */
export interface GovernanceProvider {
  evaluate(input: GovernanceInput): GovernanceDecision | Promise<GovernanceDecision>;
}

/** A single tamper-evident audit record. `hash` chains over `prevHash` for integrity. */
export interface AuditEntry {
  ts: string;
  toolName: string;
  actionType: string;
  agentId?: string;
  tenantId?: string;
  traceId?: string;
  action: GovernanceAction;
  allowed: boolean;
  rule: string;
  reason?: string;
  prevHash: string;
  hash: string;
}

/** Where audit records are written. Default logs a hash-chained JSON line; route to IL5 Monitor/Storage in prod. */
export interface AuditSink {
  write(entry: AuditEntry): void | Promise<void>;
}

export interface Logger {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
}

/** Thrown by the agent-side wrapper when a tool call is denied (AGT's `GovernanceDenied`). */
export class GovernanceDenied extends Error {
  readonly decision: GovernanceDecision;
  constructor(decision: GovernanceDecision) {
    super(
      `Action denied by policy rule '${decision.rule}'${decision.reason ? `: ${decision.reason}` : ''}`,
    );
    this.name = 'GovernanceDenied';
    this.decision = decision;
  }
}

// ---------------------------------------------------------------------------
// Policy document (AGT `governance.toolkit/v1` subset)
// ---------------------------------------------------------------------------

/**
 * Safe, declarative matcher. All present keys must match (AND). No expression `eval` is
 * ever performed — membership/regex only — so the gate cannot be turned into an injection
 * sink (OWASP). `args_pattern` is tested against `JSON.stringify(args)`.
 */
interface PolicyMatch {
  tool_name?: string | string[];
  action_type?: string | string[];
  agent_id?: string | string[];
  args_pattern?: string;
}

interface PolicyRule {
  name: string;
  description?: string;
  priority?: number;
  action: GovernanceAction;
  match?: PolicyMatch;
  /** AGT-style condition string. Supported subset: `FIELD in [..]`, `FIELD == '..'`, `FIELD matches '..'`. */
  condition?: string;
}

interface PolicyDocument {
  apiVersion?: string;
  name?: string;
  default_action?: 'allow' | 'deny';
  rules?: PolicyRule[];
}

function asArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Map an AGT condition field name onto the evaluated record. */
function fieldValue(field: string, rec: { toolName: string; actionType: string; agentId?: string; argsText: string }): string | undefined {
  switch (field) {
    case 'tool_name':
    case 'tool':
    case 'action.tool':
      return rec.toolName;
    case 'action_type':
    case 'action.type':
      return rec.actionType;
    case 'agent_id':
    case 'agent.id':
      return rec.agentId;
    case 'input_text':
      return rec.argsText;
    default:
      return undefined;
  }
}

/**
 * Evaluate the safe subset of an AGT `condition:` string. Returns null (no decision) for
 * any syntax outside the allow-list so an unparseable rule can never silently match.
 */
function conditionMatches(
  condition: string,
  rec: { toolName: string; actionType: string; agentId?: string; argsText: string },
  logger?: Logger,
): boolean | null {
  // FIELD in ['a', 'b', ...]
  const inMatch = /^([\w.]+)\s+in\s+\[(.*)\]$/.exec(condition.trim());
  if (inMatch) {
    const value = fieldValue(inMatch[1], rec);
    if (value === undefined) return false;
    const list = inMatch[2]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter((s) => s.length > 0);
    return list.includes(value);
  }
  // FIELD == 'value'
  const eqMatch = /^([\w.]+)\s*==\s*['"](.*)['"]$/.exec(condition.trim());
  if (eqMatch) {
    return fieldValue(eqMatch[1], rec) === eqMatch[2];
  }
  // FIELD matches 'regex'
  const reMatch = /^([\w.]+)\s+matches\s+['"](.*)['"]$/.exec(condition.trim());
  if (reMatch) {
    const value = fieldValue(reMatch[1], rec);
    if (value === undefined) return false;
    try {
      return new RegExp(reMatch[2]).test(value);
    } catch {
      logger?.warn?.(`[governance] invalid regex in condition: ${condition}`);
      return null;
    }
  }
  logger?.warn?.(`[governance] unsupported condition (ignored): ${condition}`);
  return null;
}

/** In-process evaluator for the AGT policy subset. Deterministic, no external calls (IL5-safe). */
export class LocalPolicyProvider implements GovernanceProvider {
  private readonly rules: PolicyRule[];
  private readonly defaultAction: 'allow' | 'deny';

  constructor(doc: PolicyDocument, private readonly logger?: Logger) {
    this.defaultAction = doc.default_action ?? 'allow';
    // Higher priority first; stable for equal priority.
    this.rules = [...(doc.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  evaluate(input: GovernanceInput): GovernanceDecision {
    const rec = {
      toolName: input.toolName,
      actionType: input.actionType ?? deriveActionType(input),
      agentId: input.agentId,
      argsText: safeStringify(input.args),
    };

    for (const rule of this.rules) {
      if (this.ruleMatches(rule, rec)) {
        return {
          allowed: rule.action === 'allow',
          action: rule.action,
          rule: rule.name,
          reason: rule.description,
        };
      }
    }
    return {
      allowed: this.defaultAction === 'allow',
      action: this.defaultAction,
      rule: 'default',
      reason: `default_action=${this.defaultAction}`,
    };
  }

  private ruleMatches(rule: PolicyRule, rec: { toolName: string; actionType: string; agentId?: string; argsText: string }): boolean {
    if (rule.match) {
      const m = rule.match;
      const toolNames = asArray(m.tool_name);
      if (toolNames.length && !toolNames.includes(rec.toolName)) return false;
      const actionTypes = asArray(m.action_type);
      if (actionTypes.length && !actionTypes.includes(rec.actionType)) return false;
      const agentIds = asArray(m.agent_id);
      if (agentIds.length && (rec.agentId === undefined || !agentIds.includes(rec.agentId))) return false;
      if (m.args_pattern) {
        try {
          if (!new RegExp(m.args_pattern).test(rec.argsText)) return false;
        } catch {
          this.logger?.warn?.(`[governance] invalid args_pattern in rule '${rule.name}'`);
          return false;
        }
      }
      // An empty match object matches nothing (avoids accidental catch-all).
      return Boolean(toolNames.length || actionTypes.length || agentIds.length || m.args_pattern);
    }
    if (rule.condition) {
      return conditionMatches(rule.condition, rec, this.logger) === true;
    }
    return false;
  }
}

function deriveActionType(input: GovernanceInput): string {
  const args = input.args;
  if (args && typeof args === 'object' && 'action' in args) {
    const a = (args as Record<string, unknown>).action;
    if (typeof a === 'string') return a;
  }
  return input.toolName;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

function findPolicyFile(explicit?: string): string | undefined {
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const rel of ['governance/policy.yaml', 'governance/policy.yml', 'governance/policy.json', 'policy.yaml']) {
      const candidate = path.join(dir, rel);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parsePolicyFile(filePath: string): PolicyDocument {
  const text = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.json')) return JSON.parse(text) as PolicyDocument;
  // YAML support is an optional dependency, loaded only when governance is enabled with a
  // YAML policy — so the default/disabled path never requires `js-yaml`.
  let yaml: { load(input: string): unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    yaml = require('js-yaml') as { load(input: string): unknown };
  } catch {
    throw new Error(
      `Policy '${filePath}' is YAML but 'js-yaml' is not installed. Run 'npm i js-yaml' or supply a .json policy.`,
    );
  }
  return (yaml.load(text) ?? {}) as PolicyDocument;
}

// ---------------------------------------------------------------------------
// Audit sink (hash-chained)
// ---------------------------------------------------------------------------

/** Default sink: logs a hash-chained JSON line. Replace with an IL5 Monitor/Storage sink in production. */
export class ConsoleHashChainAuditSink implements AuditSink {
  private prevHash = 'GENESIS';
  constructor(private readonly logger: Logger = console) {}
  write(entry: AuditEntry): void {
    this.logger.info?.(`[governance:audit] ${JSON.stringify(entry)}`);
    this.prevHash = entry.hash;
  }
  /** Compute the next chained hash for a record (called by {@link Governance}). */
  static chain(prevHash: string, record: Omit<AuditEntry, 'hash'>): string {
    return createHash('sha256').update(prevHash).update(JSON.stringify(record)).digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Governance facade + composition helpers
// ---------------------------------------------------------------------------

export interface GovernanceOptions {
  enabled?: boolean;
  policyPath?: string;
  provider?: GovernanceProvider;
  auditSink?: AuditSink;
  logger?: Logger;
  /** When an evaluation throws, allow the call instead of denying. Default false (fail-closed). */
  failOpen?: boolean;
}

/** True when governance is switched on (`GOVERNANCE_ENABLED=true`). */
export function isGovernanceEnabled(): boolean {
  return (process.env.GOVERNANCE_ENABLED || 'false').toLowerCase() === 'true';
}

/** Orchestrates evaluate → audit → allow/deny. Construct once and share across wrappers. */
export class Governance {
  readonly enabled: boolean;
  private readonly logger: Logger;
  private readonly failOpen: boolean;
  private readonly auditSink: AuditSink;
  private readonly explicitProvider?: GovernanceProvider;
  private readonly policyPath?: string;
  private provider?: GovernanceProvider;
  private auditPrevHash = 'GENESIS';

  constructor(opts: GovernanceOptions = {}) {
    this.enabled = opts.enabled ?? isGovernanceEnabled();
    this.logger = opts.logger ?? console;
    this.failOpen = opts.failOpen ?? (process.env.GOVERNANCE_FAIL_OPEN || 'false').toLowerCase() === 'true';
    this.auditSink = opts.auditSink ?? new ConsoleHashChainAuditSink(this.logger);
    this.explicitProvider = opts.provider;
    this.policyPath = opts.policyPath ?? process.env.GOVERNANCE_POLICY_PATH;
  }

  private getProvider(): GovernanceProvider {
    if (this.explicitProvider) return this.explicitProvider;
    if (this.provider) return this.provider;

    const kind = (process.env.GOVERNANCE_PROVIDER || 'local').toLowerCase();
    if (kind === 'agt-sdk') {
      // SEAM: vendor `@microsoft/agent-governance-sdk`, then back this with its
      // PolicyEvaluator / govern() once it is IL5-reviewed. Until then, fail loudly
      // rather than silently allowing.
      throw new Error(
        "GOVERNANCE_PROVIDER=agt-sdk is not wired yet. Vendor '@microsoft/agent-governance-sdk' and implement an adapter, or use the default 'local' provider.",
      );
    }

    const file = findPolicyFile(this.policyPath);
    if (!file) {
      throw new Error(
        `Governance is enabled but no policy file was found (set GOVERNANCE_POLICY_PATH or add governance/policy.yaml).`,
      );
    }
    this.logger.info?.(`[governance] loading policy: ${file}`);
    this.provider = new LocalPolicyProvider(parsePolicyFile(file), this.logger);
    return this.provider;
  }

  /** Evaluate a single tool call and write an audit record. Never throws when failOpen. */
  async evaluate(input: GovernanceInput): Promise<GovernanceDecision> {
    if (!this.enabled) return { allowed: true, action: 'allow', rule: 'disabled' };
    let decision: GovernanceDecision;
    try {
      decision = await this.getProvider().evaluate(input);
    } catch (err) {
      this.logger.warn?.(`[governance] evaluation error: ${(err as Error).message}`);
      decision = this.failOpen
        ? { allowed: true, action: 'allow', rule: 'error:fail-open' }
        : { allowed: false, action: 'deny', rule: 'error:fail-closed', reason: (err as Error).message };
    }
    await this.recordAudit(input, decision);
    return decision;
  }

  private async recordAudit(input: GovernanceInput, decision: GovernanceDecision): Promise<void> {
    const record: Omit<AuditEntry, 'hash'> = {
      ts: new Date().toISOString(),
      toolName: input.toolName,
      actionType: input.actionType ?? deriveActionType(input),
      agentId: input.agentId ?? process.env.AGENT_ID,
      tenantId: input.tenantId,
      traceId: input.traceId,
      action: decision.action,
      allowed: decision.allowed,
      rule: decision.rule,
      reason: decision.reason,
      prevHash: this.auditPrevHash,
    };
    const hash = ConsoleHashChainAuditSink.chain(this.auditPrevHash, record);
    this.auditPrevHash = hash;
    try {
      await this.auditSink.write({ ...record, hash });
    } catch (err) {
      this.logger.warn?.(`[governance] audit write failed: ${(err as Error).message}`);
    }
  }
}

/** Lazily-created shared instance for the convenience wrappers below. */
let _shared: Governance | undefined;
export function getGovernance(): Governance {
  if (!_shared) _shared = new Governance();
  return _shared;
}

/** Override the shared instance (tests / custom audit sinks). */
export function setGovernance(g: Governance): void {
  _shared = g;
}

/**
 * Agent-side gate. Wrap the loop's `callTool` so every model-driven tool call is
 * policy-checked and audited. Denied calls throw {@link GovernanceDenied}. When governance
 * is disabled the original function is returned unchanged (zero overhead in local dev).
 */
export function governedToolCaller(
  callTool: (name: string, args: unknown) => Promise<unknown>,
  governance: Governance = getGovernance(),
): (name: string, args: unknown) => Promise<unknown> {
  if (!governance.enabled) return callTool;
  return async (name: string, args: unknown): Promise<unknown> => {
    const decision = await governance.evaluate({ toolName: name, args });
    if (!decision.allowed) throw new GovernanceDenied(decision);
    return callTool(name, args);
  };
}

/**
 * Server-side gate. Wrap a single MCP tool's handler. Denied calls return an `isError`
 * {@link ToolResult} (the MCP-idiomatic way to surface a tool failure) rather than throwing
 * across the JSON-RPC boundary. Pass-through when governance is disabled.
 */
export function governTool(tool: McpTool, governance: Governance = getGovernance()): McpTool {
  if (!governance.enabled) return tool;
  const original = tool.handler;
  return {
    ...tool,
    handler: async (args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> => {
      const decision = await governance.evaluate({
        toolName: tool.name,
        args,
        tenantId: ctx.tenantId,
        traceId: ctx.traceId,
      });
      if (!decision.allowed) {
        return {
          content: [{ type: 'text', text: `Tool ${tool.name} denied by policy '${decision.rule}'${decision.reason ? `: ${decision.reason}` : ''}` }],
          isError: true,
        };
      }
      return original(args, ctx);
    },
  };
}

/** Wrap every tool on a server with {@link governTool}. Use as `registerMcpServer(governServer(def), ...)`. */
export function governServer(server: McpServerDef, governance: Governance = getGovernance()): McpServerDef {
  if (!governance.enabled) return server;
  return { ...server, tools: server.tools.map((t) => governTool(t, governance)) };
}

/**
 * Convenience for agent hosts: a governed `callTool` that dispatches to a remote MCP
 * capability server over Streamable HTTP. Equivalent to
 * `governedToolCaller(mcpToolCaller(serverUrl))`.
 */
export function governedMcpToolCaller(
  serverUrl: string,
  governance: Governance = getGovernance(),
): (name: string, args: unknown) => Promise<unknown> {
  return governedToolCaller(mcpToolCaller(serverUrl), governance);
}
