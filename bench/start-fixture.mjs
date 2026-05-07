// Local helper: starts the fixture server for benchmark runs.
// Reads SAFARI_PILOT_FIXTURE_PORT_HOST (default 18080).
// Stays alive until SIGTERM/SIGINT.
import { startFixtureServer } from '../test/helpers/fixture-server.js';

const server = await startFixtureServer();
console.log(`fixture host: http://127.0.0.1:${server.hostPort}`);
const shutdown = async () => { await server.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Keep alive
setInterval(() => undefined, 60_000);
