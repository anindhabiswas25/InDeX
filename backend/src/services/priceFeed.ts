/**
 * Price Feed Service — Fetches INIT/USD price from CoinGecko.
 * Caches in memory with TTL. Stores snapshots to MongoDB metrics collection.
 */
import { config } from "../config";

function log(msg: string) { console.log(`[price-feed] ${msg}`); }
function warn(msg: string) { console.warn(`[price-feed] ${msg}`); }

let cachedPrice: { price: number; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch INIT price from CoinGecko.
 */
export async function fetchInitPrice(): Promise<number> {
  // Return cache if fresh
  if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_TTL) {
    return cachedPrice.price;
  }

  try {
    const url = `${config.coingeckoApiUrl}/simple/price?ids=${config.initCoinId}&vs_currencies=usd`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`CoinGecko ${response.status}: ${response.statusText}`);
    const data = await response.json() as Record<string, { usd: number }>;
    const price = data[config.initCoinId]?.usd || 0;

    cachedPrice = { price, timestamp: Date.now() };
    log(`INIT price: $${price.toFixed(4)}`);
    return price;
  } catch (err: any) {
    warn(`CoinGecko fetch failed: ${err.message}`);
    return cachedPrice?.price || 0;
  }
}

/**
 * Get current cached price without fetching.
 */
export function getCachedPrice(): { price: number; timestamp: number } | null {
  return cachedPrice;
}
