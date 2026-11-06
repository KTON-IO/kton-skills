// Does kton-sdk's checkWithdrawal (the KTON skill's pre-send check) say what
// the deployed pool code actually does? The real mainnet pool (code + data of
// 2026-11-06) in the sandbox, in several states (its own; previous round
// empty; a thin free balance; burns already queued), and for each a burn just
// under and just over the predicted limit, waiting and at once. Sandbox only.
import { Blockchain, createShardAccount, internal, BlockchainTransaction } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano, TupleItem } from '@ton/core';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import { Pool, dataToFullConfig, poolFullConfigToCell } from '../wrappers/Pool';
import { Op } from '../PoolConstants';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkWithdrawal, parsePoolData } = require('kton-sdk');

const FIX = process.env.FIXTURES!;
const f = JSON.parse(readFileSync(`${FIX}/pool-public-2026-11-06.json`, 'utf-8'));
const GOV = Address.parse('EQA9JzZn6pQlCxao0UYw0wumvUamrEpYioM_CqvdmHmjDwSs');
// A made-up holder: any address serves, and none belongs to anyone.
const USER = new Address(0, Buffer.alloc(32, 0x5a));
const KTON = 1_000_000_000n;

// The sandbox's get-method stack, in the shape TonCenter v3 returns (what the SDK parses).
function toV3(item: TupleItem): any {
    if (item.type === 'int') return { type: 'num', value: (item.value < 0n ? '-0x' : '0x') + (item.value < 0n ? -item.value : item.value).toString(16) };
    if (item.type === 'cell' || item.type === 'slice' || item.type === 'builder')
        return { type: item.type === 'cell' ? 'cell' : 'slice', value: item.cell.toBoc().toString('base64') };
    if (item.type === 'null') return { type: 'list', value: [] };
    if (item.type === 'tuple') return { type: 'tuple', value: item.items.map(toV3) };
    throw new Error('unexpected ' + item.type);
}

function poolTx(txs: BlockchainTransaction[], pool: Address) {
    return txs.find(t => t.inMessage?.info.dest instanceof Address && (t.inMessage.info.dest as Address).equals(pool))!;
}

