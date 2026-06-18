'use strict';
/* Headless integration test: 3 bots join a table and play several hands. */
const WebSocket = require('ws');

const URL = process.env.URL || 'ws://localhost:3010/ws';
const TABLE = 'TESTROOM';
const NAMES = ['Alice', 'Bob', 'Cara'];

let handsSeen = 0;
let lastPhase = {};
const privacy = { ok: true };
const seenWinners = [];

function bot(name, seat) {
  const ws = new WebSocket(URL);
  let myId = null;
  let myseat = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', table: TABLE, name })));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'hello') myId = m.id;
    if (m.type === 'welcome') setTimeout(() => ws.send(JSON.stringify({ type: 'sit', seat })), 100);
    if (m.type === 'seated') myseat = m.seat;
    if (m.type === 'state') {
      // Privacy check: I must never receive another seat's hole cards (except reveals at showdown).
      if (m.phase === 'playing') {
        for (const s of m.seats) {
          if (s && s.hasCards && s.seat !== myseat && s.cardsLeaked) privacy.ok = false;
        }
        if (m.hole && myseat == null) privacy.ok = false;
      }

      // Track hands + winners (only count once per showdown, by first bot)
      if (name === NAMES[0]) {
        if (lastPhase.p !== m.phase) {
          if (m.phase === 'showdown' && m.results) {
            handsSeen++;
            const w = m.results.filter((r) => r.delta > 0).map((r) => `${r.name}+${r.delta}${r.hand ? '/' + r.hand : ''}`);
            const total = m.seats.filter(Boolean).reduce((a, s) => a + s.stack, 0);
            seenWinners.push(`hand ${handsSeen}: ${w.join(',')} | chiptotal=${total} | board=${(m.community || []).map(c => c.rank + c.suit[0]).join(' ')}`);
          }
          lastPhase.p = m.phase;
        }
      }

      // Act when it's my turn.
      if (m.legal && m.toAct === myseat) {
        const la = m.legal;
        let action, bet;
        const r = Math.random();
        if (la.actions.includes('check')) { action = r < 0.2 && la.actions.includes('bet') ? 'bet' : 'check'; }
        else if (la.actions.includes('call')) { action = r < 0.15 ? 'fold' : (r > 0.9 && la.actions.includes('raise') ? 'raise' : 'call'); }
        else { action = la.actions[0]; }
        if (action === 'bet' || action === 'raise') bet = la.chipRange.min;
        setTimeout(() => ws.send(JSON.stringify({ type: 'action', action, bet })), 60);
      }
    }
  });
  return ws;
}

NAMES.forEach((n, i) => bot(n, i));

setTimeout(() => {
  console.log('=== RESULTS ===');
  console.log('hands completed:', handsSeen);
  console.log('hole-card privacy held:', privacy.ok);
  seenWinners.forEach((l) => console.log(l));
  process.exit(0);
}, 18000);
