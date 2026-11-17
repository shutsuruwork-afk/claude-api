// index.html の E2E テスト。外部ネットワーク不要（シグナリングはローカルの PeerJS サーバー、ICE サーバーなし）。
//   cd tests && npm install && npx playwright install chromium && npm test
//   node e2e.js --list          … テストの一覧（分類ごと）
//   node e2e.js <名前の一部>    … テスト名か分類名に一致するものだけ実行
//   SKIP_SLOW=1 npm test        … 時間のかかる自動テスト系（各 40 秒前後）を省略
// テストは下の section() の分類ごとに並べる。新しいテストは当てはまる分類の中に足す。
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

// ---- 複数のテストで使う補助 ----
// 全員がページを開いた状態から、同じ瞬間に「参加」を押す
async function joinTogether(n, cfg) {
  const room = newRoom();
  const pages = await Promise.all([...Array(n)].map((_, i) => open('ABCDEFG'[i], { cfg })));
  for (const p of pages) await p.fill('#room', room);
  await Promise.all(pages.map(p => p.evaluate(() => document.querySelector('#joinBtn').click())));
  return pages;
}

// 端末同士の通信が塞がれた状態: 中継のみ + TURN なし = 候補が 1 つも出ないので P2P は絶対につながらない（シグナリングは通る）
const BLOCKED = { ice: [], relayOnly: true };

const names = p => p.evaluate(() => [...members.values()].map(m => m.name).sort().join(','));

// 1 台テスト: ページの中に仮の相手（iframe）を作って自動テストを流す
async function soloRun(p) {
  await p.fill('#autoLabel', '自宅');
  await p.click('#soloBtn');
  await p.waitForFunction(() => auto && !auto.running && lastResult, null, { timeout: 240000 });
  const r = await p.evaluate(() => lastResult);
  const info = JSON.stringify(r.steps, null, 1);
  const cap = k => (r.caps.find(c => c.key === k) || {}).status;
  assert.strictEqual(r.solo, true);
  assert.strictEqual(r.label, '【1 台テスト】自宅');
  assert.deepStrictEqual(r.participants, ['S', 'S（仮の相手）']);
  assert.ok(!r.steps.some(x => x.status === 'fail'), info);
  assert.strictEqual(cap('solo'), 'ok', info);
  assert.strictEqual(cap('room'), 'ok');
  // 端末の外に出ていない計測は「使える」と表示しない
  for (const k of ['reach', 'lan', 'mesh', 'board', 'coop', 'action', 'bigdata', 'fast', 'file', 'recover', 'clock']) assert.strictEqual(cap(k), 'na', k);
  assert.match(r.caps.find(c => c.key === 'coop').reason, /1 台テストでは未検証（この端末の中では ○/);
  assert.deepStrictEqual(r.metrics.rt30.bg, [], '仮の相手のタイマーが遅れている');
  assert.deepStrictEqual(await p.evaluate(() => loadHist().map(x => [x.id, !!x.received])), [[r.id, false]]);
  await p.click('#soloClose');
  await p.waitForFunction(() => !document.querySelector('#soloHolder iframe') && members.size === 0, null, { timeout: 10000 });
}

const tests = [];
let currentSection = '';
const section = name => { currentSection = name; };
const test = (name, fn, slow) => tests.push({ section: currentSection, name, fn, slow });

// ======================================================================
section('単体（ページの中の関数）');
// ======================================================================

test('IP を伏せるがブラウザのバージョンは残す', async () => {
  const p = await open('U');
  const out = await p.evaluate(() => maskIps('Chrome/130.0.0.0 Safari/537.36 srflx 203.0.113.7:54321 http://10.0.0.1/x 2001:db8::1:2 12:34:56'));
  assert.strictEqual(out, 'Chrome/130.0.0.0 Safari/537.36 srflx [IP] http://[IP]/x [IP] 12:34:56');
});

test('ルーム ID は常に PeerJS で有効・名前ごとに別', async () => {
  const p = await open('U');
  const names = ['会議室', 'テスト', 'Room A', 'room-abc', 'a__b', '_x', 'ＡＢＣ', 'abc', ' Abc '];
  const ids = await p.evaluate(ns => ns.map(beaconIdOf), names);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/, id);
  assert.strictEqual(ids[3], 'p2pt-room-room-abc');
  assert.notStrictEqual(ids[0], ids[1]);
  assert.strictEqual(ids[6], ids[7]); // 全角・大文字小文字・前後の空白は同じ部屋
  assert.strictEqual(ids[7], ids[8]);
});

