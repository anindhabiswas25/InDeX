import { FastifyInstance } from "fastify";
import { queryContract, getQueryClient } from "../chain";
import { config } from "../config";

export async function statsRoutes(app: FastifyInstance) {
  app.get("/stats", async (_req, reply) => {
    try {
      if (!config.stakingAddress) {
        return reply.code(503).send({ error: "Staking contract not configured" });
      }

      const [rateRes, contractConfig, client] = await Promise.all([
        queryContract<{ rate: string }>(config.stakingAddress, { exchange_rate: {} }),
        queryContract<any>(config.stakingAddress, { config: {} }),
        getQueryClient(),
      ]);

      const balance = await client.getBalance(config.stakingAddress, config.denom);
      const tvl = balance.amount;
      const rate = parseFloat(rateRes.rate);

      // Simple APY estimate: (rate - 1) annualized. In practice this comes from historical data.
      const apy = Math.max(0, (rate - 1) * 100);

      return {
        tvl,
        tvl_denom: config.denom,
        total_staked: tvl,
        exchange_rate: rateRes.rate,
        apy_percent: apy.toFixed(2),
      };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });

  app.get("/exchange-rate", async (_req, reply) => {
    try {
      if (!config.stakingAddress) {
        return reply.code(503).send({ error: "Staking contract not configured" });
      }
      const res = await queryContract<{ rate: string }>(config.stakingAddress, { exchange_rate: {} });
      return { rate: res.rate };
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
