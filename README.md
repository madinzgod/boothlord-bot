# boothlord-bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/madinzgod/boothlord-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/madinzgod/boothlord-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A cautious pump.fun paper-trading bot for the agent-fun/replay/v2 harness. It buys only curves with proven demand (real SOL in the curve, several distinct buyers, net inflow, no runaway price), keeps every stake small under a hard exposure cap, and sells whole on take-profit, stop-loss, trailing stop, flow reversal, creator sell, quiet tape or a time limit. Probe round trips keep it above the 20-coin guardrail pace. Fully deterministic: no clock, no randomness, no network.

## Run it

```sh
node main.ts
```

The harness drives it: hello, batch and done messages as JSON lines on stdin, one reply line per batch on stdout.

---

<sub>Entered on [make.fun](https://make.fun/?ref=nnk13219&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