test('経路の判定（host 同士でも別ネットワークなら S）', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => [
    sameLan('192.168.1.5', '192.168.1.9'), sameLan('10.0.0.1', '192.168.1.9'), sameLan('abcd.local', '203.0.113.5'), sameLan(undefined, undefined),
    sameLan('2001:db8:1:2::10', '2001:db8:1:2:aaaa::1'), sameLan('fe80::1', 'fe80::2%eth0'),
    sameLan('2001:db8:1:2::10', '2400:4000:5:6::1'), sameLan('203.0.113.5', '198.51.100.7'),
    routeLetter('host', 'host', true), routeLetter('host', 'host', false), routeLetter('srflx', 'host', true), routeLetter('relay', 'host', true),
  ]);
  assert.deepStrictEqual(r, [true, true, true, true, true, true, false, false, 'H', 'S', 'S', 'R']);
});

test('結果の検証と、バックグラウンド端末がある場合の判定', async () => {
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

test('NAT の判定: IPv4 と IPv6 の両方があっても対称型と誤判定しない', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => [
    natSymmetric([{ addr: '203.0.113.9', port: 60214, base: 0 }, { addr: '2001:db8::5', port: 51000, base: 0 }], 2), // 家の結果と同じ形
    natSymmetric([{ addr: '203.0.113.9', port: 60214, base: 50000 }, { addr: '203.0.113.9', port: 60999, base: 50000 }], 1), // 同じソケットが別の対応 → 対称型
    natSymmetric([{ addr: '203.0.113.9', port: 60214, base: 0 }, { addr: '203.0.113.9', port: 60999, base: 0 }], 1), // 隠れていてもソケットは 1 つ → 対称型
    natSymmetric([{ addr: '203.0.113.9', port: 60214, base: 0 }, { addr: '203.0.113.9', port: 60999, base: 0 }], 2), // ソケットが 2 つありうる → 断定しない
    natSymmetric([{ addr: '203.0.113.9', port: 60214, base: 50000 }], 1),
  ]);
  assert.deepStrictEqual(r, [false, true, true, false, false]);
});

test('端末内テストが不成立でも、相手とつながっていれば「WebRTC が使えない」としない', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => {
    const st = (M, k) => deriveCaps(Object.assign({ participants: ['a'], browser: { rtc: true } }, M)).find(c => c.key === k).status;
    const mesh = { pairs: 1, ok: 1, H: 0, S: 1, R: 0, fail: 0, pending: 0, failed: [], why: [] };
    return [
      st({ loopback: { ok: true, ms: 10 } }, 'webrtc'),
      st({ loopback: { ok: false, hidden: true }, participants: ['a', 'b'], mesh }, 'webrtc'), // 家の結果と同じ形
      st({ loopback: { ok: false, hidden: true }, participants: ['a', 'b'], mesh }, 'manual'),
      st({ loopback: { ok: false, viaIce: true, hidden: true } }, 'webrtc'),
      st({ loopback: { ok: false, hidden: true } }, 'webrtc'),
      st({ loopback: { ok: false, hidden: false, host: 0 } }, 'webrtc'),
      st({ loopback: { ok: false, hidden: false, host: 0 } }, 'manual'),
    ];
  });
  assert.deepStrictEqual(r, ['ok', 'ok', 'cond', 'ok', 'cond', 'ng', 'ng']);
});

