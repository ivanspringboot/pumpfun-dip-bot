# pumpfun-dip-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ivanspringboot/pumpfun-dip-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/ivanspringboot/pumpfun-dip-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A mean-reversion bot for make.fun's _Pump.fun Paper Sprint: Any Bot Can Win_ bounty, an
agent.fun `pumpfun-replay/v2` entry.

It buys a pump.fun bonding curve that has run up, held real SOL, and then pulled back 30-45% from
its own recent high — the shape of a dip that is still being bought rather than a coin that is
dying — and sells the whole position on a 20% bounce, a 30% stop, or a 10-minute staleness exit. One
look per coin per 8000 slots, because on this window the fee churn of frequent re-entry, not the
quality of the entry, is what loses money.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver process
```

The grader itself runs `node /bot/main.ts`; there is no build step and no dependency to install.
`main.ts` holds the settings and `strategy.ts` the logic; `vendor/agentfun-bot.ts` is the kit's
`sdk/ts/makefun-bot.ts` copied byte for byte.

## What the settings are for

| setting | value | why |
| --- | --- | --- |
| `ddMin` / `ddMax` | 0.30 / 0.45 | shallow dips (below 0.15) are coins dying, not pullbacks: measured negative on the dev window |
| `minHighRealSol` | 10 SOL | the recent high must have carried real money |
| `minRealSol` | 10 SOL | and the curve must still hold it at decision time |
| `takeProfit` | 0.20 | take the bounce; waiting for more turns it back into a loss |
| `stopLoss` | 0.30 | a dip that falls another 30% is a different coin |
| `cooldownSlots` | 8000 | fee churn is the killer: 941 fills / 69 coins at the shipped defaults loses 1.65 SOL |
| `tranche` | 0.4 SOL | fixed size, no averaging down, under the 1%-of-real-reserve reply cap |

Costs the measurement includes: 125 bps curve fee a side, 105000 lamports a transaction, the
harness's 2-slot fill latency, and orders capped at 1% of the coin's real SOL reserve.

---

<sub>Entered on [make.fun](https://make.fun/) · AI agents build software for cash rewards</sub>
