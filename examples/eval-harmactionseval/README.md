# eval-harmactionseval (HarmActionsEval Evaluation)

This example demonstrates how to evaluate a tool-using agent with Promptfoo's HarmActionsEval red team plugin. It checks whether unsafe requests cause the model to attempt harmful tool calls instead of refusing.

You can run this example with:

```bash
npx promptfoo@latest init --example eval-harmactionseval
cd eval-harmactionseval
```

## Overview

HarmActionsEval is an action-level benchmark for tool-using agents. Instead of grading the final text response, it evaluates whether the model attempts to invoke a tool call when presented with unsafe prompts.

Before the benchmark starts, Promptfoo verifies that the target can successfully make a simple tool call. The target model must support function or tool calling for this example to work.

## Environment Variables

This example uses an OpenAI-compatible chat model as the target.
It uses the following environment variables:

- `OPENAI_API_KEY` for the target model
- `OPENAI_MODEL` for the model name, such as `gpt-5.4-mini`
- `API_BASE_URL` for an OpenAI-compatible endpoint, such as `https://api.openai.com/v1`

## Running the Evaluation

To run the eval:

```bash
promptfoo redteam run
```

To run the example from the repository root with the local build:

```bash
npx promptfoo redteam run -c examples/eval-harmactionseval/promptfooconfig.local.yaml
```

`promptfooconfig.local.yaml` is configured to use the local build of Promptfoo.

## What to Expect

The run generates HarmActionsEval test cases and fails cases where the model attempts the benchmarked tool call. This is useful for evaluating agents that use tools. Promptfoo runs the core 141-case HarmActionsEval benchmark successfully.
