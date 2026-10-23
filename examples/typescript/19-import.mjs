// Bring a conversation that started elsewhere into Twigg, then carry on with it. The import only
// writes to an empty chat, so running it twice is safe: the second time answers `skipped`.
import { Twigg } from "@twigg/sdk";

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = twigg.chatByExternalId(`examples:import-${Date.now()}`, {
  chat: { namespace: "examples" },
});

const imported = await chat.importHistory([
  { type: "prompt", text: "Hi, I'm Ann. Where is order 7?" },
  { type: "tool_call", tool_use_id: "c1", name: "track_order", arguments: { order: 7 } },
  { type: "tool_result", tool_use_id: "c1", tool_name: "track_order", text: "Shipped today" },
  { type: "message", text: "Order 7 shipped today." },
]);
if ("skipped" in imported) console.log(`already had ${imported.existing_parts} parts`);
else {
  console.log(`stored ${imported.imported_parts} parts for $${imported.cost}`);
  for (const warning of imported.warnings) console.log(`  ${warning.code}: ${warning.message}`);
}

const again = await chat.importHistory([{ type: "prompt", text: "Not stored" }]);
console.log("skipped" in again ? "second import skipped" : "second import stored");

console.log((await chat.send("What's my name, and which order did I ask about?")).text);
await chat.delete();
