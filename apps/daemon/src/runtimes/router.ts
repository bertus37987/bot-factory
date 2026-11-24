import type { HubConfig, ModelEntry, ProviderConfig, RouteTarget } from "@bot-factory/shared";
import type { ResolvedRoute } from "./types";

export class ModelRouter {
  constructor(private config: HubConfig) {}

  public setConfig(newConfig: HubConfig): void {
    this.config = newConfig;
  }

  public getConfig(): HubConfig {
    return this.config;
  }

  public resolveIntent(
    intent: string,
    opts?: {
      projectOverrides?: Record<string, RouteTarget>;
      explicitOverride?: RouteTarget;
      excludeProvider?: string;
    },
  ): ResolvedRoute {
    const projectOverride = this.config.routing.allowPerProjectOverride ? opts?.projectOverrides?.[intent] : undefined;
    const validProjectOverride =
      projectOverride && this.hasTarget(projectOverride) ? projectOverride : undefined;
    const defaultIntentTarget = this.config.routing.defaultsByIntent[intent];
    const validDefaultIntent =
      defaultIntentTarget && this.hasTarget(defaultIntentTarget) ? defaultIntentTarget : undefined;
    const parallelDefault = this.config.routing.defaultsByIntent.coding_parallel;
    const validParallelDefault =
      parallelDefault && this.hasTarget(parallelDefault) ? parallelDefault : undefined;

    const candidate =
      (this.config.routing.allowPerTaskOverride ? opts?.explicitOverride : undefined) ??
      validProjectOverride ??
      validDefaultIntent ??
      validParallelDefault ??
      this.firstAvailableTarget();

    if (
      opts?.excludeProvider &&
      candidate.provider === opts.excludeProvider &&
      this.config.routing.crossFamilyVerification
    ) {
      const alt = this.findCrossFamilyAlternative(opts.excludeProvider);
      if (alt) return alt;
    }

    return this.resolveTarget(candidate);
  }

  public resolveTarget(target: RouteTarget): ResolvedRoute {
    const providerCfg = this.config.providers[target.provider];
    if (!providerCfg) {
      throw new Error(`Unknown provider in routing config: ${target.provider}`);
    }
    const resolvedModel = this.findModelEntry(providerCfg, target.model);
    if (!resolvedModel) {
      throw new Error(`Unknown model '${target.model}' for provider '${target.provider}'`);
    }
    return {
      provider: target.provider,
      model: resolvedModel.key,
      runtimeKind: providerCfg.runtime,
      resolvedModelId: resolvedModel.entry.id,
    };
  }

  private hasTarget(target: RouteTarget): boolean {
    const providerCfg = this.config.providers[target.provider];
    if (!providerCfg) return false;
    return this.findModelEntry(providerCfg, target.model) !== null;
  }

  private findModelEntry(
    providerCfg: ProviderConfig,
    modelKeyOrId: string,
  ): { key: string; entry: ModelEntry } | null {
    const direct = providerCfg.models[modelKeyOrId];
    if (direct) return { key: modelKeyOrId, entry: direct };
    for (const [key, entry] of Object.entries(providerCfg.models)) {
      if (entry.id === modelKeyOrId) {
        return { key, entry };
      }
    }
    return null;
  }

  private findCrossFamilyAlternative(excludedProvider: string): ResolvedRoute | null {
    for (const [providerName, providerCfg] of Object.entries(this.config.providers)) {
      if (providerName === excludedProvider) continue;
      for (const [modelKey, modelCfg] of Object.entries(providerCfg.models)) {
        if (modelCfg.capabilities.includes("review") || modelCfg.tier === "flagship") {
          return {
            provider: providerName,
            model: modelKey,
            runtimeKind: providerCfg.runtime,
            resolvedModelId: modelCfg.id,
          };
        }
      }
    }
    // Open BYOS fallback: if no non-excluded provider advertises review/flagship, use any available provider/model.
    for (const [providerName, providerCfg] of Object.entries(this.config.providers)) {
      if (providerName === excludedProvider) continue;
      const firstEntry = Object.entries(providerCfg.models)[0];
      if (firstEntry) {
        const [modelKey, modelCfg] = firstEntry;
        return {
          provider: providerName,
          model: modelKey,
          runtimeKind: providerCfg.runtime,
          resolvedModelId: modelCfg.id,
        };
      }
    }
    return null;
  }

  private firstAvailableTarget(): RouteTarget {
    for (const [providerName, providerCfg] of Object.entries(this.config.providers)) {
      const firstModel = Object.keys(providerCfg.models)[0];
      if (firstModel) return { provider: providerName, model: firstModel };
    }
    throw new Error("No providers with configured models found in hub config");
  }
}
