// The tool loop by hand, without runTools: send a tool definition with the turn,
// read the model's pending tool calls, and answer them with tool_result parts.
// This is what runTools automates, and what you'd do for a tool that needs a human.
import { Twigg } from "@twigg/sdk";

const tools = [
  {
    name: "lookup_order",
    description: "Look up an order by id",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Manual tools" }, { tools });

let result = await chat.send("Where is order A-1042?");
while (result.pendingToolCalls.length > 0) {
  const answers = result.pendingToolCalls.map((call) => {
    console.log("model asked for", call.name, call.input);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      tool_name: call.name,
      text: JSON.stringify({ status: "shipped", eta: "Friday" }),
    };
  });
  result = await chat.send(answers);
}

console.log(result.text);
