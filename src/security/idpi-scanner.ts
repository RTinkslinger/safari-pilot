// ─── IdpiScanner ─────────────────────────────────────────────────────────────
//
// Indirect Prompt Injection (IDPI) defence layer. Scans arbitrary text content
// retrieved from web pages for patterns that attempt to hijack agent behaviour.
//
// Each detector is a named rule with a confidence weight (0.0–1.0). A result
// is marked unsafe when any matched threat has confidence > 0.5.

export interface IdpiThreat {
  pattern: string;
  confidence: number;
  match: string;
}

export interface ScanResult {
  safe: boolean;
  threats: IdpiThreat[];
}

interface PatternRule {
  name: string;
  regex: RegExp;
  confidence: number;
}

// ─── Pattern Registry ─────────────────────────────────────────────────────────

const PATTERN_RULES: PatternRule[] = [
  // 1. Instruction override attempts
  {
    name: 'instruction_override',
    regex: /ignore\s+(previous|prior|all\s+prior|above)\s+instructions?|disregard\s+(the\s+)?(above|previous|prior)/gi,
    confidence: 0.95,
  },

  // 2. Role reassignment attempts
  {
    name: 'role_reassignment',
    regex: /you\s+are\s+now\s+(a|an)\s+\w+|you\s+are\s+a\s+\w+/gi,
    confidence: 0.80,
  },

  // 3. Fake system prompt injection
  {
    name: 'fake_system_prompt',
    regex: /^system:|^SYSTEM:|###\s*System\b/gim,
    confidence: 0.90,
  },

  // 4. Base64-encoded payloads (50+ contiguous base64 chars)
  {
    name: 'base64_payload',
    regex: /[A-Za-z0-9+/]{50,}={0,2}/g,
    confidence: 0.65,
  },

  // 5. Secrecy / concealment instructions
  {
    name: 'secrecy_instruction',
    regex: /do\s+not\s+tell\s+(the\s+)?user|keep\s+this\s+secret|don['']?t\s+mention\s+this/gi,
    confidence: 0.90,
  },

  // 6. HTML-encoded instruction sequences (&#x...; or &#...;)
  {
    name: 'html_encoded_instruction',
    regex: /(?:&#x[0-9a-fA-F]{2,4};){4,}|(?:&#\d{2,5};){4,}/g,
    confidence: 0.75,
  },

  // 7. CSS content property with non-trivial text
  {
    name: 'css_content_injection',
    regex: /content\s*:\s*["'][^"']{10,}["']/gi,
    confidence: 0.70,
  },

  // 8. Hidden text patterns via CSS
  {
    name: 'hidden_text',
    regex: /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt|em|rem)?/gi,
    confidence: 0.60,
  },

  // 9. Unicode homoglyph attacks — non-ASCII characters mixed into Latin words
  {
    name: 'unicode_homoglyph',
    regex: /[^\x00-\x7F\s]{1}[a-zA-Z]{2,}|[a-zA-Z]{2,}[^\x00-\x7F\s]{1}/g,
    confidence: 0.75,
  },
];

// ─── IdpiScanner ─────────────────────────────────────────────────────────────

export class IdpiScanner {
  /**
   * Scan a text string for indirect prompt injection patterns.
   *
   * Returns a result with:
   * - `safe` — false when any threat confidence exceeds 0.5
   * - `threats` — all matched threats with their pattern name, confidence, and
   *               the excerpt that triggered the match
   */
  scan(text: string): ScanResult {
    const threats: IdpiThreat[] = [];

    for (const rule of PATTERN_RULES) {
      // Reset lastIndex so repeated calls work correctly on global regexes
      rule.regex.lastIndex = 0;

      let match: RegExpExecArray | null;
      const seen = new Set<string>();

      while ((match = rule.regex.exec(text)) !== null) {
        const excerpt = match[0].slice(0, 100); // cap excerpt length
        if (seen.has(excerpt)) continue; // deduplicate identical matches
        seen.add(excerpt);

        threats.push({
          pattern: rule.name,
          confidence: rule.confidence,
          match: excerpt,
        });

        // Prevent infinite loops on zero-length matches
        if (match.index === rule.regex.lastIndex) {
          rule.regex.lastIndex++;
        }
      }
    }

    const safe = threats.every((t) => t.confidence <= 0.5);

    return { safe, threats };
  }

  /**
   * Invalidate any memoized scan state for this tool.
   *
   * At commit 1a this is a no-op: IdpiScanner is stateless. Reserved for future
   * engine-aware scan caching.
   */
  invalidateForDegradation(_toolName: string): void {
    // Stateless at 1a; reserved for future caching semantics.
  }
}
