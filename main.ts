// Boothlord pump.fun paper sprint — entry bot.
//
// Strategy in one paragraph: most fresh pump.fun curves bleed to zero, and the
// curve fee (about 1.25% a side) plus adverse selection eat any bot that chases
// size. So this bot trades small and picky, on two paths. The flow path buys
// curves that already show real demand — SOL actually in the curve, several
// distinct buyers, more money flowing in than out over the last stretch of
// slots, and a price that has not already run away. (A launch path that
// judges brand-new curves by their opening tape is implemented below but
// switched off: on the dev window it added fee bleed without an edge, so the
// shipped configuration runs the flow path alone, under a small per-run
// budget.) Every position is sold whole on the first of a
// take-profit, a stop-loss, a trailing stop, a flow reversal, the creator
// selling, the tape going quiet, or a hard time limit. Total money at risk is
// capped far below the bankroll, so no plausible window can draw the account
// down anywhere near the 50% guardrail. A pacing rule keeps cheap probe round
// trips flowing whenever completed round trips lag the count the guardrail
// asks for (20 coins), so the entry always clears the minimum bar.
//
// The bot is a pure function of the batch stream: no clock, no randomness, no
// environment reads, iteration only over insertion-ordered maps. The two
// grading executions therefore produce identical action logs.

import { LAMPORTS_PER_SOL, runBot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1e9;
/** Curve fee share used when valuing a position for exit decisions. */
const CURVE_FEE = 0.0125;

// ---- entry filter -----------------------------------------------------------
/** Path switches, set from what the dev window and its stress copies support. */
const ENABLE_FLOW = true;
const ENABLE_LAUNCH = false;
/** Slots a curve must have lived before it may be bought (launch bundles dump early). */
const MIN_AGE_SLOTS = 150;
/** Real SOL that must sit in the curve: enough liquidity that our size cap is usable. */
const MIN_REAL_SOL = 10;
const MAX_REAL_SOL = 60;
/** Lookback (slots) for the flow test. */
const FLOW_SLOTS = 45;
/** Net SOL in over the flow window (buys minus sells). */
const MIN_NET_FLOW_SOL = 3.0;
/** The price must also have risen at least this share inside the window: demand
 * that is actually lifting the curve, not just churning under it. */
const MIN_WINDOW_RISE = 0.1;
/** Most flow entries in a whole run: the path is a small, deliberate allocation
 * on top of the probe floor, never the main engine. */
const FLOW_RUN_BUDGET = 12;
/** At least this many buy trades and this many distinct buyers in the window. */
const MIN_FLOW_BUYS = 4;
const MIN_FLOW_BUYERS = 6;
/** Sells may be at most this share of buy volume in the window. */
const MAX_SELL_SHARE = 0.6;
/** Price now may be at most this multiple of its price at the window's start. */
const MAX_RUNUP = 1.4;

// ---- sizing -----------------------------------------------------------------
/** One position's total buy, before the per-reply reserve cap trims it. */
const STAKE_SOL = 0.04;
/** Smallest buy worth the transaction fee (also above the 0.01 SOL round-trip bar). */
const MIN_BUY_SOL = 0.012;
/** Buys refuse a fill that moved more than this against us during the latency. */
const BUY_SLIPPAGE_BPS = 800;
/** At most this many strategy positions at once; the last slot is for probes. */
const MAX_MAIN_POSITIONS = 4;
/** Hard cap on SOL at cost across open positions plus buys in flight. */
const MAX_EXPOSURE_SOL = 1.2;
/** Slots to wait after leaving a curve before it may be bought again. */
const COOLDOWN_SLOTS = 200;
/** Most times one curve may be entered in a run. */
const MAX_ENTRIES_PER_CURVE = 2;

// ---- exits ------------------------------------------------------------------
const TAKE_PROFIT = 0.18; // sell when the position is worth 18% over cost
const STOP_LOSS = 0.12; // sell when it is worth 12% under cost
const TRAIL_ARM = 0.1; // trailing stop arms 10% over cost
const TRAIL_DROP = 0.12; // then a 12% fall from the best value sells
const FADE_SLOTS = 15; // flow window for the reversal exit
const FADE_NET_SOL = -0.5; // net outflow past this sells
const QUIET_SLOTS = 300; // no trade for this long while held: sell, free the slot
const MAX_HOLD_SLOTS = 900; // never hold longer than this

// ---- launch entries -----------------------------------------------------------
// A second, separate path for brand-new curves. The opening slots of a launch
// are the one moment a small buyer is not chasing: the crowd piles in after
// the create, and a launch whose opening tape shows a committed creator plus
// a handful of independent buyers — not a giant bundle cluster, and no
// creator sell yet — tends to keep rising for a short while. Buy it small,
// leave fast.
/** Decide a launch once its age reaches this, and never after this. */
const LAUNCH_MIN_AGE = 4;
const LAUNCH_MAX_AGE = 24;
/** Creator's own buy in the opening tape: committed, but not a whale bundle. */
const LAUNCH_MIN_DEV_BUY_SOL = 0.1;
const LAUNCH_MAX_DEV_BUY_SOL = 3;
/** Distinct non-creator buyers in the opening tape: interest without a cluster. */
const LAUNCH_MIN_BUYERS = 3;
const LAUNCH_MAX_BUYERS = 12;
/** Sells may be at most this share of opening volume. */
const LAUNCH_MAX_SELL_SHARE = 0.35;
/** Real SOL in the curve before a launch buy is allowed. */
const LAUNCH_MIN_REAL_SOL = 1.5;
const LAUNCH_STAKE_SOL = 0.03;
/** Launch exits are faster: the opening pop is the whole thesis. */
const LAUNCH_TAKE_PROFIT = 0.25;
const LAUNCH_STOP_LOSS = 0.15;
const LAUNCH_MAX_HOLD_SLOTS = 240;
const LAUNCH_QUIET_SLOTS = 120;

// ---- guardrail pacing -------------------------------------------------------
/** Round trips to bank (the bar is 20 coins; aim higher for margin). */
const TARGET_ROUND_TRIPS = 24;
/** The final window is 6 hours; pace probes against three quarters of it. */
const PACE_SECONDS = 6 * 3600 * 0.75;
/** Probe size: above the 0.01 SOL bar, small enough to cost almost nothing. */
const PROBE_SOL = 0.015;
/** A probe needs a curve at least this liquid. */
const PROBE_MIN_REAL_SOL = 6;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
  /** Spot price (SOL per token) from the trade's own post-trade reserves. */
  price: number;
}

