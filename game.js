'use strict';

/**
 * PokerTable — one ephemeral Texas Hold'em table.
 *
 * The server is fully authoritative: it owns the deck (via the poker-ts engine),
 * runs the betting state machine, and sends each client a *personalized* state
 * message that contains only that player's own hole cards. Opponents' cards are
 * shown as backs until showdown.
 *
 * Transport-agnostic: a `client` is any object with `{ id, name, seat, send(obj) }`.
 * server.js adapts WebSockets to that shape.
 */

const { Table } = require('poker-ts');

// Table tuning (play money — no real stakes).
const SMALL_BLIND = 25;
const BIG_BLIND = 50;
const BUY_IN = 2500; // 50 big blinds
const MAX_SEATS = 9;

// Timers (ms).
const TURN_MS = 30000; // how long a connected player has to act
const AUTO_MS = 900; // grace before auto-acting for absent/leaving players
const HAND_START_DELAY = 3500; // pause before a new hand once ≥2 players are seated
const SHOWDOWN_MS = 7000; // how long the showdown result stays up
const FOLDWIN_MS = 2500; // shorter pause when a hand ends on folds (no cards shown)

const RANKING_NAMES = [
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight',
  'Flush', 'Full house', 'Four of a kind', 'Straight flush', 'Royal flush',
];

class PokerTable {
  constructor(code) {
    this.code = code;
    this.maxSeats = MAX_SEATS;
    this.sb = SMALL_BLIND;
    this.bb = BIG_BLIND;
    this.buyIn = BUY_IN;

    this.engine = new Table({ smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND }, MAX_SEATS);

    /** seat index -> { client, name, connected, folded, inHand, cards, startStack, standAfter } | null */
    this.seatMeta = new Array(MAX_SEATS).fill(null);
    this.clients = new Set();
    this.voicePeers = new Set(); // client ids with mic enabled

    this.phase = 'waiting'; // 'waiting' | 'playing' | 'showdown'
    this.community = [];
    this.button = null;
    this.reveals = null; // seat -> [cards] shown at showdown
    this.results = null; // [{ seat, name, delta, hand }]
    this.turnDeadline = null;
    this._lastPot = 0;
    this.timer = null;
  }

  // ---- client lifecycle -----------------------------------------------------

  addClient(client) {
    this.clients.add(client);
    client.seat = null;
    this._send(client, { type: 'welcome', id: client.id, code: this.code });
    this._send(client, this._stateFor(client));
  }

  removeClient(client) {
    this.clients.delete(client);
    this._voiceLeave(client);

    const seat = client.seat;
    const m = seat != null ? this.seatMeta[seat] : null;
    if (m) {
      m.connected = false;
      m.client = null;
      const t = this.engine;
      if (t.isHandInProgress() && m.inHand && !m.folded) {
        // Leave the hand cleanly: act now if it's their turn, otherwise the
        // turn timer will fast-fold them when the action reaches their seat.
        m.standAfter = true;
        if (t.isBettingRoundInProgress() && t.playerToAct() === seat) this._autoAct(seat);
        else this.broadcast();
      } else if (!t.isHandInProgress()) {
        this._removeSeat(seat); // safe to free the seat between hands
        this.broadcast();
      } else {
        m.standAfter = true; // seated but not in this hand — drop at hand end
        this.broadcast();
      }
    }
    if (this.clients.size === 0) this._clearTimer();
  }

  // ---- player actions -------------------------------------------------------

