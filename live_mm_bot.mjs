import {
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import relayerPkg from "@polymarket/builder-relayer-client";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseUnits,
  zeroHash,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import fs from "node:fs";

const { RelayClient, OperationType } = relayerPkg;
const ZERO = 0;
const ONE = 1;
const EPSILON = 1e-9;
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

loadEnv(".env", false);
loadEnv(".env.live", true);

const config = {
  liveArmed: env("LIVE_ARMED", ""),
  privateKey: env("PRIVATE_KEY", ""),
  depositWalletAddress: env("DEPOSIT_WALLET_ADDRESS", ""),
  signatureType: Number(env("SIGNATURE_TYPE", "3")),
  quoteUsd: num("LIVE_QUOTE_USD", 0.1),
  maxGlobalUsd: num("LIVE_MAX_GLOBAL_USD", 30),
  maxActiveInventoryMarkets: Number(env("LIVE_MAX_ACTIVE_INVENTORY_MARKETS", "4")),
  maxMarketUsd: num("LIVE_MAX_MARKET_USD", 0.5),
  maxPairCost: num("LIVE_MAX_PAIR_COST", 0.97),
  repairMaxPairCost: num("LIVE_REPAIR_MAX_PAIR_COST", Number(env("LIVE_MAX_PAIR_COST", "0.97"))),
  minMergeProfit: num("LIVE_MIN_MERGE_PROFIT", 0.003),
  minMergeShares: num("LIVE_MIN_MERGE_SHARES", 0.1),
  exitBeforeCloseMinutes: num("LIVE_EXIT_BEFORE_CLOSE_MINUTES", 5),
  emergencyPairBeforeClose: bool("LIVE_EMERGENCY_PAIR_BEFORE_CLOSE", true),
  emergencyMaxPairCost: num("LIVE_EMERGENCY_MAX_PAIR_COST", 1.0),
  quoteTtlSeconds: Number(env("LIVE_QUOTE_TTL_SECONDS", "20")),
  scanIntervalSeconds: Number(env("LIVE_SCAN_INTERVAL_SECONDS", "5")),
  cancelSettleMs: Number(env("LIVE_CANCEL_SETTLE_MS", "2000")),
  cancelAllOnStart: bool("LIVE_CANCEL_ALL_ON_START", true),
  cancelOnly: bool("LIVE_CANCEL_ONLY", false),
  maxQuoteCycles: Number(env("LIVE_MAX_QUOTE_CYCLES", "0")),
  stopAfterFill: bool("LIVE_STOP_AFTER_FILL", false),
  debugReconcile: bool("LIVE_DEBUG_RECONCILE", false),
  autoMerge: bool("LIVE_AUTO_MERGE", true),
  autoDeploySafe: bool("LIVE_AUTO_DEPLOY_SAFE", true),
  minQuoteShares: num("LIVE_MIN_QUOTE_SHARES", 5),
  maxSideShares: num("LIVE_MAX_SIDE_SHARES", 5),
  maxTotalShares: num("LIVE_MAX_TOTAL_SHARES", 10),
  keywords: env("MARKET_KEYWORDS", "btc,bitcoin,eth,ethereum,sol,solana,xrp")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  requiredText: env("MARKET_REQUIRED_TEXT", "up or down")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  marketSearchQueries: env(
    "MARKET_SEARCH_QUERIES",
    "bitcoin up or down,ethereum up or down,solana up or down,xrp up or down",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  maxMarketsPerScan: Number(env("MAX_MARKETS_PER_SCAN", "3")),
  clobHost: env("CLOB_HOST", "https://clob.polymarket.com"),
  gammaMarketsUrl: env("GAMMA_MARKETS_URL", "https://gamma-api.polymarket.com/markets"),
  gammaEventsUrl: env("GAMMA_EVENTS_URL", "https://gamma-api.polymarket.com/events"),
  gammaPublicSearchUrl: env("GAMMA_PUBLIC_SEARCH_URL", "https://gamma-api.polymarket.com/public-search"),
  clobBookUrl: env("CLOB_BOOK_URL", "https://clob.polymarket.com/book"),
  chainId: Number(env("CHAIN_ID", "137")),
  rpcUrl: env("RPC_URL", "https://polygon-rpc.com"),
  relayerUrl: env("POLYMARKET_RELAYER_URL", "https://relayer-v2.polymarket.com"),
  relayerApiKey: env("RELAYER_API_KEY", ""),
  relayerApiKeyAddress: env("RELAYER_API_KEY_ADDRESS", ""),
};

const inventories = new Map();
const ledgerPath = "live_mm_trades.csv";
let client;
let wallet;
let shuttingDown = false;
let activeQuote = null;
let quoteCycles = 0;
let sawFillThisRun = false;

main().catch((error) => {
  console.error("fatal_error", error?.stack || error);
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  await shutdown("SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdown("SIGTERM");
});

async function main() {
  assertLiveArmed();
  loadInventoryFromLedger();
  await initTradingClient();

  console.log(
    `LIVE portfolio_mm armed quote_usd=${config.quoteUsd} max_global_usd=${config.maxGlobalUsd} max_market_usd=${config.maxMarketUsd} max_pair_cost=${config.maxPairCost} repair_max_pair_cost=${config.repairMaxPairCost}`,
  );

  if (config.cancelAllOnStart) {
    console.log("cancel_all_on_start=true");
    await cancelAllAndSettle("startup");
  }
  if (config.cancelOnly) {
    console.log("cancel_only=true done");
    return;
  }

  while (!shuttingDown) {
    const markets = await fetchMarkets();
    const symbols = markets.map((market) => `${market.symbol}:${market.slug}`).join(",");
    console.log(
      `eligible_markets=${markets.length} symbols=${symbols || "-"} active_inventory_markets=${activeInventoryMarketCount()} exposure_usd=${fmt(globalExposureUsd())}`,
    );

    for (const market of markets) {
      await quoteMarketOnce(market);
      if (shouldStopAfterCycle()) {
        await cleanStop("guard_stop");
        return;
      }
    }

    await sleep(config.scanIntervalSeconds * 1000);
  }
}

async function initTradingClient() {
  if (!config.privateKey) throw new Error("PRIVATE_KEY is required in .env.live");
  if (!config.depositWalletAddress) {
    throw new Error("DEPOSIT_WALLET_ADDRESS/funder address is required in .env.live");
  }

  const account = privateKeyToAccount(config.privateKey);
  wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(config.rpcUrl),
  });

  const tempClient = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer: wallet,
  });
  const creds = await tempClient.createOrDeriveApiKey();

  client = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer: wallet,
    creds,
    signatureType: signatureTypeValue(config.signatureType),
    funderAddress: config.depositWalletAddress,
  });
}

