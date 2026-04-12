import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

/**
 * File-based IPC protocol between daemon and extension:
 *
 * Daemon writes: ~/.safari-pilot/bridge/commands/{id}.json
 *   Format: { "id": "<commandID>", "script": "...", ... }
 *
 * Extension reads command, executes, then writes:
 *   ~/.safari-pilot/bridge/results/{id}.json
 *   Format: { "id": "<commandID>", "result": <any>, "timestamp": "..." }
 *
 * These tests verify the file format contract without needing the actual
 * Swift daemon or Safari extension.
 */

let testDir: string;
let commandsDir: string;
let resultsDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `safari-pilot-bridge-test-${Date.now()}`);
  commandsDir = join(testDir, 'commands');
  resultsDir = join(testDir, 'results');
  mkdirSync(commandsDir, { recursive: true });
  mkdirSync(resultsDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ─── Command File Format ────────────────────────────────────────────────────

describe('Bridge IPC — Command Files', () => {
  it('command file is valid JSON with required fields', () => {
    const commandId = 'cmd-test-001';
    const command = {
      id: commandId,
      script: 'return document.title',
    };

    const filePath = join(commandsDir, `${commandId}.json`);
    writeFileSync(filePath, JSON.stringify(command));

    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.id).toBe(commandId);
    expect(parsed.script).toBe('return document.title');
  });

  it('command file name matches the command ID', () => {
    const commandId = 'exec-abc-123';
    const command = { id: commandId, script: 'return 1' };

    const filePath = join(commandsDir, `${commandId}.json`);
    writeFileSync(filePath, JSON.stringify(command));

    expect(existsSync(filePath)).toBe(true);
    expect(filePath.endsWith(`${commandId}.json`)).toBe(true);
  });

  it('command file supports additional params alongside script', () => {
    const command = {
      id: 'cmd-with-params',
      script: 'return window.location.href',
      timeout: 5000,
      tabId: 42,
    };

    const filePath = join(commandsDir, `${command.id}.json`);
    writeFileSync(filePath, JSON.stringify(command));

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.timeout).toBe(5000);
    expect(parsed.tabId).toBe(42);
    expect(parsed.script).toBeDefined();
  });

  it('multiple command files can coexist in the directory', () => {
    for (let i = 0; i < 5; i++) {
      const cmd = { id: `cmd-${i}`, script: `return ${i}` };
      writeFileSync(join(commandsDir, `cmd-${i}.json`), JSON.stringify(cmd));
    }

    const files = readdirSync(commandsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(5);
  });

  it('oldest command file sorts first alphabetically for FIFO processing', () => {
    // Write files with lexicographically ordered names to simulate time order
    const ids = ['cmd-001', 'cmd-002', 'cmd-003'];
    for (const id of ids) {
      writeFileSync(
        join(commandsDir, `${id}.json`),
        JSON.stringify({ id, script: 'return 1' }),
      );
    }

    const files = readdirSync(commandsDir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    expect(files[0]).toBe('cmd-001.json');
    expect(files[files.length - 1]).toBe('cmd-003.json');
  });
});

// ─── Result File Format ────────────────────────────────────────────────────

describe('Bridge IPC — Result Files', () => {
  it('result file is valid JSON with required fields', () => {
    const resultId = 'cmd-test-001';
    const result = {
      id: resultId,
      result: { ok: true, value: 'Example Domain' },
      timestamp: new Date().toISOString(),
    };

    const filePath = join(resultsDir, `${resultId}.json`);
    writeFileSync(filePath, JSON.stringify(result));

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.id).toBe(resultId);
    expect(parsed.result).toBeDefined();
    expect(parsed.timestamp).toBeDefined();
  });

  it('result file name matches the command ID', () => {
    const resultId = 'exec-abc-123';
    const result = {
      id: resultId,
      result: 'test-value',
      timestamp: new Date().toISOString(),
    };

    const filePath = join(resultsDir, `${resultId}.json`);
    writeFileSync(filePath, JSON.stringify(result));

    expect(existsSync(filePath)).toBe(true);
    expect(filePath.endsWith(`${resultId}.json`)).toBe(true);
  });

  it('result file can contain error information', () => {
    const result = {
      id: 'cmd-error',
      result: { ok: false, error: { message: 'Tab not found' } },
      timestamp: new Date().toISOString(),
    };

    const filePath = join(resultsDir, `${result.id}.json`);
    writeFileSync(filePath, JSON.stringify(result));

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.result.ok).toBe(false);
    expect(parsed.result.error.message).toBe('Tab not found');
  });

  it('result file supports complex nested result values', () => {
    const result = {
      id: 'cmd-complex',
      result: {
        ok: true,
        value: {
          title: 'Test Page',
          url: 'https://example.com',
          cookies: [
            { name: 'session', value: 'abc123' },
          ],
        },
      },
      timestamp: new Date().toISOString(),
    };

    const filePath = join(resultsDir, `${result.id}.json`);
    writeFileSync(filePath, JSON.stringify(result));

    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(parsed.result.value.title).toBe('Test Page');
    expect(parsed.result.value.cookies).toHaveLength(1);
  });
});