test('つながらない理由の切り分け', async () => {
  const p = await open('U');
  const r = await p.evaluate(() => {
    const base = { lh: 1, lhHidden: 1, ls: 1, lr: 0, rh: 1, rhHidden: 1, rs: 1, rr: 0, sameNat: true, answered: true, pairs: 2, sent: 40, recv: 0, got: 0 };
    const sdp = 'v=0\r\na=candidate:1 1 udp 2113937151 0a1b2c3d-1111.local 54321 typ host generation 0\r\na=candidate:2 1 udp 1677729535 203.0.113.9 60214 typ srflx raddr 0.0.0.0 rport 0\r\na=candidate:3 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active\r\n';
    const c = sdpCands(sdp);
    return [diagReason(base), diagReason({ ...base, lhHidden: 0, rhHidden: 0, lan: true }), diagReason({ ...base, sameNat: false }), diagReason({ ...base, sameNat: null, ls: 0, rs: 0 }),
      diagReason({ ...base, rh: 0, rs: 0 }), diagReason({ ...base, lh: 0, ls: 0, relayOnly: true }), diagReason({ ...base, answered: false }), [c.h, c.hid, c.s, c.r, c.pub.size]];
  });
  assert.match(r[0], /同じネットワーク.*ローカル IP を隠している.*LAN 内の直接接続を助ける/);
  assert.match(r[1], /ローカル IP を伝えても届かない.*端末間通信が禁止.*TURN/);
  assert.match(r[2], /別々のネットワーク.*TURN/);
  assert.match(r[3], /同じネットワークかどうかは判定できない/);
  assert.match(r[4], /相手から接続候補が届いていない/);
  assert.match(r[5], /TURN 中継のみ/);
  assert.match(r[6], /返事が来ていない/);
  assert.deepStrictEqual(r[7], [2, 1, 1, 0, 1]);
  for (const t of r.slice(0, 7)) assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(t), 'IP が理由の文に出ている');
});

// ======================================================================
section('参加と合流');
// ======================================================================

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

test('誰もいないルームに 5 台が同時に入っても、窓口は 1 台だけで全員そろう', async () => {
  const pages = await joinTogether(5);
  await waitSynced(pages, 5, 15000);
  const beacons = await Promise.all(pages.map(p => p.evaluate(() => beaconOpen)));
  assert.strictEqual(beacons.filter(Boolean).length, 1);
});

