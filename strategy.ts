// Mean reversion after a drawdown on pump.fun bonding curves.
//
// Idea: a curve that ran up and then dropped sharply from its recent high, while buyers are still
// stepping in, tends to bounce part of the way back. We buy into that dip in small tranches (each
// within the per-reply size cap of 1% of the curve's real SOL reserve) and sell the whole position
// on a partial rebound, on a stop, or when the trade has gone stale.
//
// Everything here is a pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Lookback (slots) for the recent high the drawdown is measured from. */
  highWindow: number;
  /** Enter when price is at least this far below the recent high (fraction). */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** The curve must hold at least this much real SOL (lamports) at decision time. */
  minRealSol: bigint;
  /** The recent high must have come with at least this much real SOL (lamports). */
  minHighRealSol: bigint;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** Net SOL bought over the last `flowTrades` trades must be at least this (lamports, may be negative). */
  minNetFlow: bigint;
  /** Lamports per tranche (capped by the reply size cap) and most lamports per position. */
  tranche: bigint;
  maxPosition: bigint;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuy: bigint;
  /** Add tranches only while the price stays within this fraction of the first entry price. */
  addBand: number;
  /** Take profit when the position's liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Or when the price recovers this share of the gap between entry and the recent high. */
  recoverShare: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  /**
   * Curves holding at least this much real SOL at entry are "strong" and get full size; weaker ones
   * (down to minRealSol) get a small probe size, and at most maxWeakOpen of them are held at once.
   */
  strongRealSol: bigint;
  weakTranche: bigint;
  weakMaxPosition: bigint;
  maxWeakOpen: number;
  /** Hold limit for weak-tier positions (slots). */
  weakMaxHoldSlots: number;
  /** Drawdown band for weak-tier entries. */
  weakDdMin: number;
  weakDdMax: number;
  /** Exits are sent as this many equal sells in one reply. */
  sellSplits: number;
}

// Chosen from the middle of a broadly profitable region on the dev window (not its single best
// point): a ~2500-slot (~17 min) high, a 30-45% dip on strong curves, 20% take profit, 10% stop.
export const DEFAULT_PARAMS: Params = {
  highWindow: 2500,
  ddMin: 0.3,
  ddMax: 0.45,
  minRealSol: 3_000_000_000n,
  minHighRealSol: 3_000_000_000n,
  flowTrades: 6,
  minBuys: 3,
  lastMustBeBuy: true,
  minNetFlow: 0n,
  tranche: 200_000_000n,
  maxPosition: 1_000_000_000n,
  minBuy: 8_000_000n,
  addBand: 0.05,
  takeProfit: 0.2,
  recoverShare: 0,
  stopLoss: 0.1,
  maxHoldSlots: 600,
  cooldownSlots: 300,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  strongRealSol: 25_000_000_000n,
  weakTranche: 10_000_000n,
  weakMaxPosition: 40_000_000n,
  maxWeakOpen: 3,
  weakMaxHoldSlots: 200,
  weakDdMin: 0.2,
  weakDdMax: 0.6,
  sellSplits: 2,
};

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Book {
  ticks: Tick[];
  /** Price and slot of the first fill decision, and the recent high when we entered. */
  entryPrice: number;
  entrySlot: number;
  entryHigh: number;
  /** Lamports committed to buys on this position (sent, filled or not). */
  committed: bigint;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
  /** Entered as a strong-tier position. */
  strong: boolean;
}

const FEE_BPS = 125n;
const BPS = 10_000n;

/**
 * The per-reply buy cap, with a margin: the harness checks it against the reserves shifted by our
 * own earlier flow on the coin, which can sit a little below the recorded ones the SDK keeps.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/**
 * What selling `tokens` would pay, curve fees deducted, against the reserves the harness marks for
 * the mint (the recorded reserves shifted by our own net flow into the curve).
 */
function liquidationValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { ticks: [], entryPrice: 0, entrySlot: -1, entryHigh: 0, committed: 0n, coolUntil: -1, exiting: false, strong: false };
      books.set(mint, b);
    }
    return b;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      b.ticks.push({ slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
      if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
    }
    // A position whose sell resolved (or failed) may need another exit attempt.
    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          b.committed = 0n;
          b.entrySlot = -1;
          b.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        // The opening buy never filled: forget the entry.
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          b.committed = 0n;
          b.entrySlot = -1;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits and adds on held positions, in mint order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (b.exiting) continue;
      const value = liquidationValue(marks.get(mint), h.token_amount);
      const ticks = b.ticks;
      const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;
      const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
      const target = b.entryPrice + p.recoverShare * (b.entryHigh - b.entryPrice);
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      const tp = gain >= p.takeProfit || (p.recoverShare > 0 && price >= target && gain > 0.03);
      const sl = gain <= -p.stopLoss;
      const stale = slot - entrySlot >= (b.strong ? p.maxHoldSlots : p.weakMaxHoldSlots);
      if (tp || sl || stale) {
        if (pendingMints.has(mint)) continue;
        const n = BigInt(Math.max(1, Math.min(p.sellSplits, cap - orders.length)));
        const piece = h.token_amount / n;
        for (let i = 1n; i <= n; i++) {
          const amount = i === n ? h.token_amount - piece * (n - 1n) : piece;
          orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: p.sellSlippageBps });
        }
        b.exiting = true;
        continue;
      }
      // Add a tranche while the dip holds near the first entry.
      const maxPos = b.strong ? p.maxPosition : p.weakMaxPosition;
      if (pendingMints.has(mint) || b.committed >= maxPos) continue;
      if (Math.abs(price / b.entryPrice - 1) > p.addBand) continue;
      let amount = maxPos - b.committed;
      const tranche = b.strong ? p.tranche : p.weakTranche;
      if (amount > tranche) amount = tranche;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      b.committed += amount;
      pendingMints.add(mint);
    }

    // 2. New entries on coins that traded this slot.
    let entries = 0;
    let open = state.committedPositionCount();
    let weakOpen = 0;
    for (const m of state.positions.keys()) if (!book(m).strong) weakOpen++;
    for (const o of state.pending.values()) if (o.order.side === 'buy' && !state.positions.has(o.order.mint) && !book(o.order.mint).strong) weakOpen++;
    for (const mint of touched) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = book(mint);
      if (slot < b.coolUntil) continue;
      const ticks = b.ticks;
      if (ticks.length < p.flowTrades) continue;
      const last = ticks[ticks.length - 1]!;
      if (last.realSol < p.minRealSol) continue;
      // Recent high within the window.
      let hi = 0;
      let hiReal = 0n;
      for (let i = ticks.length - 1; i >= 0; i--) {
        const t = ticks[i]!;
        if (slot - t.slot > p.highWindow) break;
        if (t.price > hi) {
          hi = t.price;
          hiReal = t.realSol;
        }
      }
      if (hi <= 0 || hiReal < p.minHighRealSol) continue;
      const dd = 1 - last.price / hi;
      const strong = last.realSol >= p.strongRealSol;
      if (strong ? dd < p.ddMin || dd > p.ddMax : dd < p.weakDdMin || dd > p.weakDdMax) continue;
      // Buyers still there.
      let buys = 0;
      let net = 0n;
      for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (t.isBuy) {
          buys++;
          net += t.sol;
        } else net -= t.sol;
      }
      if (buys < p.minBuys || net < p.minNetFlow) continue;
      if (p.lastMustBeBuy && !last.isBuy) continue;
      if (!strong && weakOpen >= p.maxWeakOpen) continue;
      let amount = strong ? p.tranche : p.weakTranche;
      const maxPos = strong ? p.maxPosition : p.weakMaxPosition;
      if (amount > maxPos) amount = maxPos;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      b.entryPrice = last.price;
      b.entrySlot = slot;
      b.entryHigh = hi;
      b.committed = amount;
      b.exiting = false;
      b.strong = strong;
      pendingMints.add(mint);
      entries++;
      open++;
      if (!strong) weakOpen++;
    }
    return orders;
  };
}
