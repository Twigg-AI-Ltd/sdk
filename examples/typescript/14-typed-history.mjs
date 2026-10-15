// Read a transcript using the history part types (HistoryPrompt, HistoryToolCall, ...).
// `part.type` is the discriminator, so a switch narrows each case to its own fields.
// Runs a short tool chat first so there is a bit of everything to show.
import { Twigg, tool } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Typed history" });

const roll = tool({
  name: "roll_die",
  description: "Roll a die with the given number of sides",
  inputSchema: { type: "object", properties: { sides: { type: "integer" } }, required: ["sides"] },
  run: ({ sides }) => String(1 + Math.floor(Math.random() * sides)),
});
await chat.runTools("Roll a d20 for me and tell me if it's a critical.", { tools: [roll] }).final();

for await (const { ordinal, part } of chat.history({ after_ordinal: -1 })) {
  switch (part.type) {
    case "prompt":
      console.log(ordinal, "you:", part.text);
      break;
    case "reasoning":
      console.log(ordinal, "thinking:", part.text || "(hidden by the provider)");
      break;
    case "tool_call":
      console.log(ordinal, "calls", part.tool_name, part.arguments);
      break;
    case "tool_result":
      console.log(ordinal, "result", part.tool_name, "->", part.text, part.is_error ? "(error)" : "");
      break;
    case "message":
      console.log(ordinal, "model:", part.text);
      break;
  }
}
