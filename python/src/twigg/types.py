"""Friendly names for the generated API models. Regenerate the models with
scripts/generate_models.sh after the pinned spec changes."""

from __future__ import annotations

from ._generated.models import (
    AbortAccepted,
    ApiKeyUsageGroup,
    ApiVersion,
    Catalogue,
    CatalogueModel,
    CatalogueModelResponse,
    ChatCreated,
    ChatPage,
    ChatSummary,
    ConfigVersionResponse,
    ContextBudget,
    ContextBudgetResponse,
    DeactivateResponse,
    DefaultPoliciesResponse,
    Discovery,
    EntryTypeUsageGroup,
    ErrorBody,
    HistoryMedia,
    HistoryMessage,
    HistoryPageResponse,
    HistoryPart,
    HistoryPrompt,
    HistoryReasoning,
    HistoryToolCall,
    HistoryToolResult,
    ImportChatResponse,
    ImportMessage,
    ImportPrompt,
    ImportSkippedResponse,
    ImportToolCall,
    ImportToolResult,
    ImportWarning,
    InstructionResponse,
    ModelUsageGroup,
    NamespacePage,
    NamespaceUsageGroup,
    OrganisationUsageGroup,
    PublicPlatformUpdate,
    ResolvedBudget,
    ResolvedConfig,
    RetentionPolicyResponse,
    RetentionRules,
    RunInspection,
    RunUsageGroup,
    SubmittedMedia,
    SubmittedPrompt,
    SubmittedToolResult,
    ToolDefinition,
    ToolSchemaResponse,
    UnknownHistoryBody,
    Usage,
    UsageReport,
    UsageRow,
)

SubmittedPart = SubmittedPrompt | SubmittedToolResult
"""One part of a submission: a prompt or a tool result."""

ImportPart = ImportPrompt | ImportMessage | ImportToolCall | ImportToolResult
"""One part of a conversation to import. Plain dicts work as well; a tool call's `arguments`
may also be a string holding a JSON object."""

ImportResult = ImportChatResponse | ImportSkippedResponse
"""An import's answer: what was stored, or `skipped=True` when the chat already had history."""

UsageGroup = (
    ModelUsageGroup
    | NamespaceUsageGroup
    | ApiKeyUsageGroup
    | OrganisationUsageGroup
    | EntryTypeUsageGroup
    | RunUsageGroup
)
"""What a usage row is grouped by; the class matches the query's `group_by`."""

ConfigVersion = ConfigVersionResponse
InstructionVersion = InstructionResponse
ToolsVersion = ToolSchemaResponse
ContextBudgetVersion = ContextBudgetResponse
RetentionPolicyVersion = RetentionPolicyResponse
DefaultPolicies = DefaultPoliciesResponse
PlatformUpdate = PublicPlatformUpdate

__all__ = [
    "AbortAccepted",
    "ApiKeyUsageGroup",
    "ApiVersion",
    "Catalogue",
    "CatalogueModel",
    "CatalogueModelResponse",
    "ChatCreated",
    "ChatPage",
    "ChatSummary",
    "ConfigVersion",
    "ConfigVersionResponse",
    "ContextBudget",
    "ContextBudgetResponse",
    "ContextBudgetVersion",
    "DeactivateResponse",
    "DefaultPolicies",
    "DefaultPoliciesResponse",
    "Discovery",
    "EntryTypeUsageGroup",
    "ErrorBody",
    "HistoryMedia",
    "HistoryMessage",
    "HistoryPageResponse",
    "HistoryPart",
    "HistoryPrompt",
    "HistoryReasoning",
    "HistoryToolCall",
    "HistoryToolResult",
    "ImportChatResponse",
    "ImportMessage",
    "ImportPart",
    "ImportPrompt",
    "ImportResult",
    "ImportSkippedResponse",
    "ImportToolCall",
    "ImportToolResult",
    "ImportWarning",
    "InstructionResponse",
    "InstructionVersion",
    "ModelUsageGroup",
    "NamespacePage",
    "NamespaceUsageGroup",
    "OrganisationUsageGroup",
    "PlatformUpdate",
    "PublicPlatformUpdate",
    "ResolvedBudget",
    "ResolvedConfig",
    "RetentionPolicyResponse",
    "RetentionPolicyVersion",
    "RetentionRules",
    "RunInspection",
    "RunUsageGroup",
    "SubmittedMedia",
    "SubmittedPart",
    "SubmittedPrompt",
    "SubmittedToolResult",
    "ToolDefinition",
    "ToolSchemaResponse",
    "ToolsVersion",
    "UnknownHistoryBody",
    "Usage",
    "UsageGroup",
    "UsageReport",
    "UsageRow",
]
