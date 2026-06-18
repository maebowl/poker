'use strict';
/* Edge tests: (1) strict hole-card privacy scan, (2) mid-hand disconnect. */
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:3010/ws';
const TABLE = 'EDGE' + Math.floor(Math.random() * 1000);

let privacyViolations = 0;
let crashed = false;
let progressedAfterDisconnect = false;
let bobActed = 0;

// Count {rank,suit} card objects that are NOT in community or my own hole.
function scanPrivacy(state, myseat) {
  if (state.phase !== 'playing') return;
  const allowed = new Set();
  (state.community || []).forEach((c) => allowed.add(c));
  (state.hole || []).forEach((c) => allowed.add(c));
  // seats must carry no card objects at all (only booleans)
  for (const s of state.seats) {
    if (!s) continue;
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (v && typeof v === 'object' && 'rank' in v && 'suit' in v) privacyViolations++;
    }
  }
  // hole must belong to me
  if (state.hole && myseat == null) privacyViolations++;
}

function bot(name, seat, opts = {}) {
  const ws = new WebSocket(URL);
  let myseat = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', table: TABLE, name })));
  ws.on('error', () => {});
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') setTimeout(() => ws.send(JSON.stringify({ type: 'sit', seat })), 80);
    if (m.type === 'seated') myseat = m.seat;
    if (m.type === 'state') {
      scanPrivacy(m, myseat);
      if (m.legal && m.toAct === myseat) {
        if (name === 'Bob') {
          bobActed++;
          if (opts.disconnectAfter && bobActed >= opts.disconnectAfter) { ws.close(); return; }
        }
        const la = m.legal;
        const action = la.actions.includes('check') ? 'check' : (la.actions.includes('call') ? 'call' : la.actions[0]);
        setTimeout(() => { try { ws.send(JSON.stringify({ type: 'action', action })); } catch {} }, 50);
      }
      // Alice notices the hand reach showdown even though Bob bailed.
      if (name === 'Alice' && m.phase === 'showdown') progressedAfterDisconnect = true;
    }
  });
  return ws;
}

bot('Alice', 0);
bot('Bob', 1, { disconnectAfter: 1 });

setTimeout(() => {
  console.log('=== EDGE RESULTS ===');
  console.log('privacy violations:', privacyViolations);
  console.log('hand progressed to showdown after mid-hand disconnect:', progressedAfterDisconnect);
  process.exit(0);
}, 12000);
