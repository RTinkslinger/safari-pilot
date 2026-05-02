// extension/lib/route-command.js
// Pure helper. No browser globals. Used by content-isolated.js to decide
// whether a stored sp_cmd_* command belongs to this frame.
//
// Returns:
//   true  — process this command (passes filter)
//   false — skip (different tab, different frame, or stale frameUrl)
//   null  — myFrameId not yet known; caller MUST queue and re-check
//           after the sp_getFrameId handshake completes
//
// Contract:
//   tabId mismatch → false (early reject)
//   myFrameId null → null (caller queues)
//   omitted cmd.frameId → matches only myFrameId === 0 (top frame)
//   explicit cmd.frameId → matches only cmd.frameId === myFrameId
//   cmd.frameUrl set → must equal currentLocationHref or → false

export function shouldProcess(cmd, myTabId, myFrameId, currentLocationHref) {
  if (cmd.tabId !== myTabId) return false;
  if (myFrameId === null) return null;
  const targetFrameId = cmd.frameId ?? 0;
  if (targetFrameId !== myFrameId) return false;
  if (cmd.frameUrl != null && currentLocationHref != null && cmd.frameUrl !== currentLocationHref) {
    return false;
  }
  return true;
}
