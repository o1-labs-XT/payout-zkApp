// Comment `this.actionState.set(this.reducer.getActions().hash);` in `Payout.ts` to deploy and progress through the tests
//? It's weird that there's inconsistency regarding the first actionState between local blockchain and Mesa Testnet

//! If fee is not set to 2e8, we get insufficient_fee error when interacting on Mesa Testnet
//! It seems the default fee is not enough -> we might need to adjust the default rather than setting higher fee every time

import {
  UInt64,
  Mina,
  PrivateKey,
  PublicKey,
  fetchAccount,
  AccountUpdate,
} from 'o1js';
import { PayoutZkapp } from './Payout.js';

import dotenv from 'dotenv';
import { logTxInfo } from './helpers.js';

dotenv.config();

const MINA_NANO = 1e9;
const MINA_NODE_ENDPOINT =
  'https://plain-1-graphql.mina-mesa-network.gcp.o1test.net/graphql';
const MINA_ARCHIVE_ENDPOINT =
  'https://plain-1-graphql.mesa-archive-node-api.gcp.o1test.net/graphql'; // 'placeholder'

const proofsEnabled = true;
const logsEnabled = true;
const fee = 2e8;

console.time('compile...');
if (proofsEnabled) await PayoutZkapp.compile();
console.timeEnd('compile...');

// Set up the Mina Mesa Testnet
const Mesa = Mina.Network({
  mina: MINA_NODE_ENDPOINT,
  archive: MINA_ARCHIVE_ENDPOINT,
});
Mina.setActiveInstance(Mesa);

const payerPrivKeyBase58 = process.env.PAYOUT_SENDER_KEY;
const requesterPrivKeyBase58 = process.env.PAYOUT_REQUEST_KEY;

if (!payerPrivKeyBase58 || !requesterPrivKeyBase58) {
  throw new Error('Missing private keys in .env');
}

const payerPrivateKey = PrivateKey.fromBase58(payerPrivKeyBase58);
const requesterPrivateKey = PrivateKey.fromBase58(requesterPrivKeyBase58);

// Derive public keys
const payerPublicKey = payerPrivateKey.toPublicKey();
const requesterPublicKey = requesterPrivateKey.toPublicKey();

console.log('Payer PK:', payerPublicKey.toBase58());
console.log('Requester PK:', requesterPublicKey.toBase58());

// Set up the zkapp account
let zkappPrivateKey = PrivateKey.random();
let zkappAddress = zkappPrivateKey.toPublicKey();
let zkapp = new PayoutZkapp(zkappAddress);

console.log('Deploying zkApp...');
await deployZkapp(zkapp, payerPrivateKey, zkappPrivateKey);

const requestTx = await Mina.transaction(
  { sender: requesterPublicKey, fee },
  async () => {
    //! Test only; otherwise, for security reason we would have added a nullifer
    //! scheme for accounts that already had a filled payout request before
    for (let i = 0; i < 7; i++)
      await zkapp.requestPayout(UInt64.from(0.5 * MINA_NANO));
  }
);

console.log('Request Transaction Info:', logTxInfo(requestTx), 'request');
await waitTransactionAndFetchAccount(requestTx, [requesterPrivateKey]);

console.log(
  'Payout Requester balance before: ',
  Mina.getAccount(requesterPublicKey).balance.toBigInt() / 1_000_000_000n
);

const payoutTx = await Mina.transaction(
  { sender: payerPublicKey, fee },
  async () => {
    await zkapp.payout(UInt64.from(2e9));
  }
);

console.log('Payout Transaction Info:', logTxInfo(payoutTx));
await waitTransactionAndFetchAccount(payoutTx, [payerPrivateKey]);

console.log(
  'Payout Requester balance after: ',
  Mina.getAccount(requesterPublicKey).balance.toBigInt() / 1_000_000_000n
);

/// HELPER FUNCTIONS

function log(...args: any[]) {
  if (logsEnabled) {
    console.log(...args);
  }
}

/**
 * Wait for a transaction to be included in a block and fetch the account.
 * @param tx The transaction to wait for
 * @param keys The keys to sign the transaction
 * @param accountsToFetch The accounts to fetch after the transaction is included
 */
async function waitTransactionAndFetchAccount(
  tx: Awaited<ReturnType<typeof Mina.transaction>>,
  keys: PrivateKey[],
  accountsToFetch?: PublicKey[]
) {
  try {
    log('\nProving and sending transaction');
    await tx.prove();
    const pendingTransaction = await tx.sign(keys).send();

    log('Waiting for transaction to be included in a block');

    console.time('Mesa: Pending transaction');
    const status = await pendingTransaction.safeWait();
    console.timeEnd('Mesa: Pending transaction');

    if (status.status === 'rejected') {
      log('Transaction rejected', JSON.stringify(status.errors));
      throw new Error(
        'Transaction was rejected: ' + JSON.stringify(status.errors)
      );
    }

    if (accountsToFetch) {
      await fetchAccounts(accountsToFetch);
    }
  } catch (error) {
    log('error', error);
    throw error;
  }
}

/**
 * Fetch given accounts from the Mina to local cache.
 * @param accounts List of account public keys to fetch
 */
async function fetchAccounts(accounts: PublicKey[]) {
  for (let account of accounts) {
    await fetchAccount({ publicKey: account }, MINA_NODE_ENDPOINT);
  }
}

async function deployZkapp(
  zkapp: PayoutZkapp,
  deployerKey: PrivateKey,
  zkappPrivateKey: PrivateKey
) {
  const deployerAccount = deployerKey.toPublicKey();
  const tx = await Mina.transaction(
    { sender: deployerAccount, fee },
    async () => {
      AccountUpdate.fundNewAccount(deployerAccount);
      await zkapp.deploy();
    }
  );

  await waitTransactionAndFetchAccount(
    tx,
    [deployerKey, zkappPrivateKey],
    [zkappAddress]
  );
}
