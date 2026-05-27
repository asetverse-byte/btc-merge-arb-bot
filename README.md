# BTC Market Maker + Auto Merge Bot

Standalone crypto Up/Down market-maker bot, separate from the old signal bot.

This version is paper execution by default. It simulates passive market-maker
BUY quotes on both YES and NO, tracks inventory, then auto-merges paired
inventory when the paired average cost is profitable.

## Run

```powershell
cd C:\Users\ilham\OneDrive\Desktop\btc_merge_arb_bot
py .\btc_merge_arb_bot.py
```

If `py` is not available, use any Python 3 executable.

## Default Mode

```env
EXECUTION_MODE=MM_PAPER
PAPER_START_BALANCE=20
MM_QUOTE_USD=0.25
MM_MAX_MARKET_USD=1.00
MM_MAX_PAIR_COST=0.97
MM_MIN_MERGE_PROFIT=0.003
```

## Flow

```text
scan active BTC/ETH/SOL/XRP Up or Down binary markets
read YES and NO orderbooks
simulate maker BUY quotes on both sides
skew quotes if inventory is imbalanced
record paper fills
if YES + NO paired average cost <= 0.97
  auto merge paired shares into $1/share
  record realized PnL
```

Paper logs are written to:

```text
paper_mm_trades.csv
```

## Modes

```text
SCAN      print quote plans only
MM_PAPER  simulate maker fills, inventory, and auto-merge
LIVE      blocked until real CLOB order + relayer merge adapters are added
```

## Tiny Live Runner

The live runner is a separate Node.js file:

```powershell
cd C:\Users\ilham\OneDrive\Desktop\btc_merge_arb_bot
npm install
copy .env.live.example .env.live
notepad .env.live
npm run live
```

It will not send orders until `.env.live` contains:

```env
LIVE_ARMED=I_UNDERSTAND_SMALL_LIVE
```

Default live guards are intentionally tiny:

```env
LIVE_QUOTE_USD=2.50
LIVE_MIN_QUOTE_SHARES=5
LIVE_MAX_SIDE_SHARES=5
LIVE_MAX_TOTAL_SHARES=10
LIVE_MAX_GLOBAL_USD=30.00
LIVE_MAX_ACTIVE_INVENTORY_MARKETS=4
LIVE_MAX_MARKET_USD=6.00
LIVE_MAX_PAIR_COST=0.97
LIVE_EXIT_BEFORE_CLOSE_MINUTES=5
LIVE_EMERGENCY_PAIR_BEFORE_CLOSE=true
LIVE_EMERGENCY_MAX_PAIR_COST=1.00
LIVE_QUOTE_TTL_SECONDS=20
LIVE_CANCEL_SETTLE_MS=2000
LIVE_MAX_QUOTE_CYCLES=0
LIVE_STOP_AFTER_FILL=false
LIVE_AUTO_DEPLOY_SAFE=true
```

The live runner posts short-lived GTD BUY quotes on YES and NO, cancels stale
quotes, reconciles matched order size, and sends an auto-merge through the
Polymarket relayer when paired inventory is profitable.

The default market filter is deliberately narrow:

```env
MARKET_KEYWORDS=btc,bitcoin,eth,ethereum,sol,solana,xrp
MARKET_REQUIRED_TEXT=up or down
```
