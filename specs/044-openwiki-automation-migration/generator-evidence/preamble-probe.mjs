// Probe 2: when the 4096-token budget is consumed by narration BEFORE the model
// emits a tool_use block, does the turn come back with zero tool calls (the
// ReAct loop's exit condition)?
import { ChatAnthropic } from "/usr/local/lib/node_modules/openwiki/node_modules/@langchain/anthropic/dist/index.js";
import { tool } from "/usr/local/lib/node_modules/openwiki/node_modules/@langchain/core/dist/tools/index.js";
import * as z from "/usr/local/lib/node_modules/openwiki/node_modules/zod/index.js";

const writeFile = tool(async () => "ok", {
  name: "write_file",
  description: "Write a file to the wiki.",
  schema: z.object({ file_path: z.string(), content: z.string() }),
});

const PROMPT =
  "Before you call any tool, think out loud in plain prose at length. " +
  "Write a detailed narration of your investigative plan for documenting " +
  "this repository's package-manager enforcement invariant: what you would " +
  "read, in what order, what you would cross-check, what the risks are, " +
  "what the style rules imply, and how you would verify each claim. Be " +
  "exhaustive and discursive - at least 3000 words of narration. THEN, " +
  "after all of that, call write_file to create the page.";

for (const modelId of ["claude-sonnet-5", "claude-sonnet-4-5"]) {
  const model = new ChatAnthropic(modelId, {
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  const res = await model.bindTools([writeFile]).invoke(PROMPT);
  const text = typeof res.content === "string"
    ? res.content
    : res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const nCalls = res.tool_calls?.length ?? 0;
  console.log(`\n=== ${modelId} (maxTokens=${model.maxTokens}) ===`);
  console.log("  stop_reason:", res.response_metadata?.stop_reason);
  console.log("  output_tokens:", res.usage_metadata?.output_tokens);
  console.log("  tool_calls:", nCalls);
  console.log("  text ends with: ..." + JSON.stringify(text.slice(-90)));
  console.log(
    `  >>> ReAct loop: ${nCalls === 0 ? "EXIT — run ends, exit 0, NOTHING WRITTEN" : "continue"}`,
  );
}
