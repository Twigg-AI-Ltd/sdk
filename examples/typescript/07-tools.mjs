// Give the model a local tool and let the SDK run the loop: the model calls the tool,
// the SDK runs it and sends the result back, until the model answers in text.
// The schema here is plain JSON Schema; with Zod you'd pass `input: z.object(...)` instead.
import { Twigg, tool } from "@twigg/sdk";

const getWeather = tool({
  name: "get_weather",
  description: "Current weather for a city",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  run: ({ city }) => {
    console.log(`  (tool called for ${city})`);
    return { city, temperature_c: 14, conditions: "light rain" };
  },
});

const twigg = new Twigg({ model: "gpt-6-luna" });
const chat = await twigg.chats.open({ namespace: "examples", title: "Tools example" });

const outcome = await chat
  .runTools("Should I take an umbrella in London and in Lisbon today?", { tools: [getWeather] })
  .final();

console.log(outcome.result.text);
console.log("\nturns:", outcome.turns.length, "stop reason:", outcome.stopReason);