async function quoteMarketOnce(market) {
  if (isNearClose(market)) {
    await handleNearCloseMarket(market);
    return;
  }

  await cancelAllAndSettle("pre_cycle");

  const yesBook = await fetchBook(market.yesTokenId);
  const noBook = await fetchBook(market.noTokenId);
  if (!yesBook.bestBid || !yesBook.bestAsk || !noBook.bestBid || !noBook.bestAsk) return;

  const tickSize = String(market.tickSize || (await getTickSize(market.yesTokenId)));
  const tick = Number(tickSize);
  let yesBid = buildBid(yesBook, tick);
  let noBid = buildBid(noBook, tick);
  const inventory = getInventory(market.id);
  const hadInventory = isInventoryActive(inventory);
  const sidesToQuote = quoteSidesForInventory(inventory);
  const pairCostLimit =
    hadInventory && sidesToQuote.length === 1 ? config.repairMaxPairCost : config.maxPairCost;

  if (!hadInventory && activeInventoryMarketCount() >= config.maxActiveInventoryMarkets) {
    console.log(
      `SKIP active_market_cap active=${activeInventoryMarketCount()} max=${config.maxActiveInventoryMarkets} title=${JSON.stringify(market.title)}`,
    );
    return;
  }

  if (sidesToQuote.length === 1 && sidesToQuote[0] === "NO") {
    const maxNoBid = floorToTick(pairCostLimit - avgCost(inventory, "YES"), tick);
    noBid = Math.min(noBid, maxNoBid);
    if (noBid <= ZERO) {
      console.log(
        `SKIP need_no_unavailable max_no=${fmt(maxNoBid)} yes_avg=${fmt(avgCost(inventory, "YES"))} title=${JSON.stringify(market.title)}`,
      );
      return;
    }
  } else if (sidesToQuote.length === 1 && sidesToQuote[0] === "YES") {
    const maxYesBid = floorToTick(pairCostLimit - avgCost(inventory, "NO"), tick);
    yesBid = Math.min(yesBid, maxYesBid);
    if (yesBid <= ZERO) {
      console.log(
        `SKIP need_yes_unavailable max_yes=${fmt(maxYesBid)} no_avg=${fmt(avgCost(inventory, "NO"))} title=${JSON.stringify(market.title)}`,
      );
      return;
    }
  }

  const pairCost = inventoryAwarePairCost(inventory, sidesToQuote, yesBid, noBid);

  if (
    yesBid <= ZERO ||
    noBid <= ZERO ||
    pairCost - pairCostLimit > EPSILON
  ) {
    console.log(
      `SKIP pair_cost=${fmt(pairCost)} max=${fmt(pairCostLimit)} yes_bid=${fmt(yesBid)} no_bid=${fmt(noBid)} title=${JSON.stringify(market.title)}`,
    );
    return;
  }

  if (inventory.totalCost >= config.maxMarketUsd) {
    console.log(`SKIP max_inventory market_cost=${fmt(inventory.totalCost)} title=${JSON.stringify(market.title)}`);
    await tryAutoMerge(market, inventory);
    return;
  }

  const minShares = Math.max(config.minQuoteShares, Number(market.orderMinSize || 0));
  const yesSize = sidesToQuote.includes("YES")
    ? boundedQuoteSize(inventory, "YES", yesBid, minShares)
    : ZERO;
  const noSize = sidesToQuote.includes("NO")
    ? boundedQuoteSize(inventory, "NO", noBid, minShares)
    : ZERO;
  if (!sidesToQuote.length) {
    console.log(`SKIP no_sides_to_quote title=${JSON.stringify(market.title)}`);
    return;
  }
  const plannedCost = yesSize * yesBid + noSize * noBid;
  const remainingBudget = config.maxMarketUsd - inventory.totalCost;
  if (plannedCost > remainingBudget) {
    console.log(
      `SKIP min_order_too_large planned_cost=${fmt(plannedCost)} remaining=${fmt(remainingBudget)} min_shares=${fmt(minShares)} title=${JSON.stringify(market.title)}`,
    );
    return;
  }
  if (!hadInventory && globalExposureUsd() + plannedCost > config.maxGlobalUsd) {
    console.log(
      `SKIP global_exposure planned=${fmt(plannedCost)} exposure=${fmt(globalExposureUsd())} max=${fmt(config.maxGlobalUsd)} title=${JSON.stringify(market.title)}`,
    );
    return;
  }
  console.log(
    `POST symbol=${market.symbol} sides=${sidesToQuote.join("+")} yes=${fmt(yesBid)} no=${fmt(noBid)} pair=${fmt(pairCost)} shares=${fmt(minShares)} inv_yes=${fmt(inventory.yesQty)} inv_no=${fmt(inventory.noQty)} global_exposure=${fmt(globalExposureUsd())} ttl=${config.quoteTtlSeconds}s title=${JSON.stringify(market.title)}`,
  );
  quoteCycles += 1;

  const posted = [];
  if (yesSize > ZERO) {
    posted.push(
      await postOrder(market.yesTokenId, yesBid, yesSize, tickSize, market.negRisk, "YES"),
    );
  }
  if (noSize > ZERO) {
    posted.push(
      await postOrder(market.noTokenId, noBid, noSize, tickSize, market.negRisk, "NO"),
    );
  }

  activeQuote = {
    market,
    inventory,
    posted: posted.filter(Boolean),
  };

  await sleep(config.quoteTtlSeconds * 1000);
  await cancelAllAndSettle("post_ttl");

  await reconcileActiveQuote();
  activeQuote = null;

  await tryAutoMerge(market, inventory);
}