  sit(client, seat) {
    if (client.seat != null) return this._err(client, 'You are already seated.');
    seat = Number(seat);
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.maxSeats) return;
    if (this.seatMeta[seat]) return this._err(client, 'That seat is taken.');
    try {
      this.engine.sitDown(seat, this.buyIn);
    } catch (e) {
      return this._err(client, 'Cannot sit: ' + e.message);
    }
    this.seatMeta[seat] = {
      client, name: client.name, connected: true,
      folded: false, inHand: false, cards: null, startStack: this.buyIn, standAfter: false,
    };
    client.seat = seat;
    this._send(client, { type: 'seated', seat });
    this._maybeStart();
    this.broadcast();
  }

  stand(client) {
    const seat = client.seat;
    if (seat == null) return;
    const m = this.seatMeta[seat];
    if (!m) return;
    const t = this.engine;
    if (t.isHandInProgress() && m.inHand && !m.folded) {
      m.standAfter = true; // fold + remove at hand end
      if (t.isBettingRoundInProgress() && t.playerToAct() === seat) this._autoAct(seat);
      else this.broadcast();
    } else {
      this._removeSeat(seat);
      this._send(client, { type: 'stood' });
      this.broadcast();
    }
  }

  act(client, action, bet) {
    const seat = client.seat;
    const t = this.engine;
    if (seat == null || !t.isHandInProgress() || !t.isBettingRoundInProgress()) return;
    if (t.playerToAct() !== seat) return this._err(client, 'It is not your turn.');
    const legal = t.legalActions();
    if (!legal.actions.includes(action)) return this._err(client, 'Illegal action.');
    let betSize;
    if (action === 'bet' || action === 'raise') {
      const want = Math.round(Number(bet) || 0);
      betSize = Math.max(legal.chipRange.min, Math.min(legal.chipRange.max, want));
    }
    this._clearTimer();
    this._applyAction(seat, action, betSize);
  }

  // ---- voice (WebRTC mesh signaling relay) ----------------------------------

  voice(client, on) {
    if (on) {
      if (this.voicePeers.has(client.id)) return;
      const peers = [...this.clients]
        .filter((c) => c !== client && this.voicePeers.has(c.id))
        .map((c) => ({ id: c.id, name: c.name }));
      this._send(client, { type: 'voice-peers', peers });
      this.voicePeers.add(client.id);
      for (const c of this.clients) {
        if (c !== client && this.voicePeers.has(c.id)) {
          this._send(c, { type: 'voice-joined', id: client.id, name: client.name });
        }
      }
    } else {
      this._voiceLeave(client);
    }
  }

  signal(client, to, data) {
    const target = [...this.clients].find((c) => c.id === to);
    if (target) this._send(target, { type: 'signal', from: client.id, data });
  }

  chat(client, text) {
    text = String(text || '').slice(0, 300).trim();
    if (!text) return;
    const msg = { type: 'chat', from: client.id, name: client.name, text };
    for (const c of this.clients) this._send(c, msg);
  }

  // ---- internal: state machine ----------------------------------------------

  _maybeStart() {
    if (this.engine.isHandInProgress()) return;
    if (this._fundedSeats().length >= 2 && this.phase !== 'showdown') {
      this._clearTimer();
      this.phase = 'waiting';
      this.timer = setTimeout(() => this._startHandIfPossible(), HAND_START_DELAY);
    }
  }

  _startHandIfPossible() {
    this._clearTimer();
    const t = this.engine;
    if (t.isHandInProgress()) return;

    // Clear out anyone who busted or asked to leave (only legal between hands).
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (!m) continue;
      const es = t.seats()[i];
      if (m.standAfter || !es || es.stack <= 0) {
        const client = m.client;
        const busted = !m.standAfter;
        this._removeSeat(i);
        if (client) this._send(client, { type: 'left-seat', reason: busted ? 'busted' : 'stood' });
      }
    }

    this.reveals = null;
    this.results = null;
    const funded = this._fundedSeats();
    if (funded.length < 2) {
      this.phase = 'waiting';
      this.community = [];
      this._lastPot = 0;
      this.broadcast();
      return;
    }

    // Reset per-hand bookkeeping and record starting stacks (pre-blinds).
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (!m) continue;
      const es = t.seats()[i];
      m.folded = false;
      m.cards = null;
      m.standAfter = false;
      m.inHand = !!(es && es.stack > 0);
      m.startStack = es ? es.stack : 0;
    }

    t.startHand();
    this.phase = 'playing';
    this.community = [];
    this.button = t.button();
    this._lastPot = 0;

    const hc = t.holeCards();
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (m && m.inHand && hc[i]) m.cards = hc[i];
    }

    this._advance();
  }

  /** Drive engine transitions until a player must act or the hand ends. */
  _advance() {
    const t = this.engine;
    while (t.isHandInProgress() && !t.isBettingRoundInProgress()) {
      // Snapshot board/pot before the transition that may end the hand.
      this.community = t.communityCards().slice();
      this.button = t.button();
      this._lastPot = this._livePot();
      if (t.areBettingRoundsCompleted()) {
        t.showdown();
        break;
      }
      t.endBettingRound();
    }

    if (t.isHandInProgress() && t.isBettingRoundInProgress()) {
      this.community = t.communityCards().slice();
      this.button = t.button();
      this._startTurn();
      this.broadcast();
      return;
    }
    this._finishHand();
  }

  _startTurn() {
    this._clearTimer();
    const t = this.engine;
    if (!(t.isHandInProgress() && t.isBettingRoundInProgress())) return;
    const seat = t.playerToAct();
    const m = this.seatMeta[seat];
    // Absent or leaving players act almost immediately so the table keeps moving.
    const absent = !m || !m.connected || m.standAfter;
    this.turnDeadline = Date.now() + (absent ? AUTO_MS : TURN_MS);
    this.timer = setTimeout(() => this._autoAct(seat), absent ? AUTO_MS : TURN_MS);
  }

  _autoAct(seat) {
    const t = this.engine;
    if (!(t.isHandInProgress() && t.isBettingRoundInProgress() && t.playerToAct() === seat)) return;
    this._clearTimer();
    const m = this.seatMeta[seat];
    const legal = t.legalActions();
    // Players who are leaving fold; idle players check if free, else fold.
    let action;
    if (m && m.standAfter) action = legal.actions.includes('fold') ? 'fold' : 'check';
    else action = legal.actions.includes('check') ? 'check' : 'fold';
    this._applyAction(seat, action);
  }

  _applyAction(seat, action, betSize) {
    const t = this.engine;
    try {
      t.actionTaken(action, betSize);
    } catch (e) {
      this.broadcast();
      return;
    }
    if (action === 'fold' && this.seatMeta[seat]) this.seatMeta[seat].folded = true;
    this._advance();
  }

  _finishHand() {
    const t = this.engine;
    let winnersByPot = [];
    try { winnersByPot = t.winners(); } catch { winnersByPot = []; }

    const handBySeat = {};
    for (const pot of winnersByPot) {
      for (const entry of pot) {
        const seat = entry[0];
        const info = entry[1];
        if (info && typeof info.ranking === 'number') handBySeat[seat] = RANKING_NAMES[info.ranking] || null;
      }
    }

    // Net result per player from stack deltas — always correct, no pot accounting.
    const seatsNow = t.seats();
    const results = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (!m || !m.inHand) continue;
      const now = seatsNow[i] ? seatsNow[i].stack : 0;
      const delta = now - (m.startStack || now);
      results.push({ seat: i, name: m.name, delta, hand: handBySeat[i] || null });
    }

    // Reveal cards only if it actually went to showdown (more than one contender).
    const contenders = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (m && m.inHand && !m.folded) contenders.push(i);
    }
    this.reveals = {};
    if (contenders.length > 1) {
      for (const i of contenders) if (this.seatMeta[i].cards) this.reveals[i] = this.seatMeta[i].cards;
    }

    this.results = results;
    this.phase = 'showdown';
    this.broadcast();

    this._clearTimer();
    this.timer = setTimeout(() => this._startHandIfPossible(), contenders.length > 1 ? SHOWDOWN_MS : FOLDWIN_MS);
  }

  // ---- internal: helpers ----------------------------------------------------

  _removeSeat(seat) {
    const m = this.seatMeta[seat];
    if (!m) return;
    try { this.engine.standUp(seat); } catch { /* not seated in engine */ }
    if (m.client) m.client.seat = null;
    this.seatMeta[seat] = null;
  }

  _fundedSeats() {
    const es = this.engine.seats();
    const out = [];
    for (let i = 0; i < this.maxSeats; i++) if (es[i] && es[i].stack > 0) out.push(i);
    return out;
  }

  _livePot() {
    const t = this.engine;
    if (!t.isHandInProgress()) return this._lastPot;
    let total = 0;
    for (const p of t.pots()) total += p.size;
    for (const s of t.seats()) if (s) total += s.betSize;
    return total;
  }

  _voiceLeave(client) {
    if (!this.voicePeers.has(client.id)) return;
    this.voicePeers.delete(client.id);
    for (const c of this.clients) if (c !== client) this._send(c, { type: 'voice-left', id: client.id });
  }

  _clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.turnDeadline = null;
  }

  _err(client, message) {
    this._send(client, { type: 'error', message });
  }

  _send(client, obj) {
    try { client.send(obj); } catch { /* socket closed */ }
  }

  // ---- internal: state serialization ----------------------------------------

  _publicState() {
    const t = this.engine;
    const inHand = t.isHandInProgress();
    const es = t.seats();
    const toAct = inHand && t.isBettingRoundInProgress() ? t.playerToAct() : null;

    const seats = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const m = this.seatMeta[i];
      if (!m) { seats.push(null); continue; }
      const s = es[i];
      seats.push({
        seat: i,
        name: m.name,
        connected: m.connected,
        stack: s ? s.stack : 0,
        bet: s ? s.betSize : 0,
        folded: !!m.folded,
        inHand: !!m.inHand,
        hasCards: !!(m.inHand && !m.folded && this.phase === 'playing'),
        toAct: toAct === i,
        isButton: this.button === i,
        sittingOut: this.phase === 'playing' && !m.inHand,
      });
    }

    return {
      type: 'state',
      code: this.code,
      phase: this.phase,
      blinds: { sb: this.sb, bb: this.bb, buyIn: this.buyIn },
      maxSeats: this.maxSeats,
      community: this.phase === 'waiting' ? [] : (this.community || []),
      pot: this.phase === 'playing' ? this._livePot() : (this.phase === 'showdown' ? this._lastPot : 0),
      round: inHand ? t.roundOfBetting() : null,
      button: this.button,
      toAct,
      turnDeadline: toAct != null ? this.turnDeadline : null,
      seats,
      reveals: this.phase === 'showdown' ? this.reveals : null,
      results: this.phase === 'showdown' ? this.results : null,
    };
  }

  _stateFor(client) {
    const base = this._publicState();
    const seat = client.seat;
    const t = this.engine;
    let hole = null;
    let legal = null;
    if (seat != null && this.seatMeta[seat] && this.seatMeta[seat].cards) {
      hole = this.seatMeta[seat].cards;
    }
    if (seat != null && t.isHandInProgress() && t.isBettingRoundInProgress() && t.playerToAct() === seat) {
      legal = t.legalActions();
    }
    return Object.assign(base, { you: seat, hole, legal });
  }

  broadcast() {
    for (const c of this.clients) this._send(c, this._stateFor(c));
  }
}

module.exports = { PokerTable, MAX_SEATS, BUY_IN, SMALL_BLIND, BIG_BLIND };
