export type LocalAgentProfile = 'baseline-v1' | 'single-agent-v1' | 'single-agent-no-thinking-v1' | 'compact-v1';
export type LocalContextStrategy = 'direct-v1' | 'staged-v1' | 'staged-request-v2';

export interface LocalContextIntent {
  goal: string;
  constraints: string[];
  searchTerms: string[];
}

export interface LocalContextStageEvidence {
  name: 'intent' | 'selection';
  status: 'running' | 'completed' | 'failed';
  durationMs: number;
  error: string | null;
  inputBytes: number;
  /** No tokenizer runs here. Runtime prompt counts are recorded separately. */
  inputTokens: null;
  promptTokens: number | null;
  outputTokens: number | null;
  doneReason: string | null;
  loadDurationNs: number | null;
  promptEvalDurationNs: number | null;
  evalDurationNs: number | null;
}

export interface LocalContextPreparationEvidence {
  strategy: 'staged-v1' | 'staged-request-v2';
  status: 'running' | 'completed' | 'failed';
  originalPromptSha256: string;
  effectivePromptSha256: string | null;
  originalPromptBytes: number;
  /** Present only for v2: the caller-supplied literal request, never an inferred extraction. */
  requestSha256?: string;
  requestBytes?: number;
  requestOffsetBytes?: number;
  effectivePromptBytes: number | null;
  durationMs: number;
  error: string | null;
  intent: LocalContextIntent | null;
  inventory: { paths: string[]; bytes: number; truncated: boolean };
  selectedPaths: string[];
  excerpts: { path: string; sha256: string; bytes: number; lines: number; truncated: boolean }[];
  stages: LocalContextStageEvidence[];
  options: { num_ctx: number; num_predict: number; temperature: number; top_p: number; top_k: number; seed: number; think: false; timeoutMs: number };
}

/** Requested CLI configuration; request serialization and effectiveness need separate evidence. */
export interface LocalAgentProfileEvidence {
  agentProfile: LocalAgentProfile;
  requestedReasoning: 'none' | null;
  /** Exact non-path profile overrides. Contract content is identified separately by hash. */
  appliedSettings: Record<string, string | boolean>;
  contractSha256: string | null;
}

/** Developer evaluation configuration. Reported runtime capabilities are not validation evidence. */
export interface LocalInferenceConfig {
  runtime: 'ollama';
  endpoint: string;
  model: string;
  modelDigest: string;
  /** Agent context budget; does not configure Ollama's actual num_ctx. */
  contextWindow: number;
  agentProfile?: LocalAgentProfile;
  /** Experimental advisory retrieval. Direct preserves the existing agent prompt. */
  contextStrategy?: LocalContextStrategy;
}

/** Identifiers observed on the wire; does not establish model tool-use quality. */
export interface LocalToolContract {
  type: string;
  name: string;
  namespace: string;
}

/** Runtime reports only. These fields are not model-quality or hardware validation. */
export interface LocalInferenceEvidence extends Partial<LocalAgentProfileEvidence> {
  runtime: 'ollama';
  runtimeVersion: string;
  model: string;
  modelDigest: string;
  reportedCapabilities: string[];
  validatedCapabilities: string[];
  requestedAgentContextWindow: number;
  effectiveRuntimeContext: null;
  effectiveRuntimeContextReason: string;
  observedToolContracts?: LocalToolContract[];
  contextPreparation?: LocalContextPreparationEvidence;
}
