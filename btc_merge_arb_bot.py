#!/usr/bin/env python3
"""
Standalone BTC market-maker paper bot with auto-merge accounting.

This version is intentionally paper-only for execution. It simulates passive
BUY quotes on both YES and NO, tracks inventory, and auto-merges paired
inventory when the paired average cost is profitable.
"""

from __future__ import annotations

import csv
import json
import os
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from pathlib import Path
from typing import Any


ZERO = Decimal("0")
ONE = Decimal("1")


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_decimal(name: str, default: str) -> Decimal:
    raw = os.getenv(name, default).strip()
    try:
        return Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(f"Invalid decimal for {name}: {raw}") from exc


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    return int(raw.strip())


@dataclass(frozen=True)
class Config:
    mode: str
    scan_interval_seconds: int
    run_once: bool
    market_keywords: tuple[str, ...]
    market_required_text: tuple[str, ...]
    gamma_markets_url: str
    gamma_events_url: str
    clob_book_url: str
    paper_start_balance: Decimal
    paper_ledger_file: str
    mm_quote_usd: Decimal
    mm_max_market_usd: Decimal
    mm_tick: Decimal
    mm_min_quote_price: Decimal
    mm_max_quote_price: Decimal
    mm_max_pair_cost: Decimal
    mm_min_merge_profit: Decimal
    mm_min_merge_shares: Decimal
    mm_assume_fill_probability_bps: int
    mm_fill_when_crossed: bool
    max_markets_per_scan: int

    @classmethod
    def from_env(cls) -> "Config":
        mode = os.getenv("EXECUTION_MODE", "MM_PAPER").strip().upper()
        if mode not in {"SCAN", "MM_PAPER", "LIVE"}:
            raise ValueError("EXECUTION_MODE must be SCAN, MM_PAPER, or LIVE")

        keywords = tuple(
            item.strip().lower()
            for item in os.getenv(
                "MARKET_KEYWORDS", "btc,bitcoin,eth,ethereum,sol,solana,xrp"
            ).split(",")
            if item.strip()
        )
        required_text = tuple(
            item.strip().lower()
            for item in os.getenv("MARKET_REQUIRED_TEXT", "up or down").split(",")
            if item.strip()
        )
        fill_probability = env_int("MM_ASSUME_FILL_PROBABILITY_BPS", 2500)
        if fill_probability < 0 or fill_probability > 10000:
            raise ValueError("MM_ASSUME_FILL_PROBABILITY_BPS must be 0..10000")

        return cls(
            mode=mode,
            scan_interval_seconds=env_int("SCAN_INTERVAL_SECONDS", 10),
            run_once=env_bool("RUN_ONCE", False),
            market_keywords=keywords,
            market_required_text=required_text,
            gamma_markets_url=os.getenv(
                "GAMMA_MARKETS_URL", "https://gamma-api.polymarket.com/markets"
            ),
            gamma_events_url=os.getenv(
                "GAMMA_EVENTS_URL", "https://gamma-api.polymarket.com/events"
            ),
            clob_book_url=os.getenv(
                "CLOB_BOOK_URL", "https://clob.polymarket.com/book"
            ),
            paper_start_balance=env_decimal("PAPER_START_BALANCE", "20"),
            paper_ledger_file=os.getenv("PAPER_LEDGER_FILE", "paper_mm_trades.csv"),
            mm_quote_usd=env_decimal("MM_QUOTE_USD", "0.25"),
            mm_max_market_usd=env_decimal("MM_MAX_MARKET_USD", "1.00"),
            mm_tick=env_decimal("MM_TICK", "0.01"),
            mm_min_quote_price=env_decimal("MM_MIN_QUOTE_PRICE", "0.03"),
            mm_max_quote_price=env_decimal("MM_MAX_QUOTE_PRICE", "0.97"),
            mm_max_pair_cost=env_decimal("MM_MAX_PAIR_COST", "0.97"),
            mm_min_merge_profit=env_decimal("MM_MIN_MERGE_PROFIT", "0.003"),
            mm_min_merge_shares=env_decimal("MM_MIN_MERGE_SHARES", "0.10"),
            mm_assume_fill_probability_bps=fill_probability,
            mm_fill_when_crossed=env_bool("MM_FILL_WHEN_CROSSED", True),
            max_markets_per_scan=env_int("MAX_MARKETS_PER_SCAN", 5),
        )


@dataclass(frozen=True)
class Market:
    id: str
    title: str
    slug: str
    condition_id: str
    yes_token_id: str
    no_token_id: str


