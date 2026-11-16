// index.html の E2E テスト。外部ネットワーク不要（シグナリングはローカルの PeerJS サーバー、ICE サーバーなし）。
//   cd tests && npm install && npx playwright install chromium && npm test
//   node e2e.js <名前の一部>   … 一部のテストだけ実行     SKIP_SLOW=1 … 自動テスト（約 1.5 分）を省略
const path = require('path'), fs = require('fs'), http = require('http'), assert = require('assert');
const { PeerServer } = require('peer');
const { chromium } = require('playwright');

const FILE = path.resolve(__dirname, '..', 'index.html');
const WEB = 8123, SIG = 9123;
const CFG = name => ({ name, ice: [], relayOnly: false, server: { host: '127.0.0.1', port: SIG, path: '/', secure: false } });
const SYNCED = n => new RegExp(`${n} 台すべて同期済み`);
let browser, opened = [], errors = [], roomSeq = 0;
const newRoom = () => `t${Date.now().toString(36)}-${++roomSeq}`;

async function open(name, { room, url, history, cfg } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([cfg, hist]) => {
    if (!localStorage.getItem('p2pt.cfg')) localStorage.setItem('p2pt.cfg', JSON.stringify(cfg));
    if (hist && !localStorage.getItem('p2pt.seeded')) { localStorage.setItem('p2pt.history', hist); localStorage.setItem('p2pt.seeded', '1'); }
  }, [Object.assign(CFG(name), cfg || {}), history || null]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.goto(url || `http://127.0.0.1:${WEB}/` + (room ? '?room=' + encodeURIComponent(room) : ''));
  opened.push({ name, page, ctx });
  return page;
}
const banner = p => p.textContent('#syncBanner');
const waitSynced = (pages, n = pages.length, timeout = 30000) =>
  Promise.all(pages.map(p => p.waitForFunction(re => new RegExp(re).test(document.querySelector('#syncBanner').textContent), SYNCED(n).source, { timeout })));
async function group(n, room = newRoom()) {
  const pages = [await open('A', { room })];
  await pages[0].waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  for (let i = 1; i < n; i++) pages.push(await open('ABCDEFG'[i], { room }));
  await waitSynced(pages);
  return pages;
}
// send a raw message from this page to every directly connected device
const sendAll = (p, msg) => p.evaluate(m => { for (const L of links.values()) if (L.isOpen) L.send(m); }, msg);

const tests = [];
const test = (name, fn, slow) => tests.push({ name, fn, slow });

test('unit: IP を伏せるがブラウザのバージョンは残す', async () => {
  const p = await open('U');
  const out = await p.evaluate(() => maskIps('Chrome/130.0.0.0 Safari/537.36 srflx 203.0.113.7:54321 http://10.0.0.1/x 2001:db8::1:2 12:34:56'));
  assert.strictEqual(out, 'Chrome/130.0.0.0 Safari/537.36 srflx [IP] http://[IP]/x [IP] 12:34:56');
});

test('unit: ルーム ID は常に PeerJS で有効・名前ごとに別', async () => {
  const p = await open('U');
  const names = ['会議室', 'テスト', 'Room A', 'room-abc', 'a__b', '_x', 'ＡＢＣ', 'abc', ' Abc '];
  const ids = await p.evaluate(ns => ns.map(beaconIdOf), names);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/, id);
  assert.strictEqual(ids[3], 'p2pt-room-room-abc');
  assert.notStrictEqual(ids[0], ids[1]);
  assert.strictEqual(ids[6], ids[7]); // 全角・大文字小文字・前後の空白は同じ部屋
  assert.strictEqual(ids[7], ids[8]);
});

test('unit: 経路の判定（host 同士でも別ネットワークなら S）', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => [
    sameLan('192.168.1.5', '192.168.1.9'), sameLan('10.0.0.1', '192.168.1.9'), sameLan('abcd.local', '203.0.113.5'), sameLan(undefined, undefined),
    sameLan('2001:db8:1:2::10', '2001:db8:1:2:aaaa::1'), sameLan('fe80::1', 'fe80::2%eth0'),
    sameLan('2001:db8:1:2::10', '2400:4000:5:6::1'), sameLan('203.0.113.5', '198.51.100.7'),
    routeLetter('host', 'host', true), routeLetter('host', 'host', false), routeLetter('srflx', 'host', true), routeLetter('relay', 'host', true),
  ]);
  assert.deepStrictEqual(r, [true, true, true, true, true, true, false, false, 'H', 'S', 'S', 'R']);
});

