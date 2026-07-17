import { randomUUID } from 'crypto';

import type {
  ClaudianCompanionApiV1,
  CompanionCreateSessionRequest,
  CompanionEvent,
  CompanionHistoryMessage,
  CompanionMessageRequest,
  CompanionPermissionMode,
  CompanionProvider,
  CompanionProviderId,
  CompanionResumeState,
  CompanionSession,
  CompanionTurnResult,
} from '../../core/companion/CompanionApi';
import {
  CLAUDIAN_COMPANION_API_SYMBOL,
  CLAUDIAN_COMPANION_API_VERSION,
} from '../../core/companion/CompanionApi';
import type { ProviderHost } from '../../core/providers/ProviderHost';
import { ProviderRegistry } from '../../core/providers/ProviderRegistry';
import type { ChatRuntime } from '../../core/runtime/ChatRuntime';
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

    runtime.setApprovalCallback(async (toolName) => (
      request.permissionMode === 'auto-write' && this.isFileChangeTool(toolName)
        ? 'allow'
        : 'deny'
    ));
    runtime.setAskUserQuestionCallback(async () => null);
    runtime.setExitPlanModeCallback(async () => null);
    runtime.syncConversationState(conversation, externalContextPaths);

    this.sessions.set(sessionId, {
      id: sessionId,
      providerId: request.providerId,
      runtime,
      conversation,
      permissionMode: request.permissionMode,
      externalContextPaths,
      running: false,
      cancelRequested: false,
      closeRequested: false,
    });

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
  ): Promise<CompanionTurnResult> {
    const session = this.getSession(sessionId);
    if (session.running) {
      throw new Error('A turn is already running for this Companion session.');
    }
    if (!request.text.trim()) {
      throw new Error('Companion message text cannot be empty.');
    }

    session.running = true;
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
    if (request.clientId !== 'vault-pilot') {
      throw new Error('This Companion API only accepts the vault-pilot client.');
    }
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
      title: 'Vault Pilot remote session',
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