@dataclass(frozen=True)
class BookSide:
    price: Decimal
    size: Decimal


@dataclass(frozen=True)
class Book:
    best_bid: BookSide | None
    best_ask: BookSide | None


@dataclass(frozen=True)
class QuotePlan:
    market: Market
    yes_book: Book
    no_book: Book
    yes_bid: Decimal
    no_bid: Decimal
    yes_size: Decimal
    no_size: Decimal
    pair_cost: Decimal
    estimated_profit_per_pair: Decimal


@dataclass
class Inventory:
    yes_qty: Decimal = ZERO
    yes_cost: Decimal = ZERO
    no_qty: Decimal = ZERO
    no_cost: Decimal = ZERO

    @property
    def total_cost(self) -> Decimal:
        return self.yes_cost + self.no_cost

    @property
    def total_qty(self) -> Decimal:
        return self.yes_qty + self.no_qty

    def add(self, side: str, qty: Decimal, cost: Decimal) -> None:
        if side == "YES":
            self.yes_qty += qty
            self.yes_cost += cost
        elif side == "NO":
            self.no_qty += qty
            self.no_cost += cost
        else:
            raise ValueError(f"Unknown side: {side}")

    def remove_pair(self, qty: Decimal) -> Decimal:
        yes_avg = self.avg_cost("YES")
        no_avg = self.avg_cost("NO")
        cost = (yes_avg + no_avg) * qty
        self.yes_qty -= qty
        self.no_qty -= qty
        self.yes_cost -= yes_avg * qty
        self.no_cost -= no_avg * qty
        self.clean_dust()
        return cost

    def avg_cost(self, side: str) -> Decimal:
        if side == "YES":
            return ZERO if self.yes_qty <= ZERO else self.yes_cost / self.yes_qty
        return ZERO if self.no_qty <= ZERO else self.no_cost / self.no_qty

    def paired_qty(self) -> Decimal:
        return min(self.yes_qty, self.no_qty)

    def paired_avg_cost(self) -> Decimal:
        if self.paired_qty() <= ZERO:
            return ZERO
        return self.avg_cost("YES") + self.avg_cost("NO")

    def clean_dust(self) -> None:
        if abs(self.yes_qty) < Decimal("0.000001"):
            self.yes_qty = ZERO
            self.yes_cost = ZERO
        if abs(self.no_qty) < Decimal("0.000001"):
            self.no_qty = ZERO
            self.no_cost = ZERO


class PaperLedger:
    fields = [
        "ts",
        "event",
        "market_id",
        "title",
        "side",
        "price",
        "shares",
        "cash_delta",
        "pnl",
        "balance_after",
        "yes_qty",
        "no_qty",
        "paired_avg_cost",
        "note",
    ]

    def __init__(self, path: str, start_balance: Decimal) -> None:
        self.path = Path(path)
        self.balance = start_balance
        self.inventories: dict[str, Inventory] = {}
        self.load_existing_balance()

    def load_existing_balance(self) -> None:
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))
        except OSError:
            return
        if not rows:
            return
        try:
            self.balance = Decimal(rows[-1]["balance_after"])
        except (KeyError, InvalidOperation):
            return

    def inventory(self, market_id: str) -> Inventory:
        if market_id not in self.inventories:
            self.inventories[market_id] = Inventory()
        return self.inventories[market_id]

    def record(self, row: dict[str, str]) -> None:
        should_write_header = not self.path.exists()
        with self.path.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=self.fields)
            if should_write_header:
                writer.writeheader()
            writer.writerow({field: row.get(field, "") for field in self.fields})


