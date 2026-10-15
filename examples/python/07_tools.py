# Give the model a local tool and let the SDK run the loop: the model calls the tool,
# the SDK runs it and sends the result back, until the model answers in text.
# The input schema comes from the type hints and the docstring becomes the description.
from twigg import Twigg, tool


@tool
def get_weather(city: str) -> dict[str, object]:
    """Current weather for a city."""
    print(f"  (tool called for {city})")
    return {"city": city, "temperature_c": 14, "conditions": "light rain"}


twigg = Twigg(model="gpt-6-luna")
chat = twigg.chats.open(namespace="examples", title="Tools example")

outcome = chat.run_tools(
    "Should I take an umbrella in London and in Lisbon today?", tools=[get_weather]
).final()

print(outcome.result.text)
print("\nturns:", len(outcome.turns), "stop reason:", outcome.stop_reason)
