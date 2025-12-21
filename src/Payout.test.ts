import { AccountUpdate, Mina, PrivateKey, PublicKey, UInt64 } from 'o1js';
import { PayoutZkapp } from './Payout.js';
import { requestPayout, sendPayout, getAccountBalance } from './helpers.js';

const proofsEnabled = false;
const MINA_NANO = 1e9;

async function deployZkapp(
  zkapp: PayoutZkapp,
  deployerKey: PrivateKey,
  zkappPrivateKey: PrivateKey
) {
  const deployerAccount = deployerKey.toPublicKey();
  const tx = await Mina.transaction(deployerAccount, async () => {
    AccountUpdate.fundNewAccount(deployerAccount);
    await zkapp.deploy();
  });

  await tx.prove();
  await tx.sign([deployerKey, zkappPrivateKey]).send();
}

describe('Payout ZkApp Tests', () => {
  let aliceKey: PrivateKey,
    alicePubKey: PublicKey,
    bobKey: PrivateKey,
    bobPubKey: PublicKey,
    dannyKey: PrivateKey,
    dannyPubKey: PublicKey,
    eveKey: PrivateKey,
    evePubKey: PublicKey,
    zkappAddress: PublicKey,
    zkappPrivateKey: PrivateKey,
    zkapp: PayoutZkapp;

  beforeAll(async () => {
    if (proofsEnabled) await PayoutZkapp.compile();

    // Set up the Mina local blockchain
    const Local = await Mina.LocalBlockchain({ proofsEnabled });
    Mina.setActiveInstance(Local);

    // Get keys and addresses
    aliceKey = Local.testAccounts[0].key;
    alicePubKey = aliceKey.toPublicKey(); // Local.testAccounts is an array of 10 test accounts that have been pre-filled with Mina

    bobKey = Local.testAccounts[1].key;
    bobPubKey = bobKey.toPublicKey();

    dannyKey = Local.testAccounts[2].key;
    dannyPubKey = dannyKey.toPublicKey();

    eveKey = Local.testAccounts[3].key;
    evePubKey = eveKey.toPublicKey();

    // Set up the zkapp account
    zkappPrivateKey = PrivateKey.random();
    zkappAddress = zkappPrivateKey.toPublicKey();
    zkapp = new PayoutZkapp(zkappAddress);
  });

  it('Deploy and initialize Payout zkApp', async () => {
    await deployZkapp(zkapp, aliceKey, zkappPrivateKey);
  });

  it('Bob payout request (1 MINA)', async () => {
    const endActionStateBefore = zkapp.reducer.getActions().hash;
    await requestPayout(zkapp, bobKey, 1 * MINA_NANO);
    const endActionStateAfter = zkapp.reducer.getActions().hash;

    expect(endActionStateBefore).not.toEqual(endActionStateAfter);
  });

  it('Process payout requests up to 1 MINA (Bob paid; counters updated)', async () => {
    const bobBalanceBefore = getAccountBalance(bobPubKey);
    const requestCountBefore = zkapp.counter.get();
    const totalAmountBefore = zkapp.total.get();

    await sendPayout(zkapp, aliceKey, 1 * MINA_NANO);

    const bobBalanceAfter = getAccountBalance(bobPubKey);
    const requestCountAfter = zkapp.counter.get();
    const totalAmountAfter = zkapp.total.get();

    expect(bobBalanceAfter).toEqual(bobBalanceBefore + 1n);
    expect(requestCountAfter).toEqual(requestCountBefore.add(1));
    expect(totalAmountAfter).toEqual(totalAmountBefore.add(1 * MINA_NANO));
  });

  it('Danny payout request (2 MINA)', async () => {
    const endActionStateBefore = zkapp.reducer.getActions().hash;
    await requestPayout(zkapp, dannyKey, 2 * MINA_NANO);
    const endActionStateAfter = zkapp.reducer.getActions().hash;

    expect(endActionStateBefore).not.toEqual(endActionStateAfter);
  });

  it('Process payout requests up to 1.5 MINA (Danny ignored; no state changes)', async () => {
    const dannyBalanceBefore = getAccountBalance(dannyPubKey);
    const requestCountBefore = zkapp.counter.get();
    const totalAmountBefore = zkapp.total.get();

    await sendPayout(zkapp, aliceKey, 1.5 * MINA_NANO);

    const dannyBalanceAfter = getAccountBalance(dannyPubKey);
    const requestCountAfter = zkapp.counter.get();
    const totalAmountAfter = zkapp.total.get();

    expect(dannyBalanceAfter).toEqual(dannyBalanceBefore);
    expect(requestCountAfter).toEqual(requestCountBefore);
    expect(totalAmountAfter).toEqual(totalAmountBefore);
  });

  it('Eve queues 4 payout requests (1 MINA each)', async () => {
    const requestTx = await Mina.transaction(
      { sender: evePubKey },
      async () => {
        //! Test-only: we allow repeat requests (no nullifier / replay protection here)
        await zkapp.requestPayout(UInt64.from(1 * MINA_NANO));
        await zkapp.requestPayout(UInt64.from(1 * MINA_NANO));
        await zkapp.requestPayout(UInt64.from(1 * MINA_NANO));
        await zkapp.requestPayout(UInt64.from(1 * MINA_NANO));
      }
    );

    await requestTx.prove();
    (await requestTx.sign([eveKey]).send()).safeWait();
  });

  it('Danny queues 2 payout requests (1.5 MINA each)', async () => {
    const requestTx = await Mina.transaction(
      { sender: dannyPubKey },
      async () => {
        await zkapp.requestPayout(UInt64.from(1.5 * MINA_NANO));
        await zkapp.requestPayout(UInt64.from(1.5 * MINA_NANO));
      }
    );

    await requestTx.prove();
    (await requestTx.sign([dannyKey]).send()).safeWait();
  });

  it('Bob queues 1 payout request (3 MINA)', async () => {
    const requestTx = await Mina.transaction(
      { sender: bobPubKey },
      async () => {
        await zkapp.requestPayout(UInt64.from(3 * MINA_NANO));
      }
    );

    await requestTx.prove();
    (await requestTx.sign([bobKey]).send()).safeWait();
  });

  it('Process payout requests up to 3 MINA (Eve+Danny+Bob paid; totals reflect 10 MINA)', async () => {
    // Pending actions:
    // - Eve:   4 * 1.0 = 4 MINA
    // - Danny: 2 * 1.5 = 3 MINA
    // - Bob:   1 * 3.0 = 3 MINA
    // Total payout amount = 10 MINA across 7 requests.
    const aliceBalanceBefore = getAccountBalance(alicePubKey);
    const bobBalanceBefore = getAccountBalance(bobPubKey);
    const dannyBalanceBefore = getAccountBalance(dannyPubKey);
    const eveBalanceBefore = getAccountBalance(evePubKey);

    const requestCountBefore = zkapp.counter.get();
    const totalAmountBefore = zkapp.total.get();

    await sendPayout(zkapp, aliceKey, 3 * MINA_NANO);

    const aliceBalanceAfter = getAccountBalance(alicePubKey);
    const bobBalanceAfter = getAccountBalance(bobPubKey);
    const dannyBalanceAfter = getAccountBalance(dannyPubKey);
    const eveBalanceAfter = getAccountBalance(evePubKey);

    const requestCountAfter = zkapp.counter.get();
    const totalAmountAfter = zkapp.total.get();

    expect(aliceBalanceBefore).toEqual(aliceBalanceAfter + 10n);
    expect(bobBalanceAfter).toEqual(bobBalanceBefore + 3n);
    expect(dannyBalanceAfter).toEqual(dannyBalanceBefore + 3n);
    expect(eveBalanceAfter).toEqual(eveBalanceBefore + 4n);

    expect(requestCountAfter).toEqual(requestCountBefore.add(7));
    expect(totalAmountAfter).toEqual(totalAmountBefore.add(10 * MINA_NANO));
  });
});
