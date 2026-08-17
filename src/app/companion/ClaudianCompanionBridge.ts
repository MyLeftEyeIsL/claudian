import { randomUUID } from 'crypto';
import { realpathSync } from 'fs';
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
  type CompanionToolApprovalHandler,
  type CompanionToolApprovalRequest,
  type CompanionTurnResult,
} from '../../core/companion/CompanionApi';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { ChatRuntime } from '../../core/runtime/ChatRuntime';
import type { ApprovalCallbackOptions } from '../../core/runtime/types';
import type { ChatMessage, Conversation, StreamChunk } from '../../core/types';
import { CompanionProviderHost } from './CompanionProviderHost';

const SUPPORTED_PROVIDERS: readonly CompanionProviderId[] = ['claude', 'codex'];

interface ManagedSession {
  id: string;
  providerId: CompanionProviderId;
  runtime: ChatRuntime;
  conversation: Conversation;
  permissionMode: CompanionPermissionMode;
  externalContextPaths: string[];
  running: boolean;
  cancelRequested: boolean;
  closeRequested: boolean;
  allowedScopes: Set<string>;
  allowedTurnScopes: Set<string>;
  onToolApproval?: CompanionToolApprovalHandler;
  eventListener?: (event: CompanionEvent) => void;
}

export interface ClaudianCompanionBridgeOptions {
  providerHost: ProviderHost;
  pluginVersion: string;
  createRuntime?: (host: ProviderHost, providerId: CompanionProviderId) => ChatRuntime;
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
  private readonly providerHost: ProviderHost;
  private readonly createRuntime: (
    host: ProviderHost,
    providerId: CompanionProviderId,
  ) => ChatRuntime;

  constructor(options: ClaudianCompanionBridgeOptions) {
    this.providerHost = options.providerHost;
    this.claudianVersion = options.pluginVersion;
    this.createRuntime = options.createRuntime ?? ((host, providerId) =>
      ProviderRegistry.createChatRuntime({ plugin: host, providerId }));
  }

