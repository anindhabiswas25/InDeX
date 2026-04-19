import { FastifyInstance } from "fastify";
import { queryContract } from "../chain";
import { config } from "../config";

export async function governanceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { start_after?: string; limit?: string } }>(
    "/governance/proposals",
    async (req, reply) => {
      try {
        if (!config.governanceAddress) {
          return reply.code(503).send({ error: "Governance contract not configured" });
        }
        const msg: Record<string, unknown> = {};
        if (req.query.start_after) msg.start_after = parseInt(req.query.start_after, 10);
        if (req.query.limit) msg.limit = parseInt(req.query.limit, 10);
        const res = await queryContract(config.governanceAddress, { proposals: msg });
        return res;
      } catch (err: any) {
        return reply.code(500).send({ error: err.message });
      }
    },
  );
}
