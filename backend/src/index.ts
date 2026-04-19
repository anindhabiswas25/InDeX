import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config";
import { connectMongo, disconnectMongo } from "./mongo";
import { startKeeper, stopKeeper } from "./keeper";
import { healthRoutes } from "./routes/health";
import { statsRoutes } from "./routes/stats";
import { validatorsRoutes } from "./routes/validators";
import { withdrawalsRoutes } from "./routes/withdrawals";
import { lendingRoutes } from "./routes/lending";
import { governanceRoutes } from "./routes/governance";
import { apyRoutes } from "./routes/apy";
import { liquidityRoutes } from "./routes/liquidity";
import { leverageRoutes } from "./routes/leverage";
import { priceRoutes } from "./routes/price";
import { restakingRoutes } from "./routes/restaking";
import { protocolRoutes } from "./routes/protocol";

async function main() {
  const app = Fastify({ logger: true });

  // CORS
  await app.register(cors, { origin: true });

  // Rate limiting — 200 req/min per IP
  await app.register(rateLimit, {
    max: 200,
    timeWindow: "1 minute",
  });

  // Connect MongoDB
  await connectMongo();

  // Register routes
  await app.register(healthRoutes);
  await app.register(statsRoutes);
  await app.register(validatorsRoutes);
  await app.register(withdrawalsRoutes);
  await app.register(lendingRoutes);
  await app.register(governanceRoutes);
  await app.register(apyRoutes);
  await app.register(liquidityRoutes);
  await app.register(leverageRoutes);
  await app.register(priceRoutes);
  await app.register(restakingRoutes);
  await app.register(protocolRoutes);

  // Start server
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Server listening on port ${config.port}`);

  // Start keeper bot + all services
  startKeeper();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down...");
    stopKeeper();
    await disconnectMongo();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", () => {}); // ignore hangup so nohup works
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