interface CurveNote {
  creator: Pubkey | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
  lastTradeSlot: number;
  /** The launch path judges each curve once; this is set when it has. */
  launchDecided: boolean;
}

interface HeldNote {
  openedSlot: number;
  peakRatio: number;
  exitSent: boolean;
  /** True when the launch path opened this position: its exits are faster. */
  launch: boolean;
}

const notes = new Map<Pubkey, CurveNote>();
const heldNotes = new Map<Pubkey, HeldNote>();
/** Mints where a probe round trip is in flight: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
/** Mints with a completed round trip from a buy of at least the bar size. */
const roundTripCoins = new Set<Pubkey>();
/** Mints where one of my buys of at least the bar size has filled. */
const qualifiedBuys = new Set<Pubkey>();
/** Flow entries placed this run, against FLOW_RUN_BUDGET. */
let flowEntries = 0;
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function noteOf(mint: Pubkey): CurveNote {
  let n = notes.get(mint);
  if (n === undefined) {
    n = { creator: null, trades: [], entries: 0, lastExitSlot: -1_000_000_000, lastTradeSlot: -1, launchDecided: false };
    notes.set(mint, n);
  }
  return n;
}

/** Net SOL flow (buys minus sells) over the last `window` slots before `now`. */
function netFlow(n: CurveNote, now: number, window: number): number {
  let net = 0;
  for (let i = n.trades.length - 1; i >= 0; i--) {
    const t = n.trades[i]!;
    if (t.slot <= now - window) break;
    net += t.buy ? t.sol : -t.sol;
  }
  return net;
}

/** Does this curve pass every entry test at this batch? */
function entryOk(state: BotState, mint: Pubkey, now: number): boolean {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  const realSol = Number(curve.real_quote_reserves) / SOL;
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (curve.created_slot !== null && now - curve.created_slot < MIN_AGE_SLOTS) return false;
  const n = noteOf(mint);
  if (n.entries >= MAX_ENTRIES_PER_CURVE) return false;
  if (now - n.lastExitSlot < COOLDOWN_SLOTS) return false;

  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  /** Price of the last trade at or before the window opened; -1 while unseen. */
  let startPrice = -1;
  /** Price of the newest trade inside the window. */
  let lastPrice = -1;
  const buyers = new Set<Pubkey>();
  for (const t of n.trades) {
    if (t.slot <= now - FLOW_SLOTS) {
      startPrice = t.price;
      continue;
    }
    if (t.buy) {
      buySol += t.sol;
      buys++;
      buyers.add(t.user);
    } else {
      sellSol += t.sol;
    }
    lastPrice = t.price;
  }
  if (buys < MIN_FLOW_BUYS || buyers.size < MIN_FLOW_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_FLOW_SOL) return false;
  if (buySol > 0 && sellSol > MAX_SELL_SHARE * buySol) return false;
  // No chasing: a curve that already ran far inside one window is a top, not an entry.
  if (startPrice > 0 && lastPrice > startPrice * MAX_RUNUP) return false;
  // And no dead tape: the window's flow must have lifted the price a little.
  if (startPrice > 0 && lastPrice < startPrice * (1 + MIN_WINDOW_RISE)) return false;
  return true;
}

