# Mina zkApp: Payout Zkapp

## Context and motivation

This example demonstrates the internal approach used at o1Labs to work with and test the increased limits introduced by the Mesa hardfork. It also serves as a more advanced example of how to use events; as well as actions & reducer to handle concurrent state updates.

The example shows how to exercise the increased limits for account updates, actions, and events in order to add more logic to your zkApp on top of being a practical guide for using the pre-Mesa `o1js` package to test, deploy, and interact with zkApps on Mesa Testnet.

## Overview

The example is a **payout zkApp** built around **actions & reducer**:

- Users can **request a payout** by dispatching an action.
- A designated **payer** can later choose to **fulfill all pending requests up to a specified maximum amount**.

During payout:

- the payer specifies the maximum amount they are willing to pay,
- all pending requests with requested amounts **less than or equal to** this maximum are fulfilled, and
- requests exceeding the maximum are ignored and **do not** contribute to any state updates.

Example:

- Alice requests `1` MINA,
- Bob requests `2` MINA,
- Josh requests `3` MINA.  
  If the payer chooses to pay up to `2` MINA, Alice and Bob are paid, while Josh is ignored.

At first glance, this flow may appear similar to a sequence of plain MINA transfers. The key difference is that the zkApp can **provably update application-specific metadata under concurrent usage**, such as:

- the total number of fulfilled requests,
- the total amount paid out by the payer, and
- additional metadata (for example, which payouts were ignored and how many payers participated).

Without using actions and a reducer, these state updates would often fail due to state precondition checks under concurrent transactions. Using actions makes it possible to:

- batch multiple payouts into a single transaction,
- fit more account updates into one transaction,
- reduce transaction fees, and
- keep application-specific metadata on-chain, instead of relying on off-chain indexing or explorer-based analysis.

## More technical details

This section provides additional context on how events and actions & reducer are used in this example.

### Payout request (actions)

- Each payout request dispatches an **action** containing `4` fields:

  - the requester’s public key (`2` fields),
  - the requested amount (`1` field),
  - a `Bool` flag `isPending` (`1` field) used to distinguish real requests from dummy actions.
    - The `isPending` flag is mainly used to avoid unintentionally increasing event volume, although dummy actions could also be used to further stress-test events.

- The previous limit for action fields in a single transaction was `100`, and this limit is increased to `1024` following the Mesa hardfork. In this example, that means it is possible to exceed `100` action fields within a single transaction.

- A natural question here is how to stress-test the increased action field limits when each action only contains `4` fields and is dispatched by calling a zkApp method once.

- The answer is to fit multiple `requestPayout` calls into a single transaction when testing the zkApp. The increased limits apply at the transaction level, not only at the individual method-call level.

