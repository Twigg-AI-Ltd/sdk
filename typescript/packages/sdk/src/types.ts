// Friendly names over the generated OpenAPI types. Regenerate the schema with `pnpm gen:types`
// after `node scripts/sync-spec.mjs` at the repository root.
import type { components, operations } from "./generated/schema.js";

type Schemas = components["schemas"];
type Query<Operation extends keyof operations> = NonNullable<
  operations[Operation]["parameters"]["query"]
>;

// Identifiers
export type ChatId = Schemas["ChatId"];
export type ExternalChatId = Schemas["ExternalChatId"];
export type ChatPartId = Schemas["ChatPartId"];
export type RunId = Schemas["RunId"];
export type ModelId = Schemas["ModelId"];
export type ToolUseId = Schemas["ToolUseId"];
export type Namespace = Schemas["Namespace"];
export type SystemInstructionId = Schemas["SystemInstructionId"];
export type ToolSchemaId = Schemas["ToolSchemaId"];
export type ContextBudgetPolicyId = Schemas["ContextBudgetPolicyId"];
export type RetentionPolicyId = Schemas["RetentionPolicyId"];

// Errors
export type ErrorBody = Schemas["ErrorBody"];
export type ErrorEnvelope = Schemas["ErrorEnvelope"];

// Chats and history
export type CreateChatRequest = Schemas["CreateChatRequest"];
export type OpenChatRequest = Schemas["OpenChatRequest"];
export type ChatCreated = Schemas["ChatCreated"];
export type ChatSummary = Schemas["ChatSummary"];
export type ChatPage = Schemas["ChatPage"];
export type ListChatsQuery = Query<"listChats">;
export type GetChatQuery = Query<"getChat">;
export type UpdateChatRequest = Schemas["UpdateChatRequest"];
export type UserMetadataPatch = Schemas["UserMetadataPatch"];
export type ChatUsage = Schemas["ChatUsage"];
export type ChatsDeleted = Schemas["ChatsDeleted"];
export type HistoryQuery = Query<"getChatHistory">;
export type HistoryPageResponse = Schemas["HistoryPageResponse"];
export type HistoryPart = Schemas["HistoryPart"];
export type HistoryBody = Schemas["HistoryBody"];
export type HistoryPrompt = Schemas["HistoryPrompt"];
export type HistoryToolResult = Schemas["HistoryToolResult"];
export type HistoryMessage = Schemas["HistoryMessage"];
export type HistoryReasoning = Schemas["HistoryReasoning"];
export type HistoryToolCall = Schemas["HistoryToolCall"];
export type HistoryMedia = Schemas["HistoryMedia"];
export type UserMetadata = Schemas["UserMetadata"];
/** Your own JSON on a submitted part, stored beside it and never sent to a model. */
export type ClientData = Schemas["ClientData"];

// Importing a conversation
export type ImportPrompt = Schemas["ImportPrompt"];
export type ImportMessage = Schemas["ImportMessage"];
/** The API also takes `arguments` as a string holding a JSON object, as many histories store it. */
export type ImportToolCall = Omit<Schemas["ImportToolCall"], "arguments"> & {
  arguments: Record<string, unknown> | string;
};
export type ImportToolResult = Schemas["ImportToolResult"];
export type ImportPart = ImportPrompt | ImportMessage | ImportToolCall | ImportToolResult;
export type ImportChatRequest = Omit<Schemas["ImportChatRequest"], "parts"> & {
  parts: ImportPart[];
};
export type ImportChatResponse = Schemas["ImportChatResponse"];
export type ImportSkippedResponse = Schemas["ImportSkippedResponse"];
/** An import's answer: what was stored, or `skipped: true` when the chat already had history. */
export type ImportResult = ImportChatResponse | ImportSkippedResponse;
export type ImportWarning = Schemas["ImportWarning"];
export type ImportWarningCode = Schemas["ImportWarningCode"];

