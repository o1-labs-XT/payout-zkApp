/**
 * Mesa Testnet “stress” runner for an already-deployed `PayoutZkapp`.
 *
 * What this script does
 * - Connects to Mesa Testnet using `Mina.Network` (node + archive endpoints).
 * - Repeats a bounded number of rounds (`ROUNDS`) to exercise the zkApp under realistic usage:
 *   1) Fetches and prints zkApp metadata (counter / total / actionState) and pending actions count.
 *   2) Sends a “request” transaction that enqueues `REQUESTS_PER_ROUND` payout requests (actions).
 *   3) Sends a “payout” transaction that processes pending requests up to `PAYOUT_MAX_AMOUNT`.
 *   4) Fetches and prints zkApp metadata and pending actions again.
 * - Measures transaction inclusion responsiveness via `safeWait()` timing:
 *   - Per tx: request safeWait and payout safeWait
 *   - Per round: total safeWait (request + payout)
 *   - End summary: min / max / avg safeWait for requests, payouts, and all txs, plus total safeWait.
 *
 * Inputs / configuration
 * - Reads keys + zkApp address from hooking into `.env`:
 *   - `PAYOUT_SENDER_KEY`     : base58 private key for the payer (sends payout tx)
 *   - `PAYOUT_REQUEST_KEY`    : base58 private key for the requester (sends request tx)
 *   - `PAYOUT_ZKAPP_ADDRESS`  : base58 public key of the deployed payout zkApp to interact with
 *
 * Notes:
 * - Do not increase `REQUESTS_PER_ROUND` blindly: pushing too many requests can make the next payout fail
 *   (account update/action limits + reducer safety constraints). See the repo’s “Security Considerations” in README.md.
 */

import { Mina, PrivateKey, PublicKey, UInt64, fetchAccount } from 'o1js';
import dotenv from 'dotenv';
import { PayoutZkapp } from './Payout.js';

dotenv.config();

const MINA_NANO = 1e9;

// Mesa endpoints
const MINA_NODE_ENDPOINT =
  'https://plain-1-graphql.mina-mesa-network.gcp.o1test.net/graphql';
const MINA_ARCHIVE_ENDPOINT = 'http://mesa-archive-node-api.gcp.o1test.net';

// Run parameters
const PROOFS_ENABLED = true;
const ROUNDS = 7;
const TX_FEE = 2e8;
const REQUESTS_PER_ROUND = 7;
const REQUEST_AMOUNT = UInt64.from(0.5 * MINA_NANO);
const PAYOUT_MAX_AMOUNT = UInt64.from(2 * MINA_NANO);
const ROUND_SLEEP_MS = 10_000;

// Required env
const payerPrivKeyBase58 = process.env.PAYOUT_SENDER_KEY?.trim();
const requesterPrivKeyBase58 = process.env.PAYOUT_REQUEST_KEY?.trim();
const zkappAddressBase58 = process.env.PAYOUT_ZKAPP_ADDRESS?.trim();

if (!payerPrivKeyBase58 || !requesterPrivKeyBase58 || !zkappAddressBase58) {
  throw new Error(
    'Missing env vars. Required: PAYOUT_SENDER_KEY, PAYOUT_REQUEST_KEY, PAYOUT_ZKAPP_ADDRESS'
  );
}

// Keys
const payerPrivateKey = PrivateKey.fromBase58(payerPrivKeyBase58);
const requesterPrivateKey = PrivateKey.fromBase58(requesterPrivKeyBase58);

const payerPublicKey = payerPrivateKey.toPublicKey();
const requesterPublicKey = requesterPrivateKey.toPublicKey();
const zkappAddress = PublicKey.fromBase58(zkappAddressBase58);

// Network
const Mesa = Mina.Network({
  mina: MINA_NODE_ENDPOINT,
  archive: MINA_ARCHIVE_ENDPOINT,
});
Mina.setActiveInstance(Mesa);

// zkApp handle
const zkapp = new PayoutZkapp(zkappAddress);

// ✅ safeWait duration stats (ms)
type MsAgg = { sumMs: number; n: number; minMs: number; maxMs: number };
const msAll: MsAgg = {
  sumMs: 0,
  n: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
};
const msRequest: MsAgg = {
  sumMs: 0,
  n: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
};
const msPayout: MsAgg = {
  sumMs: 0,
  n: 0,
  minMs: Number.POSITIVE_INFINITY,
  maxMs: 0,
};