test('窓口が開通直後に送った一覧・hello が失われても、すぐ参加できる', async () => {
  // ブラウザは「チャネルが開いた瞬間に応答側が送った最初のメッセージ」をまれに落とす。それを確実に再現する
  const room = newRoom();
  const A = await open('A', { room });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  await A.evaluate(() => {
    const orig = RTCDataChannel.prototype.send, seen = new WeakSet();
    RTCDataChannel.prototype.send = function (d) {
      if (typeof d === 'string' && /"t":"(members|hello)"/.test(d) && !seen.has(this)) { seen.add(this); return; }
      return orig.call(this, d);
    };
  });
  const B = await open('B', { room });
  await waitSynced([A, B], 2, 4000);
  await B.waitForFunction(() => /接続成功: A/.test(document.querySelector('#log').textContent), null, { timeout: 3000 });
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

// ======================================================================
section('つながらないとき');
// ======================================================================

test('直接通信が塞がれていても相手を発見し、理由を表示する（3 台）', async () => {
  const room = newRoom();
  const A = await open('A', { room, cfg: BLOCKED });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  const B = await open('B', { room, cfg: BLOCKED });
  for (const p of [A, B]) await p.waitForFunction(() => members.size === 1, null, { timeout: 10000 });
  assert.match(await banner(B), /を見つけました。接続中|直接つながりません/);
  const C = await open('C', { room, cfg: BLOCKED });
  for (const p of [A, B, C]) await p.waitForFunction(() => members.size === 2, null, { timeout: 15000 });
  assert.deepStrictEqual([await names(A), await names(B), await names(C)], ['B,C', 'A,C', 'A,B']);
  for (const p of [A, B, C]) {
    await p.waitForFunction(() => /見つかりましたが、直接つながりません/.test(document.querySelector('#syncBanner').textContent) && document.querySelector('#helpBox').open, null, { timeout: 40000 });
    assert.ok((await p.evaluate(() => document.querySelector('#matrix').innerText)).includes('×'));
    assert.match(await p.textContent('#whyBox'), /「TURN 中継のみ」の設定/);
  }
});

test('候補は出ているのに届かない場合、理由と候補の内訳を表示する', async () => {
  const room = newRoom();
  // 相手の候補をすべて捨てる = パケットが 1 つも届かないネットワークと同じ状態
  const drop = p => p.evaluate(() => { RTCPeerConnection.prototype.addIceCandidate = async () => {}; });
  const A = await open('A'); await drop(A); await A.fill('#room', room); await A.click('#joinBtn');
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  const B = await open('B'); await drop(B); await B.fill('#room', room); await B.click('#joinBtn');
  for (const p of [A, B]) {
    await p.waitForFunction(() => /見つかりましたが、直接つながりません/.test(document.querySelector('#syncBanner').textContent) && document.querySelector('#whyBox').textContent !== '', null, { timeout: 35000 });
    const why = await p.textContent('#whyBox');
    assert.match(why, /自分の候補: host [1-9]/, why);
    assert.match(why, /相手から接続候補が届いていない|パケットが届かない/, why);
    assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(why), 'IP が出ている');
  }
  assert.match(await A.evaluate(() => buildReport()), /つながらない理由: /);
});

test('窓口が古い版で応答しなくても「ルームに他の端末がいる」と表示する', async () => {
  const room = newRoom();
  const A = await open('A', { room, cfg: BLOCKED });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  await A.evaluate(() => { peer.connect = () => undefined; }); // 古い版と同じく、窓口側からは接続しに行かない
  const B = await open('B', { room, cfg: BLOCKED });
  await B.waitForFunction(() => /他の端末がいますが、接続できていません/.test(document.querySelector('#syncBanner').textContent), null, { timeout: 10000 });
});

test('「LAN 内の直接接続を助ける」でローカル IP が相手に伝わるようになる', async () => {
  const p = await open('L');
  const hidden = () => p.evaluate(async () => (await runDiag()).hostHidden);
  assert.strictEqual(await hidden(), true);
  await p.context().grantPermissions(['microphone']);
  await p.click('#helpBox > summary'); await p.click('#lanBtn');
  await p.waitForFunction(() => document.querySelector('#lanState').textContent !== '', null, { timeout: 10000 });
  const state = await p.textContent('#lanState');
  if (/有効/.test(state)) assert.strictEqual(await hidden(), false);
  else { // マイク取得に対応していないブラウザ: ページが理由を表示して止まることだけ確認する
    console.log('  (このブラウザはマイク取得に非対応のため、ローカル IP の確認は省略)');
    assert.match(await p.textContent('#log'), /マイクの許可が得られませんでした/);
  }
  await p.evaluate(() => { document.querySelector('#diagBtn').closest('details').open = true; });
  await p.click('#diagBtn');
  await p.waitForFunction(() => /NAT 判定/.test(document.querySelector('#diagOut').textContent), null, { timeout: 15000 });
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(await p.textContent('#diagOut')), '診断画面に IP が出ている');
});

