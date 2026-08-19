import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import { Address4, Address6 } from 'ip-address';
import path from 'path';

import {
  CLAUDIAN_COMPANION_API_SYMBOL,
  CLAUDIAN_COMPANION_API_VERSION,
  type ClaudianCompanionApiV1,
  type CompanionCreateSessionRequest,
  type CompanionEvent,
  type CompanionHistoryMessage,
  type CompanionMessageRequest,
  type CompanionPermissionMode,
  type CompanionProvider,
  type CompanionProviderId,
  type CompanionResumeState,
  type CompanionSession,
  type CompanionToolApprovalDecision,
  type CompanionToolApprovalHandler,
  type CompanionToolApprovalRequest,
  type CompanionTurnResult,
} from '../../core/companion/CompanionApi';
import type {
  ProviderApprovalInteractionRequest,
  ProviderExecutionBackend,
  ProviderExecutionEvent,
  ProviderExecutionRun,
  ProviderExecutionSessionLease,
  ProviderInteractionPort,
  ProviderSessionSnapshot,
} from '../../core/execution';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '../../core/providers/ProviderWorkspaceRegistry';
import type { ChatMessage } from '../../core/types';
import { getVaultPath } from '../../utils/path';
import { CompanionProviderHost } from './CompanionProviderHost';

