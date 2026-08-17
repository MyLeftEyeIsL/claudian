export const CLAUDIAN_COMPANION_API_VERSION = '1.4.0' as const;
export const CLAUDIAN_COMPANION_API_SYMBOL = 'claudian.companion-api.v1' as const;

export type CompanionProviderId = 'claude' | 'codex';
export type CompanionPermissionMode = 'read-only' | 'auto-write';

export interface CompanionCapabilities {
  permissionModes: readonly CompanionPermissionMode[];
  streaming: boolean;
  cancellation: boolean;
  vaultRootCwd: boolean;
  toolApproval: boolean;
}

export interface CompanionProvider {
  id: CompanionProviderId;
  name: string;
  enabled: boolean;
}

export interface CompanionHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

export interface CompanionResumeState {
  providerSessionId?: string | null;
  providerState?: Record<string, unknown>;
  selectedModel?: string;
}

export interface CompanionCreateSessionRequest {
  clientId: string;
  providerId: CompanionProviderId;
  permissionMode: CompanionPermissionMode;
  selectedModel?: string;
  resumeState?: CompanionResumeState;
  history?: CompanionHistoryMessage[];
  externalContextPaths?: string[];
}

export interface CompanionSession {
  sessionId: string;
  providerId: CompanionProviderId;
  resumeState: CompanionResumeState;
}

export interface CompanionMessageRequest {
  text: string;
  externalContextPaths?: string[];
}

export interface CompanionToolApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  category: 'network-read' | 'vault-read';
  riskLevel: 'low' | 'medium' | 'high';
  summary: string;
  scope: string;
  allowSession: boolean;
  turnScope?: string;
  allowTurn: boolean;
  outsideWorkspace: boolean;
  decisionReason?: string;
  blockedPath?: string;
  network?: { host: string; protocol: string };
}

export type CompanionToolApprovalDecision = 'allow-once' | 'allow-turn' | 'allow-session' | 'deny';
export type CompanionToolApprovalHandler = (
  request: CompanionToolApprovalRequest,
) => Promise<CompanionToolApprovalDecision>;

export type CompanionEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.started'; toolId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool.finished'; toolId: string; content: string; isError: boolean }
  | { type: 'notice'; message: string; level: 'info' | 'warning' }
  | { type: 'usage'; usage: unknown }
  | { type: 'turn.failed'; message: string }
  | { type: 'turn.completed'; text: string };

export interface CompanionTurnResult {
  turnId: string;
  status: 'completed' | 'failed' | 'cancelled';
  text: string;
  error?: string;
  resumeState: CompanionResumeState;
}

export interface ClaudianCompanionApiV1 {
  readonly apiVersion: typeof CLAUDIAN_COMPANION_API_VERSION;
  readonly claudianVersion: string;
  readonly capabilities: CompanionCapabilities;

  listProviders(): CompanionProvider[];
  createSession(request: CompanionCreateSessionRequest): Promise<CompanionSession>;
  sendMessage(
    sessionId: string,
    request: CompanionMessageRequest,
    onEvent?: (event: CompanionEvent) => void,
    onToolApproval?: CompanionToolApprovalHandler,
  ): Promise<CompanionTurnResult>;
  cancel(sessionId: string): void;
  closeSession(sessionId: string): void;
}
