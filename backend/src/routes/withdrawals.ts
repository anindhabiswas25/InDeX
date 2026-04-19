import { FastifyInstance } from "fastify";
import { queryContract } from "../chain";
import { config } from "../config";

export async function withdrawalsRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string } }>("/withdrawals/:address", async (req, reply) => {
    try {
      if (!config.stakingAddress) {
        return reply.code(503).send({ error: "Staking contract not configured" });
      }
      const { address } = req.params;
      const res = await queryContract(config.stakingAddress, {
        withdrawal_requests: { address },
      });
      return res;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
