#!/usr/bin/env node
import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = await createServer();
  await server.start();
}

main().catch((error) => {
  console.error('Safari Pilot failed to start:', error);
  process.exit(1);
});
