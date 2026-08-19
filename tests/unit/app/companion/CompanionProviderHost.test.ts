import '@/providers';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';

import { CompanionProviderHost } from '@/app/companion/CompanionProviderHost';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import type { ProviderHost } from '@/core/providers/ProviderHost';

describe('CompanionProviderHost', () => {
  it('replaces a stale saved Codex model with the valid projected fallback', () => {
    const staleModel = 'gpt-5.4';
    const source = {
      settings: {
        ...DEFAULT_CLAUDIAN_SETTINGS,
        settingsProvider: 'claude',
        savedProviderModel: {
          ...DEFAULT_CLAUDIAN_SETTINGS.savedProviderModel,
          codex: staleModel,
        },
        providerConfigs: {
          ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs,
          codex: {
            ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs.codex,
            enabled: true,
            discoveredModels: TEST_CODEX_CATALOG,
          },
        },
      },
    } as unknown as ProviderHost;

    const host = new CompanionProviderHost(source, 'codex', 'read-only');

    expect(host.settings.model).toBe(TEST_CODEX_MODEL);
    expect(host.settings.savedProviderModel.codex).toBe(TEST_CODEX_MODEL);
    expect(source.settings.savedProviderModel.codex).toBe(staleModel);
  });
});