test('unit: 結果の検証と、バックグラウンド端末がある場合の判定', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => {
    const ok = { id: 'a', ts: 1, by: 'x', caps: [{ key: 'k', title: 't', reason: 'r', status: 'ok' }], participants: ['x'], steps: [{ title: 's', status: 'pass' }], device: {} };
    const rt = bg => ({ u: { p50: 5, p95: 10, p99: 12, max: 15, loss: 0, jit: 1, stalls: 0, maxGap: 0, pairs: 1 }, r: null, fastNA: false, bg, missing: [] });
    const cap = bg => deriveCaps({ participants: ['a', 'b'], rt30: rt(bg) }).find(c => c.key === 'coop').status;
    return [validResult(ok), validResult(null), validResult({ ...ok, caps: 'x' }), validResult({ ...ok, caps: [{ key: 'k', title: 't', reason: 'r', status: '<b>' }] }),
      validResult({ ...ok, participants: [1] }), validResult({ ...ok, steps: [{ title: 's', status: 'constructor' }] }), cap([]), cap(['B'])];
  });
  assert.deepStrictEqual(r, [true, false, false, false, false, false, 'ok', 'cond']);
});

test('3 台が同期し、マス目とチャットが全員に届く', async () => {
  const [A, B, C] = await group(3);
  await A.click('#grid > div:nth-child(5)');
  await B.fill('#msg', 'こんにちは'); await B.click('#send');
  for (const p of [A, B, C]) {
    await p.waitForFunction(() => document.querySelector('#grid > div:nth-child(5)').style.background !== '' && /こんにちは/.test(document.querySelector('#chat').textContent), null, { timeout: 10000 });
  }
  await waitSynced([A, B, C]);
});

test('2 台がほぼ同時に参加しても 3 台そろう', async () => {
  const room = newRoom();
  const A = await open('A', { room });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  const [B, C] = await Promise.all([open('B', { room }), open('C', { room })]);
  await waitSynced([A, B, C], 3, 12000);
});

test('窓口の端末を再読み込みしても全員が合流する', async () => {
  const [A, B, C] = await group(3);
  await A.reload();
  await waitSynced([A, B, C], 3, 30000);
});

test('窓口の端末が抜けたら残りが窓口を引き継ぎ、新規参加者を受け入れる', async () => {
  const room = newRoom();
  const [A, B, C] = await group(3, room);
  await A.context().close();
  await Promise.race([B, C].map(p => p.waitForFunction(() => beaconOpen, null, { timeout: 30000 })));
  const D = await open('D', { room });
  await waitSynced([B, C, D], 3, 30000);
});

test('日本語のルーム名で接続でき、別の名前とは混ざらない', async () => {
  const s = Date.now().toString(36);
  const A = await open('A', { room: '会議室' + s });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  const B2 = await open('B', { room: '会議室' + s });
  const X = await open('X', { room: 'テスト' + s });
  await waitSynced([A, B2], 2);
  await X.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  await X.waitForTimeout(3000);
  assert.match(await banner(X), /自分だけです/);
  assert.match(await banner(A), SYNCED(2));
});

test('一斉書き込み 1000 回が書き込み完了から 5 秒以内に収束する', async () => {
  const [A, B, C] = await group(3);
  await A.selectOption('#burstN', '1000'); await A.click('#burstBtn');
  for (const p of [A, B, C]) await p.waitForFunction(() => burst && burst.done, null, { timeout: 70000 });
  for (const p of [A, B, C]) {
    const r = await p.evaluate(() => burst.result);
    assert.ok(r.ok && r.devices === 3 && r.sec <= 5, JSON.stringify(r));
  }
});