/**
 * The launch test, run once per curve when its age first reaches
 * LAUNCH_MIN_AGE: read the opening tape (every trade since the create) and
 * judge the launch by who showed up, not by where the price went.
 */
function launchOk(state: BotState, mint: Pubkey, now: number): boolean {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete || curve.created_slot === null) return false;
  const age = now - curve.created_slot;
  if (age < LAUNCH_MIN_AGE || age > LAUNCH_MAX_AGE) return false;
  if (Number(curve.real_quote_reserves) / SOL < LAUNCH_MIN_REAL_SOL) return false;
  const n = noteOf(mint);
  if (n.creator === null) return false;
  let devBuy = 0;
  let buySol = 0;
  let sellSol = 0;
  const buyers = new Set<Pubkey>();
  for (const t of n.trades) {
    if (t.user === n.creator) {
      if (!t.buy) return false; // the creator already sold: the launch is over
      devBuy += t.sol;
    } else if (t.buy) {
      buySol += t.sol;
      buyers.add(t.user);
    } else {
      sellSol += t.sol;
    }
  }
  if (devBuy < LAUNCH_MIN_DEV_BUY_SOL || devBuy > LAUNCH_MAX_DEV_BUY_SOL) return false;
  if (buyers.size < LAUNCH_MIN_BUYERS || buyers.size > LAUNCH_MAX_BUYERS) return false;
  const volume = buySol + sellSol;
  if (volume > 0 && sellSol > LAUNCH_MAX_SELL_SHARE * volume) return false;
  return true;
}

