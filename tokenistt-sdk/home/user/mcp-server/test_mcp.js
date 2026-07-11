/**
 * test_mcp.js
 * Automated test runner for the Tokenistt MCP SSE Server.
 * Connects to the SSE stream, resolves the sessionId, sends a tools/list JSON-RPC call, and outputs the result.
 * Run with: node test_mcp.js
 */

async function test() {
  console.log("Connecting to MCP SSE endpoint: http://localhost:3002/sse ...");
  const response = await fetch("http://localhost:3002/sse");
  
  if (!response.body) {
    console.error("Failed to read SSE response body stream.");
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  
  let buffer = "";
  let sessionId = null;
  
  // Read chunks of SSE stream until we get the sessionId
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    
    // Look for: /messages?sessionId=...
    const match = buffer.match(/sessionId=([a-f0-9\-]+)/i) || buffer.match(/sessionId=([^&\s\r\n]+)/);
    if (match) {
      sessionId = match[1];
      console.log(`Successfully obtained Session ID: ${sessionId}`);
      break;
    }
  }
  
  if (!sessionId) {
    console.error("Could not parse sessionId from the SSE stream.");
    process.exit(1);
  }
  
  console.log("\nSending tools/list JSON-RPC request to /messages...");
  const rpcRes = await fetch(`http://localhost:3002/messages?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {}
    })
  });
  
  if (rpcRes.ok) {
    console.log("SUCCESS! MCP Server returned the following tools:");
    const result = await rpcRes.json();
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(`Error: RPC Request failed with status ${rpcRes.status}`);
    console.error(await rpcRes.text());
  }
  
  process.exit(0);
}

test().catch(console.error);