class PolymarketPublicClient:
    def __init__(self, config: Config) -> None:
        self.config = config

    def get_json(self, url: str, params: dict[str, str] | None = None) -> Any:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(url, headers={"User-Agent": "btc-mm-paper/0.1"})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))

    def fetch_markets(self, limit: int = 200) -> list[Market]:
        items = self.fetch_markets_from_events(limit)
        if not items:
            raw = self.get_json(
                self.config.gamma_markets_url,
                {"active": "true", "closed": "false", "limit": str(limit)},
            )
            items = raw if isinstance(raw, list) else raw.get("markets", [])
        markets = [market for item in items if (market := self.parse_market(item))]
        return markets[: self.config.max_markets_per_scan]

    def fetch_markets_from_events(self, limit: int) -> list[dict[str, Any]]:
        raw = self.get_json(
            self.config.gamma_events_url,
            {
                "active": "true",
                "closed": "false",
                "order": "volume24hr",
                "ascending": "false",
                "limit": str(limit),
            },
        )
        events = raw if isinstance(raw, list) else raw.get("events", [])
        markets: list[dict[str, Any]] = []
        for event in events:
            event_markets = event.get("markets", []) if isinstance(event, dict) else []
            if isinstance(event_markets, list):
                markets.extend(
                    market for market in event_markets if isinstance(market, dict)
                )
        return markets

    def parse_market(self, item: dict[str, Any]) -> Market | None:
        title = str(item.get("question") or item.get("title") or "")
        slug = str(item.get("slug") or "")
        searchable = f"{title} {slug}".lower()
        if not any(keyword in searchable for keyword in self.config.market_keywords):
            return None
        if self.config.market_required_text and not any(
            phrase in searchable for phrase in self.config.market_required_text
        ):
            return None

        outcomes = parse_json_list(item.get("outcomes"))
        token_ids = parse_json_list(item.get("clobTokenIds"))
        if len(outcomes) != 2 or len(token_ids) != 2:
            return None

        outcome_to_token = {
            str(outcome).strip().lower(): str(token_id)
            for outcome, token_id in zip(outcomes, token_ids)
        }
        yes_token_id = outcome_to_token.get("yes") or outcome_to_token.get("up")
        no_token_id = outcome_to_token.get("no") or outcome_to_token.get("down")
        condition_id = str(item.get("conditionId") or item.get("condition_id") or "")
        if not yes_token_id or not no_token_id or not condition_id:
            return None

        return Market(
            id=str(item.get("id") or condition_id),
            title=title,
            slug=slug,
            condition_id=condition_id,
            yes_token_id=yes_token_id,
            no_token_id=no_token_id,
        )

    def fetch_book(self, token_id: str) -> Book:
        book = self.get_json(self.config.clob_book_url, {"token_id": token_id})
        return Book(
            best_bid=self.best_side(book, "bids", find_min=False),
            best_ask=self.best_side(book, "asks", find_min=True),
        )

    def best_side(
        self, book: Any, side_name: str, *, find_min: bool
    ) -> BookSide | None:
        orders = book.get(side_name) if isinstance(book, dict) else None
        if not orders:
            return None
        parsed = []
        for order in orders:
            try:
                price = Decimal(str(order["price"]))
                size = Decimal(str(order["size"]))
            except (KeyError, InvalidOperation):
                continue
            if price > ZERO and size > ZERO:
                parsed.append(BookSide(price=price, size=size))
        if not parsed:
            return None
        selector = min if find_min else max
        return selector(parsed, key=lambda side: side.price)


