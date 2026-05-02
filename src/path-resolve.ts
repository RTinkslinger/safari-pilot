/**
 * Phase 5A · 5A.1 — pure path resolution helpers.
 *
 * resolveUploadPath: expand ~ → homedir, reject relative paths and NUL
 * bytes, fs.realpath-resolve symlinks, surface a warning when realpath
 * diverges from the input (forensic trail per spec security model).
 *
 * findClosestSibling (stretch goal): on ENOENT, read parent dir entries,
 * return the smallest-Levenshtein-distance match (only when distance ≤ 3
 * to avoid junk suggestions).
 */
import { realpathSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, basename } from 'node:path';
import {
  FileUploadPathNotAbsoluteError,
  FileUploadPathNotReadableError,
} from './errors.js';

export interface ResolvedPath {
  absolute: string;
  warnings: string[];
}

export function resolveUploadPath(input: string): ResolvedPath {
  // NUL bytes are a path-injection vector. Spaces are LEGAL in macOS paths
  // (e.g., /Users/Aakash/Claude Projects/...) — do NOT reject them.
  if (input.includes('\x00')) {
    throw new FileUploadPathNotReadableError(input);
  }
  let expanded: string;
  if (input === '~') {
    expanded = homedir();
  } else if (input.startsWith('~/')) {
    expanded = join(homedir(), input.slice(2));
  } else if (input.startsWith('~')) {
    // ~user form — not supported.
    throw new FileUploadPathNotAbsoluteError(input);
  } else if (!isAbsolute(input)) {
    throw new FileUploadPathNotAbsoluteError(input);
  } else {
    expanded = input;
  }

  const warnings: string[] = [];
  let absolute = expanded;
  try {
    const real = realpathSync(expanded);
    if (real !== expanded) {
      warnings.push(`symlink resolved: ${expanded} -> ${real}`);
      absolute = real;
    }
  } catch {
    // realpath fails on non-existent paths — that's not our concern here;
    // caller's fs.stat will raise the proper ENOENT typed error.
  }

  return { absolute, warnings };
}

// Stretch-goal helper — keeping under 30 lines per spec budget.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[bl];
}

export function findClosestSibling(missingPath: string): string | undefined {
  const dir = dirname(missingPath);
  const target = basename(missingPath);
  if (!existsSync(dir)) return undefined;
  let bestMatch: string | undefined;
  let bestDistance = Infinity;
  for (const entry of readdirSync(dir)) {
    const dist = levenshtein(target.toLowerCase(), entry.toLowerCase());
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = entry;
    }
  }
  if (bestMatch === undefined || bestDistance > 3) return undefined;
  return join(dir, bestMatch);
}