async function handleNearCloseMarket(market) {
  console.log(
    `NEAR_CLOSE minutes_left=${fmt(minutesUntilClose(market))} title=${JSON.stringify(market.title)}`,
  );
  await cancelAllAndSettle("near_close");

  const inventory = getInventory(market.id);
  await tryAutoMerge(market, inventory);
  if (!config.emergencyPairBeforeClose) return;

  const sidesToQuote = quoteSidesForInventory(inventory);
  if (sidesToQuote.length !== 1) {
    console.log(
      `NEAR_CLOSE no_unpaired_side yes=${fmt(inventory.yesQty)} no=${fmt(inventory.noQty)}`,
    );
    return;
  }

  const yesBook = await fetchBook(market.yesTokenId);
  const noBook = await fetchBook(market.noTokenId);
  const tickSize = String(market.tickSize || (await getTickSize(market.yesTokenId)));
  const tick = Number(tickSize);
  const minShares = Math.max(config.minQuoteShares, Number(market.orderMinSize || 0));
  const missingSide = sidesToQuote[0];
  const pairedGap = Math.abs(inventory.yesQty - inventory.noQty);
  const shares = floorToTick(Math.min(pairedGap, config.maxSideShares), 0.000001);
  if (shares < minShares) {
    console.log(`NEAR_CLOSE skip_small_gap gap=${fmt(pairedGap)} min=${fmt(minShares)}`);
    return;
  }

  if (missingSide === "YES") {
    const maxYesPrice = floorToTick(config.emergencyMaxPairCost - avgCost(inventory, "NO"), tick);
    const ask = yesBook.bestAsk?.price ?? Number.POSITIVE_INFINITY;
    if (ask - maxYesPrice > EPSILON) {
      console.log(
        `NEAR_CLOSE skip_emergency_yes ask=${fmt(ask)} max=${fmt(maxYesPrice)} no_avg=${fmt(avgCost(inventory, "NO"))}`,
      );
      return;
    }
    console.log(`NEAR_CLOSE emergency_buy YES price=${fmt(ask)} shares=${fmt(shares)}`);
    const posted = await postOrder(market.yesTokenId, ask, shares, tickSize, market.negRisk, "YES", OrderType.FOK);
    if (posted) {
      activeQuote = { market, inventory, posted: [posted] };
      await reconcileActiveQuote();
      activeQuote = null;
      await tryAutoMerge(market, inventory);
    }
  } else {
    const maxNoPrice = floorToTick(config.emergencyMaxPairCost - avgCost(inventory, "YES"), tick);
    const ask = noBook.bestAsk?.price ?? Number.POSITIVE_INFINITY;
    if (ask - maxNoPrice > EPSILON) {
      console.log(
        `NEAR_CLOSE skip_emergency_no ask=${fmt(ask)} max=${fmt(maxNoPrice)} yes_avg=${fmt(avgCost(inventory, "YES"))}`,
      );
      return;
    }
    console.log(`NEAR_CLOSE emergency_buy NO price=${fmt(ask)} shares=${fmt(shares)}`);
    const posted = await postOrder(market.noTokenId, ask, shares, tickSize, market.negRisk, "NO", OrderType.FOK);
    if (posted) {
      activeQuote = { market, inventory, posted: [posted] };
      await reconcileActiveQuote();
      activeQuote = null;
      await tryAutoMerge(market, inventory);
    }
  }
}

