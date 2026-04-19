import { FastifyInstance } from "fastify";
import { assessRisk, RiskMetrics } from "../services/riskEngine";
import { liquidations as liquidationsCollection, metrics as metricsCollection, snapshots as snapshotsCollection } from "../mongo";

export async function protocolRoutes(app: FastifyInstance) {
  // GET /api/protocol-health — current risk assessment
  app.get("/api/protocol-health", async () => {
    const risk = await assessRisk();
    return risk;
  });

  // GET /api/liquidations/recent — last 50 liquidations
  app.get("/api/liquidations/recent", async () => {
    const docs = await liquidationsCollection()
      .find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .toArray();
    return { liquidations: docs };
  });

  // GET /api/metrics/history — metrics over time
  app.get<{ Querystring: { hours?: string } }>("/api/metrics/history", async (req) => {
    const hours = parseInt(req.query.hours || "24", 10);
    const since = Date.now() - hours * 60 * 60 * 1000;
    const docs = await metricsCollection()
      .find({ timestamp: { $gte: since } })
      .sort({ timestamp: 1 })
      .toArray();
    return { metrics: docs };
  });

  // GET /api/snapshots — exchange rate history
  app.get<{ Querystring: { hours?: string } }>("/api/snapshots", async (req) => {
    const hours = parseInt(req.query.hours || "24", 10);
    const since = Date.now() - hours * 60 * 60 * 1000;
    const docs = await snapshotsCollection()
      .find({ timestamp: { $gte: since } })
      .sort({ timestamp: 1 })
      .toArray();
    return { snapshots: docs };
  });

  // GET /api/lending/pool — lending pool state
  app.get("/api/lending/pool", async () => {
    const { queryContract } = await import("../chain");
    const { config } = await import("../config");
    const pool = await queryContract(config.lendingAddress, { pool_state: {} });
    return pool;
  });
}
