import type { CompanionPermissionMode } from '../../core/companion/CompanionApi';
import type { ProviderExecutionTransitionScope } from '../../core/execution';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../core/providers/ProviderSettingsCoordinator';
import type { ProviderCliResolutionContext, ProviderId } from '../../core/providers/types';
import type { ClaudianSettings } from '../../core/types';
import type { EnvironmentScope } from '../../core/types/settings';

function buildCompanionSettings(
  source: ClaudianSettings,
  providerId: ProviderId,
  companionMode: CompanionPermissionMode,
): ClaudianSettings {
  const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
    source,
    providerId,
  );
  const permissionMode = companionMode === 'read-only' && providerId === 'claude'
    ? 'plan'
    : 'normal';
  const providerConfig = {
    ...(settings.providerConfigs[providerId] ?? {}),
    ...(providerId === 'codex'
      ? { safeMode: companionMode === 'read-only' ? 'read-only' : 'workspace-write' }
      : { safeMode: 'acceptEdits' }),
  };

  return {
    ...settings,
    settingsProvider: providerId,
    permissionMode,
    providerConfigs: {
      ...settings.providerConfigs,
      [providerId]: providerConfig,
    },
    savedProviderPermissionMode: {
      ...settings.savedProviderPermissionMode,
      [providerId]: permissionMode,
    },
  };
}

export class CompanionProviderHost implements ProviderHost {
  readonly settings: ClaudianSettings;

  constructor(
    private readonly source: ProviderHost,
    providerId: ProviderId,
    companionMode: CompanionPermissionMode,
  ) {
    this.settings = buildCompanionSettings(source.settings, providerId, companionMode);
  }

  get app() {
    return this.source.app;
  }

  get storage() {
    return this.source.storage;
  }

  get executionLifecycleRegistry() {
    return this.source.executionLifecycleRegistry;
  }

  get manifest() {
    return this.source.manifest;
  }

  async saveSettings(): Promise<void> {}

  async mutateSettings(
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
  ): Promise<void> {
    await mutation(this.settings);
  }

  async mutateSettingsConditionally(
    mutation: (settings: ClaudianSettings) => boolean | Promise<boolean>,
  ): Promise<void> {
    await mutation(this.settings);
  }

  loadData(): Promise<unknown> {
    return this.source.loadData();
  }

  saveData(data: unknown): Promise<void> {
    return this.source.saveData(data);
  }

  normalizeModelVariantSettings(): boolean {
    return false;
  }

  getActiveEnvironmentVariables(providerId: ProviderId): string {
    return this.source.getActiveEnvironmentVariables(providerId);
  }

  getEnvironmentVariablesForScope(scope: EnvironmentScope): string {
    return this.source.getEnvironmentVariablesForScope(scope);
  }

  async applyEnvironmentVariables(
    _scope: EnvironmentScope,
    _envText: string,
  ): Promise<void> {}

  async applyEnvironmentVariablesBatch(
    _updates: Array<{ scope: EnvironmentScope; envText: string }>,
  ): Promise<void> {}

  async applyProviderRuntimeSettings(
    _providerIds: ProviderId[],
    mutation: (settings: ClaudianSettings) => void | Promise<void>,
    onApplied?: () => void | Promise<void>,
  ): Promise<void> {
    await mutation(this.settings);
    await onApplied?.();
  }

  async getResolvedProviderCliPath(
    providerId: ProviderId,
    context?: ProviderCliResolutionContext,
  ): Promise<string | null> {
    return await this.source.getResolvedProviderCliPath(providerId, context);
  }

  runProviderExecutionTransition<T>(
    providerIds: ProviderId[],
    mutation: (scope: ProviderExecutionTransitionScope) => Promise<T>,
    parentScope?: ProviderExecutionTransitionScope,
  ): Promise<T> {
    return this.source.runProviderExecutionTransition(
      providerIds,
      mutation,
      parentScope,
    );
  }

  notifyProviderChatOptionsChanged(providerId: ProviderId): void {
    this.source.notifyProviderChatOptionsChanged(providerId);
  }
}
