import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateTask, type BenchmarkTask, type PreflightResult } from './types.js';

// ─── Exported Types ───────────────────────────────────────────────────────────

export interface LoadResult {
  tasks: BenchmarkTask[];
  errors: string[];
}

export interface FilterResult {
  eligible: BenchmarkTask[];
  skipped: Array<{ task: BenchmarkTask; reason: string }>;
}

// ─── Roadmap gate → required tool mapping ─────────────────────────────────────

const ROADMAP_GATE_TOOLS: Record<string, string> = {
  'file-downloads': 'safari_wait_for_download',
  'pdf-export': 'safari_export_pdf',
  'video-recording': 'safari_start_recording',
  'route-modification': 'safari_route_request',
};

// ─── loadTasks ────────────────────────────────────────────────────────────────

/**
 * Reads all subdirectories of tasksDir, parses every .json file found,
 * validates each parsed object as a BenchmarkTask, and returns the
 * successfully loaded tasks alongside any per-file error strings.
 */
export async function loadTasks(tasksDir: string): Promise<LoadResult> {
  const tasks: BenchmarkTask[] = [];
  const errors: string[] = [];

  let subdirs: string[];
  try {
    subdirs = readdirSync(tasksDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    errors.push(`Failed to read tasks directory "${tasksDir}": ${String(err)}`);
    return { tasks, errors };
  }

  for (const subdir of subdirs) {
    const categoryDir = join(tasksDir, subdir);
    let files: string[];
    try {
      files = readdirSync(categoryDir).filter((f) => f.endsWith('.json'));
    } catch (err) {
      errors.push(`Failed to read category directory "${categoryDir}": ${String(err)}`);
      continue;
    }

    for (const file of files) {
      const filePath = join(categoryDir, file);
      let raw: string;
      try {
        raw = readFileSync(filePath, 'utf-8');
      } catch (err) {
        errors.push(`${filePath}: Failed to read file: ${String(err)}`);
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        errors.push(`${filePath}: JSON parse error: ${String(err)}`);
        continue;
      }

      const validationErrors = validateTask(parsed as BenchmarkTask);
      if (validationErrors.length > 0) {
        errors.push(`${filePath}: Validation errors: ${validationErrors.join('; ')}`);
        continue;
      }

      tasks.push(parsed as BenchmarkTask);
    }
  }

  return { tasks, errors };
}

// ─── filterTasks ──────────────────────────────────────────────────────────────

/**
 * Filters a list of tasks by capability requirements and optional
 * category/ID selectors. Tasks excluded by the category or ID filters
 * are silently dropped (not added to `skipped`). Tasks that match the
 * selectors but fail a capability check are added to `skipped` with a
 * human-readable reason string.
 */
export function filterTasks(
  tasks: BenchmarkTask[],
  preflight: PreflightResult,
  categories: string[] | null,
  taskIds: string[] | null
): FilterResult {
  const eligible: BenchmarkTask[] = [];
  const skipped: Array<{ task: BenchmarkTask; reason: string }> = [];

  for (const task of tasks) {
    // ── Selector filters (silent exclusion — not added to skipped) ──────────

    if (categories !== null && !categories.includes(task.category)) {
      continue;
    }

    if (taskIds !== null && !taskIds.includes(task.id)) {
      continue;
    }

    // ── Capability checks (failures go to skipped with reason) ──────────────

    // enabled_after — skip if date is in the future
    if (task.enabled_after) {
      const enabledDate = new Date(task.enabled_after);
      if (enabledDate > new Date()) {
        skipped.push({ task, reason: `enabled_after: task not available until ${task.enabled_after}` });
        continue;
      }
    }

    // roadmap_gate — check if the gate's required tool is available
    if (task.roadmap_gate) {
      const requiredTool = ROADMAP_GATE_TOOLS[task.roadmap_gate];
      if (!requiredTool || !preflight.availableTools.includes(requiredTool)) {
        const toolNote = requiredTool ? ` (requires ${requiredTool})` : '';
        skipped.push({
          task,
          reason: `roadmap gate: ${task.roadmap_gate} not yet shipped${toolNote}`,
        });
        continue;
      }
    }

    // requires.tools — all declared tools must be available
    const missingTools = task.requires.tools.filter(
      (tool) => !preflight.availableTools.includes(tool)
    );
    if (missingTools.length > 0) {
      skipped.push({
        task,
        reason: `Missing required tools: ${missingTools.join(', ')}`,
      });
      continue;
    }

    // requires.engines — all declared engines must be healthy
    const missingEngines = task.requires.engines.filter(
      (engine) => !preflight.healthyEngines.includes(engine)
    );
    if (missingEngines.length > 0) {
      skipped.push({
        task,
        reason: `Missing required engines: ${missingEngines.join(', ')}`,
      });
      continue;
    }

    // requires.auth_domains — all declared auth domains must be authenticated
    const missingAuth = task.requires.auth_domains.filter(
      (domain) => !preflight.authenticatedDomains.includes(domain)
    );
    if (missingAuth.length > 0) {
      skipped.push({
        task,
        reason: `Missing auth for domains: ${missingAuth.join(', ')}`,
      });
      continue;
    }

    // requires.competitive — competitive readiness must be true
    if (task.requires.competitive && !preflight.competitiveReady) {
      skipped.push({
        task,
        reason: 'Competitive benchmark environment not ready',
      });
      continue;
    }

    eligible.push(task);
  }

  return { eligible, skipped };
}
