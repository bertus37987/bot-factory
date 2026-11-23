import type { HubConfig, RouteTarget } from "@bot-factory/shared";
import type { ResolvedRoute } from "./types";

export class ModelRouter {
  constructor(private readonly config: HubConfig) {}

  public resolveIntent(
    intent: string,
    opts?: {
      projectOverrides?: Record<string, RouteTarget>;
      explicitOverride?: RouteTarget;
      excludeProvider?: string;
    },
  ): ResolvedRoute {
    const candidate =
      (this.config.routing.allowPerTaskOverride ? opts?.explicitOverride : undefined) ??
      (this.config.routing.allowPerProjectOverride ? opts?.projectOverrides?.[intent] : undefined) ??
      this.config.routing.defaultsByIntent[intent] ??
      this.config.routing.defaultsByIntent.coding_parallel ??
      this.firstAvailableTarget();

    if (opts?.excludeProvider && candidate.provider === opts.excludeProvider && this.config.routing.crossFamilyVerification) {
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
    const modelEntry = providerCfg.models[target.model];
    if (!modelEntry) {
      throw new Error(`Unknown model '${target.model}' for provider '${target.provider}'`);
    }
    return {
      provider: target.provider,
      model: target.model,
      runtimeKind: providerCfg.runtime,
      resolvedModelId: modelEntry.id,
    };
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
    return null;
  }

  private firstAvailableTarget(): RouteTarget {
    const [providerName, providerCfg] = Object.entries(this.config.providers)[0] ?? [];
    if (!providerName || !providerCfg) {
      throw new Error("No providers configured in hub config");
    }
    const firstModel = Object.keys(providerCfg.models)[0];
    if (!firstModel) throw new Error(`Provider '${providerName}' has no models configured`);
    return { provider: providerName, model: firstModel };
  }
}
