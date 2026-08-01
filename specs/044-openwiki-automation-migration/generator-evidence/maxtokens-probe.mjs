// Probe: does the pinned model's default maxTokens truncate a page-writing
// tool call into a turn with NO tool calls (which is the ReAct loop's stop
// condition)? Uses the exact ChatAnthropic that openwiki constructs.
import { ChatAnthropic } from "/usr/local/lib/node_modules/openwiki/node_modules/@langchain/anthropic/dist/index.js";
import { tool } from "/usr/local/lib/node_modules/openwiki/node_modules/@langchain/core/dist/tools/index.js";
import * as z from "/usr/local/lib/node_modules/openwiki/node_modules/zod/index.js";

const writeFile = tool(async () => "ok", {
  name: "write_file",
  description: "Write a file to the wiki.",
  schema: z.object({
    file_path: z.string(),
    content: z.string().describe("The full markdown content of the page"),
  }),
});

const PROMPT =
  "Write the full markdown page /invariants/package-manager-enforcement.md " +
  "using the write_file tool. It must be a thorough, complete reference page " +
  "of at least 400 lines covering: why npm and yarn are hard-blocked, the " +
  "root package.json preinstall only-allow pnpm script, how a fresh clone " +
  "fails, CI enforcement, troubleshooting, worked examples, and an FAQ. " +
  "Do not summarise - emit the entire page content in the tool call.";

for (const modelId of ["claude-sonnet-5", "claude-sonnet-4-5"]) {
  const model = new ChatAnthropic(modelId, {
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  console.log(`\n=== ${modelId} — resolved maxTokens = ${model.maxTokens} ===`);
  const res = await model.bindTools([writeFile]).invoke(PROMPT);
  console.log("  stop_reason :", res.response_metadata?.stop_reason);
  console.log("  usage       :", JSON.stringify(res.usage_metadata));
  console.log("  tool_calls  :", res.tool_calls?.length ?? 0);
  console.log(
    "  invalid_tool_calls:",
    res.invalid_tool_calls?.length ?? 0,
  );
  const graphWouldExit =
    !res.tool_calls || res.tool_calls.length === 0;
  console.log(
    `  >>> ReAct loop would ${graphWouldExit ? "EXIT (write nothing, exit 0)" : "CONTINUE to the tool node"}`,
  );
}
