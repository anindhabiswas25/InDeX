/**
 * Event Listener — Tendermint WebSocket subscription for real-time on-chain events.
 * Connects to Initia RPC WebSocket, subscribes to contract events, parses and
 * publishes them to the event bus + persists to MongoDB.
 */
import WebSocket from "ws";
import { config } from "../config";
import { eventBus, EventType } from "./eventBus";
import { events as eventsCollection, getState, setState } from "../mongo";

let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let isRunning = false;

const CONTRACT_ADDRESSES = new Set([
  config.stakingAddress,
  config.initxTokenAddress,
  config.lpPoolAddress,
  config.lendingAddress,
  config.governanceAddress,
].filter(Boolean));

function log(msg: string) { console.log(`[event-listener] ${msg}`); }
function warn(msg: string) { console.warn(`[event-listener] ${msg}`); }

// Map wasm action → EventType
const ACTION_MAP: Record<string, EventType> = {
  deposit: EventType.STAKE_EXECUTED,
  request_withdrawal: EventType.UNSTAKE_EXECUTED,
  claim_withdrawal: EventType.WITHDRAWAL_READY,
  add_rewards: EventType.REWARD_UPDATED,
  borrow: EventType.BORROW_EXECUTED,
  repay: EventType.REPAY_EXECUTED,
  swap_init_for_initx: EventType.SWAP_EXECUTED,
  swap_initx_for_init: EventType.SWAP_EXECUTED,
  liquidate: EventType.LIQUIDATION_DETECTED,
};

function parseWasmEvents(result: any): void {
  try {
    const txResult = result?.data?.value?.TxResult || result?.result?.data?.value?.TxResult;
    if (!txResult) return;

    const height = parseInt(txResult.height, 10);
    const txHash = txResult.tx ? Buffer.from(txResult.tx, "base64").toString("hex").substring(0, 64) : "";

    const events = txResult.result?.events || [];
    for (const event of events) {
      if (!event.type?.startsWith("wasm")) continue;

      const attrs: Record<string, string> = {};
      for (const attr of event.attributes || []) {
        const key = attr.key ? Buffer.from(attr.key, "base64").toString() : attr.key;
        const value = attr.value ? Buffer.from(attr.value, "base64").toString() : attr.value;
        if (key && value) attrs[key] = value;
      }

      const contractAddr = attrs["_contract_address"] || attrs["contract_address"] || "";
      if (!CONTRACT_ADDRESSES.has(contractAddr)) continue;

      const action = attrs["action"] || event.type.replace("wasm-", "");

      // Persist to MongoDB
      const doc = {
        txHash: txHash + "_" + event.type + "_" + action,
        blockHeight: height,
        timestamp: Date.now(),
        contract: contractAddr,
        action,
        sender: attrs["sender"] || attrs["from"] || "",
        attributes: attrs,
      };

      eventsCollection().insertOne(doc).catch(() => {}); // ignore duplicates

      // Publish to event bus
      const eventType = ACTION_MAP[action];
      if (eventType) {
        eventBus.publish(eventType, { ...attrs, txHash, blockHeight: height, contract: contractAddr });
      }

      log(`${action} from ${contractAddr.substring(0, 15)}... height=${height}`);
    }

    // Save last processed height
    setState("lastProcessedBlock", height).catch(() => {});
  } catch (err: any) {
    warn(`Parse error: ${err.message}`);
  }
}

function connect() {
  if (ws) {
    try { ws.close(); } catch (_) {}
  }

  const wsUrl = config.wsUrl;
  log(`Connecting to ${wsUrl}`);

  ws = new WebSocket(wsUrl);

  ws.on("open", () => {
    log("Connected");

    // Subscribe to all Tx events
    const subscribeMsg = {
      jsonrpc: "2.0",
      method: "subscribe",
      id: 1,
      params: {
        query: "tm.event='Tx'",
      },
    };
    ws!.send(JSON.stringify(subscribeMsg));
    log("Subscribed to tm.event='Tx'");
  });

  ws.on("message", (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.result && msg.result.data) {
        parseWasmEvents(msg);
      }
    } catch (_) {}
  });

  ws.on("close", () => {
    warn("Connection closed, reconnecting in 5s...");
    scheduleReconnect();
  });

  ws.on("error", (err: Error) => {
    warn(`WebSocket error: ${err.message}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!isRunning) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

export function startEventListener(): void {
  if (isRunning) return;
  isRunning = true;
  connect();
}

export function stopEventListener(): void {
  isRunning = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch (_) {}
    ws = null;
  }
  log("Stopped");
}
