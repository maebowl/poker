'use strict';

/**
 * app.js — poker table client.
 * Connects over WebSocket, renders the authoritative state the server sends
 * (only ever showing this client's own hole cards), and lets the player act.
 */

const SUIT = { clubs: '♣', diamonds: '♦', hearts: '♥', spades: '♠' };
const RED = new Set(['hearts', 'diamonds']);

const $ = (id) => document.getElementById(id);

let ws = null;
let myId = null;
let mySeat = null;
let myName = '';
let tableCode = '';
let lastState = null;
let iceServers = [];
let timerRAF = null;
let reconnectTimer = null;

// ---- connection -------------------------------------------------------------

function wsURL() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

function connect() {
  ws = new WebSocket(wsURL());
  ws.onopen = () => {
    send({ type: 'join', table: tableCode, name: myName });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };
  ws.onclose = () => {
    if (reconnectTimer) return;
    toast('Disconnected — reconnecting…');
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      myId = msg.id;
      iceServers = msg.iceServers || [];
      Voice.configure({ send, myId, iceServers, onChange: renderVoiceBtn });
      break;
    case 'welcome':
      myId = msg.id;
      tableCode = msg.code;
      $('table-code').textContent = tableCode;
      break;
    case 'state':
      lastState = msg;
      mySeat = msg.you;
      render(msg);
      break;
    case 'seated':
      mySeat = msg.seat;
      break;
    case 'stood':
    case 'left-seat':
      mySeat = null;
      if (msg.reason === 'busted') toast('You busted out — take a seat to buy back in.');
      break;
    case 'error':
      toast(msg.message);
      break;
    case 'chat':
      addChat(msg.name, msg.text);
      break;
    case 'voice-peers': Voice.onPeers(msg.peers); break;
    case 'voice-joined': Voice.onJoined(msg); toast(`${msg.name} joined voice`); break;
    case 'voice-left': Voice.onLeft(msg.id); break;
    case 'signal': Voice.onSignal(msg.from, msg.data); break;
  }
}

// ---- join screen ------------------------------------------------------------