test('全消去で操作ログが全端末から消え、後から来た端末にも古い操作が届かない', async () => {
  const room = newRoom();
  const [A, B, C] = await group(3, room);
  await A.selectOption('#burstN', '50'); await A.click('#burstBtn');
  for (const p of [A, B, C]) await p.waitForFunction(() => burst && burst.done && ops.size >= 150, null, { timeout: 30000 });
  await B.click('#clearBtn');
  for (const p of [A, B, C]) await p.waitForFunction(() => ops.size === 0 && epoch === 1 && !document.querySelector('#grid > div[style*="background"]'), null, { timeout: 10000 });
  await C.click('#grid > div:nth-child(3)');
  const D = await open('D', { room });
  await waitSynced([A, B, C, D], 4);
  for (const p of [A, B, C, D]) assert.deepStrictEqual(await p.evaluate(() => [ops.size, epoch]), [1, 1]);
});

test('他端末からの不正な値で表示が壊れない・スクリプトが実行されない', async () => {
  const [A, B] = await group(2);
  const aId = await A.evaluate(() => me.id), bId = await B.evaluate(() => me.id);
  const X = '<img src=x onerror="window.__xss=1">';
  await sendAll(B, { t: 'st', id: 'evil1', sq: 1, name: X, color: 'red;position:fixed;inset:0', links: { [aId]: { r: X, rtt: X, n: X } }, h: X, n: X, ttl: 0 });
  await sendAll(B, { t: 'st', id: X, sq: 1, name: 'x' });
  await sendAll(B, { t: 'st', id: 'evil2', sq: 1, name: { toString: 1 }, links: 'x', ttl: 0 });
  await sendAll(B, { t: 'op', ops: [{ id: 'e:1', o: 'e', s: 1, l: 999, e: 0, k: 'm', v: X, n: X, col: 'red;position:fixed;inset:0' },
    { id: 'e:2', o: 'e', s: 2, l: 1000, e: 0, k: 'c', c: 7, v: 'url(http://127.0.0.1:1/leak)' }, { id: 'e:3', o: 'e', s: 3, l: 1001, k: 'c', c: 'x', v: 1 }, null, { id: 5 }] });
  await sendAll(B, { t: 'rtres', id: 'r1', from: bId, name: X, rate: X, rows: [{ to: X, k: X, sent: 5, loss: X, p50: X, p95: X, stalls: X, maxGap: X, off: X }, null] });
  await sendAll(B, { t: 'rtres', id: 'r2', from: bId });
  await sendAll(B, { t: 'rtstart', id: 'rs1', rate: 1e9, size: 1e12, dur: 1e9 });
  await sendAll(B, { t: 'burst', bid: 'b1', n: 1e9 });
  await sendAll(B, { t: 'autores' });
  await sendAll(B, { t: 'autores', result: { id: 'bad', ts: 1, caps: 'x' } });
  await sendAll(B, { t: 'autores', result: { id: 'bad2', ts: 1, by: X, caps: [{ key: 'k', title: X, reason: X, status: 'ok"><img src=x onerror=window.__xss=1>' }], participants: [X], steps: [], device: {} } });
  await sendAll(B, { t: 'hello', id: 'someone-else', name: 'spoof' });
  await sendAll(B, { t: 'sv', sv: 'x', ep: 'x' });
  await A.waitForFunction(() => /evil1|&lt;img/.test(document.querySelector('#matrix').innerHTML) && document.querySelector('#rtTable').innerHTML !== '', null, { timeout: 10000 });
  await A.waitForTimeout(1500);
  const r = await A.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('main img').length, fixed: document.querySelectorAll('[style*="fixed"]').length,
    cell: document.querySelector('#grid > div:nth-child(8)').style.background, hist: loadHist().length, rt: !!(rt && !rt.done), burst: !!burst, banner: document.querySelector('#syncBanner').textContent }));
  assert.deepStrictEqual({ ...r, banner: undefined }, { xss: undefined, imgs: 0, fixed: 0, cell: '', hist: 0, rt: false, burst: false, banner: undefined });
  // the page keeps working
  await A.click('#grid > div:nth-child(20)');
  await B.waitForFunction(() => document.querySelector('#grid > div:nth-child(20)').style.background !== '', null, { timeout: 10000 });
});

