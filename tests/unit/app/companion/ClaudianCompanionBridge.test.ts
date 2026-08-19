import '@/providers';

import { ClaudianCompanionBridge } from '@/app/companion/ClaudianCompanionBridge';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@/app/settings/defaultSettings';
import {
  CLAUDIAN_COMPANION_API_SYMBOL,
  type CompanionEvent,
} from '@/core/companion/CompanionApi';
import {
  type ProviderExecutionBackend,
  type ProviderExecutionEvent,
  ProviderExecutionLifecycleRegistry,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionSnapshot,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';

type ExecuteHandler = (
  session: FakeExecutionSession,
  request: ProviderExecutionRequest,
  executionId: string,
  turnId: string,
) => AsyncIterable<ProviderExecutionEvent>;

class FakeExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'claude' as const;
  readonly sessionInstanceId: string;
  readonly execute = jest.fn((request: ProviderExecutionRequest): ProviderExecutionRun => {
    const executionId = `execution-${this.index}`;
    const turnId = `turn-${this.index}`;
    this.index += 1;
    return {
      executionId,
      turnId,
      events: this.executeHandler(this, request, executionId, turnId),
      cancel: this.cancel,
    };
  });
  readonly cancel = jest.fn();
  readonly getStatus = jest.fn().mockReturnValue('idle');
  readonly onEvent = jest.fn((_listener: (event: ProviderSessionEvent) => void) => () => undefined);
  readonly dispose = jest.fn().mockResolvedValue(undefined);

  private index = 1;

  constructor(
    id: number,
    private readonly executeHandler: ExecuteHandler,
    private snapshot: ProviderSessionSnapshot = {
      providerId: 'claude',
      revision: 0,
      status: 'idle',
    },
  ) {
    this.sessionInstanceId = `session-instance-${id}`;
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.snapshot;
  }

  setSnapshot(snapshot: ProviderSessionSnapshot): void {
    this.snapshot = snapshot;
  }
}

function requestedScope(
  session: FakeExecutionSession,
  executionId: string,
  turnId: string,
  sequence: number,
) {
  return {
    kind: 'requested' as const,
    sessionInstanceId: session.sessionInstanceId,
    executionId,
    turnId,
    sequence,
  };
}

function createProviderHost(): ProviderHost {
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  return {
    app: {
      vault: { adapter: { basePath: '/vault' } },
    } as unknown as ProviderHost['app'],
    executionLifecycleRegistry: lifecycleRegistry,
    settings: {
      ...DEFAULT_CLAUDIAN_SETTINGS,
      providerConfigs: {
        ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs,
        claude: {
          ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs.claude,
          enabled: true,
        },
        codex: {
          ...DEFAULT_CLAUDIAN_SETTINGS.providerConfigs.codex,
          enabled: true,
        },
      },
    },
    storage: {} as ProviderHost['storage'],
    manifest: { version: '2.1.4' },
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
    applyProviderRuntimeSettings: jest.fn().mockResolvedValue(undefined),
    getResolvedProviderCliPath: jest.fn().mockResolvedValue(null),
    runProviderExecutionTransition: jest.fn((providerIds, mutation, parentScope) =>
      lifecycleRegistry.runTransition(providerIds, mutation, parentScope)),
    notifyProviderChatOptionsChanged: jest.fn(),
  };
}

