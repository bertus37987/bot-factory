import type { SubscriptionTopic } from "@bot-factory/shared";
import type { OutboxEffectRow, StateDatabase } from "../db/database";

export interface DecidedAction<TResult = unknown> {
  result: TResult;
  events: Array<{ topic: SubscriptionTopic; eventType: string; payload: unknown }>;
  effects: Array<{ effectType: string; payload: Record<string, unknown> }>;
  applyProjections: () => void;
}

export type EffectHandler = (effect: OutboxEffectRow) => Promise<void>;
export type PostCommitListener = (topic: SubscriptionTopic, eventType: string, payload: unknown, seq: number) => void;

export class CommandCore {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly listeners = new Set<PostCommitListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private drainPromise: Promise<number> | null = null;
  private pendingRescan = false;
  private stopped = false;

  constructor(private readonly db: StateDatabase) {}

  public onPostCommit(listener: PostCommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public registerEffectHandler(effectType: string, handler: EffectHandler): void {
    this.handlers.set(effectType, handler);
  }

  public commitCommand<TResult>(commandId: string, commandType: string, decide: () => DecidedAction<TResult>): TResult {
    const existing = this.db.getCommandReceipt(commandId);
    if (existing !== null) {
      return existing as TResult;
    }

    const committedEvents: Array<{ topic: SubscriptionTopic; eventType: string; payload: unknown; seq: number }> = [];

    const result = this.db.runAtomicWrite(() => {
      const action = decide();
      action.applyProjections();

      for (const evt of action.events) {
        const { seq } = this.db.appendEvent(evt.topic, evt.eventType, evt.payload);
        committedEvents.push({ ...evt, seq });
      }
      for (const eff of action.effects) {
        this.db.enqueueOutboxEffect(eff.effectType, eff.payload);
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

    void this.drainOutboxOnce();
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
      void this.drainOutboxOnce();
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
    while (this.drainPromise) {
      this.pendingRescan = true;
      await this.drainPromise;
      if (this.stopped || this.db.isClosed()) return 0;
      if (!this.pendingRescan && !this.drainPromise) return 0;
    }
    this.drainPromise = this.runDrainCycle().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async runDrainCycle(): Promise<number> {
    let totalProcessed = 0;
    do {
      this.pendingRescan = false;
      if (this.stopped || this.db.isClosed()) break;
      const effects = this.db.claimPendingEffects(5);
      for (const eff of effects) {
        if (this.stopped || this.db.isClosed()) break;
        const handler = this.handlers.get(eff.effectType);
        if (!handler) {
          this.db.settleOutboxEffect(eff.id, "dead_letter", `No handler for effect ${eff.effectType}`);
          continue;
        }
        try {
          await handler(eff);
          if (!this.stopped && !this.db.isClosed()) {
            this.db.settleOutboxEffect(eff.id, "done");
          }
          totalProcessed += 1;
        } catch (err) {
          if (this.stopped || this.db.isClosed()) break;
          const msg = err instanceof Error ? err.message : String(err);
          if (eff.attempts >= 3) {
            this.db.settleOutboxEffect(eff.id, "dead_letter", msg);
          } else {
            const backoffMs = Math.min(30_000, 1000 * 2 ** eff.attempts);
            this.db.settleOutboxEffect(eff.id, "pending", msg, Date.now() + backoffMs);
          }
        }
      }
    } while (this.pendingRescan && !this.stopped && !this.db.isClosed());
    return totalProcessed;
  }
}
