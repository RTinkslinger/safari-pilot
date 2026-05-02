// extension/lib/handshake-machine.js
// Pure reducer for the lazy sp_getFrameId handshake. No browser globals.
//
// State shape:
//   { phase: 'IDLE' | 'AWAITING_FRAME_ID' | 'READY',
//     myFrameId: number | null,
//     queue: Array<cmd> }
//
// Effects (returned alongside state — caller dispatches):
//   { type: 'send_sp_getFrameId' }
//   { type: 'process_cmd', cmd }

export const INITIAL_STATE = { phase: 'IDLE', myFrameId: null, queue: [] };

export function frameIdHandshakeReducer(state, event) {
  switch (event.type) {
    case 'sp_cmd_arrived': {
      if (state.phase === 'IDLE') {
        return {
          state: { ...state, phase: 'AWAITING_FRAME_ID', queue: [event.cmd] },
          effects: [{ type: 'send_sp_getFrameId' }],
        };
      }
      if (state.phase === 'AWAITING_FRAME_ID') {
        return {
          state: { ...state, queue: [...state.queue, event.cmd] },
          effects: [],
        };
      }
      // READY
      return { state, effects: [{ type: 'process_cmd', cmd: event.cmd }] };
    }
    case 'sp_getFrameId_response': {
      if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
      const drained = state.queue.map((cmd) => ({ type: 'process_cmd', cmd }));
      return {
        state: { phase: 'READY', myFrameId: event.frameId, queue: [] },
        effects: drained,
      };
    }
    case 'sp_getFrameId_error': {
      if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
      return { state: INITIAL_STATE, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}
