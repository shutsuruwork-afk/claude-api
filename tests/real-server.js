// 手動の確認用（npm test には含まれない）: 本物の公開 PeerJS サーバー 0.peerjs.com で 2 台をつなぐ。
//   node real-server.js ../index.html                        通常
//   node real-server.js ../index.html '{"relayOnly":true}'   端末同士の通信が塞がれた状態を再現
const fs = require('fs'), http = require('http');
const { chromium } = require('playwright');
const html = fs.readFileSync(process.argv[2]);
const cfgExtra = JSON.parse(process.argv[3] || '{}');
(async () => {
  http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(html); }).listen(8125, '127.0.0.1');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, proxy: proxy ? { server: proxy, bypass: '127.0.0.1,localhost' } : undefined });
  const room = 'dbg-' + Math.random().toString(36).slice(2, 9);
  const mk = async name => {
    const c = await b.newContext({ ignoreHTTPSErrors: true });
    await c.addInitScript(([n, extra]) => localStorage.setItem('p2pt.cfg', JSON.stringify(Object.assign({ name: n, ice: [], relayOnly: false, server: null }, extra))), [name, cfgExtra]);
    const p = await c.newPage();
    p.on('pageerror', e => console.log(name, 'pageerror', e.message));
    await p.goto('http://127.0.0.1:8125/?room=' + room);
    return p;
  };
  const dump = async (n, p) => console.log(`[${n}] ${await p.textContent('#syncBanner')} | ${await p.textContent('#sigState')} | ${await p.textContent('#roleState')}\n   ` +
    (await p.evaluate(() => [...document.querySelectorAll('#log > div')].slice(-14).map(d => d.textContent).join('\n   '))));
  const A = await mk('A'); await A.waitForTimeout(6000);
  const B = await mk('B'); await B.waitForTimeout(Number(process.env.WAIT || 12000));
  await dump('A', A); await dump('B', B);
  console.log('matrix A:', (await A.evaluate(() => document.querySelector('#matrix').innerText)).replace(/\n/g, ' / '));
  await b.close(); process.exit(0);
})();
