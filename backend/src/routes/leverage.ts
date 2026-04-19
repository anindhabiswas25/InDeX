import { FastifyInstance } from "fastify";
import { LeverageEngine } from "../services/leverageEngine";

const engine = new LeverageEngine();

export async function leverageRoutes(app: FastifyInstance) {
  /**
   * POST /api/leverage/simulate
   * Body: { principal, loops, collateralFactor, stakingAPR, borrowAPR }
   */
  app.post("/api/leverage/simulate", async (request, reply) => {
    try {
      const { principal, loops, collateralFactor, stakingAPR, borrowAPR } = request.body as {
        principal: number;
        loops: number;
        collateralFactor: number;
        stakingAPR: number;
        borrowAPR: number;
      };

      if (!principal || !loops || !collateralFactor || stakingAPR === undefined || borrowAPR === undefined) {
        return reply.status(400).send({ error: "Missing required fields: principal, loops, collateralFactor, stakingAPR, borrowAPR" });
      }

      const result = engine.simulate({ principal, loops, collateralFactor, stakingAPR, borrowAPR });
      return reply.send(result);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * GET /api/leverage/optimal?stakingAPR=0.06&borrowAPR=0.04&collateralFactor=0.7
   */
  app.get("/api/leverage/optimal", async (request, reply) => {
    try {
      const query = request.query as {
        stakingAPR?: string;
        borrowAPR?: string;
        collateralFactor?: string;
      };

      const stakingAPR = parseFloat(query.stakingAPR || "0.06");
      const borrowAPR = parseFloat(query.borrowAPR || "0.04");
      const collateralFactor = parseFloat(query.collateralFactor || "0.7");

      if (isNaN(stakingAPR) || isNaN(borrowAPR) || isNaN(collateralFactor)) {
        return reply.status(400).send({ error: "Invalid numeric parameters" });
      }

      const result = engine.optimal(stakingAPR, borrowAPR, collateralFactor);
      return reply.send(result);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });
}
