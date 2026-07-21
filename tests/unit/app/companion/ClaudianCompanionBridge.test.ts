import '@/providers';

import { ClaudianCompanionBridge } from '@/app/companion/ClaudianCompanionBridge';
import { CompanionProviderHost } from '@/app/companion/CompanionProviderHost';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import {
  CLAUDIAN_COMPANION_API_SYMBOL,
} from '@/core/companion/CompanionApi';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';

function createProviderHost(): ProviderHost {
  return {
    app: {} as ProviderHost['app'],
    settings: {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      providerConfigs: {
        ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs,
        codex: {
          ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs.codex,
          enabled: true,
        },
      },
    },
    storage: {} as ProviderHost['storage'],
    manifest: { version: '2.0.34' },
    saveSettings: jest.fn().mockResolvedValue(undefined),
    mutateSettings: jest.fn().mockResolvedValue(undefined),
    mutateSettingsConditionally: jest.fn().mockResolvedValue(undefined),
    loadData: jest.fn().mockResolvedValue({}),
    saveData: jest.fn().mockResolvedValue(undefined),
    normalizeModelVariantSettings: jest.fn().mockReturnValue(false),
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getEnvironmentVariablesForScope: jest.fn().mockReturnValue(''),
    applyEnvironmentVariables: jest.fn().mockResolvedValue(undefined),
    applyEnvironmentVariablesBatch: jest.fn().mockResolvedValue(undefined),
    getResolvedProviderCliPath: jest.fn().mockReturnValue(null),
  };
}

function createRuntime(): ChatRuntime {
  return {
    providerId: 'claude',
    getCapabilities: jest.fn(),
    prepareTurn: jest.fn((request) => ({
      request,
      persistedContent: request.text,
      prompt: request.text,
      isCompact: false,
      mcpMentions: new Set(),
    })),
    onReadyStateChange: jest.fn(() => () => {}),
    setResumeCheckpoint: jest.fn(),
    syncConversationState: jest.fn(),
    reloadMcpServers: jest.fn().mockResolvedValue(undefined),
    ensureReady: jest.fn().mockResolvedValue(true),
    query: jest.fn(async function* () {
      yield { type: 'text', content: 'Hello from Claudian' } as const;
      yield { type: 'done' } as const;
    }),
    cancel: jest.fn(),
    resetSession: jest.fn(),
    getSessionId: jest.fn().mockReturnValue('provider-session'),
    consumeSessionInvalidation: jest.fn().mockReturnValue(false),
    isReady: jest.fn().mockReturnValue(true),
    getSupportedCommands: jest.fn().mockResolvedValue([]),
    cleanup: jest.fn(),
    rewind: jest.fn(),
    setApprovalCallback: jest.fn(),
    setApprovalDismisser: jest.fn(),
    setAskUserQuestionCallback: jest.fn(),
    setExitPlanModeCallback: jest.fn(),
    setPermissionModeSyncCallback: jest.fn(),
    setAutoTurnCallback: jest.fn(),
    consumeTurnMetadata: jest.fn().mockReturnValue({}),
    buildSessionUpdates: jest.fn().mockReturnValue({
      updates: {
        sessionId: 'provider-session',
        providerState: { providerSessionId: 'provider-session' },
      },
    }),
    resolveSessionIdForFork: jest.fn().mockReturnValue(null),
  } as ChatRuntime;
}