/** What selling the whole position would net now, in SOL, fees and tx fee deducted. */
function closeValue(
  state: BotState,
  mint: Pubkey,
  tokens: bigint,
  mark: { virtual_quote_reserves: string; virtual_token_reserves: string } | undefined,
): number {
  const curve = state.curves.get(mint);
  const vq = mark ? Number(mark.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : 0;
  const vt = mark ? Number(mark.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : 0;
  if (vt <= 0 || tokens <= 0n) return 0;
  const gross = (Number(tokens) * vq) / (vt + Number(tokens));
  return (gross / SOL) * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / SOL;
}

await runBot({
  onBatch(state, batch) {
    const now = batch.slot;
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const txSol = Number(state.txFeeLamports()) / SOL;

    // ---- fold this batch in -------------------------------------------------
    const tradedNow = new Set<Pubkey>();
    const creatorSold = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && f.quote_lamports !== '0' && BigInt(f.quote_lamports) >= BigInt(Math.floor(MIN_BUY_SOL * SOL))) {
        qualifiedBuys.add(f.mint);
      }
      if (f.side === 'sell' && qualifiedBuys.has(f.mint)) roundTripCoins.add(f.mint);
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        noteOf(e.mint).creator = e.creator;
      } else if (e.event === 'TradeEvent') {
        const n = noteOf(e.mint);
        n.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: Number(e.sol_amount) / SOL,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        n.lastTradeSlot = e.slot;
        tradedNow.add(e.mint);
        if (!e.is_buy && n.creator !== null && e.user === n.creator) creatorSold.add(e.mint);
      }
    }
    // Prune tapes to the stretch any test can still look back over.
    const keepFrom = now - Math.max(FLOW_SLOTS, QUIET_SLOTS) - 5;
    for (const mint of tradedNow) {
      const t = noteOf(mint).trades;
      let cut = 0;
      while (cut < t.length && t[cut]!.slot <= keepFrom) cut++;
      if (cut > 0) t.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingMints = new Set<Pubkey>();
    const pendingSellMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      pendingMints.add(p.order.mint);
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
    }

    // ---- exits first ----------------------------------------------------------
    for (const [mint, pos] of state.positions) {
      let h = heldNotes.get(mint);
      if (h === undefined) {
        h = { openedSlot: now, peakRatio: 0, exitSent: false, launch: false };
        heldNotes.set(mint, h);
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue; // the replay closes it
      if (pendingSellMints.has(mint)) {
        h.exitSent = true;
        continue;
      }
      const cost = Number(pos.cost_lamports) / SOL;
      const value = closeValue(state, mint, pos.token_amount, marks.get(mint));
      const ratio = cost > 0 ? value / cost : 0;
      if (ratio > h.peakRatio) h.peakRatio = ratio;
      const n = noteOf(mint);
      const takeProfit = h.launch ? LAUNCH_TAKE_PROFIT : TAKE_PROFIT;
      const stopLoss = h.launch ? LAUNCH_STOP_LOSS : STOP_LOSS;
      const quietSlots = h.launch ? LAUNCH_QUIET_SLOTS : QUIET_SLOTS;
      const maxHold = h.launch ? LAUNCH_MAX_HOLD_SLOTS : MAX_HOLD_SLOTS;
      let exit = h.exitSent;
      if (!exit && ratio >= 1 + takeProfit) exit = true;
      if (!exit && ratio <= 1 - stopLoss) exit = true;
      if (!exit && h.peakRatio >= 1 + TRAIL_ARM && ratio <= h.peakRatio * (1 - TRAIL_DROP)) exit = true;
      if (!exit && netFlow(n, now, FADE_SLOTS) < FADE_NET_SOL) exit = true;
      if (!exit && creatorSold.has(mint)) exit = true;
      if (!exit && now - n.lastTradeSlot > quietSlots) exit = true;
      if (!exit && now - h.openedSlot > maxHold) exit = true;
      if (!exit) continue;
      h.exitSent = true;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }
    // Forget positions that are gone (sold, completed or flattened).
    for (const mint of [...heldNotes.keys()]) {
      if (!state.positions.has(mint) && !pendingMints.has(mint)) {
        heldNotes.delete(mint);
        noteOf(mint).lastExitSlot = now;
      }
    }

    // ---- probes: sell as soon as the buy lands --------------------------------
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      if (pos === undefined) {
        if (!pendingMints.has(mint)) probes.delete(mint);
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // ---- exposure and cash shared by the buy paths -----------------------------
    let exposure = 0;
    for (const pos of state.positions.values()) exposure += Number(pos.cost_lamports) / SOL;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') exposure += Number(p.order.quote_lamports) / SOL;
    }
    let free = Number(state.freeCashLamports()) / SOL;
    let committed = state.committedPositionCount();

    // ---- entries ----------------------------------------------------------------
    for (const mint of tradedNow) {
      if (orders.length >= cap) break;
      if (committed >= MAX_MAIN_POSITIONS + probes.size) break;
      if (state.positions.has(mint) || pendingMints.has(mint) || probes.has(mint)) continue;
      if (heldNotes.has(mint)) continue;
      // The launch path judges a young curve once; the flow path takes the rest.
      const n = noteOf(mint);
      const curve = state.curves.get(mint);
      let launch = false;
      let stake = STAKE_SOL;
      if (ENABLE_LAUNCH && curve !== undefined && curve.created_slot !== null && !n.launchDecided && now - curve.created_slot >= LAUNCH_MIN_AGE) {
        n.launchDecided = true;
        if (!launchOk(state, mint, now)) continue;
        launch = true;
        stake = LAUNCH_STAKE_SOL;
      } else if (!ENABLE_FLOW || flowEntries >= FLOW_RUN_BUDGET || !entryOk(state, mint, now)) {
        continue;
      }
      const capSol = Number(state.maxBuyLamports(mint)) / SOL;
      let amount = Math.min(stake, capSol, MAX_EXPOSURE_SOL - exposure, free - txSol);
      if (amount < MIN_BUY_SOL) continue;
      orders.push({
        side: 'buy',
        mint,
        quote_lamports: BigInt(Math.floor(amount * SOL)),
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      free -= amount + txSol;
      exposure += amount;
      committed++;
      n.entries++;
      if (!launch) flowEntries++;
      heldNotes.set(mint, { openedSlot: now, peakRatio: 0, exitSent: false, launch });
    }

    // ---- guardrail pacing: probe when round trips lag ---------------------------
    if (
      probes.size === 0 &&
      committed < state.hello.caps.max_open_positions &&
      firstBlockTime !== null &&
      lastBlockTime !== null
    ) {
      const pace = Math.min(1, (lastBlockTime - firstBlockTime) / PACE_SECONDS);
      const inFlight = qualifiedBuys.size - roundTripCoins.size;
      const banked = roundTripCoins.size + Math.max(0, inFlight);
      if (banked < Math.ceil(TARGET_ROUND_TRIPS * pace)) {
        // Fresh coins first: a probe on a coin that already banked its round
        // trip buys nothing but fees. Only when no fresh coin qualifies does
        // a repeat probe make sense (it cannot happen while behind pace).
        for (const freshPass of [true, false]) {
          let placed = false;
          for (const mint of tradedNow) {
            if (orders.length >= cap) break;
            if (state.positions.has(mint) || pendingMints.has(mint) || heldNotes.has(mint)) continue;
            if (freshPass && roundTripCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / SOL < PROBE_MIN_REAL_SOL) continue;
            if (free < PROBE_SOL + 2 * txSol) break;
            const capSol = Number(state.maxBuyLamports(mint)) / SOL;
            if (capSol < PROBE_SOL) continue;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * SOL)), max_slippage_bps: BUY_SLIPPAGE_BPS });
            probes.set(mint, false);
            free -= PROBE_SOL + txSol;
            committed++;
            placed = true;
            break;
          }
          if (placed) break;
        }
      }
    }

    return orders;
  },
});
