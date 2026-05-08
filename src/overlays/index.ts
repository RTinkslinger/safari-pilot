import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type {
  AllowlistFile,
  OverlayPattern,
  PatternRegistryEntry,
} from './types.js';

const VALID_CATEGORIES = new Set(['cookie-consent', 'registration-wall', 'app-install', 'paywall']);
const VALID_SIGNAL_TYPES = new Set([
  'selector',
  'aria-label-substring',
  'aria-role',
  'fixed-position',
  'z-index-above',
]);

export function loadAllowlistFile(path: string): AllowlistFile {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as AllowlistFile;
  validateAllowlistFile(parsed, basename(path));
  return parsed;
}

function validateAllowlistFile(file: AllowlistFile, filename: string): void {
  if (typeof file.version !== 'number' || file.version < 1) {
    throw new Error(`${filename}: version must be a positive integer`);
  }
  if (!VALID_CATEGORIES.has(file.category)) {
    throw new Error(`${filename}: invalid category "${file.category}"`);
  }
  if (!Array.isArray(file.patterns)) {
    throw new Error(`${filename}: patterns must be an array`);
  }
  for (const pattern of file.patterns) {
    validatePattern(pattern, filename);
  }
}

function validatePattern(p: OverlayPattern, filename: string): void {
  if (!p.id || typeof p.id !== 'string') {
    throw new Error(`${filename}: pattern missing id`);
  }
  if (!Array.isArray(p.signals) || p.signals.length < 2) {
    throw new Error(
      `${filename}: pattern "${p.id}" must have at least 2 signals (two-signal rule). Single-signal patterns are rejected to prevent false positives.`,
    );
  }
  for (const signal of p.signals) {
    if (!VALID_SIGNAL_TYPES.has(signal.type)) {
      throw new Error(`${filename}: pattern "${p.id}" has invalid signal type "${signal.type}"`);
    }
    if (typeof signal.value !== 'string') {
      throw new Error(`${filename}: pattern "${p.id}" signal value must be a string`);
    }
  }
  if (!p.dismiss || !['click', 'esc-key', 'remove-node'].includes(p.dismiss.action)) {
    throw new Error(`${filename}: pattern "${p.id}" has invalid dismiss action`);
  }
  if (!p.verify || p.verify.type !== 'node-removed') {
    throw new Error(`${filename}: pattern "${p.id}" must have verify.type === 'node-removed'`);
  }
  if (typeof p.verify.stabilityMs !== 'number' || p.verify.stabilityMs < 0) {
    throw new Error(`${filename}: pattern "${p.id}" stabilityMs must be non-negative number`);
  }
}

export function buildRegistry(files: AllowlistFile[]): PatternRegistryEntry[] {
  const entries: PatternRegistryEntry[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    for (const pattern of file.patterns) {
      if (seenIds.has(pattern.id)) {
        throw new Error(`Duplicate pattern id across allowlist files: "${pattern.id}"`);
      }
      seenIds.add(pattern.id);
      entries.push({
        ...pattern,
        category: file.category,
        fileVersion: file.version,
      });
    }
  }
  return entries;
}

export function loadAllAllowlists(baseDir: string): PatternRegistryEntry[] {
  const filenames = ['cookie-consent.json', 'registration-walls.json', 'app-install.json', 'paywalls.json'];
  const files: AllowlistFile[] = [];
  for (const name of filenames) {
    const file = loadAllowlistFile(`${baseDir}/${name}`);
    console.error(`[safari-pilot] loaded allowlist ${name} version ${file.version} (${file.patterns.length} patterns)`);
    files.push(file);
  }
  return buildRegistry(files);
}