- However, there is a practical limit to this approach: the more actions that are dispatched, the more account updates will later be generated during payout, which can effectively DoS the payout method (see the [security considerations section](#security-considerations) for more details).

- For completeness, and purely for stress-testing purposes, additional dummy fields can be added to the action to more aggressively test the increased limits. This approach was tested internally to verify both the `100` and `1024` field limits, but it is not included in this codebase to keep the example focused and clear.
  - That said, it is possible to combine both approaches: adding dummy fields to actions and dispatching multiple requests within a single transaction.

### Payout processing (reducer and events)

- During payout, the payer specifies the maximum amount they are willing to pay.
- All pending requests with requested amounts **less than or equal to** the specified maximum are fulfilled.
- Requests exceeding the maximum are ignored and **do not** contribute to payments or state updates.

  - This mechanism can also act as a safeguard for the payer, allowing them to limit what gets paid when there are too many requests. An additional parameter could further limit the maximum number of payouts to fulfill. For example, a payer willing to fulfill `1` MINA requests with a limit of `3` would only pay the first three requests that are less than or equal to `1` MINA.

- When a payout is executed, the transaction generates all required account updates to transfer funds from the payer to the requesters, and emits an event for each individual payment. Each event also includes the reduced metadata updated by the reducer.

#### Account updates

- Each fulfilled request generates **2 account updates** (payer → recipient).
- The zkApp method call itself adds **1** additional account update.
- For `n` fulfilled requests, the payout method produces `2n + 1` account updates.

#### Events

- For every fulfilled request, an event is emitted containing:
  - the payer public key (`2` fields),
  - the recipient public key (`2` fields),
  - the requested amount (`1` field),
  - the updated total amount paid (`1` field), and
  - the updated count of fulfilled requests (`1` field).
- Each event consists of `7` fields.
- For `n` fulfilled requests, this results in `n` events holding `7n` fields.

Example:

- `10` fulfilled requests → `10` events → `70` total event fields.

---

For more details, refer to the _Intended stress-testing approach_ section in the issue comment here:  
https://github.com/o1-labs/o1js/issues/2695#issuecomment-3680019613

### Notes

- All limits discussed here were tested internally. The current values for action and event field sizes, as well as the number of account updates per transaction, were intentionally kept to the minimum required by the use case in order to preserve the clarity and integrity of the example.

- To learn more about actions and reducers, refer to:
  - https://docs.o1labs.org/o1js/zkapps/actions-and-reducers#actions
  - https://docs.minaprotocol.com/zkapps/writing-a-zkapp/feature-overview/actions-and-reducer

## Security considerations

- This example is a proof of concept and does not address all security considerations required for a production-ready zkApp.

- The reducer API in `o1js` is currently not safe for unrestricted production use. The `reduce()` method breaks if more than a hard-coded number of actions (default: `32`) are pending. Work is actively in progress to mitigate this limitation (see the [security best practices documentation](https://docs.minaprotocol.com/zkapps/writing-a-zkapp/introduction-to-zkapps/secure-zkapps#best-practices-for-zkapp-security) for more details).

  - In the context of this payout zkApp, the `32`-action limit is not the primary bottleneck. `32` actions correspond to `65` account updates during payout, which already exceeds even the increased transaction limits.
  - The more significant concern in this example is the open permission model: any user can request payouts without restriction.
  - This can be mitigated by introducing a limiter on the number of requests that can be safely handled by the reducer, or by bounding the number of account updates generated during payout to prevent the `payout` method from being blocked.

- Since this example explicitly tests the limits of account updates per transaction, it is important to highlight the constraint imposed by the formula `2n + 1` account updates for `n` fulfilled requests.

  - With a maximum of `31` account updates per transaction, any value of `n` greater than `15` will result in a transaction failure.
  - Note that `n` here refers to the number of _fulfilled_ requests, not the total number of pending actions.
  - One possible mitigation is to require the payer to be aware of this limit and choose a payout amount that results in no more than `15` fulfillable requests. However, this approach is not ideal, as it places the burden of analysis on the payer.
  - A more robust approach is to introduce an explicit limiter in the reducer logic based on the `2n + 1` formula. In this case, the payout would only fulfill as many pending requests as can safely fit within the account update limit.
  - Another option is to add an explicit parameter to the `payout` method that allows the payer to specify the maximum number of payouts to fulfill that is less than or eual to `15`. For example, a payer could choose to pay up to `2` MINA, but only for a maximum of `5` fulfillable requests.
  - Similarly, the `requestPayout` method itself could be gated to prevent new requests once a predefined limit has been reached.

- Another security consideration is that this payout example allows any user to request payments an arbitrary number of times.

  - This design choice is intentional in order to more easily stress-test the increased limits for account updates, actions, and events.
  - In a production setting, this could be mitigated by integrating a Merkle map and a nullifier scheme to track which users have requested payouts. This approach would also enable tracking additional metadata about users and payout history.

- For more information on general zkApp security considerations, see:  
  https://docs.minaprotocol.com/zkapps/writing-a-zkapp/introduction-to-zkapps/secure-zkapps#best-practices-for-zkapp-security

## How to Use the Pre-Mesa o1js Package

To use the pre-Mesa `o1js` package, simply override the `o1js` peer dependency by installing it from `npm i https://pkg.pr.new/o1-labs/o1js@2701` as seen in the project's [`package.json`](./package.json).

## How to Deploy and Interact with the Mesa Testnet

- To deploy on the Mesa Testnet, first create a new `.env` file and add two private keys. See [./.env.example](./.env.example) for a reference.

- The two keys defined there must be funded. You can generate fresh keys and request test funds from the
  [Mina faucet](https://faucet.minaprotocol.com/).

  ```ts
  import { PrivateKey } from 'o1js';

  let requesterPrivKey = PrivateKey.random();
  console.log('requester private key base58: ', requesterPrivKey.toBase58());

  let payerPubKey = payerPrivKey.toPublicKey();
  console.log('payer public key base58: ', payerPubKey.toBase58());
  ```

- Once the keys are set, build the project and deploy the zkApp while simulating a game on the Mesa Testnet by running:

  ```sh
  npm run build
  node build/src/run-mt.js
  ```

- To deploy and interact with Mesa Testnet, make sure to configure the following endpoints:

  - **Mina Node Endpoint:**  
    `https://plain-1-graphql.mina-mesa-network.gcp.o1test.net/graphql`
  - **Mina Archive Endpoint (required when using actions):**  
    `http://mesa-archive-node-api.gcp.o1test.net`

  Refer to `src/run-mt.ts` (lines 23–25) for an example on how to configure the endpoints in order to deploy and interact with Mesa Testnet.

- For additional context and background on Mesa and the related changes in `o1js`, see the Mesa pre-release blog post:  
  https://www.o1labs.org/blog/o1js-mesa-prerelease

## Commands to Use

### Integration tests on Mesa local blockchain

- `npm run test`

### Local execution with more verbose logs

- `npm run build`
- `node build/src/run-local.js`

### Deploying and interacting with the zkApp on Mesa Testnet

- `npm run build`
- `node build/src/run-mt.js`

## License

[Apache-2.0](LICENSE)