const SUPPORTED_PROVIDERS: readonly CompanionProviderId[] = ['claude', 'codex'];

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneJsonValue(
  value: unknown,
  label: string,
  seen: Set<object> = new Set(),
): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} must contain only JSON-compatible values.`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => cloneJsonValue(item, label, seen));
    }
    if (!isRecord(value)) {
      throw new Error(`${label} must contain only JSON-compatible values.`);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item, label, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function cloneJsonRecord(value: Record<string, unknown>, label: string): Record<string, unknown> {
  return cloneJsonValue(value, label) as Record<string, unknown>;
}

interface ManagedSession {
  readonly id: string;
  readonly providerId: CompanionProviderId;
  readonly permissionMode: CompanionPermissionMode;
  readonly vaultRoot: string;
  interactionPort: ProviderInteractionPort;
  readonly allowedScopes: Set<string>;
  readonly allowedTurnScopes: Set<string>;
  readonly history: ChatMessage[];
  selectedModel?: string;
  externalContextPaths: string[];
  resumeState: CompanionResumeState;
  lease: ProviderExecutionSessionLease | null;
  removeInvalidationListener?: () => void;
  activeRun?: ProviderExecutionRun;
  activeAbortController?: AbortController;
  activeTurnId?: string;
  running: boolean;
  cancelRequested: boolean;
  closeRequested: boolean;
  onToolApproval?: CompanionToolApprovalHandler;
  eventListener?: (event: CompanionEvent) => void;
  toolOutputs: Map<string, { content: string; isError: boolean }>;
}

export interface ClaudianCompanionBridgeOptions {
  providerHost: ProviderHost;
  pluginVersion: string;
  createBackend?: (
    host: ProviderHost,
    providerId: CompanionProviderId,
  ) => ProviderExecutionBackend;
}

export class ClaudianCompanionBridge implements ClaudianCompanionApiV1 {
  readonly apiVersion = CLAUDIAN_COMPANION_API_VERSION;
  readonly claudianVersion: string;
  readonly capabilities = {
    permissionModes: ['read-only', 'auto-write'],
    streaming: true,
    cancellation: true,
    vaultRootCwd: true,
    toolApproval: true,
  } as const;

  private readonly sessions = new Map<string, ManagedSession>();
  private readonly creationTasks = new Set<Promise<CompanionSession>>();
  private readonly disposalTasks = new Set<Promise<void>>();
  private readonly providerHost: ProviderHost;
  private readonly createBackend: (
    host: ProviderHost,
    providerId: CompanionProviderId,
  ) => ProviderExecutionBackend;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: ClaudianCompanionBridgeOptions) {
    this.providerHost = options.providerHost;
    this.claudianVersion = options.pluginVersion;
    this.createBackend = options.createBackend ?? ((host, providerId) =>
      ProviderRegistry.createExecutionBackend(host, providerId));
  }

  register(): void {
    if (this.disposed) {
      throw new Error('Cannot register a disposed Companion bridge.');
    }
    Reflect.set(window, Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL), this);
  }

  unregister(): void {
    const key = Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL);
    if (Reflect.get(window, key) === this) {
      Reflect.deleteProperty(window, key);
    }
  }

  listProviders(): CompanionProvider[] {
    return SUPPORTED_PROVIDERS.map((providerId) => ({
      id: providerId,
      name: ProviderRegistry.getProviderDisplayName(providerId),
      enabled: ProviderRegistry.isEnabled(providerId, this.providerHost.settings),
    }));
  }

  createSession(
    request: CompanionCreateSessionRequest,
  ): Promise<CompanionSession> {
    const creation = this.createSessionInternal(request);
    this.creationTasks.add(creation);
    void creation.then(
      () => this.creationTasks.delete(creation),
      () => this.creationTasks.delete(creation),
    );
    return creation;
  }

  private async createSessionInternal(
    request: CompanionCreateSessionRequest,
  ): Promise<CompanionSession> {
    this.assertAvailable();
    this.validateCreateRequest(request);
    const vaultRoot = getVaultPath(this.providerHost.app);
    if (!vaultRoot) {
      throw new Error('Companion requires a filesystem-backed Obsidian vault.');
    }

    await ProviderWorkspaceRegistry.ensureInitialized(
      this.providerHost,
      request.providerId,
      'companion',
    );
    this.assertAvailable();

    const sessionId = randomUUID();
    const resumeState = this.normalizeResumeState(
      request.resumeState,
      request.selectedModel,
    );
    const session = {} as ManagedSession;
    Object.assign(session, {
      id: sessionId,
      providerId: request.providerId,
      permissionMode: request.permissionMode,
      vaultRoot,
      allowedScopes: new Set<string>(),
      allowedTurnScopes: new Set<string>(),
      history: (request.history ?? []).map((message, index) =>
        this.toChatMessage(message, index)),
      selectedModel: request.selectedModel ?? request.resumeState?.selectedModel,
      externalContextPaths: [...(request.externalContextPaths ?? [])],
      resumeState,
      lease: null,
      running: false,
      cancelRequested: false,
      closeRequested: false,
      toolOutputs: new Map<string, { content: string; isError: boolean }>(),
    });
    session.interactionPort = this.createInteractionPort(session);

    this.sessions.set(sessionId, session);
    try {
      this.acquireLease(session);
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }

    return {
      sessionId,
      providerId: request.providerId,
      resumeState: this.copyResumeState(session),
    };
  }

  async sendMessage(
    sessionId: string,
    request: CompanionMessageRequest,
    onEvent?: (event: CompanionEvent) => void,
    onToolApproval?: CompanionToolApprovalHandler,
  ): Promise<CompanionTurnResult> {
    this.assertAvailable();
    this.validateMessageRequest(request, onEvent, onToolApproval);
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('Companion sessionId must be a non-empty string.');
    }
    const session = this.getSession(sessionId);
    if (session.running) {
      throw new Error('A turn is already running for this Companion session.');
    }

    const lease = this.ensureLease(session);
    session.running = true;
    session.cancelRequested = false;
    session.allowedTurnScopes.clear();
    session.onToolApproval = onToolApproval;
    session.eventListener = onEvent;
    session.toolOutputs.clear();
    session.externalContextPaths = request.externalContextPaths
      ? [...request.externalContextPaths]
      : session.externalContextPaths;

    const abortController = new AbortController();
    session.activeAbortController = abortController;
    let turnId: string = randomUUID();
    let output = '';
    let errorMessage: string | undefined;
    let status: CompanionTurnResult['status'] | undefined;
    const startedAt = Date.now();

    try {
      const run = lease.session.execute({
        input: [{ type: 'text', text: request.text }],
        context: {
          externalContextPaths: [...session.externalContextPaths],
        },
        conversationHistory: session.history.map(message => ({ ...message })),
        configuration: {
          systemInstructions: { kind: 'provider-default' },
          ...(session.selectedModel ? { model: session.selectedModel } : {}),
          permissionMode: 'normal',
          externalWorkspaceRoots: [...session.externalContextPaths],
        },
        toolPolicy: session.permissionMode === 'read-only'
          ? { kind: 'read-only' }
          : { kind: 'provider-default' },
        signal: abortController.signal,
      });
      session.activeRun = run;
      session.activeTurnId = run.turnId;
      turnId = run.turnId;
      this.emit(onEvent, { type: 'turn.started', turnId });

      for await (const event of run.events) {
        if (session.lease !== lease || !lease.isCurrent()) continue;
        const outcome = this.handleExecutionEvent(session, event, onEvent);
        output += outcome.text;
        if (outcome.status) status = outcome.status;
        if (outcome.error) errorMessage = outcome.error;
      }

      if (!status) {
        if (session.cancelRequested || abortController.signal.aborted) {
          status = 'cancelled';
        } else {
          status = 'failed';
          errorMessage = 'Provider execution ended without a terminal event.';
          this.emit(onEvent, { type: 'turn.failed', message: errorMessage });
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      status = session.cancelRequested || abortController.signal.aborted
        ? 'cancelled'
        : 'failed';
      if (status === 'failed') {
        this.emit(onEvent, { type: 'turn.failed', message: errorMessage });
      }
    } finally {
      if (session.lease === lease && lease.isCurrent()) {
        this.applyCurrentSnapshot(session, lease);
      }
      this.appendHistory(session, request.text, output, startedAt);
      session.running = false;
      session.activeRun = undefined;
      session.activeAbortController = undefined;
      session.activeTurnId = undefined;
      session.allowedTurnScopes.clear();
      session.onToolApproval = undefined;
      session.eventListener = undefined;
      session.toolOutputs.clear();
      if (session.closeRequested) {
        await this.releaseManagedSession(session);
      }
    }

    if (session.cancelRequested || session.closeRequested) {
      status = 'cancelled';
    } else if (status === 'completed') {
      this.emit(onEvent, { type: 'turn.completed', text: output });
    }

    return {
      turnId,
      status: status ?? 'failed',
      text: output,
      ...(errorMessage ? { error: errorMessage } : {}),
      resumeState: this.copyResumeState(session),
    };
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelRequested = true;
    session.activeAbortController?.abort();
    session.activeRun?.cancel();
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closeRequested = true;
    this.cancel(sessionId);
    if (!session.running) {
      this.trackDisposal(this.releaseManagedSession(session));
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.unregister();
    this.disposePromise = this.disposeAll();
    return this.disposePromise;
  }

  private async disposeAll(): Promise<void> {
    const releases = [...this.sessions.values()].map((session) => {
      session.closeRequested = true;
      this.cancel(session.id);
      return this.releaseManagedSession(session);
    });
    await Promise.allSettled([
      ...releases,
      ...this.creationTasks,
      ...this.disposalTasks,
    ]);
    this.sessions.clear();
  }

  private acquireLease(session: ManagedSession): ProviderExecutionSessionLease {
    const companionHost = new CompanionProviderHost(
      this.providerHost,
      session.providerId,
      session.permissionMode,
    );
    const backend = this.createBackend(companionHost, session.providerId);
    if (backend.providerId !== session.providerId) {
      throw new Error(`Companion backend mismatch: expected ${session.providerId}.`);
    }
    const providerSessionId = session.resumeState.providerSessionId;
    const lease = this.providerHost.executionLifecycleRegistry.acquire(
      backend,
      {
        lifecycle: 'persistent',
        nativePersistence: 'enabled',
        resumeSeed: {
          ...(typeof providerSessionId === 'string' && providerSessionId.trim()
            ? { providerSessionId }
            : {}),
          ...(session.resumeState.providerState
            ? {
                providerState: cloneJsonRecord(
                  session.resumeState.providerState,
                  'Companion providerState',
                ),
              }
            : {}),
        },
        vaultWorkingDirectory: session.vaultRoot,
        interactionPort: session.interactionPort,
      },
      'companion',
    );
    session.lease = lease;
    session.removeInvalidationListener = lease.onInvalidated(() => {
      if (session.lease !== lease) return;
      this.applyCurrentSnapshot(session, lease);
      session.resumeState.providerSessionId = null;
      session.resumeState.providerState = undefined;
      session.removeInvalidationListener = undefined;
      session.lease = null;
      if (session.running) {
        session.cancelRequested = true;
        session.activeAbortController?.abort();
        session.activeRun?.cancel();
      }
    });
    return lease;
  }

  private ensureLease(session: ManagedSession): ProviderExecutionSessionLease {
    if (session.closeRequested) {
      throw new Error(`Companion session is closing: ${session.id}`);
    }
    if (session.lease?.isCurrent()) return session.lease;
    if (session.lease) {
      const staleLease = session.lease;
      session.removeInvalidationListener?.();
      session.removeInvalidationListener = undefined;
      session.lease = null;
      this.trackDisposal(staleLease.release());
    }
    session.cancelRequested = false;
    return this.acquireLease(session);
  }

  private createInteractionPort(session: ManagedSession): ProviderInteractionPort {
    return {
      requestApproval: async (request, signal) => ({
        interactionId: request.interactionId,
        decision: await this.resolveApproval(session, request, signal),
      }),
      askUserQuestion: async request => ({
        interactionId: request.interactionId,
        answers: null,
      }),
      requestPlanDecision: async request => ({
        interactionId: request.interactionId,
        decision: null,
      }),
      dismissInteraction: () => undefined,
    };
  }

  private async resolveApproval(
    session: ManagedSession,
    request: ProviderApprovalInteractionRequest,
    signal: AbortSignal,
  ): Promise<'allow' | 'deny' | 'cancel'> {
    if (
      signal.aborted
      || !session.running
      || session.activeTurnId !== request.turnId
      || session.lease?.session.sessionInstanceId !== request.sessionInstanceId
    ) {
      return 'cancel';
    }
    if (this.isFileChangeTool(request.toolName)) {
      if (session.permissionMode === 'auto-write') return 'allow';
      this.emitPolicyDenial(session, `${request.toolName} is blocked by read-only mode.`);
      return 'deny';
    }
    if (this.isCommandTool(request.toolName)) {
      this.emitPolicyDenial(session, `${request.toolName} is blocked by Companion policy.`);
      return 'deny';
    }

    const approval = this.buildApprovalRequest(
      request.toolName,
      cloneJsonRecord(request.input, 'Companion approval input'),
      request.description,
      request.decisionReason,
      request.blockedPath,
      session.vaultRoot,
    );
    if (!approval) {
      this.emitPolicyDenial(
        session,
        `${request.toolName} is not eligible for interactive read approval.`,
      );
      return 'deny';
    }
    if (session.allowedScopes.has(approval.scope)) return 'allow';
    if (
      approval.turnScope
      && session.allowedTurnScopes.has(approval.turnScope)
    ) {
      return 'allow';
    }
    if (!session.onToolApproval) return 'deny';

    const decision = await this.waitForApproval(
      session.onToolApproval,
      approval,
      signal,
    );
    if (
      signal.aborted
      || !session.running
      || session.activeTurnId !== request.turnId
      || session.lease?.session.sessionInstanceId !== request.sessionInstanceId
    ) {
      return 'cancel';
    }
    if (!decision) return signal.aborted ? 'cancel' : 'deny';
    if (decision === 'deny') return 'deny';
    if (decision === 'allow-once') return 'allow';
    if (decision === 'allow-session' && approval.allowSession) {
      session.allowedScopes.add(approval.scope);
      return 'allow';
    }
    if (
      decision === 'allow-turn'
      && approval.allowTurn
      && approval.turnScope
    ) {
      session.allowedTurnScopes.add(approval.turnScope);
      return 'allow';
    }
    return 'deny';
  }

  private waitForApproval(
    handler: CompanionToolApprovalHandler,
    request: CompanionToolApprovalRequest,
    signal: AbortSignal,
  ): Promise<CompanionToolApprovalDecision | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (decision: CompanionToolApprovalDecision | null) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(decision);
      };
      const onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(request))
        .then(decision => finish(decision))
        .catch(() => finish(null));
    });
  }

  private handleExecutionEvent(
    session: ManagedSession,
    event: ProviderExecutionEvent,
    onEvent?: (event: CompanionEvent) => void,
  ): {
    text: string;
    status?: CompanionTurnResult['status'];
    error?: string;
  } {
    switch (event.type) {
      case 'text_delta':
        this.emit(onEvent, { type: 'text.delta', text: event.text });
        return { text: event.text };
      case 'thinking_delta':
        this.emit(onEvent, { type: 'thinking.delta', text: event.text });
        return { text: '' };
      case 'tool_started':
        this.emit(onEvent, {
          type: 'tool.started',
          toolId: event.toolCallId,
          name: event.name,
          input: cloneJsonRecord(event.input, 'Companion tool input'),
        });
        return { text: '' };
      case 'tool_output':
        session.toolOutputs.set(event.toolCallId, {
          content: event.content,
          isError: event.isError === true,
        });
        return { text: '' };
      case 'tool_completed': {
        const output = session.toolOutputs.get(event.toolCallId);
        session.toolOutputs.delete(event.toolCallId);
        this.emit(onEvent, {
          type: 'tool.finished',
          toolId: event.toolCallId,
          content: event.content ?? output?.content ?? '',
          isError: event.isError === true
            || event.isBlocked === true
            || output?.isError === true,
        });
        return { text: '' };
      }
      case 'notice':
        this.emit(onEvent, {
          type: 'notice',
          message: event.message,
          level: event.level ?? 'info',
        });
        return { text: '' };
      case 'usage_updated':
        this.emit(onEvent, { type: 'usage', usage: event.usage });
        return { text: '' };
      case 'session_state_changed':
      case 'mode_changed':
        this.applySnapshot(session, event.snapshot);
        return { text: '' };
      case 'execution_error':
        this.emit(onEvent, { type: 'turn.failed', message: event.message });
        return { text: '', status: 'failed', error: event.message };
      case 'cancelled':
        return { text: '', status: 'cancelled' };
      case 'turn_completed':
        return { text: '', status: 'completed' };
      default:
        return { text: '' };
    }
  }

  private applyCurrentSnapshot(
    session: ManagedSession,
    lease: ProviderExecutionSessionLease,
  ): void {
    try {
      this.applySnapshot(session, lease.session.getSnapshot());
    } catch {
      // The last emitted snapshot remains authoritative if a disposed session cannot be read.
    }
  }

  private applySnapshot(
    session: ManagedSession,
    snapshot: ProviderSessionSnapshot,
  ): void {
    if (snapshot.providerSessionId !== undefined) {
      session.resumeState.providerSessionId = snapshot.providerSessionId;
    } else if (snapshot.status === 'invalidated') {
      session.resumeState.providerSessionId = null;
    }
    if (
      snapshot.providerState !== undefined
      || snapshot.providerStateDeletes !== undefined
    ) {
      const providerState = { ...session.resumeState.providerState };
      for (const key of snapshot.providerStateDeletes ?? []) {
        delete providerState[key];
      }
      if (snapshot.providerState) {
        Object.assign(
          providerState,
          cloneJsonRecord(snapshot.providerState, 'Companion providerState'),
        );
      }
      session.resumeState.providerState = Object.keys(providerState).length > 0
        ? providerState
        : undefined;
    }
  }

  private appendHistory(
    session: ManagedSession,
    userContent: string,
    assistantContent: string,
    startedAt: number,
  ): void {
    session.history.push(
      {
        id: randomUUID(),
        role: 'user',
        content: userContent,
        timestamp: startedAt,
      },
      {
        id: randomUUID(),
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now(),
      },
    );
  }

  private async releaseManagedSession(session: ManagedSession): Promise<void> {
    if (this.sessions.get(session.id) === session) {
      this.sessions.delete(session.id);
    }
    session.removeInvalidationListener?.();
    session.removeInvalidationListener = undefined;
    const lease = session.lease;
    session.lease = null;
    if (lease) {
      await lease.release();
    }
  }

  private trackDisposal(promise: Promise<void>): void {
    this.disposalTasks.add(promise);
    void promise.then(
      () => this.disposalTasks.delete(promise),
      () => this.disposalTasks.delete(promise),
    );
  }

  private validateCreateRequest(request: CompanionCreateSessionRequest): void {
    if (!isRecord(request)) {
      throw new Error('Companion create request must be an object.');
    }
    if (typeof request.clientId !== 'string' || !request.clientId.trim()) {
      throw new Error('Companion clientId must be a non-empty string.');
    }
    if (!SUPPORTED_PROVIDERS.includes(request.providerId)) {
      throw new Error(`Unsupported Companion provider: ${request.providerId}`);
    }
    if (
      request.permissionMode !== 'read-only'
      && request.permissionMode !== 'auto-write'
    ) {
      throw new Error('Companion API supports read-only and auto-write sessions only.');
    }
    if (!ProviderRegistry.isEnabled(request.providerId, this.providerHost.settings)) {
      throw new Error(`Companion provider is disabled: ${request.providerId}`);
    }
    if (
      request.selectedModel !== undefined
      && (typeof request.selectedModel !== 'string' || !request.selectedModel.trim())
    ) {
      throw new Error('Companion selectedModel must be a non-empty string.');
    }
    if (request.resumeState !== undefined) {
      if (!isRecord(request.resumeState)) {
        throw new Error('Companion resumeState must be an object.');
      }
      const { providerSessionId, providerState, selectedModel } = request.resumeState;
      if (
        providerSessionId !== undefined
        && providerSessionId !== null
        && (typeof providerSessionId !== 'string' || !providerSessionId.trim())
      ) {
        throw new Error('Companion resumeState.providerSessionId must be a string or null.');
      }
      if (providerState !== undefined) {
        if (!isRecord(providerState)) {
          throw new Error('Companion resumeState.providerState must be an object.');
        }
        cloneJsonRecord(providerState, 'Companion resumeState.providerState');
      }
      if (
        selectedModel !== undefined
        && (typeof selectedModel !== 'string' || !selectedModel.trim())
      ) {
        throw new Error('Companion resumeState.selectedModel must be a non-empty string.');
      }
    }
    if (request.history !== undefined) {
      if (!Array.isArray(request.history)) {
        throw new Error('Companion history must be an array.');
      }
      for (const message of request.history) {
        if (
          !isRecord(message)
          || (message.role !== 'user' && message.role !== 'assistant')
          || typeof message.content !== 'string'
          || (
            message.timestamp !== undefined
            && (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp))
          )
        ) {
          throw new Error('Companion history contains an invalid message.');
        }
      }
    }
    this.validatePathList(request.externalContextPaths, 'Companion externalContextPaths');
  }

  private validateMessageRequest(
    request: CompanionMessageRequest,
    onEvent: ((event: CompanionEvent) => void) | undefined,
    onToolApproval: CompanionToolApprovalHandler | undefined,
  ): void {
    if (!isRecord(request) || typeof request.text !== 'string' || !request.text.trim()) {
      throw new Error('Companion message text must be a non-empty string.');
    }
    this.validatePathList(request.externalContextPaths, 'Companion externalContextPaths');
    if (onEvent !== undefined && typeof onEvent !== 'function') {
      throw new Error('Companion event listener must be a function.');
    }
    if (onToolApproval !== undefined && typeof onToolApproval !== 'function') {
      throw new Error('Companion approval handler must be a function.');
    }
  }

  private validatePathList(value: unknown, label: string): void {
    if (value === undefined) return;
    if (
      !Array.isArray(value)
      || value.some(pathValue => typeof pathValue !== 'string' || !pathValue.trim())
    ) {
      throw new Error(`${label} must contain only non-empty strings.`);
    }
  }

  private normalizeResumeState(
    resumeState: CompanionResumeState | undefined,
    selectedModel: string | undefined,
  ): CompanionResumeState {
    const model = selectedModel ?? resumeState?.selectedModel;
    return {
      providerSessionId: resumeState?.providerSessionId ?? null,
      ...(resumeState?.providerState
        ? {
            providerState: cloneJsonRecord(
              resumeState.providerState,
              'Companion resumeState.providerState',
            ),
          }
        : {}),
      ...(model ? { selectedModel: model } : {}),
    };
  }

  private copyResumeState(session: ManagedSession): CompanionResumeState {
    return {
      providerSessionId: session.resumeState.providerSessionId ?? null,
      ...(session.resumeState.providerState
        ? {
            providerState: cloneJsonRecord(
              session.resumeState.providerState,
              'Companion providerState',
            ),
          }
        : {}),
      ...(session.selectedModel ? { selectedModel: session.selectedModel } : {}),
    };
  }

  private toChatMessage(
    message: CompanionHistoryMessage,
    index: number,
  ): ChatMessage {
    return {
      id: `companion-history-${index}`,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp ?? Date.now(),
    };
  }

  private isFileChangeTool(toolName: string): boolean {
    return /^(write|edit|multiedit|notebookedit|apply_patch|file_change|filechange)$/i
      .test(toolName);
  }

  private isCommandTool(toolName: string): boolean {
    return /^(bash|shell|command|command_execution|exec|execute|run_command|terminal)$/i
      .test(toolName);
  }

  private buildApprovalRequest(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    decisionReason: string | undefined,
    blockedPath: string | undefined,
    workspaceRoot: string,
  ): CompanionToolApprovalRequest | undefined {
    const normalized = toolName.toLowerCase();
    const common = {
      toolName,
      input,
      description,
      riskLevel: 'low' as const,
      ...(decisionReason ? { decisionReason } : {}),
      ...(blockedPath ? { blockedPath } : {}),
    };
    if (normalized === 'websearch' || normalized === 'web_search') {
      const query = this.stringInput(input, 'query', 'search_query', 'q');
      return {
        ...common,
        category: 'network-read',
        summary: query ? `Search: ${query}` : 'Search the web',
        scope: 'network:websearch',
        allowSession: true,
        turnScope: 'network:public',
        allowTurn: true,
        outsideWorkspace: false,
      };
    }
    if (normalized === 'webfetch' || normalized === 'web_fetch') {
      const url = this.stringInput(input, 'url', 'uri');
      const parsedUrl = this.parseSafeUrl(url);
      if (!url || !parsedUrl) return undefined;
      const network = this.networkFromUrl(url);
      if (!network) return undefined;
      const origin = `${network.protocol}://${network.host}`;
      const privateTarget = this.isPrivateHost(parsedUrl.hostname);
      return {
        ...common,
        network,
        category: 'network-read',
        riskLevel: privateTarget ? 'high' : 'medium',
        summary: `Fetch: ${url}`,
        scope: `network:webfetch:${origin}`,
        allowSession: !privateTarget,
        ...(!privateTarget ? { turnScope: 'network:public' } : {}),
        allowTurn: !privateTarget,
        outsideWorkspace: false,
      };
    }
    if (/^(read|read_file|grep|glob|search|find|list|list_directory|ls)$/.test(normalized)) {
      const target = this.stringInput(
        input,
        'file_path',
        'path',
        'directory',
        'cwd',
      ) ?? '.';
      const canonicalTarget = this.canonicalPath(target, workspaceRoot);
      const canonicalRoot = this.canonicalPath(workspaceRoot);
      const scopePath = normalized === 'read' || normalized === 'read_file'
        ? this.pathApi(canonicalTarget).dirname(canonicalTarget)
        : canonicalTarget;
      const outsideWorkspace = !this.isPathWithin(canonicalTarget, canonicalRoot);
      return {
        ...common,
        category: 'vault-read',
        riskLevel: outsideWorkspace ? 'medium' : 'low',
        summary: `${toolName}: ${target}`,
        scope: `vault:${normalized}:${scopePath}`,
        allowSession: true,
        allowTurn: false,
        outsideWorkspace,
      };
    }
    return undefined;
  }

  private stringInput(input: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  }

  private networkFromUrl(value?: string): { host: string; protocol: string } | undefined {
    const parsed = this.parseSafeUrl(value);
    return parsed
      ? { host: parsed.host, protocol: parsed.protocol.replace(/:$/, '') }
      : undefined;
  }

  private parseSafeUrl(value?: string): URL | undefined {
    if (!value) return undefined;
    try {
      const parsed = new URL(value);
      if (
        !['http:', 'https:'].includes(parsed.protocol)
        || parsed.username
        || parsed.password
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private isPrivateHost(value: string): boolean {
    const lower = value.trim().toLowerCase();
    const unwrapped = lower.startsWith('[') && lower.endsWith(']')
      ? lower.slice(1, -1)
      : lower;
    const hostname = unwrapped.replace(/\.+$/, '').split('%')[0];
    if (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
    ) {
      return true;
    }
    if (Address4.isValid(hostname)) {
      return this.isNonPublicIpv4(new Address4(hostname));
    }
    if (!Address6.isValid(hostname)) return false;
    const address = new Address6(hostname);
    const embeddedIpv4 = address.embeddedIPv4();
    if (embeddedIpv4) return this.isNonPublicIpv4(embeddedIpv4);
    return address.isPrivate()
      || address.isLoopback()
      || address.isLinkLocal()
      || address.isMulticast()
      || address.isUnspecified()
      || address.isCGNAT()
      || address.isBroadcast()
      || address.isDocumentation();
  }

  private isNonPublicIpv4(address: Address4): boolean {
    const [first, second, third] = address.toArray();
    return address.isPrivate()
      || address.isLoopback()
      || address.isLinkLocal()
      || address.isMulticast()
      || address.isUnspecified()
      || address.isBroadcast()
      || address.isCGNAT()
      || first >= 240
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 198 && (second === 18 || second === 19))
      || (first === 198 && second === 51 && third === 100)
      || (first === 203 && second === 0 && third === 113);
  }

  private canonicalPath(value: string, workspaceRoot?: string): string {
    const api = this.pathApi(value || workspaceRoot || '');
    const absolute = api.isAbsolute(value)
      ? api.normalize(value)
      : api.resolve(workspaceRoot ?? '.', value);
    try {
      return this.normalizeComparablePath(realpathSync.native(absolute), api === path.win32);
    } catch {
      return this.normalizeComparablePath(absolute, api === path.win32);
    }
  }

  private pathApi(value: string): typeof path {
    return /^[a-z]:[\\/]/i.test(value) || value.includes('\\')
      ? path.win32
      : path.posix;
  }

  private normalizeComparablePath(value: string, windows: boolean): string {
    const normalized = (windows ? path.win32 : path.posix)
      .normalize(value)
      .replace(/[\\/]+$/, '');
    return windows ? normalized.toLowerCase() : normalized;
  }

  private isPathWithin(target: string, root: string): boolean {
    const api = this.pathApi(root);
    const normalizedTarget = this.normalizeComparablePath(
      target,
      api === path.win32,
    );
    const normalizedRoot = this.normalizeComparablePath(root, api === path.win32);
    const relative = api.relative(normalizedRoot, normalizedTarget);
    return relative === ''
      || (!relative.startsWith('..') && !api.isAbsolute(relative));
  }

  private emitPolicyDenial(session: ManagedSession, message: string): void {
    this.emit(session.eventListener, { type: 'notice', message, level: 'warning' });
  }

  private getSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Companion session not found: ${sessionId}`);
    }
    return session;
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('Companion bridge is disposed.');
    }
  }

  private emit(
    listener: ((event: CompanionEvent) => void) | undefined,
    event: CompanionEvent,
  ): void {
    try {
      listener?.(event);
    } catch {
      // Consumer errors must not interrupt provider execution.
    }
  }
}