async function postOrder(tokenId, price, size, tickSize, negRisk, outcome, orderType = OrderType.GTC) {
  try {
    const response = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      {
        tickSize: String(tickSize),
        negRisk,
      },
      orderType,
    );
    const orderId = response.orderID || response.id;
    const status = response.status || "unknown";
    console.log(`ORDER outcome=${outcome} id=${orderId || "unknown"} status=${status}`);
    if (!orderId) {
      console.log(`ORDER_RESPONSE outcome=${outcome} ${JSON.stringify(response)}`);
      return null;
    }
    return {
      id: orderId,
      outcome,
      price,
    };
  } catch (error) {
    console.error(`order_error outcome=${outcome}`, error?.message || error);
    return null;
  }
}

async function reconcileOrder(market, posted, inventory) {
  if (!posted.id) return;
  const order = await safeCall("getOrder", () => client.getOrder(posted.id));
  if (config.debugReconcile && order) {
    console.log(`ORDER_DEBUG id=${posted.id} ${JSON.stringify(order)}`);
  }
  const matched = matchedSizeFromOrder(order);
  if (!Number.isFinite(matched) || matched <= ZERO) return;

  const cost = matched * posted.price;
  if (posted.outcome === "YES") {
    inventory.yesQty += matched;
    inventory.yesCost += cost;
  } else {
    inventory.noQty += matched;
    inventory.noCost += cost;
  }
  appendLedger({
    event: "FILL",
    market_id: market.id,
    title: market.title,
    side: posted.outcome,
    price: posted.price,
    shares: matched,
    cash_delta: -cost,
    pnl: 0,
    yes_qty: inventory.yesQty,
    no_qty: inventory.noQty,
    paired_avg_cost: pairedAvgCost(inventory),
    note: `order=${posted.id}`,
  });
  console.log(`FILL side=${posted.outcome} price=${fmt(posted.price)} shares=${fmt(matched)}`);
  sawFillThisRun = true;
}