describe('ClaudianCompanionBridge', () => {
  afterEach(() => {
    Reflect.deleteProperty(
      window,
      Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL),
    );
  });

  it('registers and removes the public API', () => {
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => createRuntime(),
    });

    bridge.register();
    expect(bridge.apiVersion).toBe('1.4.0');
    expect(bridge.capabilities).toEqual({
      permissionModes: ['read-only', 'auto-write'],
      streaming: true,
      cancellation: true,
      vaultRootCwd: true,
      toolApproval: true,
    });
    expect(Reflect.get(
      window,
      Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL),
    )).toBe(bridge);

    bridge.dispose();
    expect(Reflect.get(
      window,
      Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL),
    )).toBeUndefined();
  });

  it('runs a headless read-only turn and returns resume state', async () => {
    const runtime = createRuntime();
    const events: string[] = [];
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => runtime,
    });
    const session = await bridge.createSession({
      clientId: 'vault-pilot',
      providerId: 'claude',
      permissionMode: 'read-only',
    });

    const result = await bridge.sendMessage(
      session.sessionId,
      { text: 'Hello' },
      event => events.push(event.type),
    );

    expect(result).toMatchObject({
      status: 'completed',
      text: 'Hello from Claudian',
      resumeState: {
        providerSessionId: 'provider-session',
      },
    });
    expect(events).toEqual([
      'turn.started',
      'text.delta',
      'turn.completed',
    ]);
    expect(runtime.setApprovalCallback).toHaveBeenCalled();

    bridge.cancel(session.sessionId);
    expect(runtime.cancel).toHaveBeenCalled();
    bridge.closeSession(session.sessionId);
    expect(runtime.cleanup).toHaveBeenCalled();
  });

  it('isolates read-only and auto-write settings from the source host', () => {
    const source = createProviderHost();
    const claudeHost = new CompanionProviderHost(source, 'claude', 'read-only');
    const codexHost = new CompanionProviderHost(source, 'codex', 'auto-write');

    expect(claudeHost.settings.permissionMode).toBe('plan');
    expect(codexHost.settings.permissionMode).toBe('normal');
    expect(codexHost.settings.providerConfigs.codex?.safeMode).toBe('workspace-write');
    expect(source.settings.permissionMode).toBe(DEFAULT_CLAUDIAN_SETTINGS.permissionMode);
  });

  it('allows file-change approvals but rejects command approvals in auto-write mode', async () => {
    const runtime = createRuntime();
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => runtime,
    });
    await bridge.createSession({
      clientId: 'vault-pilot',
      providerId: 'claude',
      permissionMode: 'auto-write',
    });

    const approval = (runtime.setApprovalCallback as jest.Mock).mock.calls[0][0];
    await expect(approval('Write')).resolves.toBe('allow');
    await expect(approval('apply_patch')).resolves.toBe('allow');
    await expect(approval('Bash')).resolves.toBe('deny');
  });

  it('forwards tool approvals and remembers session-level decisions', async () => {
    const runtime = createRuntime();
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => runtime,
    });
    const session = await bridge.createSession({
      clientId: 'vault-pilot',
      providerId: 'claude',
      permissionMode: 'read-only',
      externalContextPaths: ['C:/Vault'],
    });
    const approval = (runtime.setApprovalCallback as jest.Mock).mock.calls[0][0];
    const handler = jest.fn().mockResolvedValue('allow-session');
    (runtime.query as jest.Mock).mockImplementation(async function* () {
      expect(await approval('WebSearch', { query: 'news' }, 'Search the web', {
        networkApprovalContext: { host: 'example.com', protocol: 'https' },
      })).toBe('allow');
      expect(await approval('WebSearch', { query: 'more' }, 'Search again')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://example.com/a' }, 'Fetch A')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://example.com/b' }, 'Fetch B')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://other.example/b' }, 'Fetch other')).toBe('allow');
      expect(await approval('WebFetch', { url: 'http://127.0.0.1/admin' }, 'Fetch local')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://user:secret@example.com' }, 'Fetch credential URL')).toBe('deny');
      expect(await approval('Read', { file_path: 'D:/Secrets/token.txt' }, 'Read outside')).toBe('allow');
      expect(await approval('Bash', { command: 'curl example.com' }, 'Run command')).toBe('deny');
      yield { type: 'done' } as const;
    });

    await bridge.sendMessage(session.sessionId, { text: 'Search' }, undefined, handler);

    expect(handler).toHaveBeenCalledTimes(5);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'WebSearch',
      input: { query: 'news' },
      network: { host: 'example.com', protocol: 'https' },
    }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'WebFetch',
      scope: 'network:webfetch:https://example.com',
      allowSession: true,
    }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'WebFetch',
      scope: 'network:webfetch:https://other.example',
    }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'WebFetch',
      riskLevel: 'high',
      allowSession: false,
    }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'Read',
      outsideWorkspace: true,
    }));
  });

  it('approves public web search and fetch once per turn', async () => {
    const runtime = createRuntime();
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => runtime,
    });
    const session = await bridge.createSession({
      clientId: 'vault-pilot',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    const approval = (runtime.setApprovalCallback as jest.Mock).mock.calls[0][0];
    (runtime.query as jest.Mock).mockImplementation(async function* () {
      expect(await approval('WebSearch', { query: 'market' }, 'Search')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://one.example/a' }, 'Fetch one')).toBe('allow');
      expect(await approval('WebFetch', { url: 'https://two.example/b' }, 'Fetch two')).toBe('allow');
      yield { type: 'done' } as const;
    });
    const handler = jest.fn().mockResolvedValue('allow-turn');

    await bridge.sendMessage(session.sessionId, { text: 'First question' }, undefined, handler);
    await bridge.sendMessage(session.sessionId, { text: 'Second question' }, undefined, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'WebSearch',
      turnScope: 'network:public',
      allowTurn: true,
    }));
  });

  it('rejects missing URLs and IPv6 private WebFetch targets', async () => {
    const runtime = createRuntime();
    const bridge = new ClaudianCompanionBridge({
      providerHost: createProviderHost(),
      pluginVersion: '2.0.34',
      createRuntime: () => runtime,
    });
    const session = await bridge.createSession({
      clientId: 'vault-pilot',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    const approval = (runtime.setApprovalCallback as jest.Mock).mock.calls[0][0];
    const handler = jest.fn().mockResolvedValue('allow-turn');
    (runtime.query as jest.Mock).mockImplementation(async function* () {
      expect(await approval('WebFetch', {}, 'Missing URL')).toBe('deny');
      expect(await approval('WebFetch', { url: 'http://[fe90::1]/' }, 'IPv6 link local')).toBe('allow');
      expect(await approval('WebFetch', { url: 'http://[::ffff:127.0.0.1]/' }, 'IPv4 mapped')).toBe('allow');
      yield { type: 'done' } as const;
    });

    await bridge.sendMessage(session.sessionId, { text: 'Fetch' }, undefined, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ riskLevel: 'high', allowTurn: false }));
  });
});
