import { FastifyInstance } from "fastify";
import { queryContract } from "../chain";
import { config } from "../config";

export async function lendingRoutes(app: FastifyInstance) {
  app.get<{ Params: { address: string } }>("/lending/position/:address", async (req, reply) => {
    try {
      if (!config.lendingAddress) {
        return reply.code(503).send({ error: "Lending contract not configured" });
      }
      const { address } = req.params;
      const res = await queryContract(config.lendingAddress, { position: { address } });
      return res;
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
