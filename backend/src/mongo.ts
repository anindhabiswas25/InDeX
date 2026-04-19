/**
 * MongoDB Client — Singleton connection and collection accessors.
 * Stores: snapshots, events, liquidations, borrowers, metrics, protocol state.
 */
import { MongoClient, Db, Collection } from "mongodb";
import { config } from "./config";

let client: MongoClient | null = null;
let db: Db | null = null;

// ── Document Types ──

export interface SnapshotDoc {
  timestamp: number;
  totalStaked: string;
  totalSupply: string;
  exchangeRate: number;
  bufferBalance: string;
  treasuryBalance: string;
  apy7d: number;
  apy30d: number;
}

export interface EventDoc {
  txHash: string;
  blockHeight: number;
  timestamp: number;
  contract: string;
  action: string;
  sender: string;
  attributes: Record<string, string>;
}

export interface LiquidationDoc {
  txHash: string;
  timestamp: number;
  borrower: string;
  liquidator: string;
  debtRepaid: string;
  collateralSeized: string;
  healthFactorBefore: number;
}

export interface BorrowerDoc {
  address: string;
  collateral: string;
  debt: string;
  healthFactor: number;
  lastUpdated: number;
}

export interface MetricsDoc {
  timestamp: number;
  tvlUsd: number;
  initPriceUsd: number;
  totalStaked: string;
  totalBorrowed: string;
  totalLpLiquidity: string;
  utilizationRate: number;
  activeProposals: number;
}

export interface ProtocolStateDoc {
  key: string;
  value: any;
  updatedAt: number;
}

// ── Connection ──

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  if (!config.mongoUri) throw new Error("MONGO_URI not configured");

  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db("initx");

  // Create indexes
  await db.collection("snapshots").createIndex({ timestamp: -1 });
  await db.collection("events").createIndex({ timestamp: -1 });
  await db.collection("events").createIndex({ action: 1, timestamp: -1 });
  await db.collection("events").createIndex({ txHash: 1 }, { unique: true, sparse: true });
  await db.collection("liquidations").createIndex({ timestamp: -1 });
  await db.collection("borrowers").createIndex({ address: 1 }, { unique: true });
  await db.collection("borrowers").createIndex({ healthFactor: 1 });
  await db.collection("metrics").createIndex({ timestamp: -1 });
  await db.collection("protocol_state").createIndex({ key: 1 }, { unique: true });

  console.log("[mongo] Connected to MongoDB");
  return db;
}

export async function disconnectMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("[mongo] Disconnected");
  }
}

export function getDb(): Db {
  if (!db) throw new Error("MongoDB not connected. Call connectMongo() first.");
  return db;
}

// ── Collection Accessors ──

export function snapshots(): Collection<SnapshotDoc> {
  return getDb().collection("snapshots");
}

export function events(): Collection<EventDoc> {
  return getDb().collection("events");
}

export function liquidations(): Collection<LiquidationDoc> {
  return getDb().collection("liquidations");
}

export function borrowers(): Collection<BorrowerDoc> {
  return getDb().collection("borrowers");
}

export function metrics(): Collection<MetricsDoc> {
  return getDb().collection("metrics");
}

export function protocolState(): Collection<ProtocolStateDoc> {
  return getDb().collection("protocol_state");
}

// ── State Helpers ──

export async function getState(key: string): Promise<any> {
  const doc = await protocolState().findOne({ key });
  return doc?.value ?? null;
}

export async function setState(key: string, value: any): Promise<void> {
  await protocolState().updateOne(
    { key },
    { $set: { value, updatedAt: Date.now() } },
    { upsert: true },
  );
}