class MarketMakerEngine:
    def __init__(
        self,
        config: Config,
        client: PolymarketPublicClient,
        paper_ledger: PaperLedger | None,
    ) -> None:
        self.config = config
        self.client = client
        self.paper_ledger = paper_ledger
        self.scan_id = 0

    def scan_once(self) -> list[QuotePlan]:
        self.scan_id += 1
        markets = self.client.fetch_markets()
        plans: list[QuotePlan] = []
        print(f"scan={self.scan_id} btc_markets={len(markets)}")

        for market in markets:
            yes_book = self.client.fetch_book(market.yes_token_id)
            no_book = self.client.fetch_book(market.no_token_id)
            plan = self.build_quote_plan(market, yes_book, no_book)
            if plan:
                plans.append(plan)

        plans.sort(key=lambda item: item.estimated_profit_per_pair, reverse=True)
        return plans

    def build_quote_plan(
        self, market: Market, yes_book: Book, no_book: Book
    ) -> QuotePlan | None:
        if not yes_book.best_bid or not no_book.best_bid:
            return None
        if not yes_book.best_ask or not no_book.best_ask:
            return None

        raw_yes_bid = yes_book.best_bid.price + self.config.mm_tick
        raw_no_bid = no_book.best_bid.price + self.config.mm_tick
        yes_bid = clamp(
            floor_to_tick(raw_yes_bid, self.config.mm_tick),
            self.config.mm_min_quote_price,
            self.config.mm_max_quote_price,
        )
        no_bid = clamp(
            floor_to_tick(raw_no_bid, self.config.mm_tick),
            self.config.mm_min_quote_price,
            self.config.mm_max_quote_price,
        )

        inventory = (
            self.paper_ledger.inventory(market.id) if self.paper_ledger else Inventory()
        )
        yes_bid, no_bid = self.apply_inventory_skew(inventory, yes_bid, no_bid)

        pair_cost = yes_bid + no_bid
        if pair_cost > self.config.mm_max_pair_cost:
            reduce_by = pair_cost - self.config.mm_max_pair_cost
            if yes_bid >= no_bid:
                yes_bid -= reduce_by
            else:
                no_bid -= reduce_by
            yes_bid = floor_to_tick(max(yes_bid, self.config.mm_min_quote_price), self.config.mm_tick)
            no_bid = floor_to_tick(max(no_bid, self.config.mm_min_quote_price), self.config.mm_tick)
            pair_cost = yes_bid + no_bid

        if pair_cost > self.config.mm_max_pair_cost:
            return None

        yes_size = quote_size(self.config.mm_quote_usd, yes_bid)
        no_size = quote_size(self.config.mm_quote_usd, no_bid)
        estimated_profit = ONE - pair_cost

        return QuotePlan(
            market=market,
            yes_book=yes_book,
            no_book=no_book,
            yes_bid=yes_bid,
            no_bid=no_bid,
            yes_size=yes_size,
            no_size=no_size,
            pair_cost=pair_cost,
            estimated_profit_per_pair=estimated_profit,
        )

    def apply_inventory_skew(
        self, inventory: Inventory, yes_bid: Decimal, no_bid: Decimal
    ) -> tuple[Decimal, Decimal]:
        if inventory.yes_qty > inventory.no_qty:
            yes_bid -= self.config.mm_tick
            no_bid += self.config.mm_tick
        elif inventory.no_qty > inventory.yes_qty:
            yes_bid += self.config.mm_tick
            no_bid -= self.config.mm_tick
        return (
            clamp(yes_bid, self.config.mm_min_quote_price, self.config.mm_max_quote_price),
            clamp(no_bid, self.config.mm_min_quote_price, self.config.mm_max_quote_price),
        )

    def handle_plan(self, plan: QuotePlan) -> None:
        print(
            "QUOTE "
            f"yes_bid={fmt(plan.yes_bid)} "
            f"no_bid={fmt(plan.no_bid)} "
            f"pair_bid_cost={fmt(plan.pair_cost)} "
            f"edge={fmt(plan.estimated_profit_per_pair)} "
            f"title={plan.market.title!r}"
        )

        if self.config.mode == "SCAN":
            return
        if self.config.mode == "MM_PAPER":
            self.execute_paper_market_maker(plan)
            return
        self.execute_live_market_maker(plan)

    def execute_paper_market_maker(self, plan: QuotePlan) -> None:
        if not self.paper_ledger:
            raise RuntimeError("MM_PAPER requires a ledger")

        inventory = self.paper_ledger.inventory(plan.market.id)
        if inventory.total_cost >= self.config.mm_max_market_usd:
            print(f"SKIP max_market_inventory title={plan.market.title!r}")
            self.try_paper_merge(plan.market, inventory)
            return

        self.maybe_fill_quote(plan, "YES", plan.yes_bid, plan.yes_size, plan.yes_book)
        self.maybe_fill_quote(plan, "NO", plan.no_bid, plan.no_size, plan.no_book)
        self.try_paper_merge(plan.market, inventory)

    def maybe_fill_quote(
        self,
        plan: QuotePlan,
        side: str,
        bid_price: Decimal,
        quote_shares: Decimal,
        book: Book,
    ) -> None:
        if not self.paper_ledger or quote_shares <= ZERO:
            return
        fill = False
        note = "simulated passive fill"
        if self.config.mm_fill_when_crossed and book.best_ask and book.best_ask.price <= bid_price:
            fill = True
            note = f"crossed ask={fmt(book.best_ask.price)}"
        elif deterministic_bps(plan.market.id, side, self.scan_id) < self.config.mm_assume_fill_probability_bps:
            fill = True

        if not fill:
            return

        inventory = self.paper_ledger.inventory(plan.market.id)
        remaining_budget = self.config.mm_max_market_usd - inventory.total_cost
        max_shares_by_budget = ZERO if remaining_budget <= ZERO else remaining_budget / bid_price
        fill_shares = min(quote_shares, max_shares_by_budget)
        if fill_shares <= ZERO:
            return

        cost = fill_shares * bid_price
        self.paper_ledger.balance -= cost
        inventory.add(side, fill_shares, cost)
        self.record(
            event="FILL",
            market=plan.market,
            inventory=inventory,
            side=side,
            price=bid_price,
            shares=fill_shares,
            cash_delta=-cost,
            pnl=ZERO,
            note=note,
        )
        print(
            "PAPER_FILL "
            f"side={side} price={fmt(bid_price)} shares={fmt(fill_shares)} "
            f"balance={fmt(self.paper_ledger.balance)}"
        )

    def try_paper_merge(self, market: Market, inventory: Inventory) -> None:
        if not self.paper_ledger:
            return
        pair_qty = inventory.paired_qty()
        if pair_qty < self.config.mm_min_merge_shares:
            return

        paired_cost = inventory.paired_avg_cost()
        profit_per_pair = ONE - paired_cost
        if paired_cost > self.config.mm_max_pair_cost:
            return
        if profit_per_pair < self.config.mm_min_merge_profit:
            return

        merge_qty = floor_to_tick(pair_qty, Decimal("0.000001"))
        cost_removed = inventory.remove_pair(merge_qty)
        cash_received = merge_qty
        pnl = cash_received - cost_removed
        self.paper_ledger.balance += cash_received
        self.record(
            event="MERGE",
            market=market,
            inventory=inventory,
            side="PAIR",
            price=paired_cost,
            shares=merge_qty,
            cash_delta=cash_received,
            pnl=pnl,
            note="auto merge paired YES+NO inventory",
        )
        print(
            "AUTO_MERGE "
            f"shares={fmt(merge_qty)} paired_cost={fmt(paired_cost)} "
            f"pnl={fmt(pnl)} balance={fmt(self.paper_ledger.balance)} "
            f"title={market.title!r}"
        )

    def record(
        self,
        *,
        event: str,
        market: Market,
        inventory: Inventory,
        side: str,
        price: Decimal,
        shares: Decimal,
        cash_delta: Decimal,
        pnl: Decimal,
        note: str,
    ) -> None:
        if not self.paper_ledger:
            return
        self.paper_ledger.record(
            {
                "ts": str(int(time.time())),
                "event": event,
                "market_id": market.id,
                "title": market.title,
                "side": side,
                "price": str(price),
                "shares": str(shares),
                "cash_delta": str(cash_delta),
                "pnl": str(pnl),
                "balance_after": str(self.paper_ledger.balance),
                "yes_qty": str(inventory.yes_qty),
                "no_qty": str(inventory.no_qty),
                "paired_avg_cost": str(inventory.paired_avg_cost()),
                "note": note,
            }
        )

    def execute_live_market_maker(self, plan: QuotePlan) -> None:
        raise NotImplementedError(
            "LIVE is blocked. Next step is wiring CLOB order posting/canceling, "
            "user fill monitoring, and CTF merge through the Polymarket relayer."
        )


