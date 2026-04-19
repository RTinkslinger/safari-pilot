import { execSync } from 'node:child_process';

// No setup needed — only teardown for retention pruning
export function setup() {}

export function teardown() {
  try {
    execSync(
      'ls -t test-results/junit/*.xml 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null; ' +
        'ls -t test-results/json/*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null',
      { shell: '/bin/bash' },
    );
  } catch {
    /* no files to prune — directory may not exist yet */
  }
}
