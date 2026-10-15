# Read a transcript using the history part types (HistoryPrompt, HistoryToolCall, ...).
# `part.type` is the discriminator, so pydantic builds the right class and isinstance narrows.
# Runs a short tool chat first so there is a bit of everything to show.
import random

from twigg import Twigg, tool
from twigg.types import (
    HistoryMessage,
    HistoryPrompt,
    HistoryReasoning,
    HistoryToolCall,
    HistoryToolResult,
)


@tool
def roll_die(sides: int) -> str:
    """Roll a die with the given number of sides."""
    return str(random.randint(1, sides))


twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Typed history")
chat.run_tools("Roll a d20 for me and tell me if it's a critical.", tools=[roll_die]).final()

for item in chat.history(after_ordinal=-1):
    part = item.part
    if isinstance(part, HistoryPrompt):
        print(item.ordinal, "you:", part.text)
    elif isinstance(part, HistoryReasoning):
        print(item.ordinal, "thinking:", part.text or "(hidden by the provider)")
    elif isinstance(part, HistoryToolCall):
        print(item.ordinal, "calls", part.tool_name, part.arguments)
    elif isinstance(part, HistoryToolResult):
        print(item.ordinal, "result", part.tool_name, "->", part.text, "(error)" if part.is_error else "")
    elif isinstance(part, HistoryMessage):
        print(item.ordinal, "model:", part.text)