async function tryAutoMerge(market, inventory) {
  const paired = Math.min(inventory.yesQty, inventory.noQty);
  if (paired < config.minMergeShares) return;

  const avgCost = pairedAvgCost(inventory);
  const profitPerPair = ONE - avgCost;
  if (profitPerPair < config.minMergeProfit) return;

  if (!config.autoMerge) {
    console.log(`MERGE_READY shares=${fmt(paired)} avg_cost=${fmt(avgCost)} auto_merge=false`);
    return;
  }

  console.log(`MERGE_SEND shares=${fmt(paired)} avg_cost=${fmt(avgCost)} title=${JSON.stringify(market.title)}`);
  let txHash;
  try {
    txHash = await mergePositions(market.conditionId, paired);
  } catch (error) {
    const message = error?.message || String(error);
    appendLedger({
      event: "MERGE_FAILED",
      market_id: market.id,
      title: market.title,
      side: "PAIR",
      price: avgCost,
      shares: paired,
      cash_delta: 0,
      pnl: 0,
      yes_qty: inventory.yesQty,
      no_qty: inventory.noQty,
      paired_avg_cost: avgCost,
      note: message.slice(0, 500),
    });
    console.error(`MERGE_FAILED shares=${fmt(paired)} avg_cost=${fmt(avgCost)} error=${message}`);
    return;
  }
  const yesAvg = inventory.yesCost / inventory.yesQty;
  const noAvg = inventory.noCost / inventory.noQty;
  const removedCost = (yesAvg + noAvg) * paired;
  const pnl = paired - removedCost;

  inventory.yesQty -= paired;
  inventory.noQty -= paired;
  inventory.yesCost -= yesAvg * paired;
  inventory.noCost -= noAvg * paired;
  cleanInventory(inventory);

  appendLedger({
    event: "MERGE",
    market_id: market.id,
    title: market.title,
    side: "PAIR",
    price: avgCost,
    shares: paired,
    cash_delta: paired,
    pnl,
    yes_qty: inventory.yesQty,
    no_qty: inventory.noQty,
    paired_avg_cost: pairedAvgCost(inventory),
    note: `tx=${txHash}`,
  });
  console.log(`MERGED shares=${fmt(paired)} pnl=${fmt(pnl)} tx=${txHash}`);
}

async function mergePositions(conditionId, shares) {
  const relayClient = new RelayClient(
    config.relayerUrl,
    config.chainId,
    wallet,
  );
  applyRelayerApiKeyAuth(relayClient);

  const amount = parseUnits(shares.toFixed(6), 6);
  const mergeAbi = [
    {
      type: "function",
      name: "mergePositions",
      stateMutability: "nonpayable",
      inputs: [
        { name: "collateralToken", type: "address" },
        { name: "parentCollectionId", type: "bytes32" },
        { name: "conditionId", type: "bytes32" },
        { name: "partition", type: "uint256[]" },
        { name: "amount", type: "uint256" },
      ],
      outputs: [],
    },
  ];
  const data = encodeFunctionData({
    abi: mergeAbi,
    functionName: "mergePositions",
    args: [PUSD_ADDRESS, zeroHash, conditionId, [1n, 2n], amount],
  });

  return executeRelayerWithSafeDeploy(
    relayClient,
    [{ to: CTF_ADDRESS, operation: OperationType.Call, data, value: "0" }],
    "BTC MM auto merge YES+NO",
  );
}

function applyRelayerApiKeyAuth(relayClient) {
  if (!config.relayerApiKey || !config.relayerApiKeyAddress) return;

  relayClient.sendAuthedRequest = async (method, path, body) =>
    relayClient.send(path, method, {
      headers: {
        RELAYER_API_KEY: config.relayerApiKey,
        RELAYER_API_KEY_ADDRESS: config.relayerApiKeyAddress,
      },
      data: body,
    });
}

async function executeRelayerWithSafeDeploy(relayClient, txns, metadata) {
  try {
    const response = await relayClient.execute(txns, metadata);
    const result = await response.wait();
    return result?.transactionHash || result?.hash || "submitted";
  } catch (error) {
    if (!isSafeNotDeployedError(error) || !config.autoDeploySafe) {
      throw error;
    }
    console.log("SAFE_NOT_DEPLOYED deploying safe before retry");
    const deployResponse = await relayClient.deploy();
    const deployResult = await deployResponse.wait();
    if (!deployResult) {
      throw new Error("safe deploy failed or timed out");
    }
    console.log(
      `SAFE_DEPLOYED tx=${deployResult.transactionHash || "unknown"} safe=${deployResult.proxyAddress || "unknown"}`,
    );
    const retryResponse = await relayClient.execute(txns, metadata);
    const retryResult = await retryResponse.wait();
    return retryResult?.transactionHash || retryResult?.hash || "submitted";
  }
}

function isSafeNotDeployedError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("safe not deployed");
}