function initJoin() {
  const params = new URLSearchParams(location.search);
  const presetTable = (params.get('table') || location.hash.replace('#', '')).toUpperCase();
  if (presetTable) $('table-input').value = presetTable;
  $('name-input').value = localStorage.getItem('poker-name') || '';

  $('join-btn').onclick = doJoin;
  $('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('table-input').focus(); });
  $('table-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
}

function doJoin() {
  myName = $('name-input').value.trim() || 'Player';
  tableCode = ($('table-input').value.trim() || 'MAIN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'MAIN';
  localStorage.setItem('poker-name', myName);
  history.replaceState(null, '', `?table=${tableCode}`);
  $('join').classList.add('hidden');
  $('table-view').classList.remove('hidden');
  connect();
}

// ---- rendering --------------------------------------------------------------

function cardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (opts.small ? ' small' : '') + (opts.muck ? ' muck' : '');
  if (!card) { el.classList.add('back'); return el; }
  if (RED.has(card.suit)) el.classList.add('red');
  const rank = card.rank === 'T' ? '10' : card.rank;
  el.innerHTML = `<span class="rank">${rank}</span><span class="suit">${SUIT[card.suit] || ''}</span>`;
  return el;
}

// Visual slot positions around the felt; slot 0 is bottom-center (the local
// player). Returns {left%, top%} for a given slot index out of `n`.
function slotPos(slot, n) {
  const theta = (slot / n) * 2 * Math.PI; // 0 = bottom, clockwise
  const x = 50 + 50 * Math.sin(theta);
  const y = 50 + 46 * Math.cos(theta);
  return { x, y };
}

function render(s) {
  // Pot + board
  const board = $('community');
  board.innerHTML = '';
  (s.community || []).forEach((c) => board.appendChild(cardEl(c)));
  const pot = $('pot');
  if (s.pot > 0) { pot.textContent = `Pot ${s.pot}`; pot.classList.remove('hidden'); }
  else pot.classList.add('hidden');

  renderStatus(s);
  renderSeats(s);
  renderActionBar(s);
  startTimerLoop();
}

function renderStatus(s) {
  const el = $('status');
  if (s.phase === 'waiting') {
    const seated = (s.seats || []).filter(Boolean).length;
    el.textContent = seated < 2 ? 'Waiting for players…' : 'Starting soon…';
  } else if (s.phase === 'showdown' && s.results) {
    const winners = s.results.filter((r) => r.delta > 0)
      .map((r) => `${r.name} +${r.delta}${r.hand ? ` (${r.hand})` : ''}`);
    el.textContent = winners.length ? winners.join('   ·   ') : 'Hand over';
  } else if (s.round) {
    el.textContent = s.round[0].toUpperCase() + s.round.slice(1);
  } else {
    el.textContent = '';
  }
}

function renderSeats(s) {
  const container = $('seats');
  container.innerHTML = '';
  const n = s.maxSeats;
  // Rotate so the local player (if seated) sits at the bottom.
  const ref = (mySeat != null) ? mySeat : 0;

  for (let i = 0; i < n; i++) {
    const slot = ((i - ref) % n + n) % n;
    const { x, y } = slotPos(slot, n);
    const seatData = s.seats[i];
    const div = document.createElement('div');
    div.className = 'seat';
    div.style.left = x + '%';
    div.style.top = y + '%';

    if (!seatData) {
      div.classList.add('empty');
      const canSit = mySeat == null;
      div.innerHTML = `<div class="holecards"></div>
        <div class="nameplate"><div class="pname">${canSit ? '+ Sit here' : 'Empty'}</div></div>
        <div class="bet-chip" style="visibility:hidden">0</div>`;
      if (canSit) div.querySelector('.nameplate').onclick = () => send({ type: 'sit', seat: i });
      container.appendChild(div);
      continue;
    }

    if (seatData.folded || seatData.sittingOut) div.classList.add('folded');
    if (!seatData.connected) div.classList.add('disconnected');
    if (seatData.toAct) div.classList.add('toact');

    // Hole cards: yours face-up; others as backs; revealed at showdown.
    const hc = document.createElement('div');
    hc.className = 'holecards';
    const reveal = s.reveals && s.reveals[i];
    if (i === mySeat && s.hole) {
      s.hole.forEach((c) => hc.appendChild(cardEl(c))); // hero's own cards, full size
    } else if (reveal) {
      reveal.forEach((c) => hc.appendChild(cardEl(c, { small: true })));
    } else if (seatData.hasCards) {
      hc.appendChild(cardEl(null, { small: true }));
      hc.appendChild(cardEl(null, { small: true }));
    }

    const plate = document.createElement('div');
    plate.className = 'nameplate';
    const note = seatData.sittingOut ? ' (next hand)' : (!seatData.connected ? ' ⚠' : '');
    plate.innerHTML = `<div class="pname">${escapeHtml(seatData.name)}${note}</div>
      <div class="pstack">${seatData.stack} chips</div>`;
    if (seatData.isButton) {
      const b = document.createElement('div'); b.className = 'dealer-btn'; b.textContent = 'D';
      plate.appendChild(b);
    }
    if (seatData.toAct) {
      const bar = document.createElement('div'); bar.className = 'timerbar'; bar.dataset.timer = '1';
      plate.appendChild(bar);
    }

    // Winner badge at showdown
    if (s.phase === 'showdown' && s.results) {
      const r = s.results.find((x) => x.seat === i && x.delta > 0);
      if (r) {
        const w = document.createElement('div'); w.className = 'winner-badge'; w.textContent = `Winner +${r.delta}`;
        plate.appendChild(w);
      }
    }

    const bet = document.createElement('div');
    bet.className = 'bet-chip';
    bet.textContent = seatData.bet > 0 ? seatData.bet : '';
    bet.style.visibility = seatData.bet > 0 ? 'visible' : 'hidden';

    div.appendChild(hc);
    div.appendChild(plate);
    div.appendChild(bet);
    container.appendChild(div);
  }
}

function renderActionBar(s) {
  const bar = $('action-bar');
  const myTurn = s.legal && s.toAct === mySeat && mySeat != null;
  if (!myTurn) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }

  const { actions, chipRange } = s.legal;
  const me = s.seats[mySeat];
  const maxBet = Math.max(0, ...s.seats.filter(Boolean).map((x) => x.bet));
  const toCall = Math.max(0, maxBet - (me ? me.bet : 0));

  bar.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'btn-row';

  if (actions.includes('fold')) {
    row.appendChild(actBtn('Fold', 'fold', () => act('fold')));
  }
  if (actions.includes('check')) {
    row.appendChild(actBtn('Check', '', () => act('check')));
  }
  if (actions.includes('call')) {
    row.appendChild(actBtn(`Call ${toCall}`, '', () => act('call')));
  }

  const aggressive = actions.includes('raise') ? 'raise' : (actions.includes('bet') ? 'bet' : null);
  let amtInput = null;
  if (aggressive) {
    const label = aggressive === 'bet' ? 'Bet' : 'Raise to';
    const raiseBtn = actBtn(`${label} ${chipRange.min}`, 'raise', () => act(aggressive, Number(amtInput.value)));
    row.appendChild(raiseBtn);
    bar.appendChild(row);

    const rrow = document.createElement('div');
    rrow.className = 'raise-row';
    const range = document.createElement('input');
    range.type = 'range'; range.min = chipRange.min; range.max = chipRange.max; range.value = chipRange.min;
    amtInput = document.createElement('input');
    amtInput.type = 'number'; amtInput.className = 'raise-amt';
    amtInput.min = chipRange.min; amtInput.max = chipRange.max; amtInput.value = chipRange.min;
    const sync = (v) => {
      v = Math.max(chipRange.min, Math.min(chipRange.max, Math.round(v) || chipRange.min));
      range.value = v; amtInput.value = v;
      raiseBtn.textContent = `${label} ${v}`;
    };
    range.oninput = () => sync(Number(range.value));
    amtInput.oninput = () => raiseBtn.textContent = `${label} ${amtInput.value}`;
    amtInput.onchange = () => sync(Number(amtInput.value));

    const quick = document.createElement('div');
    quick.className = 'quick';
    const pot = s.pot || 0;
    const mk = (lbl, val) => { const b = document.createElement('button'); b.textContent = lbl; b.onclick = () => sync(val); return b; };
    quick.appendChild(mk('Min', chipRange.min));
    if (pot > 0) {
      quick.appendChild(mk('½ Pot', maxBet + Math.round(pot / 2)));
      quick.appendChild(mk('Pot', maxBet + pot));
    }
    quick.appendChild(mk('All-in', chipRange.max));

    rrow.appendChild(range);
    rrow.appendChild(amtInput);
    bar.appendChild(rrow);
    bar.appendChild(quick);
  } else {
    bar.appendChild(row);
  }

  bar.classList.remove('hidden');
}

function actBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'act' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.onclick = () => { onClick(); };
  return b;
}