describe('the skill predicts what the pool does with a burn', () => {
    const addr = Address.parseRaw(f.address);
    let bc: Blockchain;
    let base: Cell;
    let minter: Address;

    beforeAll(async () => {
        bc = await Blockchain.create();
        bc.now = Math.floor(Date.parse(f.fetchedAt) / 1000);
        await bc.setShardAccount(addr, createShardAccount({ address: addr, code: Cell.fromBase64(f.code), data: Cell.fromBase64(f.data), balance: BigInt(f.balance) }));
        // The wrapper's getter needs a sudoer address it can parse; give it one (withdrawals do not read it).
        await bc.openContract(Pool.createFromAddress(addr)).sendSetSudoer(bc.sender(GOV), GOV, toNano('0.1'));
        base = ((await bc.getContract(addr)).account.account!.storage.state as any).state.data;
    });

    const states = async () => {
        const pool = bc.openContract(Pool.createFromAddress(addr));
        const raw = await pool.getFullDataRaw();
        minter = raw.poolJettonMinter;
        const p34 = bc.config.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell()).get(34)!;
        const frozen = BigInt('0x' + p34.hash().toString('hex')); // no rotation inside the sandbox
        const loan = raw.previousRound.borrowed > 0n ? raw.previousRound : raw.currentRound;
        const make = (edit: (cfg: any) => void) => {
            const cfg: any = dataToFullConfig(raw);
            cfg.treasury = GOV;
            cfg.savedValidatorSetHash = frozen;
            edit(cfg);
            return poolFullConfigToCell(cfg);
        };
        return [
            { name: 'as on mainnet (previous round lent out)', data: make(() => {}), balance: BigInt(f.balance) },
            {
                name: 'previous round empty',
                data: make((cfg) => {
                    cfg.prevRound = { borrowers: null, roundId: loan.roundId - 1, activeBorrowers: 0n, borrowed: 0n, expected: 0n, returned: 0n, profit: 0n };
                    cfg.currentRound = { ...loan };
                }),
                balance: BigInt(f.balance),
            },
            {
                name: 'previous round empty, 2,908 Gram free',
                data: make((cfg) => {
                    cfg.prevRound = { borrowers: null, roundId: loan.roundId - 1, activeBorrowers: 0n, borrowed: 0n, expected: 0n, returned: 0n, profit: 0n };
                    cfg.currentRound = { ...loan };
                }),
                balance: toNano('2908.457'),
            },
            {
                name: 'previous round empty, 1,500 KTON already queued',
                data: make((cfg) => {
                    cfg.prevRound = { borrowers: null, roundId: loan.roundId - 1, activeBorrowers: 0n, borrowed: 0n, expected: 0n, returned: 0n, profit: 0n };
                    cfg.currentRound = { ...loan };
                    // The queue lives with this round's payout collection; it needs one to be stored.
                    cfg.withdrawalMinter = Address.parseRaw('0:' + 'cd'.repeat(32)); // any address but the KTON minter: a bill's mint has the same op as a refund
                    cfg.requestedForWithdrawal = toNano('1500');
                }),
                balance: BigInt(f.balance),
            },
        ];
    };

    const burn = (amount: bigint, instant: boolean) => beginCell()
        .storeUint(Op.pool.withdraw, 32).storeUint(7, 64).storeCoins(amount)
        .storeAddress(USER).storeAddress(USER)
        .storeBit(!instant) // wait_till_round_end
        .storeBit(instant)  // fill_or_kill (the skill always sets it with "instant")
        .endCell();

    it('agrees with the contract on every state, mode and side of the limit', async () => {
        const rows: string[] = [];
        let disagreements = 0;
        for (const state of await states()) {
            for (const mode of ['wait', 'instant'] as const) {
                await bc.setShardAccount(addr, createShardAccount({ address: addr, code: Cell.fromBase64(f.code), data: state.data, balance: state.balance }));
                const snap = bc.snapshot();
                const stack = (await bc.runGetMethod(addr, 'get_pool_full_data')).stack.map(toV3);
                const pool = parsePoolData(stack);
                // The pool's balance as the message finds it (the sandbox counts the message's value in too).
                const limit: bigint = checkWithdrawal(pool, state.balance, KTON, mode).limit;
                for (const amount of [limit > KTON ? limit - KTON : KTON, limit + KTON]) {
                    await bc.loadFrom(snap);
                    const predicted = checkWithdrawal(pool, state.balance, amount, mode);
                    const r = await bc.sendMessage(internal({ from: minter, to: addr, value: toNano('1'), body: burn(amount, mode === 'instant') }));
                    const tx = poolTx(r.transactions, addr);
                    const refunded = tx.outMessages.values().some(m => m.info.dest instanceof Address && (m.info.dest as Address).equals(minter)
                        && m.body.beginParse().loadUint(32) === Op.payout.mint);
                    const accepted = !refunded;
                    // Predicting "take" for a burn the pool returns is the failure; the
                    // other way round (the instant limit keeps 1 TON in hand) is the safe side.
                    const unsafe = predicted.accepted && !accepted;
                    const cautious = !predicted.accepted && accepted;
                    if (unsafe) disagreements++;
                    rows.push(`${state.name} | ${mode} | ${Number(amount / KTON)} KTON | predicted ${predicted.accepted ? 'take' : 'return'} (limit ${Number(limit / KTON)}) | pool ${accepted ? 'took' : 'returned'}${unsafe ? '  <-- UNSAFE' : cautious ? '  (cautious)' : ''}`);
                }
            }
        }
        console.log(rows.join('\n'));
        expect(disagreements).toBe(0);
    });

    it('sees a rotation that is due but not run yet, and predicts nothing then', async () => {
        // The previous round repaid and empty, the loan in the current one, and
        // a saved validator set hash that is not the sandbox's: the pool is due
        // to rotate on its next message (a rotation waits while the previous
        // round still has loans out).
        const raw = await bc.openContract(Pool.createFromAddress(addr)).getFullDataRaw();
        const loan = raw.previousRound.borrowed > 0n ? raw.previousRound : raw.currentRound;
        const cfg: any = dataToFullConfig(raw);
        cfg.treasury = GOV;
        cfg.prevRound = { borrowers: null, roundId: loan.roundId - 1, activeBorrowers: 0n, borrowed: 0n, expected: 0n, returned: 0n, profit: 0n };
        cfg.currentRound = { ...loan };
        cfg.savedValidatorSetHash = 1n;
        await bc.setShardAccount(addr, createShardAccount({ address: addr, code: Cell.fromBase64(f.code), data: poolFullConfigToCell(cfg), balance: BigInt(f.balance) }));
        const worked = parsePoolData((await bc.runGetMethod(addr, 'get_pool_full_data')).stack.map(toV3));
        const stored = parsePoolData((await bc.runGetMethod(addr, 'get_pool_full_data_raw')).stack.map(toV3));
        console.log('worked-out prv round', worked.previousRound.roundId, 'stored', stored.previousRound.roundId);
        expect(worked.previousRound.roundId).not.toBe(stored.previousRound.roundId);
        const check = checkWithdrawal(worked, BigInt(f.balance), KTON, 'wait', {
            rotationPending: worked.previousRound.roundId !== stored.previousRound.roundId,
        });
        expect(check).toMatchObject({ accepted: false, reason: 'rotation-pending' });
    });
});