async function fetchMarkets() {
  let items = [
    ...(await fetchMarketsFromEvents()),
    ...(await fetchMarketsFromPublicSearch()),
  ];
  if (!items.length) {
    const url = new URL(config.gammaMarketsUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", "200");
    const raw = await getJson(url);
    items = Array.isArray(raw) ? raw : raw.markets || [];
  }
  return dedupeMarkets(items.map(parseMarket).filter(Boolean)).slice(0, config.maxMarketsPerScan);
}

async function fetchMarketsFromEvents() {
  const url = new URL(config.gammaEventsUrl);
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume24hr");
  url.searchParams.set("ascending", "false");
  url.searchParams.set("limit", "200");
  const raw = await getJson(url);
  const events = Array.isArray(raw) ? raw : raw.events || [];
  return marketsFromEvents(events);
}

async function fetchMarketsFromPublicSearch() {
  const results = [];
  for (const query of config.marketSearchQueries) {
    const url = new URL(config.gammaPublicSearchUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit_per_type", "10");
    url.searchParams.set("events_status", "active");
    url.searchParams.set("keep_closed_markets", "0");
    const raw = await getJson(url);
    const events = Array.isArray(raw?.events) ? raw.events : [];
    results.push(...marketsFromEvents(events));
  }
  return results;
}

function marketsFromEvents(events) {
  return events
    .filter((event) => event && event.active !== false && event.closed !== true)
    .flatMap((event) =>
      (Array.isArray(event.markets) ? event.markets : []).map((market) => ({
        ...event,
        ...market,
        title: market.title || market.question || event.title || event.slug || "",
        question: market.question || market.title || event.title || "",
        endDate: market.endDate || event.endDate,
        active: market.active ?? event.active,
        closed: market.closed ?? event.closed,
        enableOrderBook: market.enableOrderBook ?? event.enableOrderBook,
      })),
    );
}

function dedupeMarkets(markets) {
  const seen = new Set();
  const deduped = [];
  for (const market of markets) {
    const key = market.conditionId || market.id || `${market.yesTokenId}:${market.noTokenId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(market);
  }
  return deduped;
}

function parseMarket(item) {
  const title = String(item.question || item.title || "");
  const slug = String(item.slug || "");
  const haystack = `${title} ${slug}`.toLowerCase();
  if (!config.keywords.some((keyword) => haystack.includes(keyword))) return null;
  if (
    config.requiredText.length &&
    !config.requiredText.some((phrase) => haystack.includes(phrase))
  ) {
    return null;
  }

  const outcomes = parseJsonList(item.outcomes);
  const tokenIds = parseJsonList(item.clobTokenIds);
  if (outcomes.length !== 2 || tokenIds.length !== 2) return null;

  const yesIndex = outcomes.findIndex((item) =>
    ["yes", "up"].includes(String(item).toLowerCase()),
  );
  const noIndex = outcomes.findIndex((item) =>
    ["no", "down"].includes(String(item).toLowerCase()),
  );
  if (yesIndex < 0 || noIndex < 0) return null;

  const conditionId = String(item.conditionId || item.condition_id || "");
  if (!conditionId) return null;
  const endDate = String(item.endDate || item.endDateIso || "");
  if (isExpiredEndDate(endDate)) return null;
  if (item.active === false || item.closed === true) return null;
  if (item.acceptingOrders === false) return null;
  if (item.enableOrderBook === false) return null;

  return {
    id: String(item.id || conditionId),
    symbol: marketSymbol(title, slug),
    title,
    slug,
    conditionId,
    yesTokenId: String(tokenIds[yesIndex]),
    noTokenId: String(tokenIds[noIndex]),
    endDate,
    orderMinSize: Number(item.orderMinSize || 5),
    tickSize: Number(item.orderPriceMinTickSize || 0.01),
    negRisk: Boolean(item.negRisk),
  };
}

function marketSymbol(title, slug) {
  const haystack = `${title} ${slug}`.toLowerCase();
  if (haystack.includes("bitcoin") || haystack.includes("btc")) return "BTC";
  if (haystack.includes("ethereum") || haystack.includes("eth")) return "ETH";
  if (haystack.includes("solana") || haystack.includes("sol")) return "SOL";
  if (haystack.includes("xrp")) return "XRP";
  return "CRYPTO";
}

async function fetchBook(tokenId) {
  const url = new URL(config.clobBookUrl);
  url.searchParams.set("token_id", tokenId);
  const book = await getJson(url);
  return {
    bestBid: bestSide(book.bids, false),
    bestAsk: bestSide(book.asks, true),
  };
}

function bestSide(orders, findMin) {
  if (!Array.isArray(orders)) return null;
  const parsed = orders
    .map((order) => ({ price: Number(order.price), size: Number(order.size) }))
    .filter((order) => order.price > ZERO && order.size > ZERO);
  if (!parsed.length) return null;
  parsed.sort((a, b) => (findMin ? a.price - b.price : b.price - a.price));
  return parsed[0];
}

async function getTickSize(tokenId) {
  try {
    const tick = await client.getTickSize(tokenId);
    return String(tick);
  } catch {
    return "0.01";
  }
}

function buildBid(book, tick) {
  const raw = book.bestBid.price + tick;
  const belowAsk = book.bestAsk.price - tick;
  return floorToTick(Math.max(0, Math.min(raw, belowAsk)), tick);
}

function sizeForUsd(usd, price) {
  return floorToTick(usd / price, 0.000001);
}

function pairedAvgCost(inventory) {
  if (inventory.yesQty <= ZERO || inventory.noQty <= ZERO) return ZERO;
  return inventory.yesCost / inventory.yesQty + inventory.noCost / inventory.noQty;
}

function avgCost(inventory, side) {
  if (side === "YES") {
    return inventory.yesQty <= ZERO ? ZERO : inventory.yesCost / inventory.yesQty;
  }
  return inventory.noQty <= ZERO ? ZERO : inventory.noCost / inventory.noQty;
}

function inventoryAwarePairCost(inventory, sidesToQuote, yesBid, noBid) {
  if (sidesToQuote.length === 1 && sidesToQuote[0] === "NO") {
    return avgCost(inventory, "YES") + noBid;
  }
  if (sidesToQuote.length === 1 && sidesToQuote[0] === "YES") {
    return yesBid + avgCost(inventory, "NO");
  }
  return yesBid + noBid;
}

function cleanInventory(inventory) {
  if (Math.abs(inventory.yesQty) < 0.000001) {
    inventory.yesQty = ZERO;
    inventory.yesCost = ZERO;
  }
  if (Math.abs(inventory.noQty) < 0.000001) {
    inventory.noQty = ZERO;
    inventory.noCost = ZERO;
  }
}

function getInventory(marketId) {
  if (!inventories.has(marketId)) {
    inventories.set(marketId, {
      yesQty: ZERO,
      yesCost: ZERO,
      noQty: ZERO,
      noCost: ZERO,
      get totalCost() {
        return this.yesCost + this.noCost;
      },
    });
  }
  return inventories.get(marketId);
}

function isInventoryActive(inventory) {
  return inventory.yesQty > ZERO || inventory.noQty > ZERO;
}

function globalExposureUsd() {
  let total = ZERO;
  for (const inventory of inventories.values()) {
    total += inventory.totalCost;
  }
  return total;
}

function activeInventoryMarketCount() {
  let count = 0;
  for (const inventory of inventories.values()) {
    if (isInventoryActive(inventory)) count += 1;
  }
  return count;
}

function quoteSidesForInventory(inventory) {
  const sides = [];
  if (inventory.yesQty < config.maxSideShares) sides.push("YES");
  if (inventory.noQty < config.maxSideShares) sides.push("NO");
  if (inventory.yesQty + inventory.noQty >= config.maxTotalShares) return [];

  const imbalance = config.minMergeShares;
  if (inventory.yesQty - inventory.noQty >= imbalance) {
    return sides.includes("NO") ? ["NO"] : [];
  }
  if (inventory.noQty - inventory.yesQty >= imbalance) {
    return sides.includes("YES") ? ["YES"] : [];
  }
  return sides;
}

function boundedQuoteSize(inventory, side, price, minShares) {
  const currentSideQty = side === "YES" ? inventory.yesQty : inventory.noQty;
  const sideRemaining = config.maxSideShares - currentSideQty;
  const totalRemaining = config.maxTotalShares - inventory.yesQty - inventory.noQty;
  const allowedShares = Math.min(sideRemaining, totalRemaining);
  if (allowedShares < minShares) return ZERO;
  return Math.min(Math.max(sizeForUsd(config.quoteUsd, price), minShares), allowedShares);
}

function loadInventoryFromLedger() {
  if (!fs.existsSync(ledgerPath)) return;
  const rows = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
  if (rows.length < 2) return;
  const headers = parseCsvLine(rows[0]);
  const index = Object.fromEntries(headers.map((header, idx) => [header, idx]));
  for (const line of rows.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    const marketId = cols[index.market_id];
    if (!marketId) continue;
    const inventory = getInventory(marketId);
    const event = cols[index.event];
    const side = cols[index.side];
    const shares = Number(cols[index.shares] || 0);
    const price = Number(cols[index.price] || 0);
    if (!Number.isFinite(shares) || shares <= ZERO) continue;

    if (event === "FILL" && side === "YES") {
      inventory.yesQty += shares;
      inventory.yesCost += shares * price;
    } else if (event === "FILL" && side === "NO") {
      inventory.noQty += shares;
      inventory.noCost += shares * price;
    } else if (event === "MERGE") {
      removePairFromInventory(inventory, shares);
    }
  }
  for (const [marketId, inventory] of inventories) {
    console.log(
      `LEDGER_INVENTORY market=${marketId} yes=${fmt(inventory.yesQty)} no=${fmt(inventory.noQty)} paired_cost=${fmt(pairedAvgCost(inventory))}`,
    );
  }
}

function removePairFromInventory(inventory, shares) {
  if (inventory.yesQty <= ZERO || inventory.noQty <= ZERO) return;
  const qty = Math.min(shares, inventory.yesQty, inventory.noQty);
  const yesAvg = inventory.yesCost / inventory.yesQty;
  const noAvg = inventory.noCost / inventory.noQty;
  inventory.yesQty -= qty;
  inventory.noQty -= qty;
  inventory.yesCost -= yesAvg * qty;
  inventory.noCost -= noAvg * qty;
  cleanInventory(inventory);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const char = line[idx];
    if (char === '"' && quoted && line[idx + 1] === '"') {
      current += '"';
      idx += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function appendLedger(row) {
  const fields = [
    "ts",
    "event",
    "market_id",
    "title",
    "side",
    "price",
    "shares",
    "cash_delta",
    "pnl",
    "yes_qty",
    "no_qty",
    "paired_avg_cost",
    "note",
  ];
  const exists = fs.existsSync(ledgerPath);
  const output = {
    ts: Math.floor(Date.now() / 1000),
    ...row,
  };
  if (!exists) fs.writeFileSync(ledgerPath, `${fields.join(",")}\n`);
  fs.appendFileSync(
    ledgerPath,
    `${fields.map((field) => csv(output[field] ?? "")).join(",")}\n`,
  );
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "btc-mm-live/0.1" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function safeCall(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${label}_error`, error?.message || error);
    return null;
  }
}

function signatureTypeValue(value) {
  if (value === 3) return SignatureTypeV2.POLY_1271;
  return value;
}

function assertLiveArmed() {
  if (config.liveArmed !== "I_UNDERSTAND_SMALL_LIVE") {
    throw new Error(
      "LIVE_ARMED must be I_UNDERSTAND_SMALL_LIVE in .env.live before this bot can send real orders.",
    );
  }
}

function loadEnv(path, override) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (override || !process.env[key.trim()]) {
      process.env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function bool(name, fallback) {
  const raw = env(name, String(fallback));
  return ["1", "true", "yes", "y", "on"].includes(raw.toLowerCase());
}

function num(name, fallback) {
  const value = Number(env(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function floorToTick(value, tick) {
  return Math.floor(value / tick) * tick;
}

function fmt(value) {
  return Number(value || 0).toFixed(4);
}

function csv(value) {
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replaceAll('"', '""')}"`;
  return raw;
}

function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isNearClose(market) {
  const minutes = minutesUntilClose(market);
  return Number.isFinite(minutes) && minutes <= config.exitBeforeCloseMinutes;
}

function minutesUntilClose(market) {
  if (!market.endDate) return Number.POSITIVE_INFINITY;
  return (Date.parse(market.endDate) - Date.now()) / 60000;
}

function isExpiredEndDate(endDate) {
  if (!endDate) return false;
  const timestamp = Date.parse(endDate);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp <= Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, canceling open orders before exit`);
  await cleanStop(signal);
  process.exit(0);
}

async function cleanStop(reason) {
  console.log(`${reason}: canceling open orders`);
  if (client) await cancelAllAndSettle(reason);
  await reconcileActiveQuote();
}

async function cancelAllAndSettle(reason) {
  console.log(`CANCEL_ALL reason=${reason}`);
  await safeCall("cancelAll", () => client.cancelAll());
  if (config.cancelSettleMs > 0) await sleep(config.cancelSettleMs);
}

async function reconcileActiveQuote() {
  if (!activeQuote) return;
  for (const order of activeQuote.posted) {
    await reconcileOrder(activeQuote.market, order, activeQuote.inventory);
  }
}

function shouldStopAfterCycle() {
  if (config.stopAfterFill && sawFillThisRun) {
    console.log("STOP_AFTER_FILL triggered");
    return true;
  }
  if (config.maxQuoteCycles > 0 && quoteCycles >= config.maxQuoteCycles) {
    console.log(`MAX_QUOTE_CYCLES reached cycles=${quoteCycles}`);
    return true;
  }
  return false;
}

function matchedSizeFromOrder(order) {
  if (!order) return ZERO;
  const candidates = [
    order.size_matched,
    order.sizeMatched,
    order.matched_size,
    order.matchedSize,
    order.filled_size,
    order.filledSize,
    order.executed_size,
    order.executedSize,
    order.takerAmountFilled,
    order.makerAmountFilled,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > ZERO) return parsed;
  }
  return ZERO;
}