test('「LAN 内の直接接続を助ける」を使った端末が、相手の画面と結果に残る', async () => {
  const [A, B] = await group(2);
  await A.context().grantPermissions(['microphone']);
  await A.click('#helpBox > summary'); await A.click('#lanBtn');
  await A.waitForFunction(() => document.querySelector('#lanState').textContent !== '', null, { timeout: 10000 });
  if (!/有効/.test(await A.textContent('#lanState'))) { console.log('  (このブラウザはマイク取得に非対応のため省略)'); return; }
  await B.waitForFunction(() => [...members.values()].some(m => m.status && m.status.lan), null, { timeout: 10000 });
  assert.match(await A.evaluate(() => buildReport()), /LAN 内の直接接続を助ける: 使用中/);
  assert.match(await B.evaluate(() => buildReport()), /LAN 内の直接接続を助ける: 未使用/);
  const reason = await B.evaluate(() => deriveCaps({ participants: ['B', 'A'], lanAssist: ['A'], mesh: { pairs: 1, ok: 1, H: 1, S: 0, R: 0, fail: 0, pending: 0, failed: [], why: [] } }).find(c => c.key === 'lan').reason);
  assert.match(reason, /を使用: A/);
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

// ======================================================================
section('共有データ');
// ======================================================================

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

test('2 台が同時に全消去しても同じ状態になる', async () => {
  const [A, B, C] = await group(3);
  await A.click('#grid > div:nth-child(1)');
  await waitSynced([A, B, C]);
  await Promise.all([A, B].map(p => p.evaluate(() => document.querySelector('#clearBtn').click())));
  for (const p of [A, B, C]) await p.waitForFunction(() => epoch === 1 && ops.size === 0, null, { timeout: 10000 });
  await Promise.all([A, B, C].map((p, i) => p.click(`#grid > div:nth-child(${i + 2})`)));
  for (const p of [A, B, C]) await p.waitForFunction(() => ops.size === 3, null, { timeout: 10000 });
  await waitSynced([A, B, C]);
});

// ======================================================================
section('不正な入力への耐性');
// ======================================================================

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

// ======================================================================
section('長時間テスト');
// ======================================================================

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

test('2 台が同時に長時間テストを開始しても 1 つにまとまる', async () => {
  const [A, B, C] = await group(3);
  const [ra, rb] = await Promise.all([A, B].map(p => p.evaluate(() => startLongAll({ dur: 6, win: 2 }))));
  assert.strictEqual([ra, rb].filter(Boolean).length, 1, '結果を出すのは 1 台だけ');
  const r = ra || rb;
  assert.strictEqual(r.metrics.long.rows.length, 6, JSON.stringify(r.metrics.long.rows.map(x => x.from + x.to)));
  assert.strictEqual(r.caps.find(c => c.key === 'long').status, 'ok', JSON.stringify(r.caps));
  for (const p of [A, B, C]) {
    await p.waitForFunction(id => loadHist().some(x => x.id === id), r.id, { timeout: 10000 });
    assert.strictEqual(await p.evaluate(() => loadHist().length), 1);
  }
});

// ======================================================================
section('自動テスト');
// ======================================================================

test('直接通信が塞がれていると、自動テストは「相手は見つかったがつながらない」と判定する', async () => {
  const room = newRoom();
  const A = await open('A', { room, cfg: BLOCKED });
  await A.waitForFunction(() => beaconOpen, null, { timeout: 15000 });
  const B = await open('B', { room, cfg: BLOCKED });
  await B.waitForFunction(() => members.size === 1, null, { timeout: 10000 });
  await B.click('#autoBtn');
  await B.waitForFunction(() => auto && !auto.running && lastResult, null, { timeout: 90000 });
  const r = await B.evaluate(() => lastResult);
  const info = JSON.stringify(r.steps, null, 1);
  assert.deepStrictEqual(r.participants, ['B', 'A']);
  assert.strictEqual(r.caps.find(c => c.key === 'reach').status, 'ng', info);
  assert.strictEqual(r.caps.find(c => c.key === 'webrtc').status, 'ok');
  // 「ブラウザが対応」と「相手とつながる」を取り違えない表示になっている
  assert.match(r.caps.find(c => c.key === 'webrtc').title, /この端末の中だけの確認/);
  assert.match(r.caps.find(c => c.key === 'reach').title, /相手の端末との直接接続/);
  assert.strictEqual(r.caps.find(c => c.key === 'room').status, 'ok');
  assert.ok(r.steps.some(x => x.status === 'fail' && /直接つながらない: /.test(x.detail)), info);
  assert.ok(r.steps.some(x => x.status === 'skip' && /省略/.test(x.detail)), info);
  assert.ok(r.build);
});

test('隠されたローカル IP を解決できない環境では、端末内テストを ❌ ではなく ⚠️ にする', async () => {
  const p = await open('M');
  // mDNS 名（隠されたローカル IP）の候補を捨てる = その名前を解決できないネットワークと同じ状態
  await p.evaluate(() => {
    const orig = RTCPeerConnection.prototype.addIceCandidate;
    RTCPeerConnection.prototype.addIceCandidate = function (c) { return c && /\.local /.test(c.candidate || '') ? Promise.resolve() : orig.apply(this, arguments); };
  });
  await p.click('#autoBtn');
  await p.waitForFunction(() => auto && !auto.running && lastResult, null, { timeout: 90000 });
  const r = await p.evaluate(() => lastResult);
  const step = r.steps.find(x => /WebRTC 単体動作/.test(x.title));
  assert.strictEqual(step.status, 'warn', JSON.stringify(step));
  assert.match(step.detail, /ローカル IP を隠して/);
  assert.strictEqual(r.caps.find(c => c.key === 'webrtc').status, 'cond');
  assert.strictEqual(r.caps.find(c => c.key === 'manual').status, 'cond');
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(r.metrics.loopback)));
});