function createBridge(
  host: ProviderHost,
  executeHandler: ExecuteHandler,
): {
  bridge: ClaudianCompanionBridge;
  backendHosts: ProviderHost[];
  configs: ProviderSessionConfig[];
  sessions: FakeExecutionSession[];
} {
  const backendHosts: ProviderHost[] = [];
  const configs: ProviderSessionConfig[] = [];
  const sessions: FakeExecutionSession[] = [];
  const bridge = new ClaudianCompanionBridge({
    providerHost: host,
    pluginVersion: '2.1.4',
    createBackend: (backendHost) => {
      backendHosts.push(backendHost);
      return {
        providerId: 'claude',
        createSession: (config) => {
          configs.push(config);
          const session = new FakeExecutionSession(sessions.length + 1, executeHandler);
          sessions.push(session);
          return session;
        },
      } satisfies ProviderExecutionBackend;
    },
  });
  return { bridge, backendHosts, configs, sessions };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function* completedTurn(
  session: FakeExecutionSession,
  _request: ProviderExecutionRequest,
  executionId: string,
  turnId: string,
): AsyncIterable<ProviderExecutionEvent> {
  yield {
    type: 'turn_started',
    scope: requestedScope(session, executionId, turnId, 1),
    accepted: true,
  };
  yield {
    type: 'thinking_delta',
    scope: requestedScope(session, executionId, turnId, 2),
    text: 'Checking context',
  };
  yield {
    type: 'tool_started',
    scope: requestedScope(session, executionId, turnId, 3),
    toolCallId: 'tool-1',
    toolScope: { kind: 'main' },
    name: 'Read',
    input: { file_path: '/vault/note.md' },
  };
  yield {
    type: 'tool_output',
    scope: requestedScope(session, executionId, turnId, 4),
    toolCallId: 'tool-1',
    toolScope: { kind: 'main' },
    content: 'note content',
  };
  yield {
    type: 'tool_completed',
    scope: requestedScope(session, executionId, turnId, 5),
    toolCallId: 'tool-1',
    toolScope: { kind: 'main' },
  };
  yield {
    type: 'text_delta',
    scope: requestedScope(session, executionId, turnId, 6),
    text: 'Hello from Claudian',
  };
  const snapshot: ProviderSessionSnapshot = {
    providerId: 'claude',
    revision: 1,
    providerSessionId: 'provider-session',
    providerState: { checkpoint: 'checkpoint-1', keep: true },
    providerStateDeletes: ['obsolete'],
    status: 'executing',
  };
  session.setSnapshot(snapshot);
  yield {
    type: 'session_state_changed',
    scope: requestedScope(session, executionId, turnId, 7),
    snapshot,
  };
  yield {
    type: 'turn_completed',
    scope: requestedScope(session, executionId, turnId, 8),
    reason: 'completed',
  };
}

describe('ClaudianCompanionBridge', () => {
  beforeEach(() => {
    jest.spyOn(ProviderRegistry, 'isEnabled').mockReturnValue(true);
    jest.spyOn(ProviderRegistry, 'getProviderDisplayName').mockImplementation(id => id);
    jest.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL));
    jest.restoreAllMocks();
  });

  it('registers the API and releases owned sessions during async disposal', async () => {
    const host = createProviderHost();
    const { bridge, sessions } = createBridge(host, completedTurn);

    bridge.register();
    expect(Reflect.get(window, Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL))).toBe(bridge);
    await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    const activeSession = sessions[0];

    await bridge.dispose();

    expect(activeSession.dispose).toHaveBeenCalledTimes(1);
    expect(Reflect.get(window, Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL))).toBeUndefined();
  });

  it('executes through a persistent lifecycle lease and projects events and resume state', async () => {
    const host = createProviderHost();
    const { bridge, configs, sessions } = createBridge(host, completedTurn);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
      selectedModel: 'claude-sonnet-4-5',
      resumeState: {
        providerSessionId: 'previous-session',
        providerState: { obsolete: true, keep: false },
      },
      history: [{ role: 'user', content: 'Previous question', timestamp: 10 }],
      externalContextPaths: ['/shared'],
    });
    const activeSession = sessions[0];
    const events: CompanionEvent[] = [];

    const result = await bridge.sendMessage(
      created.sessionId,
      { text: 'Hello' },
      event => events.push(event),
    );

    expect(ProviderWorkspaceRegistry.ensureInitialized).toHaveBeenCalledWith(
      host,
      'claude',
      'companion',
    );
    expect(configs[0]).toMatchObject({
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      vaultWorkingDirectory: '/vault',
      resumeSeed: {
        providerSessionId: 'previous-session',
        providerState: { obsolete: true, keep: false },
      },
    });
    expect(activeSession.execute).toHaveBeenCalledWith(expect.objectContaining({
      input: [{ type: 'text', text: 'Hello' }],
      context: { externalContextPaths: ['/shared'] },
      conversationHistory: [expect.objectContaining({
        role: 'user',
        content: 'Previous question',
        timestamp: 10,
      })],
      configuration: expect.objectContaining({
        model: 'claude-sonnet-4-5',
        externalWorkspaceRoots: ['/shared'],
      }),
      toolPolicy: { kind: 'read-only' },
    }));
    expect(events).toEqual([
      { type: 'turn.started', turnId: 'turn-1' },
      { type: 'thinking.delta', text: 'Checking context' },
      {
        type: 'tool.started',
        toolId: 'tool-1',
        name: 'Read',
        input: { file_path: '/vault/note.md' },
      },
      {
        type: 'tool.finished',
        toolId: 'tool-1',
        content: 'note content',
        isError: false,
      },
      { type: 'text.delta', text: 'Hello from Claudian' },
      { type: 'turn.completed', text: 'Hello from Claudian' },
    ]);
    expect(result).toEqual({
      turnId: 'turn-1',
      status: 'completed',
      text: 'Hello from Claudian',
      resumeState: {
        providerSessionId: 'provider-session',
        providerState: { checkpoint: 'checkpoint-1', keep: true },
        selectedModel: 'claude-sonnet-4-5',
      },
    });

    await bridge.dispose();
  });

  it('keeps auto-write limited to file changes and scopes read approvals to the active turn', async () => {
    const host = createProviderHost();
    const approvals: Array<{ toolName: string; decision: string }> = [];
    const interaction = {} as {
      port: ProviderSessionConfig['interactionPort'];
    };
    const executeHandler: ExecuteHandler = async function* (
      activeSession,
      request,
      executionId,
      turnId,
    ) {
      const scope = requestedScope(activeSession, executionId, turnId, 1);
      const signal = request.signal;
      const ask = async (interactionId: string, toolName: string, input: Record<string, unknown>) => {
        const response = await interaction.port.requestApproval({
          kind: 'approval',
          interactionId,
          sessionInstanceId: scope.sessionInstanceId,
          turnId,
          toolName,
          input,
          description: toolName,
        }, signal);
        approvals.push({ toolName, decision: typeof response.decision === 'string' ? response.decision : 'option' });
      };
      const stale = await interaction.port.requestApproval({
        kind: 'approval',
        interactionId: 'stale-1',
        sessionInstanceId: scope.sessionInstanceId,
        turnId: 'stale-turn',
        toolName: 'Read',
        input: { file_path: '/vault/a.md' },
        description: 'Stale read',
      }, signal);
      approvals.push({ toolName: 'StaleRead', decision: stale.decision as string });
      await ask('write-1', 'Write', { file_path: '/vault/a.md' });
      await ask('command-1', 'Bash', { command: 'whoami' });
      await ask('search-1', 'WebSearch', { query: 'first' });
      await ask('fetch-1', 'WebFetch', { url: 'https://example.com/a' });
      await ask('search-2', 'WebSearch', { query: 'second' });
      await ask('read-1', 'Read', { file_path: '/outside/secret.txt' });
      await ask('read-2', 'Read', { file_path: '/outside/secret.txt' });
      yield {
        type: 'turn_completed',
        scope,
        reason: 'completed',
      };
    };
    const { bridge, configs, sessions } = createBridge(host, executeHandler);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'auto-write',
      externalContextPaths: ['/outside'],
    });
    const activeSession = sessions[0];
    interaction.port = configs[0].interactionPort;
    const approvalHandler = jest.fn().mockImplementation(async request =>
      request.toolName === 'WebSearch' ? 'allow-turn' : 'allow-once');

    await bridge.sendMessage(
      created.sessionId,
      { text: 'Work' },
      undefined,
      approvalHandler,
    );

    expect(approvals).toEqual([
      { toolName: 'StaleRead', decision: 'cancel' },
      { toolName: 'Write', decision: 'allow' },
      { toolName: 'Bash', decision: 'deny' },
      { toolName: 'WebSearch', decision: 'allow' },
      { toolName: 'WebFetch', decision: 'allow' },
      { toolName: 'WebSearch', decision: 'allow' },
      { toolName: 'Read', decision: 'allow' },
      { toolName: 'Read', decision: 'allow' },
    ]);
    expect(approvalHandler).toHaveBeenCalledTimes(3);
    expect(approvalHandler).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'Read',
      outsideWorkspace: true,
    }));
    const executionRequest = activeSession.execute.mock.calls[0][0];
    expect(executionRequest.toolPolicy).toEqual({ kind: 'provider-default' });
    expect(executionRequest.configuration.externalWorkspaceRoots).toEqual(['/outside']);

    await bridge.dispose();
  });

  it('does not reuse public network approval for non-public host variants', async () => {
    const host = createProviderHost();
    const interaction = {} as { port: ProviderSessionConfig['interactionPort'] };
    const urls = [
      'http://localhost./',
      'http://foo.local./',
      'http://[::]/',
      'http://100.64.0.1/',
      'http://198.18.0.1/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:198.18.0.1]/',
      'http://[::ffff:198.51.100.1]/',
      'http://[64:ff9b::c612:1]/',
    ];
    const executeHandler: ExecuteHandler = async function* (
      activeSession,
      request,
      executionId,
      turnId,
    ) {
      const scope = requestedScope(activeSession, executionId, turnId, 1);
      await interaction.port.requestApproval({
        kind: 'approval',
        interactionId: 'search',
        sessionInstanceId: scope.sessionInstanceId,
        turnId,
        toolName: 'WebSearch',
        input: { query: 'public query' },
        description: 'Search',
      }, request.signal);
      for (const [index, url] of urls.entries()) {
        await interaction.port.requestApproval({
          kind: 'approval',
          interactionId: `fetch-${index}`,
          sessionInstanceId: scope.sessionInstanceId,
          turnId,
          toolName: 'WebFetch',
          input: { url },
          description: 'Fetch',
        }, request.signal);
      }
      yield { type: 'turn_completed', scope, reason: 'completed' };
    };
    const { bridge, configs } = createBridge(host, executeHandler);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'auto-write',
    });
    interaction.port = configs[0].interactionPort;
    const approvalHandler = jest.fn(async request =>
      request.toolName === 'WebSearch' ? 'allow-turn' as const : 'allow-once' as const);

    await bridge.sendMessage(created.sessionId, { text: 'Check network' }, undefined, approvalHandler);

    expect(approvalHandler).toHaveBeenCalledTimes(urls.length + 1);
    for (const request of approvalHandler.mock.calls.slice(1).map(call => call[0])) {
      expect(request).toEqual(expect.objectContaining({
        category: 'network-read',
        riskLevel: 'high',
        allowSession: false,
        allowTurn: false,
      }));
    }
    await bridge.dispose();
  });

  it('fails closed when an approval consumer returns an unsupported decision', async () => {
    const host = createProviderHost();
    const interaction = {} as { port: ProviderSessionConfig['interactionPort'] };
    let providerDecision: string | undefined;
    const executeHandler: ExecuteHandler = async function* (
      activeSession,
      request,
      executionId,
      turnId,
    ) {
      const scope = requestedScope(activeSession, executionId, turnId, 1);
      const response = await interaction.port.requestApproval({
        kind: 'approval',
        interactionId: 'search',
        sessionInstanceId: scope.sessionInstanceId,
        turnId,
        toolName: 'WebSearch',
        input: { query: 'query' },
        description: 'Search',
      }, request.signal);
      providerDecision = response.decision as string;
      yield { type: 'turn_completed', scope, reason: 'completed' };
    };
    const { bridge, configs } = createBridge(host, executeHandler);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'auto-write',
    });
    interaction.port = configs[0].interactionPort;

    await bridge.sendMessage(
      created.sessionId,
      { text: 'Search safely' },
      undefined,
      jest.fn().mockResolvedValue('unsupported-decision'),
    );

    expect(providerDecision).toBe('deny');
    await bridge.dispose();
  });

  it('deeply isolates resume state and approval input from Companion consumers', async () => {
    const host = createProviderHost();
    const interaction = {} as { port: ProviderSessionConfig['interactionPort'] };
    const approvalInput = {
      file_path: '/outside/secret.txt',
      metadata: { source: 'provider' },
    };
    const executeHandler: ExecuteHandler = async function* (
      activeSession,
      request,
      executionId,
      turnId,
    ) {
      const scope = requestedScope(activeSession, executionId, turnId, 1);
      await interaction.port.requestApproval({
        kind: 'approval',
        interactionId: 'read',
        sessionInstanceId: scope.sessionInstanceId,
        turnId,
        toolName: 'Read',
        input: approvalInput,
        description: 'Read',
      }, request.signal);
      yield { type: 'turn_completed', scope, reason: 'completed' };
    };
    const { bridge, configs } = createBridge(host, executeHandler);
    const sourceState = { checkpoint: { token: 'original' } };
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'auto-write',
      resumeState: { providerState: sourceState },
      externalContextPaths: ['/outside'],
    });
    interaction.port = configs[0].interactionPort;
    sourceState.checkpoint.token = 'mutated-source';
    const returnedState = created.resumeState.providerState as {
      checkpoint: { token: string };
    };
    returnedState.checkpoint.token = 'mutated-result';
    const approvalHandler = jest.fn(async (request) => {
      const input = request.input as { metadata: { source: string } };
      input.metadata.source = 'consumer';
      return 'allow-once' as const;
    });

    const result = await bridge.sendMessage(
      created.sessionId,
      { text: 'Read safely' },
      undefined,
      approvalHandler,
    );

    expect(result.resumeState.providerState).toEqual({
      checkpoint: { token: 'original' },
    });
    expect(approvalInput.metadata.source).toBe('provider');
    await bridge.dispose();
  });

  it('rejects malformed runtime requests', async () => {
    const host = createProviderHost();
    const { bridge } = createBridge(host, completedTurn);

    await expect(bridge.createSession({
      clientId: ' ',
      providerId: 'claude',
      permissionMode: 'read-only',
    })).rejects.toThrow('clientId');
    await expect(bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
      resumeState: {
        providerState: { invalid: () => undefined },
      },
    })).rejects.toThrow('JSON-compatible');

    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    await expect(bridge.sendMessage(
      created.sessionId,
      { text: 123 } as unknown as { text: string },
    )).rejects.toThrow('message text');
    await bridge.dispose();
  });

  it('reacquires a session after a provider transition invalidates its lease', async () => {
    const host = createProviderHost();
    const { bridge, configs, sessions } = createBridge(host, completedTurn);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    await host.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);

    const result = await bridge.sendMessage(
      created.sessionId,
      { text: 'After transition' },
    );

    expect(sessions).toHaveLength(2);
    expect(configs[1].resumeSeed).toEqual({});
    expect(result.status).toBe('completed');
    await bridge.dispose();
  });

  it('does not restore a stale resume snapshot after an active lease is invalidated', async () => {
    const host = createProviderHost();
    const turnBlocked = deferred();
    const finishTurn = deferred();
    const executeHandler: ExecuteHandler = async function* (
      activeSession,
      _request,
      executionId,
      turnId,
    ) {
      const scope = requestedScope(activeSession, executionId, turnId, 1);
      const snapshot: ProviderSessionSnapshot = {
        providerId: 'claude',
        revision: 1,
        providerSessionId: 'stale-provider-session',
        providerState: { checkpoint: 'stale-checkpoint' },
        status: 'executing',
      };
      activeSession.setSnapshot(snapshot);
      yield { type: 'session_state_changed', scope, snapshot };
      turnBlocked.resolve();
      await finishTurn.promise;
      yield { type: 'turn_completed', scope, reason: 'completed' };
    };
    const { bridge, configs, sessions } = createBridge(host, executeHandler);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });

    const resultPromise = bridge.sendMessage(created.sessionId, { text: 'Running turn' });
    await turnBlocked.promise;
    await host.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
    sessions[0].setSnapshot({
      providerId: 'claude',
      revision: 2,
      providerSessionId: 'stale-provider-session',
      providerState: { checkpoint: 'stale-checkpoint' },
      status: 'disposed',
    });
    finishTurn.resolve();

    const result = await resultPromise;

    expect(result.status).toBe('cancelled');
    expect(result.resumeState).toEqual({ providerSessionId: null });
    expect(configs).toHaveLength(1);
    await bridge.dispose();
  });

  it('rebuilds the provider host and backend from current settings after a transition', async () => {
    const host = createProviderHost();
    host.settings.systemPrompt = 'Initial prompt';
    const { bridge, backendHosts } = createBridge(host, completedTurn);
    const created = await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    expect(backendHosts[0].settings.systemPrompt).toBe('Initial prompt');

    host.settings.systemPrompt = 'Updated prompt';
    await host.executionLifecycleRegistry.runTransition(['claude'], async () => undefined);
    await bridge.sendMessage(created.sessionId, { text: 'Use current settings' });

    expect(backendHosts).toHaveLength(2);
    expect(backendHosts[1]).not.toBe(backendHosts[0]);
    expect(backendHosts[1].settings.systemPrompt).toBe('Updated prompt');
    await bridge.dispose();
  });

  it('rejects an in-flight session creation when disposal starts during workspace initialization', async () => {
    const host = createProviderHost();
    const { bridge, sessions } = createBridge(host, completedTurn);
    await bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    const initialization = deferred();
    jest.mocked(ProviderWorkspaceRegistry.ensureInitialized)
      .mockImplementationOnce(() => initialization.promise);

    const creation = bridge.createSession({
      clientId: 'mobile-helper',
      providerId: 'claude',
      permissionMode: 'read-only',
    });
    await Promise.resolve();
    const disposal = bridge.dispose();
    await Promise.resolve();

    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    initialization.resolve();

    await expect(creation).rejects.toThrow('Companion bridge is disposed');
    await disposal;
    expect(sessions).toHaveLength(1);
  });
});
