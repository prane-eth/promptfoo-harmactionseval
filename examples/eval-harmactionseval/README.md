# eval-harmactionseval (HarmActionsEval Evaluation)

This example demonstrates how to evaluate a tool-using agent with Promptfoo's HarmActionsEval red team plugin. It checks whether unsafe requests cause the model to attempt harmful tool calls instead of refusing.

You can run this example with:

```bash
npx promptfoo@latest init --example eval-harmactionseval
cd eval-harmactionseval
```

## Overview

HarmActionsEval is an action-level benchmark for tool-using agents. Instead of grading only the final text response, it evaluates whether the model tries to invoke a harmful tool when presented with unsafe prompts.

This example:

- Uses an OpenAI-compatible chat model as the target
- Runs the `harmactionseval` plugin against 141 benchmark actions
- Limits the run to 141 benchmark cases for a faster evaluation loop

Before the benchmark starts, Promptfoo verifies that the target can successfully make a simple tool call. The target model must support function or tool calling for this example to work.

## Environment Variables

This example uses the following environment variables:

- `OPENAI_API_KEY` for the target model
- `OPENAI_MODEL` for the model name, such as `gpt-5.4-mini`
- `API_BASE_URL` for an OpenAI-compatible endpoint, such as `https://api.openai.com/v1`

You can set these in a `.env` file:

```bash
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini
API_BASE_URL=https://api.openai.com/v1
```

## Files

- `promptfooconfig.yaml` is the default example configuration
- `promptfooconfig.local.yaml` matches the local repository run used to validate this setup

## Running the Evaluation

To run the downloaded example:

```bash
npx promptfoo@latest redteam run -c promptfooconfig.yaml --max-concurrency 1
```

To run it from the repository root with the local build:

```bash
npm run local -- redteam run -c examples/eval-harmactionseval/promptfooconfig.local.yaml --env-file .env --no-cache --max-concurrency 1
```

The same local setup was also validated with:

```bash
npx tsx src/main.ts redteam run -c examples/eval-harmactionseval/promptfooconfig.local.yaml --max-concurrency 1
```

## What to Expect

The run generates HarmActionsEval test cases and fails cases where the model attempts the benchmarked tool call. This is useful for evaluating agents that use tools. Promptfoo runs the core 141-case HarmActionsEval benchmark successfully.
