// A pass-through proxy for api.anthropic.com that records, per model turn:
// the requested max_tokens, the stop_reason, the output token count, and
// whether the assistant turn contained a tool_use block.
//
// Point openwiki at it with ANTHROPIC_BASE_URL=http://127.0.0.1:8787 to get
// per-turn evidence from a REAL generator run.
import http from "node:http";
import { appendFileSync } from "node:fs";

const UPSTREAM = "https://api.anthropic.com";
const LOG = process.env.PROBE_LOG ?? "/tmp/anthropic-probe.jsonl";
let turn = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  let reqInfo = {};
  try {
    const j = JSON.parse(body.toString("utf8"));
    reqInfo = {
      model: j.model,
      max_tokens: j.max_tokens,
      stream: !!j.stream,
      n_messages: j.messages?.length,
      n_tools: j.tools?.length,
    };
  } catch {
    /* not JSON (e.g. a GET) */
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (["host", "content-length", "connection"].includes(k.toLowerCase())) continue;
    headers[k] = v;
  }

  let upstream;
  try {
    upstream = await fetch(UPSTREAM + req.url, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
    appendFileSync(LOG, JSON.stringify({ turn: ++turn, ...reqInfo, proxy_error: String(err) }) + "\n");
    return;
  }

  const outHeaders = {};
  for (const [k, v] of upstream.headers.entries()) {
    // fetch already decoded the body; keeping these would corrupt the response.
    if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  res.writeHead(upstream.status, outHeaders);

  const buf = [];
  if (upstream.body) {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf.push(Buffer.from(value));
      res.write(Buffer.from(value));
    }
  }
  res.end();

  const text = Buffer.concat(buf).toString("utf8");
  // Streaming (SSE) puts the terminal stop_reason in a message_delta; the
  // non-streaming shape puts it at the top level. Take the LAST occurrence.
  const stopReasons = [...text.matchAll(/"stop_reason":\s*"([a-z_]+)"/g)].map((m) => m[1]);
  const outTokens = [...text.matchAll(/"output_tokens":\s*(\d+)/g)].map((m) => Number(m[1]));
  appendFileSync(
    LOG,
    JSON.stringify({
      turn: ++turn,
      status: upstream.status,
      ...reqInfo,
      stop_reason: stopReasons.at(-1) ?? null,
      output_tokens: outTokens.length ? Math.max(...outTokens) : null,
      had_tool_use: /"type":\s*"tool_use"/.test(text),
      // did the turn emit any tool_use AFTER exhausting the budget?
      truncated_without_tool_use:
        stopReasons.at(-1) === "max_tokens" && !/"type":\s*"tool_use"/.test(text),
    }) + "\n",
  );
});

server.listen(8787, "127.0.0.1", () => {
  console.log("probe proxy listening on http://127.0.0.1:8787 -> " + UPSTREAM);
  console.log("logging to " + LOG);
});
