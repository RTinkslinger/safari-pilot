import { HumanApprovalRequiredError } from '../errors.js';

// ─── HumanApproval ────────────────────────────────────────────────────────────
//
// Detects sensitive actions that require human confirmation before proceeding.
// Each category represents a class of action where agent autonomy is insufficient
// and a human must explicitly approve before the action is performed.
//
// `requiresApproval` returns a structured result so callers can inspect reason
// and category. `assertApproved` wraps it and throws HumanApprovalRequiredError
// for use as a hard guard in tool pipelines.

export interface ApprovalResult {
  required: boolean;
  reason?: string;
  category?: string;
}

// ─── Pattern Registry ─────────────────────────────────────────────────────────

/** OAuth / SSO provider URL patterns. */
const OAUTH_URL_PATTERNS: RegExp[] = [
  /accounts\.google\.com\/o\/oauth/i,
  /login\.microsoftonline\.com/i,
  /github\.com\/login\/oauth/i,
  /auth0\.com/i,
  /okta\.com/i,
  /login\.live\.com/i,
  /appleid\.apple\.com/i,
  /facebook\.com\/dialog\/oauth/i,
];

/** Financial checkout / payment URL patterns. */
const FINANCIAL_URL_PATTERNS: RegExp[] = [
  /paypal\.com\/checkout/i,
  /paypal\.com\/pay/i,
  /stripe\.com\/pay/i,
  /checkout\.stripe\.com/i,
  /pay\.amazon\.com/i,
  /venmo\.com\/pay/i,
];

/** Sensitive financial form field names. */
const FINANCIAL_FIELD_NAMES: RegExp[] = [
  /^card[_-]?number$/i,
  /^cvv$/i,
  /^cvc$/i,
  /^account[_-]?number$/i,
  /^routing[_-]?number$/i,
  /^bank[_-]?account$/i,
  /^credit[_-]?card$/i,
];

/** Downloadable file extensions that require approval. */
const DOWNLOAD_EXTENSIONS = /\.(exe|dmg|pkg|zip|tar|gz|rar|deb|rpm|msi|app|apk)(\?.*)?$/i;

/** Account-mutating / high-risk URL path patterns. */
const ACCOUNT_SETTINGS_PATTERNS: RegExp[] = [
  /\/settings\/security/i,
  /\/account\/delete/i,
  /\/password\/change/i,
  /\/password\/reset/i,
  /\/delete[_-]?account/i,
  /\/security\/two-factor/i,
];

/** Sensitive field names in form submissions. */
const SENSITIVE_FORM_FIELDS: RegExp[] = [
  /^password$/i,
  /^passwd$/i,
  /^pass$/i,
  /^ssn$/i,
  /^social[_-]?security/i,
  /^credit[_-]?card/i,
  /^card[_-]?number/i,
  /^cvv$/i,
  /^cvc$/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// ─── HumanApproval ───────────────────────────────────────────────────────────

export class HumanApproval {
  /**
   * Inspect an action/url/params combination and return whether human approval
   * is required. Returns `{ required: false }` for benign actions, or
   * `{ required: true, reason, category }` for sensitive ones.
   *
   * Does NOT throw — use `assertApproved` for a throwing guard.
   */
  requiresApproval(
    action: string,
    url: string,
    params?: Record<string, unknown>,
  ): ApprovalResult {
    // 1. OAuth / SSO flows
    if (matchesAny(url, OAUTH_URL_PATTERNS)) {
      return {
        required: true,
        category: 'oauth',
        reason: 'URL matches an OAuth/SSO authentication flow',
      };
    }

    // 2. Financial checkout / payment pages
    if (matchesAny(url, FINANCIAL_URL_PATTERNS)) {
      return {
        required: true,
        category: 'financial',
        reason: 'URL matches a financial payment or checkout flow',
      };
    }

    // 3. Financial form fields in params
    if (params !== undefined) {
      const fieldNames = Object.keys(params);
      const sensitiveField = fieldNames.find((f) => matchesAny(f, FINANCIAL_FIELD_NAMES));
      if (sensitiveField !== undefined) {
        return {
          required: true,
          category: 'financial',
          reason: `Request contains sensitive financial field: "${sensitiveField}"`,
        };
      }
    }

    // 4. Download actions or downloadable file extensions in URL
    const isDownloadAction = action === 'download' || action === 'safari_wait_for_download';
    if (isDownloadAction || DOWNLOAD_EXTENSIONS.test(url)) {
      return {
        required: true,
        category: 'download',
        reason: 'Action involves downloading a file',
      };
    }

    // 5. Account settings / destructive account operations
    if (matchesAny(url, ACCOUNT_SETTINGS_PATTERNS)) {
      return {
        required: true,
        category: 'account_settings',
        reason: 'URL matches a sensitive account settings or deletion path',
      };
    }

    // 6. Form submissions with sensitive field names
    const isFormAction = action === 'submit' || action === 'post'
      || action === 'safari_fill' || action === 'safari_click';
    if (isFormAction) {
      if (params !== undefined) {
        const fieldNames = Object.keys(params);
        const sensitiveField = fieldNames.find((f) => matchesAny(f, SENSITIVE_FORM_FIELDS));
        if (sensitiveField !== undefined) {
          return {
            required: true,
            category: 'form_submission',
            reason: `Form submission contains sensitive field: "${sensitiveField}"`,
          };
        }
      }
    }

    return { required: false };
  }

  /**
   * Guard variant: throws `HumanApprovalRequiredError` when approval is needed.
   * Use in tool pipelines where blocking is the correct behaviour.
   */
  assertApproved(action: string, url: string, params?: Record<string, unknown>): void {
    const result = this.requiresApproval(action, url, params);
    if (result.required) {
      const domain = extractDomain(url);
      throw new HumanApprovalRequiredError(action, domain);
    }
  }
}
