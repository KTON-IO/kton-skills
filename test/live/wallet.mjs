// A testnet wallet for the end-to-end checks, played over TON Connect the way
// a wallet app does it: it answers a connect link from `kton connect` with the
// test wallet (~/.kton-skill-test/wallet.json, testnet only), then signs each
// transaction the skill asks for and sends it to testnet, or declines it.
//
//   node test/live/wallet.mjs '<link>' [--decline] [--seconds 300]
//
// This harness is the only code in the repository that reads a recovery
// phrase: the test wallet's own, made for testnet and refused on mainnet. The
// skill never asks for, reads or keeps one.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Address, beginCell, Cell, internal, SendMode, storeStateInit } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { SessionCrypto } from '@tonconnect/protocol';

const [link, ...flags] = process.argv.slice(2);
const decline = flags.includes('--decline');
const seconds = Number(flags[flags.indexOf('--seconds') + 1]) || 300;
const saved = JSON.parse(readFileSync(join(homedir(), '.kton-skill-test', 'wallet.json'), 'utf8'));
if (saved.network !== 'testnet') throw new Error('test wallet must be testnet');
const key = await mnemonicToPrivateKey(saved.mnemonic.split(' '));
const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey, walletId: { networkGlobalId: -3 } });
const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const url = new URL(link.replace(/^tc:\/\//, 'https://tc.invalid/'));
const dappId = url.searchParams.get('id');
const request = JSON.parse(url.searchParams.get('r'));
const BRIDGE = 'https://bridge.tonapi.io/bridge';
const session = new SessionCrypto();
const post = async (obj) => {
  const body = Buffer.from(session.encrypt(JSON.stringify(obj), Buffer.from(dappId, 'hex'))).toString('base64');
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BRIDGE}/message?client_id=${session.sessionId}&to=${dappId}&ttl=300`, { method: 'POST', body });
    if (r.status !== 429) return r.status;
    await new Promise((x) => setTimeout(x, 1500 * (i + 1)));
  }
};
const manifest = await (await fetch(request.manifestUrl)).json().catch(() => null);
log('manifest', request.manifestUrl, '->', manifest?.name, manifest?.url);
const stateInit = beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64');
log('connect as', wallet.address.toString({ testOnly: true, bounceable: false }), await post({
  event: 'connect', id: Date.now(),
  payload: {
    items: [{ name: 'ton_addr', address: wallet.address.toRawString(), network: '-3', publicKey: Buffer.from(key.publicKey).toString('hex'), walletStateInit: stateInit }],
    device: { platform: 'linux', appName: 'kton-test-wallet', appVersion: '0.0.1', maxProtocolVersion: 2, features: ['SendTransaction', { name: 'SendTransaction', maxMessages: 4 }] },
  },
}));

const ctrl = new AbortController();
setTimeout(() => { ctrl.abort(); process.exit(0); }, seconds * 1000);
const events = await fetch(`${BRIDGE}/events?client_id=${session.sessionId}`, { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
const reader = events.body.getReader();
let buf = '';
for (;;) {
  const { value, done } = await reader.read().catch(() => ({ done: true }));
  if (done) break;
  buf += Buffer.from(value).toString();
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    const data = /^data: ?(.*)$/m.exec(block)?.[1];
    if (!data || data === 'heartbeat') continue;
    const wire = JSON.parse(data);
    const msg = JSON.parse(session.decrypt(Buffer.from(wire.message, 'base64'), Buffer.from(wire.from, 'hex')));
    if (msg.method === 'disconnect') { log('dApp disconnected'); await post({ result: {}, id: msg.id }); continue; }
    if (msg.method !== 'sendTransaction') continue;
    const tx = JSON.parse(msg.params[0]);
    log('asked to send', tx.network, tx.messages.map((m) => `${m.amount} nano to ${m.address}`).join('; '));
    if (decline || tx.network !== '-3') {
      await post({ error: { code: 300, message: 'User declined the transaction' }, id: msg.id });
      log('declined');
      continue;
    }
    const contract = client.open(wallet);
    await new Promise((x) => setTimeout(x, 1200));
    const seqno = await contract.getSeqno().catch(() => 0);
    const transfer = wallet.createTransfer({
      seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: tx.messages.map((m) => internal({ to: Address.parse(m.address), value: BigInt(m.amount), body: m.payload ? Cell.fromBase64(m.payload) : undefined })),
    });
    const external = beginCell().storeUint(0b10, 2).storeUint(0, 2).storeAddress(wallet.address).storeCoins(0)
      .storeBit(seqno === 0).storeMaybeRef(seqno === 0 ? beginCell().store(storeStateInit(wallet.init)).endCell() : null)
      .storeBit(1).storeRef(transfer).endCell();
    // testnet's public TonCenter allows one request a second: retry a 429.
    let sent = false;
    for (let attempt = 0; attempt < 6 && !sent; attempt++) {
      await new Promise((x) => setTimeout(x, 1200 * (attempt + 1)));
      await contract.send(transfer).then(
        () => { sent = true; log('broadcast, seqno', seqno); },
        (e) => log('broadcast failed', e.message),
      );
    }
    // A wallet that could not send says so, as a wallet app would.
    await post(sent ? { result: external.toBoc().toString('base64'), id: msg.id } : { error: { code: 0, message: 'Could not send the transaction' }, id: msg.id });
  }
}