test('壊れた履歴が保存されていてもページが動く', async () => {
  const good = { id: 'g1', ts: 1700000000000, by: 'x', label: 'ok', caps: [{ key: 'k', title: 't', reason: 'r', status: 'ok' }], participants: ['x'], steps: [], device: { ua: 'u', page: 'Web' } };
  const p = await open('H', { history: JSON.stringify([{ id: 'b', ts: 1, caps: 'x' }, null, 5, good, { id: 'c', ts: 2, caps: [], participants: 'x' }]) });
  assert.strictEqual(await p.textContent('#histCount'), '1');
  await p.click('#joinBtn');
  await p.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
});

test('ファイルを直接開いたときはルーム名をコピーする', async () => {
  const p = await open('F', { url: 'file://' + FILE });
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  assert.strictEqual(await p.textContent('#shareBtn'), 'ルーム名をコピー');
  const room = await p.inputValue('#room');
  await p.click('#shareBtn');
  await p.waitForFunction(r => document.querySelector('#log').textContent.includes(r) && !document.querySelector('#log').textContent.includes('null/'), room, { timeout: 5000 });
});

test('手動モード（SDP コピペ）だけで 2 台が同期する', async () => {
  const A = await open('A'), B = await open('B');
  const sdp = p => p.waitForFunction(() => { const v = document.querySelector('#localSdp').value; return v && !v.includes('収集中') ? v : false; }, null, { timeout: 15000 }).then(h => h.jsonValue());
  for (const p of [A, B]) await p.click('#manualBox > summary');
  await A.click('#mkOffer');
  await B.fill('#remoteSdp', await sdp(A)); await B.click('#applyRemote');
  await B.waitForFunction(() => /アンサー作成完了/.test(document.querySelector('#log').textContent), null, { timeout: 15000 });
  await A.fill('#remoteSdp', await sdp(B)); await A.click('#applyRemote');
  await waitSynced([A, B], 2);
  await A.click('#grid > div:nth-child(2)');
  await B.waitForFunction(() => document.querySelector('#grid > div:nth-child(2)').style.background !== '', null, { timeout: 10000 });
});

test('長時間テスト: 切断なしなら ✅、結果が全員に保存される', async () => {
  const [A, B, C] = await group(3);
  const r = await A.evaluate(() => startLongAll({ dur: 8, win: 2 }));
  const cap = k => r.caps.find(c => c.key === k);
  assert.strictEqual(cap('long').status, 'ok', JSON.stringify(r.caps));
  assert.strictEqual(cap('longdrop').status, 'ok');
  assert.strictEqual(r.metrics.long.rows.length, 6); // 3 台 × 相手 2
  for (const row of r.metrics.long.rows) assert.ok(row.sent > 100 && row.loss < 3 && row.wins >= 3 && /^\.+$/.test(row.tl), JSON.stringify(row));
  for (const p of [B, C]) await p.waitForFunction(id => loadHist().some(x => x.id === id && x.received) && document.querySelector('#ltTable').rows.length > 6, r.id, { timeout: 10000 });
});

test('長時間テスト: 途中の切断と復帰を記録し ⚠️ になる・中止できる', async () => {
  const [A, B, C] = await group(3);
  const bId = await B.evaluate(() => me.id);
  const done = A.evaluate(() => startLongAll({ dur: 120, win: 2 }));
  await A.waitForTimeout(3000);
  await A.evaluate(id => links.get(id).close('テスト'), bId);
  await A.waitForFunction(id => links.get(id) && links.get(id).isOpen, bId, { timeout: 20000 });
  await A.waitForTimeout(18000);
  await C.click('#ltStop'); // 他の端末からでも中止できる
  const r = await done;
  const L = r.metrics.long;
  assert.ok(L.dur < 60, 'dur ' + L.dur);
  assert.strictEqual(r.caps.find(c => c.key === 'longdrop').status, 'cond', JSON.stringify(r.caps));
  assert.strictEqual(r.caps.find(c => c.key === 'long').status, 'cond');
  assert.strictEqual(L.dropped.length, 1);
  const ab = L.rows.find(x => x.from === 'A' && x.to === 'B');
  assert.ok(ab.drops === 1 && !ab.lost && ab.downMs > 0 && ab.tl.includes('x'), JSON.stringify(ab));
  assert.strictEqual(L.rows.find(x => x.from === 'A' && x.to === 'C').drops, 0);
});

