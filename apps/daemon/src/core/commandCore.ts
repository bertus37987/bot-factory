import type { SubscriptionTopic } from "@bot-factory/shared";
import type { OutboxEffectRow, StateDatabase } from "../db/database";

export interface DecidedAction<TResult = unknown> {
  result: TResult;
  events: Array<{ topic: SubscriptionTopic; eventType: string; payload: unknown }>;
  effects: Array<{ effectType: string; payload: Record<string, unknown> }>;
  applyProjections: () => void;
}

export type EffectHandler = (effect: OutboxEffectRow) => Promise<void>;
export type EffectLane = "control" | "interactive" | "work";
export interface RegisterEffectOptions {
  lane?: EffectLane;
  concurrencyKey?: (eff: OutboxEffectRow) => string | null;
}
export type PostCommitListener = (topic: SubscriptionTopic, eventType: string, payload: unknown, seq: number) => void;

interface RegisteredHandler {
  handler: EffectHandler;
  lane: EffectLane;
  concurrencyKey?: (eff: OutboxEffectRow) => string | null;
}

export class CommandCore {
  private readonly handlers = new Map<string, RegisteredHandler>();
  private readonly listeners = new Set<PostCommitListener>();
  private readonly inFlightIds = new Set<string>();
  private readonly activeConcurrencyKeys = new Set<string>();
  private readonly activePromises = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private workInFlightCount = 0;
  private completedSinceBoot = 0;
  private stopped = false;

  constructor(
    private readonly db: StateDatabase,
    private readonly maxConcurrentWork = 8,
  ) {}

