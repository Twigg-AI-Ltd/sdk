# The tool loop by hand, without run_tools: send a tool definition with the turn,
# read the model's pending tool calls, and answer them with tool_result parts.
# This is what run_tools automates, and what you'd do for a tool that needs a human.
import json

from twigg import Twigg

tools = [
    {
        "name": "lookup_order",
        "description": "Look up an order by id",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    }
]

twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(
    namespace="examples", title="Manual tools", defaults={"tools": tools}
)

result = chat.send("Where is order A-1042?")
while result.pending_tool_calls:
    answers: list[dict[str, str]] = []
    for call in result.pending_tool_calls:
        print("model asked for", call.name, call.input)
        answers.append(
            {
                "type": "tool_result",
                "tool_use_id": call.id,
                "tool_name": call.name,
                "text": json.dumps({"status": "shipped", "eta": "Friday"}),
            }
        )
    result = chat.send(answers)

print(result.text)
