import { FastifyInstance } from "fastify";
import { queryContract } from "../chain";
import { config } from "../config";
import { getLatestSnapshot, calculateApy } from "../services/rewardEngine";
import { getExchangeRate } from "../services/oracleUpdater";

export async function apyRoutes(app: FastifyInstance) {
  // GET /api/apy - returns real APY from historical snapshots
  app.get("/api/apy", async () => {
    const [rate, apy7d, apy30d, latestSnapshot] = await Promise.all([
      getExchangeRate(),
      calculateApy(7),
      calculateApy(30),
      getLatestSnapshot(),
    ]);

    return {
      exchange_rate: rate,
      apy_7d: apy7d.toFixed(2) + "%",
      apy_7d_raw: apy7d,
      apy_30d: apy30d.toFixed(2) + "%",
      apy_30d_raw: apy30d,
      last_snapshot: latestSnapshot?.timestamp || null,
      total_staked: latestSnapshot?.totalStaked || "0",
      total_supply: latestSnapshot?.totalSupply || "0",
    };
  });
}
