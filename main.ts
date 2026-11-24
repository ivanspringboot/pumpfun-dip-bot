// make.fun pumpfun-replay/v2 entry: a dip buyer on pump.fun bonding curves, paced so fee churn does
// not eat the edge.
//
// The grader runs this file as `node /bot/main.ts` (Node 22 strips the types, no build, no install).
// It hands `runBot` one onBatch callback; the wire protocol lives in the vendored shim, which is the
// kit's sdk/ts/makefun-bot.ts copied byte for byte into vendor/.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS, type Params } from './strategy.ts';

// The settings below were chosen on the published dev window, measured through the real simulator
// (makefun grade-local), never on an idealised exit study. What each one is for:
//
//   ddMin 0.30 / ddMax 0.45  buy a coin 30-45% under its own recent high. Below 0.15 the same
//                            family of entries loses money on this window: at that depth the dip is
//                            usually a coin dying, and the 2-slot fill latency fills you into it.
//   minHighRealSol 10 SOL    the recent high must have come with real money on the curve, so the
//                            dip is a pullback of something that was actually being bought
//   minRealSol 10 SOL        and the curve must still hold 10 SOL at decision time
//   takeProfit 0.20          take a fifth off the table: a dip that bounces 20% is the trade, and
//                            waiting for more is how a bounce turns back into a loss
//   stopLoss 0.30            a dip that falls another 30% is a different coin, leave it
//   cooldownSlots 8000       the big one. The shipped defaults trade 941 fills over 69 coins and
//                            lose 1.65 SOL doing it; at 125 bps a side plus 105000 lamports an
//                            order the entries themselves are not the problem, the churn is. One
//                            look per coin per 8000 slots halves the fills and turns -1.65 into
//                            about -0.14, and the entry filters above do the rest.
//   tranche 0.4 SOL          fixed size, never add to a loser, and never above the reply cap of 1%
//                            of the curve's real SOL reserve
const PARAMS: Params = {
  ...DEFAULT_PARAMS,
  ddMin: 0.3,
  ddMax: 0.45,
  minRealSol: 10_000_000_000n,
  minHighRealSol: 10_000_000_000n,
  strongRealSol: 25_000_000_000n,
  takeProfit: 0.2,
  stopLoss: 0.3,
  cooldownSlots: 8000,
  maxHoldSlots: 600,
  maxEntriesPerBatch: 2,
  tranche: 400_000_000n,
  maxPosition: 400_000_000n,
};

// Pure function of the batches the harness sends: no clock, no randomness, no I/O, so the two
// graded executions produce byte-identical action logs.
const onBatch = createStrategy(PARAMS);

await runBot({ onBatch });
