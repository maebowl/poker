'use strict';

/**
 * Poker — HTTP + WebSocket server.
 *
 * Serves the table UI and runs an authoritative game per room. Game logic lives
 * in game.js (the PokerTable class); this file just adapts WebSockets to it and
 * relays WebRTC voice signaling between players (the audio itself is P2P and
 * never touches this server — same pattern as the cameraFeed project).
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { PokerTable } = require('./game');

const PORT = process.env.PORT || 3000;

// ---- ICE configuration (STUN free; TURN optional for hard NATs) -------------
function iceServers() {
  const servers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  return servers;
}

// ---- HTTP -------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/ice', (_req, res) => res.json({ iceServers: iceServers() }));
app.get('/health', (_req, res) => res.json({ ok: true, tables: tables.size }));

let server;
const keyPath = process.env.TLS_KEY;
const certPath = process.env.TLS_CERT;
if (keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  server = require('https').createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    app
  );
  console.log('TLS enabled (serving HTTPS).');
} else {
  server = require('http').createServer(app);
}

// ---- WebSocket --------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

let nextId = 1;
/** table code -> PokerTable */
const tables = new Map();

function getTable(code) {
  code = String(code || 'main').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'MAIN';
  if (!tables.has(code)) tables.set(code, new PokerTable(code));
  return tables.get(code);
}

function sanitizeName(name) {
  return (String(name || '').trim().slice(0, 20)) || `Player ${nextId}`;
}

wss.on('connection', (ws) => {
  // Adapt the raw socket to the `client` shape PokerTable expects.
  const client = {
    id: String(nextId++),
    name: `Player ${nextId}`,
    seat: null,
    send(obj) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    },
  };
  ws.client = client;
  let table = null;

  client.send({ type: 'hello', id: client.id, iceServers: iceServers() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        if (table) table.removeClient(client);
        client.name = sanitizeName(msg.name);
        table = getTable(msg.table);
        table.addClient(client);
        break;
      }
      case 'sit':
        if (table) table.sit(client, msg.seat);
        break;
      case 'stand':
        if (table) table.stand(client);
        break;
      case 'action':
        if (table) table.act(client, msg.action, msg.bet);
        break;
      case 'voice':
        if (table) table.voice(client, !!msg.on);
        break;
      case 'signal':
        if (table && msg.to) table.signal(client, msg.to, msg.data);
        break;
      case 'chat':
        if (table) table.chat(client, msg.text);
        break;
    }
  });

  ws.on('close', () => {
    if (table) {
      table.removeClient(client);
      // Garbage-collect empty tables shortly after the last client leaves.
      const code = table.code;
      setTimeout(() => {
        const t = tables.get(code);
        if (t && t.clients.size === 0) tables.delete(code);
      }, 30000);
    }
  });
});

server.listen(PORT, () => {
  const scheme = keyPath && certPath ? 'https' : 'http';
  console.log(`\nPoker table is running.`);
  console.log(`  Open: ${scheme}://localhost:${PORT}/\n`);
});
