---
sidebar_label: HarmActionsBench
description: Red team agent action safety using HarmActionsBench to detect harmful tool calls and unsafe agent behavior at the action level
---

# HarmActionsBench Plugin

The HarmActionsBench plugin evaluates agent safety based on agent actions rather than final responses. This makes it useful for agentic systems that can invoke tools directly, especially when you want to verify whether the agent will:

- Call a harmful tool instead of refusing
- Translate obfuscated unsafe prompts into tool execution
- Trigger disallowed actions against external systems or resources

## How it works

The plugin:

- Loads a static dataset of harmful agent actions
- Converts each benchmark action into a function tool schema
- Fails the test if the model attempts the benchmarked harmful tool call

Unlike existing benchmarks which focus on harmful textual behaviors, HarmActionsBench is specifically designed for tool-using agents and action safety controls.

## Configuration

To include HarmActionsBench in your red team setup:

```yaml
redteam:
  plugins:
    - harmactionsbench
```

You can control the number of test cases using `numTests`:

```yaml
redteam:
  plugins:
    - id: harmactionsbench
      numTests: 25
```

## When to use it

Use HarmActionsBench when your target application:

- Exposes tools or function calls to the model
- Uses MCP, OpenAI tools, or provider-native function calling
- Needs validation that unsafe requests do not become executed actions

For agentic systems, this benchmark complements plugins such as:

- [Excessive Agency](excessive-agency.md)
- [Hijacking](hijacking.md)
- [Tool Discovery](tool-discovery.md)
- [Memory Poisoning](memory-poisoning.md)

## Related Concepts

- [HarmBench Plugin](harmbench.md)
- [Model Context Protocol](mcp.md)
- [Types of LLM Vulnerabilities](../llm-vulnerability-types.md)

## Acknowledgements

HarmActionsBench is based on the Agent Action Guard benchmark created by Praneeth Vadlapati and licensed under CC-BY-4.0. More information is available at https://github.com/Pro-GenAI/Agent-Action-Guard.