test('TURN: 経路別に確認し、中継のみでも同期する', async () => {
  const Turn = require('node-turn');
  const srv = new Turn({ listeningPort: 3479, listeningIps: ['127.0.0.1'], relayIps: ['127.0.0.1'], authMech: 'long-term', credentials: { u: 'p' }, debugLevel: 'OFF' });
  srv.start();
  try {
    const ice = [{ urls: 'turn:127.0.0.1:3479', username: 'u', credential: 'p' }, { urls: 'turn:127.0.0.1:3480?transport=tcp', username: 'u', credential: 'p' }];
    const room = newRoom();
    const mk = name => open(name, { room, cfg: { ice, relayOnly: true } });
    const A = await mk('A');
    await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
    const B = await mk('B');
    await waitSynced([A, B], 2);
    await A.waitForFunction(() => [...links.values()].some(L => L.route === 'R'), null, { timeout: 10000 });
    const t = await A.evaluate(() => turnCheck());
    assert.deepStrictEqual(t.per.map(x => [x.label, x.ok]), [['UDP', true], ['TCP', false]]);
    assert.strictEqual(t.ok, true);
  } finally { srv.stop(); }
});

test('自動テスト（クイック）が 3 台で完走し、結果が全員に保存される', async () => {
  const [A, B, C] = await group(3);
  await A.fill('#autoLabel', 'e2e 203.0.113.7');
  await A.click('#autoBtn');
  await A.waitForFunction(() => auto && !auto.running && lastResult, null, { timeout: 240000 });
  const r = await A.evaluate(() => lastResult);
  const cap = k => r.caps.find(c => c.key === k).status;
  const info = JSON.stringify(r.steps, null, 1);
  assert.strictEqual(r.participants.length, 3);
  assert.ok(r.steps.every(s => s.status !== 'run'), info);
  assert.ok(!r.steps.some(s => s.status === 'fail'), info);
  for (const k of ['webrtc', 'room', 'lan', 'mesh', 'board', 'fast', 'recover']) assert.strictEqual(cap(k), 'ok', k + '\n' + info);
  assert.strictEqual(r.metrics.sync.ok, true);
  assert.strictEqual(r.metrics.reconnect.per.length, 2); // 全相手を 1 回ずつ切断
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(r.metrics)), 'IP が結果に残っている');
  const md = await A.evaluate(() => toMarkdown(lastResult));
  assert.ok(!md.includes('203.0.113.7') && md.includes('[IP]'));
  for (const p of [B, C]) await p.waitForFunction(id => loadHist().some(x => x.id === id && x.received), r.id, { timeout: 10000 });
  await waitSynced([A, B, C]);
}, true);

(async () => {
  const filter = process.argv[2];
  PeerServer({ port: SIG, host: '127.0.0.1', path: '/' });
  http.createServer((q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(FILE)); }).listen(WEB, '127.0.0.1');
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}); // 既存の Chromium を使う場合に指定
  let failed = 0;
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    if (t.slow && process.env.SKIP_SLOW) { console.log(`- skip ${t.name}`); continue; }
    opened = []; errors = [];
    const t0 = Date.now();
    try {
      await t.fn();
      assert.deepStrictEqual(errors, [], 'ページ内で例外が発生');
      console.log(`✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      console.log(`✗ ${t.name}\n  ${String(e.message).split('\n').join('\n  ')}`);
      for (const o of opened) {
        const tail = await o.page.evaluate(() => [...document.querySelectorAll('#log > div')].slice(-12).map(d => d.textContent).join('\n      ')).catch(() => '(closed)');
        console.log(`    [${o.name}] ${await o.page.textContent('#syncBanner').catch(() => '')}\n      ${tail}`);
      }
    }
    for (const o of opened) await o.ctx.close().catch(() => {});
  }
  await browser.close();
  console.log(failed ? `\n${failed} 件失敗` : '\nすべて成功');
  process.exit(failed ? 1 : 0);
})();
