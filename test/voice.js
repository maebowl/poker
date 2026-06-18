'use strict';
/* Validate the WebRTC voice mesh: two browsers enable mic and must connect P2P. */
const puppeteer = require('puppeteer-core');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://localhost:3010/';
const TABLE = 'VOICE' + Math.floor(Math.random() * 900 + 100);

async function page(browser, name) {
  const p = await browser.newPage();
  await p.goto(BASE + '?table=' + TABLE, { waitUntil: 'networkidle2' });
  await p.evaluate((nm) => { document.getElementById('name-input').value = nm; }, name);
  await p.click('#join-btn');
  // Seats render on the first state message, which only arrives after join +
  // hello (so Voice has been configured with our id by then).
  await p.waitForSelector('#seats .seat', { timeout: 5000 });
  return p;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    const a = await page(browser, 'Alice');
    const b = await page(browser, 'Bob');
    // Both enable voice.
    await a.evaluate(() => window.Voice.enable());
    await b.evaluate(() => window.Voice.enable());
    // Wait for ICE to connect.
    await new Promise((r) => setTimeout(r, 4000));
    const sa = await a.evaluate(() => ({ peers: window.Voice.peerCount(), states: window.Voice.states() }));
    const sb = await b.evaluate(() => ({ peers: window.Voice.peerCount(), states: window.Voice.states() }));
    const audioA = await a.evaluate(() => document.querySelectorAll('#audio-sinks audio').length);
    console.log('=== VOICE RESULTS ===');
    console.log('Alice:', JSON.stringify(sa), 'audioEls:', audioA);
    console.log('Bob:  ', JSON.stringify(sb));
    const ok = sa.peers === 1 && sb.peers === 1 &&
      sa.states.every((s) => s === 'connected') && sb.states.every((s) => s === 'connected');
    console.log('voice P2P connected:', ok);
  } catch (e) {
    console.error('voice test error:', e.message);
  } finally {
    await browser.close();
  }
})();
