const readline = require("node:readline");
const marker = process.argv[2];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  switch (message.method) {
    case "initialize":
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: marker, version: "1.0.0" } };
      break;
    case "tools/list":
      result = { tools: [{ name: `probe_${marker}`, description: `Synthetic ${marker}`,
        inputSchema: { type: "object", properties: {} } }] };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: marker }] };
      break;
    case "ping": result = {}; break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        error: { code: -32601, message: "Unsupported fixture method" } }) + "\n");
      return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
