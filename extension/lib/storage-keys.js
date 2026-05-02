// extension/lib/storage-keys.js
// Pure helpers for commandId-keyed storage bus keys (T55a).

const CMD_PREFIX = 'sp_cmd_';
const RESULT_PREFIX = 'sp_result_';

export function makeSpCmdKey(commandId) { return CMD_PREFIX + commandId; }
export function makeSpResultKey(commandId) { return RESULT_PREFIX + commandId; }

export function pickSpCmdKeys(storageObject) {
  return Object.keys(storageObject).filter((k) => k.startsWith(CMD_PREFIX));
}

export function parseCommandIdFromKey(key) {
  if (key.startsWith(CMD_PREFIX)) return key.slice(CMD_PREFIX.length);
  if (key.startsWith(RESULT_PREFIX)) return key.slice(RESULT_PREFIX.length);
  return null;
}