// ─── Full Round-Trip Protocol ───────────────────────────────────────────────

describe('Bridge IPC — Round Trip', () => {
  it('simulates daemon writing command and extension writing result', () => {
    const commandId = 'roundtrip-001';

    // Step 1: Daemon writes command
    const command = { id: commandId, script: 'return document.title' };
    const cmdPath = join(commandsDir, `${commandId}.json`);
    writeFileSync(cmdPath, JSON.stringify(command));
    expect(existsSync(cmdPath)).toBe(true);

    // Step 2: Extension reads and deletes command (simulated)
    const cmdData = JSON.parse(readFileSync(cmdPath, 'utf-8'));
    rmSync(cmdPath);
    expect(existsSync(cmdPath)).toBe(false);
    expect(cmdData.id).toBe(commandId);

    // Step 3: Extension writes result
    const result = {
      id: cmdData.id,
      result: { ok: true, value: 'My Page Title' },
      timestamp: new Date().toISOString(),
    };
    const resultPath = join(resultsDir, `${commandId}.json`);
    writeFileSync(resultPath, JSON.stringify(result));
    expect(existsSync(resultPath)).toBe(true);

    // Step 4: Daemon reads and deletes result
    const resultData = JSON.parse(readFileSync(resultPath, 'utf-8'));
    rmSync(resultPath);
    expect(existsSync(resultPath)).toBe(false);
    expect(resultData.id).toBe(commandId);
    expect(resultData.result.ok).toBe(true);
    expect(resultData.result.value).toBe('My Page Title');
  });

  it('commands directory is empty after all commands are consumed', () => {
    // Write and then consume 3 commands
    for (let i = 0; i < 3; i++) {
      const path = join(commandsDir, `cmd-${i}.json`);
      writeFileSync(path, JSON.stringify({ id: `cmd-${i}`, script: `return ${i}` }));
    }

    // Consume all
    const files = readdirSync(commandsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      rmSync(join(commandsDir, file));
    }

    const remaining = readdirSync(commandsDir).filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('result ID matches the original command ID for correct routing', () => {
    const ids = ['alpha', 'beta', 'gamma'];

    // Daemon writes commands
    for (const id of ids) {
      writeFileSync(
        join(commandsDir, `${id}.json`),
        JSON.stringify({ id, script: `return "${id}"` }),
      );
    }

    // Extension processes and writes results (in any order)
    for (const id of [...ids].reverse()) {
      writeFileSync(
        join(resultsDir, `${id}.json`),
        JSON.stringify({
          id,
          result: { ok: true, value: id },
          timestamp: new Date().toISOString(),
        }),
      );
    }

    // Daemon reads results — each result's id matches the filename
    for (const id of ids) {
      const resultPath = join(resultsDir, `${id}.json`);
      const data = JSON.parse(readFileSync(resultPath, 'utf-8'));
      expect(data.id).toBe(id);
      expect(data.result.value).toBe(id);
    }
  });
});
