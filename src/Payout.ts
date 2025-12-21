import {
  SmartContract,
  Struct,
  state,
  State,
  method,
  Field,
  Reducer,
  PublicKey,
  UInt64,
  AccountUpdate,
  Provable,
  Bool,
} from 'o1js';

class ReceiptDetails extends Struct({
  sender: PublicKey,
  recipient: PublicKey,
  amount: UInt64,
  count: Field,
  totalAmount: Field,
}) {}

class RequestDetails extends Struct({
  recipient: PublicKey,
  amount: UInt64,
  isPending: Bool, // this is to ignore dummy actions // bool false by default
}) {}

class ReducedType extends Struct({
  counter: Field,
  totalAmount: Field,
}) {}

export class PayoutZkapp extends SmartContract {
  @state(Field) counter = State<Field>();
  @state(Field) total = State<Field>();
  @state(Field) actionState = State<Field>();

  reducer = Reducer({ actionType: RequestDetails });

  events = {
    receipt: ReceiptDetails,
  };

  init() {
    super.init();
    this.actionState.set(this.reducer.getActions().hash);
  }

  @method async requestPayout(amount: UInt64) {
    const sender = this.sender.getAndRequireSignature();
    this.reducer.dispatch(
      new RequestDetails({ recipient: sender, amount, isPending: Bool(true) })
    );
  }

  @method async payout(amount: UInt64) {
    const actionState = this.actionState.getAndRequireEquals();
    const pendingActions = this.reducer.getActions({
      fromActionState: actionState,
    });

    const sender = this.sender.getUnconstrained();
    const count = this.counter.getAndRequireEquals();
    const total = this.total.getAndRequireEquals();

    let { counter, totalAmount } = this.reducer.reduce(
      pendingActions,
      ReducedType,
      (state: ReducedType, action: RequestDetails) => {
        const inRange = action.amount.lessThanOrEqual(amount);
        const condition = action.isPending.and(inRange);

        const payer = AccountUpdate.createIf(condition, sender);
        payer.requireSignature();
        payer.send({ to: action.recipient, amount: action.amount });

        let updatedCount = state.counter.add(condition.toField());
        const updatedTotal = Provable.if(
          condition,
          state.totalAmount.add(action.amount.value),
          total
        );

        const eventData = new ReceiptDetails({
          sender,
          recipient: action.recipient,
          amount: action.amount,
          count: updatedCount,
          totalAmount: updatedTotal,
        });

        // for (let i = 0; i < 21; i++) // uncomment if you want to emit more events to exceed the 1024 limit
        this.emitEventIf(action.isPending, 'receipt', eventData);

        return new ReducedType({
          counter: updatedCount,
          totalAmount: updatedTotal,
        });
      },
      new ReducedType({ counter: count, totalAmount: total })
    );

    this.actionState.set(pendingActions.hash);
    this.counter.set(counter);
    this.total.set(totalAmount);
  }
}