def parse_json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if not isinstance(value, str) or not value.strip():
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def load_env_file(path: str = ".env") -> None:
    env_path = Path(path)
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def clamp(value: Decimal, minimum: Decimal, maximum: Decimal) -> Decimal:
    return max(minimum, min(maximum, value))


def quote_size(usd: Decimal, price: Decimal) -> Decimal:
    if price <= ZERO:
        return ZERO
    return floor_to_tick(usd / price, Decimal("0.000001"))


def floor_to_tick(value: Decimal, tick: Decimal) -> Decimal:
    if tick <= ZERO:
        return value
    return (value / tick).to_integral_value(rounding=ROUND_DOWN) * tick


def deterministic_bps(market_id: str, side: str, scan_id: int) -> int:
    seed = f"{market_id}:{side}:{scan_id}"
    total = 0
    for char in seed:
        total = (total * 131 + ord(char)) % 10000
    return total


def fmt(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.0001'))}"


def main() -> None:
    load_env_file()
    config = Config.from_env()
    client = PolymarketPublicClient(config)
    ledger = (
        PaperLedger(config.paper_ledger_file, config.paper_start_balance)
        if config.mode == "MM_PAPER"
        else None
    )
    engine = MarketMakerEngine(config, client, ledger)

    print(
        "btc_market_maker started "
        f"mode={config.mode} "
        f"quote_usd={config.mm_quote_usd} "
        f"max_pair_cost={config.mm_max_pair_cost} "
        f"max_market_usd={config.mm_max_market_usd}"
    )
    if ledger:
        print(f"paper_ledger file={config.paper_ledger_file} balance={fmt(ledger.balance)}")

    while True:
        try:
            plans = engine.scan_once()
            if not plans:
                print("no_quote_plans")
            for plan in plans:
                engine.handle_plan(plan)
        except KeyboardInterrupt:
            print("stopped")
            return
        except Exception as exc:
            print(f"scan_error={type(exc).__name__}: {exc}")

        if config.run_once:
            return

        time.sleep(config.scan_interval_seconds)


if __name__ == "__main__":
    main()