// Per-round record for final summary
type RoundRow = {
  round: number;
  pendingBefore: number | null;
  pendingAfter: number | null;

  counterBefore: string;
  counterAfter: string;

  totalBeforeMina: string;
  totalAfterMina: string;

  requestHash: string | null;
  payoutHash: string | null;

  requestSafeWaitMs: number | null;
  payoutSafeWaitMs: number | null;
};

const rounds: RoundRow[] = [];

// ------------------------
// Main
// ------------------------
await main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  console.log('Mesa node   :', MINA_NODE_ENDPOINT);
  console.log('Mesa archive:', MINA_ARCHIVE_ENDPOINT);
  console.log('zkApp       :', zkappAddress.toBase58());
  console.log('payer       :', payerPublicKey.toBase58());
  console.log('requester   :', requesterPublicKey.toBase58());
  console.log('rounds      :', ROUNDS);

  if (PROOFS_ENABLED) {
    console.time('compile');
    await PayoutZkapp.compile();
    console.timeEnd('compile');
  }

  await fetchAccounts([zkappAddress, payerPublicKey, requesterPublicKey]);

  for (let round = 1; round <= ROUNDS; round++) {
    console.log(
      `\n==================== Round ${round}/${ROUNDS} ====================`
    );

    const before = await readZkappStatus();
    printStatus('before', before);

    const requestRes = await sendRequestTx(); // { hash, safeWaitMs } | null
    const payoutRes = await sendPayoutTx(); // { hash, safeWaitMs } | null

    const after = await readZkappStatus();
    printStatus('after', after);

    const requestSafeWaitMs = requestRes?.safeWaitMs ?? null;
    const payoutSafeWaitMs = payoutRes?.safeWaitMs ?? null;

    rounds.push({
      round,
      pendingBefore: before.pendingCount,
      pendingAfter: after.pendingCount,
      counterBefore: before.counter.toString(),
      counterAfter: after.counter.toString(),
      totalBeforeMina: before.totalMina,
      totalAfterMina: after.totalMina,
      requestHash: requestRes?.hash ?? null,
      payoutHash: payoutRes?.hash ?? null,
      requestSafeWaitMs,
      payoutSafeWaitMs,
    });

    console.log(`\nRound ${round} summary:`);
    console.log(
      `  request: safeWait=${
        requestSafeWaitMs == null ? 'x' : fmtMs(requestSafeWaitMs)
      } ` + `hash=${requestRes?.hash ?? '(failed)'}`
    );
    console.log(
      `  payout : safeWait=${
        payoutSafeWaitMs == null ? 'x' : fmtMs(payoutSafeWaitMs)
      } ` + `hash=${payoutRes?.hash ?? '(failed)'}`
    );

    const roundTotalMs = (requestSafeWaitMs ?? 0) + (payoutSafeWaitMs ?? 0);
    console.log(
      `  round total safeWait (request+payout): ${fmtMs(roundTotalMs)}`
    );

    if (round < ROUNDS) await sleep(ROUND_SLEEP_MS);
  }

  printFinalSummary();
}

// ------------------------
// Transactions
// ------------------------

type TxResult = { hash: string | null; safeWaitMs: number };

async function sendRequestTx(): Promise<TxResult | null> {
  console.log('\n→ Sending request tx...');

  try {
    const tx = await Mina.transaction(
      { sender: requesterPublicKey, fee: TX_FEE },
      async () => {
        for (let i = 0; i < REQUESTS_PER_ROUND; i++) {
          await zkapp.requestPayout(REQUEST_AMOUNT);
        }
      }
    );

    return await proveSignSendAndMeasure(tx, [requesterPrivateKey], 'request');
  } catch (err) {
    console.error('  request tx failed:', stringifyErr(err));
    return null;
  }
}

async function sendPayoutTx(): Promise<TxResult | null> {
  console.log('\n→ Sending payout tx...');

  try {
    const tx = await Mina.transaction(
      { sender: payerPublicKey, fee: TX_FEE },
      async () => {
        await zkapp.payout(PAYOUT_MAX_AMOUNT);
      }
    );

    return await proveSignSendAndMeasure(tx, [payerPrivateKey], 'payout');
  } catch (err) {
    console.error('  payout tx failed:', stringifyErr(err));
    return null;
  }
}

