// extension/build.config.js
//
// Controls compile-time flags for the Safari Pilot extension. These flags are
// consumed by scripts/build-extension.sh at packaging time — NOT at runtime.
// The runtime (background.js / content-*.js) never reads env vars; Safari's JS
// runtime has no process.env.
//
// DEBUG_HARNESS_BEGIN/END markers wrap test-only blocks in background.js and
// content scripts. Those blocks are stripped from the bundled Resources/ files
// when SAFARI_PILOT_TEST_MODE != "1" (the default for release builds).

module.exports = {
  DEBUG_HARNESS: process.env.SAFARI_PILOT_TEST_MODE === '1',
};
