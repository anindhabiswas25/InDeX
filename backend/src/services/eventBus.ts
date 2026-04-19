/**
 * Event Bus — Typed in-process event emitter for inter-service communication.
 */
import { EventEmitter } from "events";

export enum EventType {
  STAKE_EXECUTED = "STAKE_EXECUTED",
  UNSTAKE_EXECUTED = "UNSTAKE_EXECUTED",
  WITHDRAWAL_READY = "WITHDRAWAL_READY",
  REWARD_UPDATED = "REWARD_UPDATED",
  LIQUIDATION_DETECTED = "LIQUIDATION_DETECTED",
  BORROW_EXECUTED = "BORROW_EXECUTED",
  REPAY_EXECUTED = "REPAY_EXECUTED",
  SWAP_EXECUTED = "SWAP_EXECUTED",
  PROTOCOL_PAUSED = "PROTOCOL_PAUSED",
  PROTOCOL_UNPAUSED = "PROTOCOL_UNPAUSED",
  RISK_ALERT = "RISK_ALERT",
}

export interface EventPayload {
  type: EventType;
  timestamp: number;
  data: Record<string, any>;
}

class TypedEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish(type: EventType, data: Record<string, any>): void {
    const payload: EventPayload = { type, timestamp: Date.now(), data };
    this.emitter.emit(type, payload);
    this.emitter.emit("*", payload); // wildcard for logging
  }

  subscribe(type: EventType, handler: (payload: EventPayload) => void): void {
    this.emitter.on(type, handler);
  }

  subscribeAll(handler: (payload: EventPayload) => void): void {
    this.emitter.on("*", handler);
  }

  unsubscribe(type: EventType, handler: (payload: EventPayload) => void): void {
    this.emitter.off(type, handler);
  }
}

// Singleton
export const eventBus = new TypedEventBus();