async function proveSignSendAndMeasure(
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  keys: PrivateKey[],
  label: 'request' | 'payout'
): Promise<TxResult> {
  await tx.prove();
  const pending = await tx.sign(keys).send();
  const hash = pending.hash ?? null;

  console.log(`  ${label} hash:`, hash);

  const t0 = Date.now();
  console.time(`  ${label} safeWait`);
  const status = await pending.safeWait();
  console.timeEnd(`  ${label} safeWait`);
  const safeWaitMs = Date.now() - t0;

  addMs(msAll, safeWaitMs);
  if (label === 'request') addMs(msRequest, safeWaitMs);
  if (label === 'payout') addMs(msPayout, safeWaitMs);

  if (status.status === 'rejected') {
    throw new Error(
      `Transaction rejected (${label}): ${JSON.stringify(status.errors)}`
    );
  }

  await fetchAccounts([zkappAddress, payerPublicKey, requesterPublicKey]);

  return { hash, safeWaitMs };
}

function addMs(agg: MsAgg, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  agg.sumMs += ms;
  agg.n += 1;
  if (ms < agg.minMs) agg.minMs = ms;
  if (ms > agg.maxMs) agg.maxMs = ms;
}

// ------------------------
// Status / Metadata
// ------------------------

type ZkappStatus = {
  counter: ReturnType<PayoutZkapp['counter']['get']>;
  total: ReturnType<PayoutZkapp['total']['get']>;
  actionState: ReturnType<PayoutZkapp['actionState']['get']>;
  totalMina: string;
  pendingCount: number | null;
};

async function readZkappStatus(): Promise<ZkappStatus> {
  await fetchAccounts([zkappAddress]);

  const counter = zkapp.counter.get();
  const total = zkapp.total.get();
  const actionState = zkapp.actionState.get();

  let pendingCount: number | null = null;
  try {
    const pending = await zkapp.reducer.fetchActions({
      fromActionState: actionState,
    });
    pendingCount = pending.length;
  } catch (err) {
    console.warn(
      `⚠️ Could not fetch pending actions. ` +
        `Check archive endpoint / availability.\n` +
        `${stringifyErr(err)}`
    );
  }

  const totalMina = (total.toBigInt() / BigInt(MINA_NANO)).toString();

  return { counter, total, actionState, totalMina, pendingCount };
}

function printStatus(tag: 'before' | 'after', s: ZkappStatus) {
  console.log(`\n[zkApp status - ${tag}]`);
  console.log('  counter        :', s.counter.toString());
  console.log('  total (MINA)   :', s.totalMina);
  console.log('  actionState    :', s.actionState.toString());
  console.log(
    '  pendingActions :',
    s.pendingCount === null ? '(unknown)' : s.pendingCount
  );
}

// ------------------------
// Final summary
// ------------------------

function printFinalSummary() {
  console.log('\n==================== Final summary ====================');

  for (const r of rounds) {
    const reqWait =
      r.requestSafeWaitMs == null ? 'x' : fmtMs(r.requestSafeWaitMs);
    const payWait =
      r.payoutSafeWaitMs == null ? 'x' : fmtMs(r.payoutSafeWaitMs);
    const roundWaitMs = (r.requestSafeWaitMs ?? 0) + (r.payoutSafeWaitMs ?? 0);

    console.log(
      `Round ${r.round}: ` +
        `reqWait=${reqWait}, payoutWait=${payWait}, roundWait=${fmtMs(
          roundWaitMs
        )}, ` +
        `pending: ${fmtN(r.pendingBefore)} → ${fmtN(r.pendingAfter)}, ` +
        `counter: ${r.counterBefore} → ${r.counterAfter}, ` +
        `total(MINA): ${r.totalBeforeMina} → ${r.totalAfterMina}`
    );
  }

  console.log('\nSafeWait timing (m:ss.mmm):');
  console.log(`  request txs: ${fmtMsStats(msRequest)}`);
  console.log(`  payout  txs: ${fmtMsStats(msPayout)}`);
  console.log(`  all     txs: ${fmtMsStats(msAll)}`);
  console.log(`\nTotal safeWait (all txs): ${fmtMs(msAll.sumMs)}`);
}

function fmtMsStats(agg: MsAgg) {
  if (agg.n === 0) return '(no samples)';
  const avg = agg.sumMs / agg.n;
  return (
    `min=${fmtMs(agg.minMs)}, ` +
    `max=${fmtMs(agg.maxMs)}, ` +
    `avg=${fmtMs(avg)} ` +
    `(samples=${agg.n})`
  );
}

// Format milliseconds as m:ss.mmm (e.g. 1:22.944)
function fmtMs(ms: number) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(
    millis
  ).padStart(3, '0')}`;
}

function fmtN(n: number | null) {
  return n === null ? '?' : String(n);
}

// ------------------------
// Utility
// ------------------------

async function fetchAccounts(accounts: PublicKey[]) {
  for (const account of accounts) {
    await fetchAccount({ publicKey: account }, MINA_NODE_ENDPOINT);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stringifyErr(err: any) {
  if (err?.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
