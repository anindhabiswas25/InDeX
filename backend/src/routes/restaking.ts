import { FastifyInstance } from "fastify";
import { simulateRestaking, getPosition } from "../services/restakingEngine";

export async function restakingRoutes(app: FastifyInstance) {
  // POST /api/restaking/simulate — step-by-step restaking simulation
  app.post("/api/restaking/simulate", async (request, reply) => {
    try {
      const { principal, loops } = request.body as { principal: number; loops: number };
      if (!principal || !loops) {
        return reply.status(400).send({ error: "Missing required fields: principal, loops" });
      }
      const result = simulateRestaking(principal, loops);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // GET /api/restaking/position/:address — live on-chain position
  app.get<{ Params: { address: string } }>("/api/restaking/position/:address", async (req, reply) => {
    try {
      const pos = await getPosition(req.params.address);
      if (!pos) return reply.status(404).send({ error: "No position found" });
      return reply.send(pos);
    } catch (e: any) {
      return reply.status(500).send({ error: e.message });
    }
  });
}
