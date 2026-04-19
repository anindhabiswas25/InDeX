import { FastifyInstance } from "fastify";
import { fetchInitPrice, getCachedPrice } from "../services/priceFeed";
import { queryContract } from "../chain";
import { config } from "../config";

export async function priceRoutes(app: FastifyInstance) {
  // GET /api/price — current INIT price in USD
  app.get("/api/price", async () => {
    const price = await fetchInitPrice();
    const cached = getCachedPrice();
    return {
      initPriceUsd: price,
      source: "coingecko",
      updatedAt: cached?.timestamp || Date.now(),
    };
  });

  // GET /api/tvl — Total Value Locked in USD
  app.get("/api/tvl", async () => {
    const [price, pool] = await Promise.all([
      fetchInitPrice(),
      queryContract<any>(config.stakingAddress, { pool_state: {} }),
    ]);
    const totalStaked = Number(pool.total_init_staked || 0);
    // Assuming 6 decimals for the native token
    const tvlUsd = (totalStaked / 1e6) * price;
    return {
      tvlUsd,
      totalStakedRaw: pool.total_init_staked,
      initPriceUsd: price,
    };
  });
}
