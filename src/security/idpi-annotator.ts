// ─── IdpiAnnotator ───────────────────────────────────────────────────────────
//
// Indirect Prompt Injection (IDPI) annotation layer. Scans arbitrary text
// content retrieved from web pages for patterns that attempt to hijack agent
// behaviour and surfaces matches via response metadata. **This layer never
// blocks** — it annotates results so a downstream consumer (the agent host,
// audit log, or human reviewer) can decide what to do with the matched
// content.
//
// Each pattern rule is named with a confidence weight (0.0–1.0). A result is
// flagged unsafe in metadata when any matched pattern has confidence > 0.5.
// Tool execution is NOT halted when unsafe=true; the tool's output reaches
// the caller with `_meta.idpiUnsafe = true` and the threat list. T35
// (2026-04-26) renamed this from "IdpiScanner" to drop the framing that
// implied blocking semantics.
//
// To convert this to a true blocking scanner, the path is well-defined: add
// a configurable confidence threshold + throw an `IdpiBlockedError` when a
// pattern exceeds it. That decision is deferred — false-positive risk needs
// a threat-model review first.

export interface IdpiThreat {
  pattern: string;
  confidence: number;
  match: string;
}

export interface AnnotationResult {
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

// ─── IdpiAnnotator ───────────────────────────────────────────────────────────

export class IdpiAnnotator {
  /**
   * Annotate a text string with any indirect-prompt-injection patterns it
   * matches. Returns a result with:
   * - `safe` — false when any matched threat's confidence exceeds 0.5
   * - `threats` — all matched threats with their pattern name, confidence,
   *               and the excerpt that triggered the match
   *
   * The caller (server.ts post-execution) attaches the result to the tool
   * response's `_meta` and continues — it does NOT throw or block on
   * `safe: false`. See class header for the rationale.
   */
  annotate(text: string): AnnotationResult {
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
   * Invalidate any memoized annotation state for this tool.
   *
   * IdpiAnnotator is stateless — this is a no-op kept for API symmetry with
   * future engine-aware caching.
   */
  invalidateForDegradation(_toolName: string): void {
    // Stateless; reserved for future caching semantics.
  }
}