function act(action, bet) {
  send({ type: 'action', action, bet });
  $('action-bar').classList.add('hidden'); // optimistic; server confirms via next state
}

// Animate the turn-timer bars toward each player's deadline.
function startTimerLoop() {
  if (timerRAF) cancelAnimationFrame(timerRAF);
  const tick = () => {
    const s = lastState;
    timerRAF = requestAnimationFrame(tick);
    if (!s || s.toAct == null || !s.turnDeadline) return;
    const bar = document.querySelector('.timerbar[data-timer="1"]');
    if (!bar) return;
    const total = 30000;
    const remain = s.turnDeadline - Date.now();
    const frac = Math.max(0, Math.min(1, remain / total));
    bar.style.transform = `scaleX(${frac})`;
    bar.style.background = frac < 0.3 ? 'var(--red)' : 'var(--gold)';
  };
  tick();
}

// ---- voice button -----------------------------------------------------------

function renderVoiceBtn() {
  const btn = $('voice-btn');
  if (!Voice.isEnabled()) {
    btn.textContent = '🎙️ Voice off';
    btn.classList.remove('on');
  } else {
    const n = Voice.peerCount();
    btn.textContent = Voice.isMuted() ? '🔇 Muted' : `🎙️ Voice (${n})`;
    btn.classList.add('on');
  }
}

// ---- chat -------------------------------------------------------------------

function addChat(name, text) {
  const log = $('chat-log');
  const line = document.createElement('div');
  line.className = 'line';
  line.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  log.appendChild(line);
  while (log.children.length > 30) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// ---- misc -------------------------------------------------------------------

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  const el = document.createElement('div');
  el.className = 'msg';
  el.textContent = text;
  t.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- wire up UI -------------------------------------------------------------

function initControls() {
  $('voice-btn').onclick = async () => {
    if (!Voice.isEnabled()) { await Voice.enable(); }
    else { Voice.toggleMute(); }
    renderVoiceBtn();
  };
  $('voice-btn').oncontextmenu = (e) => { e.preventDefault(); Voice.disable(); renderVoiceBtn(); };

  $('leave-btn').onclick = () => {
    if (mySeat != null) send({ type: 'stand' });
    Voice.disable();
    location.href = location.pathname;
  };

  $('share-btn').onclick = async () => {
    const url = `${location.origin}/?table=${tableCode}`;
    try { await navigator.clipboard.writeText(url); toast('Invite link copied!'); }
    catch { prompt('Copy this invite link:', url); }
  };

  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (text) send({ type: 'chat', text });
    input.value = '';
  });
}

initJoin();
initControls();
