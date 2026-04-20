import type { DomainPolicy as DomainPolicyRule } from '../types.js';

// ─── DomainPolicy ─────────────────────────────────────────────────────────────
//
// Stores per-domain trust rules and evaluates URLs against them.
// Supports glob patterns (*.example.com) and built-in rules for sensitive
// domains (banking, payments) that default to untrusted + private window.

type TrustLevel = 'trusted' | 'untrusted' | 'unknown';

interface PolicyRule {
  trust: TrustLevel;
  privateWindow: boolean;
  extensionAllowed: boolean;
  maxActionsPerMinute: number;
}

export interface EvaluateResult {
  trust: TrustLevel;
  privateWindow: boolean;
  extensionAllowed: boolean;
  maxActionsPerMinute: number;
  /** True when the domain is in the operator's explicit blocked list. */
  blocked: boolean;
}

const DEFAULT_MAX_ACTIONS = 60;

export interface DomainPolicyOptions {
  blocked?: string[];
  trusted?: string[];
  defaultMaxActionsPerMinute?: number;
}

const BASE_DEFAULT_POLICY: PolicyRule = {
  trust: 'unknown',
  privateWindow: false,
  extensionAllowed: false,
  maxActionsPerMinute: DEFAULT_MAX_ACTIONS,
};

// Built-in sensitive domain patterns → untrusted, force private window
const SENSITIVE_PATTERNS: string[] = [
  '*.bank.*',
  '*.banking.*',
  'paypal.com',
  '*.paypal.com',
  'stripe.com',
  '*.stripe.com',
  'venmo.com',
  '*.venmo.com',
  'chase.com',
  '*.chase.com',
  'wellsfargo.com',
  '*.wellsfargo.com',
  'bankofamerica.com',
  '*.bankofamerica.com',
  'citibank.com',
  '*.citibank.com',
];

const SENSITIVE_POLICY: PolicyRule = {
  trust: 'untrusted',
  privateWindow: true,
  extensionAllowed: false,
  maxActionsPerMinute: 30,
};

// ── Glob matching ─────────────────────────────────────────────────────────────

/**
 * Convert a glob pattern (only * wildcard supported) to a RegExp.
 * *.example.com matches sub.example.com but NOT example.com itself.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]+');
  return new RegExp(`^${escaped}$`, 'i');
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // If it's already a hostname (no scheme), return as-is
    return url.toLowerCase();
  }
}

function matchesDomain(pattern: string, hostname: string): boolean {
  if (pattern.includes('*')) {
    return globToRegex(pattern).test(hostname);
  }
  return pattern.toLowerCase() === hostname;
}

// ─── DomainPolicy class ───────────────────────────────────────────────────────

export class DomainPolicy {
  private rules: Map<string, PolicyRule> = new Map();
  private readonly defaultPolicy: PolicyRule;
  private readonly blockedPatterns: Set<string> = new Set();

  constructor(options: DomainPolicyOptions = {}) {
    const maxActions = options.defaultMaxActionsPerMinute ?? DEFAULT_MAX_ACTIONS;
    this.defaultPolicy = { ...BASE_DEFAULT_POLICY, maxActionsPerMinute: maxActions };

    for (const pattern of SENSITIVE_PATTERNS) {
      this.rules.set(pattern, { ...SENSITIVE_POLICY });
    }

    // Config-supplied domains must not override hardcoded sensitive protections
    for (const domain of options.blocked ?? []) {
      this.blockedPatterns.add(domain);
      if (!this.rules.has(domain)) {
        this.rules.set(domain, {
          trust: 'untrusted',
          privateWindow: false,
          extensionAllowed: false,
          maxActionsPerMinute: maxActions,
        });
      }
    }

    for (const domain of options.trusted ?? []) {
      if (!this.rules.has(domain)) {
        this.rules.set(domain, {
          trust: 'trusted',
          privateWindow: false,
          extensionAllowed: true,
          maxActionsPerMinute: maxActions,
        });
      }
    }
  }

  // ── Rule management ─────────────────────────────────────────────────────────

  addRule(domain: string, policy: Partial<PolicyRule>): void {
    const existing = this.rules.get(domain) ?? { ...this.defaultPolicy };
    this.rules.set(domain, { ...existing, ...policy });
  }

  removeRule(domain: string): void {
    this.rules.delete(domain);
  }

  // ── Evaluation ──────────────────────────────────────────────────────────────

  /**
   * Evaluate a URL against all stored rules.
   * Rules are checked in insertion order; first match wins.
   * Falls back to DEFAULT_POLICY if no rule matches.
   */
  evaluate(url: string): EvaluateResult {
    const hostname = extractHostname(url);

    for (const [pattern, rule] of this.rules) {
      if (matchesDomain(pattern, hostname)) {
        const blocked = this.blockedPatterns.has(pattern);
        return { ...rule, blocked };
      }
    }

    return { ...this.defaultPolicy, blocked: false };
  }

  // ── Introspection ────────────────────────────────────────────────────────────

  getRules(): Array<{ domain: string } & PolicyRule> {
    return Array.from(this.rules.entries()).map(([domain, rule]) => ({ domain, ...rule }));
  }
}
