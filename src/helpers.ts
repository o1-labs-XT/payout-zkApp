import { Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { PayoutZkapp } from './Payout.js';

export { logTxInfo, requestPayout, sendPayout, getAccountBalance };

/**
 * Log transaction "size" at a glance:
 * - number of account updates (AUs)
 * - number of events/actions per AU
 * - total number of Field elements stored inside events/actions
 */
function logTxInfo(
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  label = 'tx'
) {
  const aus = tx.transaction.accountUpdates;

  let totalEvents = 0;
  let totalActions = 0;
  let totalEventFields = 0;
  let totalActionFields = 0;

  console.log(`\n[${label}] accountUpdates: ${aus.length}`);

  for (let i = 0; i < aus.length; i++) {
    const au = aus[i];

    const events = au.body.events.data;
    const actions = au.body.actions.data;

    const nEvents = events.length;
    const nActions = actions.length;

    // Each event/action is an array of Fields
    const eventFields = events.reduce((sum, ev) => sum + ev.length, 0);
    const actionFields = actions.reduce((sum, act) => sum + act.length, 0);

    totalEvents += nEvents;
    totalActions += nActions;
    totalEventFields += eventFields;
    totalActionFields += actionFields;

    const pk = au.body.publicKey.toBase58();

    console.log(
      `  AU[${i}]${pk ? ` (${pk})` : ''}: ` +
        `events=${nEvents} (fields=${eventFields}), ` +
        `actions=${nActions} (fields=${actionFields})`
    );
  }

  console.log(
    `[${label}] totals: ` +
      `accountUpdates=${aus.length}, ` +
      `events=${totalEvents} (fields=${totalEventFields}), ` +
      `actions=${totalActions} (fields=${totalActionFields})\n`
  );

  return {
    accountUpdates: aus.length,
    events: totalEvents,
    eventFields: totalEventFields,
    actions: totalActions,
    actionFields: totalActionFields,
  };
}

async function requestPayout(
  zkapp: PayoutZkapp,
  senderKey: PrivateKey,
  amount: number
) {
  const requestTx = await Mina.transaction(
    { sender: senderKey.toPublicKey() },
    async () => {
      await zkapp.requestPayout(UInt64.from(amount));
    }
  );

  await requestTx.prove();
  console.log('Request counts:', logTxInfo(requestTx), 'request');

  (await requestTx.sign([senderKey]).send()).safeWait();
}

async function sendPayout(
  zkapp: PayoutZkapp,
  senderKey: PrivateKey,
  amount: number
) {
  const payoutTx = await Mina.transaction(
    { sender: senderKey.toPublicKey() },
    async () => {
      await zkapp.payout(UInt64.from(amount));
    }
  );

  console.log('Payout counts:', logTxInfo(payoutTx));
  await payoutTx.prove();
  (await payoutTx.sign([senderKey]).send()).safeWait();
}

function getAccountBalance(account: PublicKey) {
  return Mina.getAccount(account).balance.toBigInt() / 1_000_000_000n;
}
