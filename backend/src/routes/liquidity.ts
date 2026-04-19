import { FastifyInstance } from "fastify";
import { queryContract } from "../chain";
import { config } from "../config";

export async function liquidityRoutes(app: FastifyInstance) {
  // GET /api/liquidity - pool state
  app.get("/api/liquidity", async () => {
    const pool = await queryContract(config.lpPoolAddress, { pool_state: {} });
    return pool;
  });

  // GET /api/liquidity/:address - user LP balance
  app.get<{ Params: { address: string } }>("/api/liquidity/:address", async (req) => {
    const { address } = req.params;
    const balance = await queryContract(config.lpPoolAddress, {
      lp_balance: { address },
    });
    return balance;
  });
}