// Responses
export type CreateResponseRequest = Schemas["CreateResponseRequest"];
export type SubmittedPart = Schemas["SubmittedPart"];
export type SubmittedPrompt = Schemas["SubmittedPrompt"];
export type SubmittedToolResult = Schemas["SubmittedToolResult"];
export type SubmittedMedia = Schemas["SubmittedMedia"];
export type ResponseEvent = Schemas["ResponseEvent"];
export type BlockStart = Schemas["BlockStart"];
export type Delta = Schemas["Delta"];
export type PendingCall = Schemas["PendingCall"];
export type StopReason = Schemas["StopReason"];
export type Usage = Schemas["Usage"];
export type ReasoningEffort = Schemas["ReasoningEffort"];
export type AbortAccepted = Schemas["AbortAccepted"];
export type ConfigWarning = Schemas["Warning_ConfigWarning"];
export type TranslationWarning = Schemas["Warning_TranslationWarning"];
export type ModelRoutedWarning = Schemas["ModelRoutedWarning"];
export type RouteDecision = Schemas["RouteDecision"];
export type RouterFallbackReason = Schemas["RouterFallbackReason"];

// Runs
export type RunInspection = Schemas["RunInspection"];
export type RunStatus = Schemas["RunStatus"];
export type RunSummary = Schemas["RunSummary"];
export type RunPage = Schemas["RunPage"];
export type ListRunsQuery = Query<"listChatRuns">;

// Catalogue and models
export type Catalogue = Schemas["Catalogue"];
export type CatalogueModel = Schemas["CatalogueModel"];
export type CatalogueModelResponse = Schemas["CatalogueModelResponse"];
export type CatalogueRouter = Schemas["CatalogueRouter"];
export type Provider = Schemas["Provider"];
export type NamespacePage = Schemas["NamespacePage"];

// Usage
export type UsageQuery = Query<"queryUsage">;
export type UsageDimension = Schemas["UsageDimension"];
export type UsageGroup = Schemas["UsageGroup"];
/** A row whose `group` is narrowed to the dimension the query grouped by (`null` when ungrouped). */
export type UsageRow<D extends UsageDimension | undefined = UsageDimension | undefined> = Omit<
  Schemas["UsageRow"],
  "group"
> & { group: D extends UsageDimension ? Extract<UsageGroup, { dimension: D }> : null };
export type UsageReport<D extends UsageDimension | undefined = UsageDimension | undefined> = Omit<
  Schemas["UsageReport"],
  "rows"
> & { rows: UsageRow<D>[] };

// Configuration
export type ConfigMode = Schemas["ConfigMode"];
export type ConfigVersion = Schemas["ConfigVersionResponse"];
export type DeactivateResponse = Schemas["DeactivateResponse"];
export type ToolDefinition = Schemas["ToolDefinition"];
export type PublishInstructionRequest = Schemas["PublishInstructionRequest"];
export type InstructionVersion = Schemas["InstructionResponse"];
export type PublishToolsRequest = Schemas["PublishToolsRequest"];
export type ToolsVersion = Schemas["ToolSchemaResponse"];
export type ContextBudget = Schemas["ContextBudget"];
export type PublishContextBudgetRequest = Schemas["PublishContextBudgetRequest"];
export type ContextBudgetVersion = Schemas["ContextBudgetResponse"];
export type RetentionRules = Schemas["RetentionRules"];
export type PublishRetentionPolicyRequest = Schemas["PublishRetentionPolicyRequest"];
export type RetentionPolicyVersion = Schemas["RetentionPolicyResponse"];
export type ResolvedConfig = Schemas["ResolvedConfig"];
export type ResolvedBudget = Schemas["ResolvedBudget"];
export type DefaultPolicies = Schemas["DefaultPoliciesResponse"];
export type ConfigDeletion = Schemas["ConfigDeletion"];

// Discovery
export type Discovery = Schemas["Discovery"];
export type ApiVersion = Schemas["ApiVersion"];
export type PlatformUpdate = Schemas["PublicPlatformUpdate"];

// Money is a decimal string. Keep it one; parsing it into a float loses cents.
export type Money = Schemas["Money"];

type EventData<E extends ResponseEvent["event"]> = Extract<ResponseEvent, { event: E }>["data"];
export type RunEventData = EventData<"run">;
export type CompactingData = EventData<"compacting">;
export type DoneEventData = EventData<"done">;