  register(): void {
    Reflect.set(window, Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL), this);
  }

  listProviders(): CompanionProvider[] {
    return SUPPORTED_PROVIDERS.map((providerId) => ({
      id: providerId,
      name: ProviderRegistry.getProviderDisplayName(providerId),
      enabled: ProviderRegistry.isEnabled(providerId, this.providerHost.settings),
    }));
  }

  async createSession(
    request: CompanionCreateSessionRequest,
  ): Promise<CompanionSession> {
    this.validateCreateRequest(request);

    const sessionId = randomUUID();
    const resumeState = request.resumeState ?? {};
    const conversation = this.createConversation(
      sessionId,
      request.providerId,
      resumeState,
      request.history ?? [],
      request.selectedModel,
    );
    const host = new CompanionProviderHost(
      this.providerHost,
      request.providerId,
      request.permissionMode,
    );
    const runtime = this.createRuntime(host, request.providerId);
    const externalContextPaths = [...(request.externalContextPaths ?? [])];

    const managedSession: ManagedSession = {
      id: sessionId,
      providerId: request.providerId,
      runtime,
      conversation,
      permissionMode: request.permissionMode,
      externalContextPaths,
      running: false,
      cancelRequested: false,
      closeRequested: false,
      allowedScopes: new Set(),
      allowedTurnScopes: new Set(),
    };
    runtime.setApprovalCallback(async (toolName, input, description, options) => {
      if (managedSession.permissionMode === 'auto-write' && this.isFileChangeTool(toolName)) {
        return 'allow';
      }
      if (this.isFileChangeTool(toolName)) {
        this.emitPolicyDenial(managedSession, `${toolName} 属于文件写入工具，不能通过只读授权放行。`);
        return 'deny';
      }
      if (this.isCommandTool(toolName)) {
        this.emitPolicyDenial(managedSession, `${toolName} 属于命令执行工具，当前策略禁止通过临时授权放行。`);
        return 'deny';
      }
      const approval = this.buildApprovalRequest(
        toolName,
        input,
        description,
        options,
        managedSession.externalContextPaths[0],
      );
      if (!approval) {
        this.emitPolicyDenial(managedSession, `${toolName} 不在可交互审批的只读工具白名单中，或目标参数无效。`);
        return 'deny';
      }
      if (managedSession.allowedScopes.has(approval.scope)) return 'allow';
      if (approval.turnScope && managedSession.allowedTurnScopes.has(approval.turnScope)) return 'allow';
      if (!managedSession.onToolApproval) return 'deny';
      let decision;
      try {
        decision = await managedSession.onToolApproval(approval);
      } catch {
        return 'deny';
      }
      if (decision === 'allow-session' && approval.allowSession) {
        managedSession.allowedScopes.add(approval.scope);
      }
      if (decision === 'allow-turn' && approval.allowTurn && approval.turnScope) {
        managedSession.allowedTurnScopes.add(approval.turnScope);
      }
      return decision === 'deny' ? 'deny' : 'allow';
    });
    runtime.setAskUserQuestionCallback(async () => null);
    runtime.setExitPlanModeCallback(async () => null);
    runtime.syncConversationState(conversation, externalContextPaths);

    this.sessions.set(sessionId, managedSession);

    return {
      sessionId,
      providerId: request.providerId,
      resumeState: this.getResumeState(conversation),
    };
  }

  async sendMessage(
    sessionId: string,
    request: CompanionMessageRequest,
    onEvent?: (event: CompanionEvent) => void,
    onToolApproval?: CompanionToolApprovalHandler,
  ): Promise<CompanionTurnResult> {
    const session = this.getSession(sessionId);
    if (session.running) {
      throw new Error('A turn is already running for this Companion session.');
    }
    if (!request.text.trim()) {
      throw new Error('Companion message text cannot be empty.');
    }

    session.running = true;
    session.allowedTurnScopes.clear();
    session.onToolApproval = onToolApproval;
    session.eventListener = onEvent;
    session.cancelRequested = false;
    const turnId = randomUUID();
    const externalContextPaths = request.externalContextPaths
      ? [...request.externalContextPaths]
      : session.externalContextPaths;
    session.externalContextPaths = externalContextPaths;
    this.emit(onEvent, { type: 'turn.started', turnId });

    let text = '';
    let errorMessage: string | undefined;
    let status: CompanionTurnResult['status'] = 'completed';
    const startedAt = Date.now();
    let persistedContent = request.text;

    try {
      session.runtime.syncConversationState(session.conversation, externalContextPaths);
      const preparedTurn = session.runtime.prepareTurn({
        text: request.text,
        externalContextPaths,
      });
      persistedContent = preparedTurn.persistedContent;

      for await (const chunk of session.runtime.query(
        preparedTurn,
        session.conversation.messages,
        {
          model: session.conversation.selectedModel,
          externalContextPaths,
        },
      )) {
        if (session.cancelRequested) {
          status = 'cancelled';
          break;
        }

        const result = this.handleChunk(chunk, onEvent);
        text += result.text;
        if (result.error) {
          errorMessage = result.error;
          status = 'failed';
        }
        if (chunk.type === 'usage') {
          session.conversation.usage = chunk.usage;
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      status = session.cancelRequested ? 'cancelled' : 'failed';
      this.emit(onEvent, { type: 'turn.failed', message: errorMessage });
    } finally {
      try {
        this.finishTurnState(session, persistedContent, text, startedAt);
      } catch (error) {
        if (!errorMessage) {
          errorMessage = error instanceof Error ? error.message : String(error);
          status = 'failed';
          this.emit(onEvent, { type: 'turn.failed', message: errorMessage });
        }
      }
      session.running = false;
      session.allowedTurnScopes.clear();
      session.onToolApproval = undefined;
      session.eventListener = undefined;
      if (session.closeRequested) {
        session.runtime.cleanup();
        this.sessions.delete(session.id);
      }
    }

    if (session.cancelRequested || session.closeRequested) {
      status = 'cancelled';
    } else if (status === 'completed') {
      this.emit(onEvent, { type: 'turn.completed', text });
    }

    return {
      turnId,
      status,
      text,
      ...(errorMessage ? { error: errorMessage } : {}),
      resumeState: this.getResumeState(session.conversation),
    };
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelRequested = true;
    session.runtime.cancel();
  }

  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.running) {
      session.cancelRequested = true;
      session.closeRequested = true;
      session.runtime.cancel();
      return;
    }
    session.runtime.cleanup();
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.running) {
        session.runtime.cancel();
      }
      session.runtime.cleanup();
    }
    this.sessions.clear();

    const key = Symbol.for(CLAUDIAN_COMPANION_API_SYMBOL);
    if (Reflect.get(window, key) === this) {
      Reflect.deleteProperty(window, key);
    }
  }

  private validateCreateRequest(request: CompanionCreateSessionRequest): void {
    if (!SUPPORTED_PROVIDERS.includes(request.providerId)) {
      throw new Error('Unsupported Companion provider: ' + request.providerId);
    }
    if (request.permissionMode !== 'read-only' && request.permissionMode !== 'auto-write') {
      throw new Error('Companion API supports read-only and auto-write sessions only.');
    }
    if (!ProviderRegistry.isEnabled(request.providerId, this.providerHost.settings)) {
      throw new Error('Companion provider is disabled: ' + request.providerId);
    }
  }

  private isFileChangeTool(toolName: string): boolean {
    return /^(write|edit|multiedit|notebookedit|apply_patch|file_change|filechange)$/i.test(toolName);
  }

  private isCommandTool(toolName: string): boolean {
    return /^(bash|shell|command|exec|execute|run_command|terminal)$/i.test(toolName);
  }

  private buildApprovalRequest(
    toolName: string,
    input: Record<string, unknown>,
    description: string,
    options?: ApprovalCallbackOptions,
    workspaceRoot?: string,
  ): CompanionToolApprovalRequest | undefined {
    const normalized = toolName.toLowerCase();
    const common = {
      toolName,
      input,
      description,
      riskLevel: 'low' as const,
      ...(options?.decisionReason ? { decisionReason: options.decisionReason } : {}),
      ...(options?.blockedPath ? { blockedPath: options.blockedPath } : {}),
      ...(options?.networkApprovalContext ? { network: options.networkApprovalContext } : {}),
    };
    if (normalized === 'websearch') {
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
    if (normalized === 'webfetch') {
      const url = this.stringInput(input, 'url', 'uri');
      const parsedUrl = this.parseSafeUrl(url);
      if (!url || !parsedUrl) return undefined;
      const network = options?.networkApprovalContext ?? this.networkFromUrl(url);
      const origin = network ? `${network.protocol}://${network.host}` : url;
      const privateTarget = network ? this.isPrivateHost(network.host) : false;
      return {
        ...common,
        ...(network ? { network } : {}),
        category: 'network-read',
        riskLevel: privateTarget ? 'high' : 'medium',
        summary: url ? `Fetch: ${url}` : 'Fetch web content',
        scope: `network:webfetch:${origin || 'unknown'}`,
        allowSession: Boolean(origin) && !privateTarget,
        ...(!privateTarget ? { turnScope: 'network:public' } : {}),
        allowTurn: !privateTarget,
        outsideWorkspace: false,
      };
    }
    if (/^(read|grep|glob|search|find|list|ls)$/.test(normalized)) {
      const target = this.stringInput(input, 'file_path', 'path', 'directory', 'cwd') ?? '.';
      const canonicalTarget = this.canonicalPath(target, workspaceRoot);
      const canonicalRoot = workspaceRoot ? this.canonicalPath(workspaceRoot) : undefined;
      const scopePath = normalized === 'read'
        ? this.pathApi(canonicalTarget).dirname(canonicalTarget)
        : canonicalTarget;
      const outsideWorkspace = canonicalRoot
        ? !this.isPathWithin(canonicalTarget, canonicalRoot)
        : false;
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
    return parsed ? { host: parsed.host, protocol: parsed.protocol.replace(/:$/, '') } : undefined;
  }

  private parseSafeUrl(value?: string): URL | undefined {
    if (!value) return undefined;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  private isPrivateHost(value: string): boolean {
    const lower = value.toLowerCase();
    const hostname = lower.startsWith('[')
      ? lower.slice(1, lower.indexOf(']') > 0 ? lower.indexOf(']') : undefined)
      : lower.split(':')[0];
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true;
    if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd')) return true;
    const ipv4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(hostname);
    if (ipv4Mapped?.[1]) return this.isPrivateHost(ipv4Mapped[1]);
    const ipv4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(hostname);
    if (ipv4MappedHex?.[1] && ipv4MappedHex[2]) {
      const high = Number.parseInt(ipv4MappedHex[1], 16);
      const low = Number.parseInt(ipv4MappedHex[2], 16);
      return this.isPrivateHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    const firstIpv6Group = /^([0-9a-f]{1,4}):/.exec(hostname)?.[1];
    if (firstIpv6Group) {
      const group = Number.parseInt(firstIpv6Group, 16);
      if (group >= 0xfe80 && group <= 0xfebf) return true;
    }
    const octets = hostname.split('.').map(Number);
    if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
    return octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || octets[0] === 0;
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

  private pathApi(value: string): typeof path.win32 | typeof path.posix {
    return /^[a-z]:[\\/]/i.test(value) || value.includes('\\') ? path.win32 : path.posix;
  }

  private normalizeComparablePath(value: string, windows: boolean): string {
    const normalized = (windows ? path.win32 : path.posix).normalize(value).replace(/[\\/]+$/, '');
    return windows ? normalized.toLowerCase() : normalized;
  }

  private isPathWithin(target: string, root: string): boolean {
    const api = this.pathApi(root);
    const normalizedTarget = this.normalizeComparablePath(target, api === path.win32);
    const normalizedRoot = this.normalizeComparablePath(root, api === path.win32);
    const relative = api.relative(normalizedRoot, normalizedTarget);
    return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
  }

  private emitPolicyDenial(session: ManagedSession, message: string): void {
    this.emit(session.eventListener, { type: 'notice', message, level: 'warning' });
  }

  private createConversation(
    sessionId: string,
    providerId: CompanionProviderId,
    resumeState: CompanionResumeState,
    history: CompanionHistoryMessage[],
    selectedModel?: string,
  ): Conversation {
    const now = Date.now();
    return {
      id: 'companion-' + sessionId,
      providerId,
      title: 'Mobile Helper remote session',
      createdAt: now,
      updatedAt: now,
      sessionId: resumeState.providerSessionId ?? null,
      selectedModel: selectedModel ?? resumeState.selectedModel,
      providerState: resumeState.providerState,
      messages: history.map((message, index) => this.toChatMessage(message, index)),
    };
  }

  private toChatMessage(
    message: CompanionHistoryMessage,
    index: number,
  ): ChatMessage {
    return {
      id: 'companion-history-' + index,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp ?? Date.now(),
    };
  }

  private handleChunk(
    chunk: StreamChunk,
    onEvent?: (event: CompanionEvent) => void,
  ): { text: string; error?: string } {
    switch (chunk.type) {
      case 'text':
        this.emit(onEvent, { type: 'text.delta', text: chunk.content });
        return { text: chunk.content };
      case 'thinking':
        this.emit(onEvent, { type: 'thinking.delta', text: chunk.content });
        return { text: '' };
      case 'tool_use':
        this.emit(onEvent, {
          type: 'tool.started',
          toolId: chunk.id,
          name: chunk.name,
          input: chunk.input,
        });
        return { text: '' };
      case 'tool_result':
      case 'tool_output':
        this.emit(onEvent, {
          type: 'tool.finished',
          toolId: chunk.id,
          content: chunk.content,
          isError: chunk.type === 'tool_result' && chunk.isError === true,
        });
        return { text: '' };
      case 'notice':
        this.emit(onEvent, {
          type: 'notice',
          message: chunk.content,
          level: chunk.level ?? 'info',
        });
        return { text: '' };
      case 'usage':
        this.emit(onEvent, { type: 'usage', usage: chunk.usage });
        return { text: '' };
      case 'error':
        this.emit(onEvent, { type: 'turn.failed', message: chunk.content });
        return { text: '', error: chunk.content };
      default:
        return { text: '' };
    }
  }

  private finishTurnState(
    session: ManagedSession,
    userContent: string,
    assistantContent: string,
    startedAt: number,
  ): void {
    const now = Date.now();
    session.conversation.messages.push(
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
        timestamp: now,
      },
    );
    session.conversation.updatedAt = now;
    session.conversation.lastResponseAt = now;

    const sessionInvalidated = session.runtime.consumeSessionInvalidation();
    const { updates } = session.runtime.buildSessionUpdates({
      conversation: session.conversation,
      sessionInvalidated,
    });
    Object.assign(session.conversation, updates);
  }

  private getResumeState(conversation: Conversation): CompanionResumeState {
    return {
      providerSessionId: conversation.sessionId,
      ...(conversation.providerState ? { providerState: conversation.providerState } : {}),
      ...(conversation.selectedModel ? { selectedModel: conversation.selectedModel } : {}),
    };
  }

  private getSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Companion session not found: ' + sessionId);
    }
    return session;
  }

  private emit(
    listener: ((event: CompanionEvent) => void) | undefined,
    event: CompanionEvent,
  ): void {
    try {
      listener?.(event);
    } catch {
      // Consumer errors must not interrupt the provider runtime.
    }
  }
}
