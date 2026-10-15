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
