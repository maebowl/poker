'use strict';
/* Drive Edge to seat 3 players and screenshot the live table (Alice's view). */
const puppeteer = require('puppeteer-core');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const BASE = process.env.BASE || 'http://localhost:3010/';
const TABLE = 'SHOT' + Math.floor(Math.random() * 900 + 100);

async function joinAndSit(browser, name, seat) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1120, height: 820 });
  await page.goto(BASE + '?table=' + TABLE, { waitUntil: 'networkidle2' });
  await page.evaluate((nm) => { try { localStorage.clear(); } catch {} document.getElementById('name-input').value = nm; }, name);
  await page.click('#join-btn');
  await page.waitForSelector('#seats .seat', { timeout: 5000 });
  // Click the empty seat at the requested engine index.
  await page.evaluate((s) => {
    window.send && window.send({ type: 'sit', seat: s });
  }, seat);
  return page;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  try {
    const alice = await joinAndSit(browser, 'Alice', 0);
    await joinAndSit(browser, 'Bob', 1);
    await joinAndSit(browser, 'Cara', 2);
    // Wait for the hand to start and cards to be dealt.
    await new Promise((r) => setTimeout(r, 5000));
    await alice.screenshot({ path: 'test/table.png' });
    console.log('screenshot saved to test/table.png');
  } catch (e) {
    console.error('shot error:', e.message);
  } finally {
    await browser.close();
  }
})();