test('1 台テスト: 仮の相手と自動テストが完走し、ネットワーク項目は未検証のまま', async () => {
  await soloRun(await open('S'));
}, true);

test('1 台テスト: ファイルを直接開いた場合も動く', async () => {
  await soloRun(await open('S', { url: 'file://' + FILE }));
}, true);

test('2 台が同時に自動テストを開始しても、走るのは 1 つだけ', async () => {
  const [A, B] = await group(2);
  await Promise.all([A, B].map(p => p.evaluate(() => document.querySelector('#autoBtn').click())));
  for (const p of [A, B]) await p.waitForFunction(() => auto && !auto.running && loadHist().length > 0, null, { timeout: 240000 });
  const st = await Promise.all([A, B].map(p => p.evaluate(() => ({ aborted: !!auto.abort, hist: loadHist().map(x => x.id), status: document.querySelector('#autoStatus').textContent }))));
  assert.strictEqual(st.filter(x => x.aborted).length, 1, JSON.stringify(st));
  assert.strictEqual(st[0].hist.length, 1); assert.deepStrictEqual(st[0].hist, st[1].hist);
  const r = await A.evaluate(() => loadHist()[0]);
  assert.ok(!r.steps.some(x => x.status === 'fail'), JSON.stringify(r.steps, null, 1));
  assert.strictEqual(r.caps.find(c => c.key === 'coop').status, 'ok');
}, true);

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
  if (filter === '--list') {
    let sec = '';
    for (const t of tests) { if (t.section !== sec) console.log(`\n■ ${sec = t.section}`); console.log(`  - ${t.name}${t.slow ? '（時間がかかる）' : ''}`); }
    console.log(`\n計 ${tests.length} 件`);
    return;
  }
  PeerServer({ port: SIG, host: '127.0.0.1', path: '/' });
  http.createServer((q, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(FILE)); }).listen(WEB, '127.0.0.1');
  // 通常の Chromium を使う（既定のヘッドレス専用ビルドは getUserMedia に対応していない）。偽のマイクを使い、実機のマイクは使わない
  browser = await chromium.launch(Object.assign({ args: ['--use-fake-device-for-media-stream'] },
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' })); // CHROMIUM_PATH: 既存の Chromium を使う場合に指定
  let failed = 0, passed = 0, skipped = 0, sec = '';
  const started = Date.now();
  for (const t of tests) {
    if (filter && !t.name.includes(filter) && !t.section.includes(filter)) continue;
    if (t.section !== sec) console.log(`\n■ ${sec = t.section}`);
    if (t.slow && process.env.SKIP_SLOW) { skipped++; console.log(`- 省略 ${t.name}`); continue; }
    opened = []; errors = [];
    const t0 = Date.now();
    try {
      await t.fn();
      assert.deepStrictEqual(errors, [], 'ページ内で例外が発生');
      passed++;
      console.log(`✓ ${t.name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      failed++;
      if (errors.length) console.log(`  ページ内の例外: ${errors.join(' / ')}`);
      console.log(`✗ ${t.name}\n  ${String(e.message).split('\n').join('\n  ')}`);
      for (const o of opened) {
        const tail = await o.page.evaluate(() => [...document.querySelectorAll('#log > div')].slice(-12).map(d => d.textContent).join('\n      ')).catch(() => '(closed)');
        console.log(`    [${o.name}] ${await o.page.textContent('#syncBanner').catch(() => '')}\n      ${tail}`);
        const state = await o.page.evaluate(() => JSON.stringify({ links: [...links.values()].map(L => ({ to: L.name, state: L.state, init: L.initiator === me.id, age: Math.round((now() - L.createdAt) / 1000) })),
          attempts: [...attempts].map(([id, a]) => ({ to: (members.get(id) || {}).name || id, n: a.n, f: a.f || 0 })) })).catch(() => '');
        if (state) console.log(`      状態: ${state}`);
      }
    }
    for (const o of opened) await o.ctx.close().catch(() => {});
  }
  await browser.close();
  console.log(`\n${failed ? failed + ' 件失敗' : 'すべて成功'}（成功 ${passed} / 失敗 ${failed}${skipped ? ' / 省略 ' + skipped : ''}、${((Date.now() - started) / 1000).toFixed(0)} 秒）`);
  process.exit(failed ? 1 : 0);
})();
