import { FastifyInstance } from "fastify";
import { config } from "../config";

// MVP: return static validator info from env / hardcoded config
const VALIDATORS = [
  {
    address: process.env.VALIDATOR_ADDRESS || "initvaloper1...",
    moniker: process.env.VALIDATOR_MONIKER || "INITx Validator",
    commission: "0.05",
    status: "BOND_STATUS_BONDED",
  },
];

export async function validatorsRoutes(app: FastifyInstance) {
  app.get("/validators", async () => ({ validators: VALIDATORS }));
}
