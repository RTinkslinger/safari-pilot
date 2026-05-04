export const MAX_PACK_NAME_LEN = 64;
export const MAX_PACK_BODY_BYTES = 32 * 1024;
const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const FORBIDDEN_BODY_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  { regex: /\beval\s*\(/, reason: 'eval is forbidden — use direct DOM access' },
  { regex: /\bnew\s+Function\b/, reason: 'Function constructor is forbidden — body itself is wrapped in Function() by the runtime' },
  { regex: /\bimport\s*\(/, reason: 'dynamic import is forbidden' },
];

export function validatePackName(name: string): void {
  if (!name) throw new Error('selectorPack name cannot be empty');
  if (name.length > MAX_PACK_NAME_LEN) {
    throw new Error(`selectorPack name length exceeds ${MAX_PACK_NAME_LEN} chars`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`selectorPack name invalid: must match ${NAME_PATTERN.source}`);
  }
}

export function validatePackBody(body: string): void {
  if (!body) throw new Error('selectorPack body cannot be empty');
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_PACK_BODY_BYTES) {
    throw new Error(`selectorPack body size ${bytes} exceeds limit ${MAX_PACK_BODY_BYTES}`);
  }
  for (const { regex, reason } of FORBIDDEN_BODY_PATTERNS) {
    if (regex.test(body)) {
      throw new Error(`selectorPack body rejected: ${reason}`);
    }
  }
}
