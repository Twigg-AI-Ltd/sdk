// Tools with typed, validated input. A schema is either any Standard Schema that can describe
// itself as JSON Schema (Zod 4.2+, ArkType, Valibot with its adapter) or a plain JSON Schema.
import type { ToolCall } from "../streaming/result.js";
import type { ChatId, RunId, SubmittedMedia, ToolDefinition } from "../types.js";

/** The parts of the Standard Schema and Standard JSON Schema interfaces the SDK uses. */
export interface StandardSchema<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly jsonSchema?: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
    };
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
      }>;
    };

export type InferOutput<S> = S extends StandardSchema<unknown, infer O> ? O : unknown;

/** What a tool's `run` sees besides its input. */
export interface ToolContext {
  call: ToolCall;
  chatId: ChatId;
  runId: RunId;
  signal: AbortSignal | undefined;
}

/** The trust level of a tool result, driving how strictly Twigg sanitises it. */
export type TrustLevel = "trusted" | "customer_data" | "untrusted";

/** A tool result with media, an error flag or a trust level. Plain strings and JSON also work. */
export class ToolResult {
  readonly text: string;
  readonly media: SubmittedMedia[];
  readonly isError: boolean;
  readonly trust: TrustLevel | undefined;

  constructor(init: {
    text?: string;
    media?: SubmittedMedia[];
    isError?: boolean;
    trust?: TrustLevel;
  }) {
    this.text = init.text ?? "";
    this.media = init.media ?? [];
    this.isError = init.isError ?? false;
    this.trust = init.trust;
  }
}

/** What `run` may return: a string, a ToolResult, or any JSON value (sent as JSON text). */
export type ToolOutput = string | ToolResult | unknown;

export interface Tool<Input = unknown> {
  readonly name: string;
  /** The definition sent to Twigg: name, description and JSON Schema. */
  readonly definition: ToolDefinition;
  /** Validate the model's arguments. */
  parse(input: unknown): Promise<{ ok: true; value: Input } | { ok: false; message: string }>;
  run(input: Input, context: ToolContext): ToolOutput | Promise<ToolOutput>;
}

/** A tool of any input type, for collections of tools. */
// biome-ignore lint/suspicious/noExplicitAny: a tool's input type is erased once it is in a list.
export type AnyTool = Tool<any>;

interface BaseSpec<Input> {
  name: string;
  description?: string;
  /** Ask the provider to guarantee calls validate against the schema. */
  strict?: boolean;
  run: (input: Input, context: ToolContext) => ToolOutput | Promise<ToolOutput>;
}

/** A tool whose input is described and validated by a Standard Schema, such as Zod. */
export interface SchemaToolSpec<S extends StandardSchema> extends BaseSpec<InferOutput<S>> {
  input: S;
  /** JSON Schema to send, for a library that cannot produce one itself. */
  inputSchema?: Record<string, unknown>;
}

/** A tool described by a plain JSON Schema. Input is not validated beyond JSON parsing. */
export interface JsonToolSpec<Input> extends BaseSpec<Input> {
  inputSchema: Record<string, unknown>;
}

export function tool<S extends StandardSchema>(spec: SchemaToolSpec<S>): Tool<InferOutput<S>>;
export function tool<Input = unknown>(spec: JsonToolSpec<Input>): Tool<Input>;
export function tool(spec: SchemaToolSpec<StandardSchema> | JsonToolSpec<unknown>): Tool {
  const schema = "input" in spec ? spec.input : undefined;
  const inputSchema =
    spec.inputSchema ?? schema?.["~standard"].jsonSchema?.input({ target: "draft-2020-12" });
  if (!inputSchema)
    throw new TypeError(
      `Tool ${spec.name}: the input schema cannot describe itself as JSON Schema. Pass inputSchema too.`,
    );
  // The meta-schema URI adds nothing for a provider and some reject it.
  const { $schema: _, ...input_schema } = inputSchema;
  return {
    name: spec.name,
    definition: {
      name: spec.name,
      description: spec.description ?? null,
      input_schema,
      ...(spec.strict === undefined ? {} : { strict: spec.strict }),
    },
    async parse(value) {
      if (!schema) return { ok: true, value };
      const result = await schema["~standard"].validate(value);
      if (!result.issues) return { ok: true, value: result.value };
      return {
        ok: false,
        message: result.issues
          .map((issue) => {
            const path = (issue.path ?? [])
              .map((p) => String(typeof p === "object" ? p.key : p))
              .join(".");
            return path ? `${path}: ${issue.message}` : issue.message;
          })
          .join("; "),
      };
    },
    run: spec.run as Tool["run"],
  };
}