  public onPostCommit(listener: PostCommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getCommandReceipt<TResult = unknown>(commandId: string): TResult | null {
    return this.db.getCommandReceipt(commandId) as TResult | null;
  }

  public registerEffectHandler(effectType: string, handler: EffectHandler, options?: RegisterEffectOptions): void {
    this.handlers.set(effectType, {
      handler,
      lane: options?.lane ?? "work",
      concurrencyKey: options?.concurrencyKey,
    });
  }

  public commitCommand<TResult>(commandId: string, commandType: string, decide: () => DecidedAction<TResult>): TResult {
    const existing = this.db.getCommandReceipt(commandId);
    if (existing !== null) {
      return existing as TResult;
    }

    const committedEvents: Array<{ topic: SubscriptionTopic; eventType: string; payload: unknown; seq: number }> = [];
    const enqueuedEffects: Array<{ id: string; effectType: string; payload: Record<string, unknown>; createdAt: number }> =
      [];

    const result = this.db.runAtomicWrite(() => {
      const action = decide();
      action.applyProjections();

      for (const evt of action.events) {
        const { seq } = this.db.appendEvent(evt.topic, evt.eventType, evt.payload);
        committedEvents.push({ ...evt, seq });
      }
      for (const eff of action.effects) {
        const id = this.db.enqueueOutboxEffect(eff.effectType, eff.payload);
        enqueuedEffects.push({ id, effectType: eff.effectType, payload: eff.payload, createdAt: Date.now() });
      }

      this.db.saveCommandReceipt(commandId, commandType, action.result);
      return action.result;
    });

    for (const evt of committedEvents) {
      for (const listener of this.listeners) {
        try {
          listener(evt.topic, evt.eventType, evt.payload, evt.seq);
        } catch {
          // Never break post-commit fan-out
        }
      }
    }

    // Immediate out-of-band dispatch for control-lane effects (e.g. bot.abort, permission.respond)
    for (const eff of enqueuedEffects) {
      const reg = this.handlers.get(eff.effectType);
      if (reg?.lane === "control") {
        this.tryDispatchImmediateControl(eff, reg);
      }
    }

    this.dispatchReadyEffects();
    return result;
  }

  public emitDirectEvent(topic: SubscriptionTopic, eventType: string, payload: unknown): number {
    const { seq } = this.db.runAtomicWrite(() => this.db.appendEvent(topic, eventType, payload));
    for (const listener of this.listeners) {
      try {
        listener(topic, eventType, payload, seq);
      } catch {
        // ignore
      }
    }
    return seq;
  }

  public startOutboxWorker(intervalMs = 250): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.dispatchReadyEffects();
    }, intervalMs);
  }

  public stopOutboxWorker(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async drainOutboxOnce(): Promise<number> {
    if (this.stopped || this.db.isClosed()) return 0;
    const startCompleted = this.completedSinceBoot;
    while (!this.stopped && !this.db.isClosed()) {
      const launched = this.dispatchReadyEffects();
      if (this.activePromises.size === 0) {
        if (launched === 0) break;
        continue;
      }
      await Promise.allSettled([...this.activePromises]);
    }
    return this.completedSinceBoot - startCompleted;
  }

  private resolveConcurrencyKey(reg: RegisteredHandler, eff: OutboxEffectRow): string | null {
    if (!reg.concurrencyKey) return null;
    const key = reg.concurrencyKey(eff);
    return key ? key : null;
  }

  private tryDispatchImmediateControl(
    enqueued: { id: string; effectType: string; payload: Record<string, unknown>; createdAt: number },
    reg: RegisteredHandler,
  ): void {
    if (this.stopped || this.db.isClosed() || this.inFlightIds.has(enqueued.id)) return;
    const preview: OutboxEffectRow = {
      id: enqueued.id,
      effectType: enqueued.effectType,
      payload: enqueued.payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: enqueued.createdAt,
      epoch: this.db.epoch,
      lastError: null,
      createdAt: enqueued.createdAt,
    };
    const key = this.resolveConcurrencyKey(reg, preview);
    if (key !== null && this.activeConcurrencyKeys.has(key)) {
      return;
    }
    const claimed = this.db.claimOutboxEffectById(enqueued.id);
    if (!claimed) return;
    this.launchClaimedEffect(claimed, reg, key);
  }

  private dispatchReadyEffects(): number {
    if (this.stopped || this.db.isClosed()) return 0;
    const scanLimit = Math.max(64, this.maxConcurrentWork * 8);
    const pending = this.db.listPendingOutboxEffects(scanLimit);
    let launched = 0;

    for (const candidate of pending) {
      if (this.stopped || this.db.isClosed()) break;
      if (this.inFlightIds.has(candidate.id)) continue;

      const reg = this.handlers.get(candidate.effectType);
      if (!reg) {
        const claimed = this.db.claimOutboxEffectById(candidate.id);
        if (claimed) {
          this.db.settleOutboxEffect(claimed.id, "dead_letter", `No handler for effect ${claimed.effectType}`);
        }
        continue;
      }

      if (reg.lane === "work" && this.workInFlightCount >= this.maxConcurrentWork) {
        continue;
      }

      const key = this.resolveConcurrencyKey(reg, candidate);
      if (key !== null && this.activeConcurrencyKeys.has(key)) {
        continue;
      }

      const claimed = this.db.claimOutboxEffectById(candidate.id);
      if (!claimed) continue;

      this.launchClaimedEffect(claimed, reg, key);
      launched += 1;
    }

    return launched;
  }

  private launchClaimedEffect(eff: OutboxEffectRow, reg: RegisteredHandler, concurrencyKey: string | null): void {
    this.inFlightIds.add(eff.id);
    if (concurrencyKey !== null) {
      this.activeConcurrencyKeys.add(concurrencyKey);
    }
    if (reg.lane === "work") {
      this.workInFlightCount += 1;
    }

    const promise = this.executeClaimedEffect(eff, reg, concurrencyKey).finally(() => {
      this.inFlightIds.delete(eff.id);
      if (concurrencyKey !== null) {
        this.activeConcurrencyKeys.delete(concurrencyKey);
      }
      if (reg.lane === "work") {
        this.workInFlightCount = Math.max(0, this.workInFlightCount - 1);
      }
      this.activePromises.delete(promise);
      if (!this.stopped && !this.db.isClosed()) {
        queueMicrotask(() => {
          this.dispatchReadyEffects();
        });
      }
    });

    this.activePromises.add(promise);
  }

  private async executeClaimedEffect(
    eff: OutboxEffectRow,
    reg: RegisteredHandler,
    _concurrencyKey: string | null,
  ): Promise<void> {
    try {
      await reg.handler(eff);
      if (!this.stopped && !this.db.isClosed()) {
        try {
          this.db.settleOutboxEffect(eff.id, "done");
          this.completedSinceBoot += 1;
        } catch {
          // Teardown / quarantine race
        }
      }
    } catch (err) {
      if (this.stopped || this.db.isClosed()) return;
      const msg = err instanceof Error ? err.message : String(err);
      try {
        if (eff.attempts >= 3) {
          this.db.settleOutboxEffect(eff.id, "dead_letter", msg);
        } else {
          const backoffMs = Math.min(30_000, 1000 * 2 ** eff.attempts);
          this.db.settleOutboxEffect(eff.id, "pending", msg, Date.now() + backoffMs);
        }
      } catch {
        // Teardown / quarantine race
      }
    }
  }
}
