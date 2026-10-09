import { test, expect, type Page, type Route } from "@playwright/test";

const event = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, timestamp: "", data });
async function setup(page: Page, events: ReturnType<typeof event>[]) {
  const session = { sessionId: "rendering", title: "Rendering fixture", cwd: "Q:\\fixture", model: "model",
    isActive: true, isRemote: false, pinned: false, archived: false, tags: [], startTime: "", modifiedTime: "" };
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    class Events extends EventTarget {
      onopen: (() => void) | null = null;
      listener = (event: Event) => {
        if (event instanceof CustomEvent) this.dispatchEvent(new MessageEvent("session-event", { data: JSON.stringify(event.detail) }));
      };
      constructor() { super(); window.addEventListener("code-fixture", this.listener); setTimeout(() => this.onopen?.(), 0); }
      close() { window.removeEventListener("code-fixture", this.listener); }
    }
    Object.defineProperty(window, "EventSource", { value: Events });
  });
  await page.route("**/api/**", (route) => {
    const command = new URL(route.request().url()).pathname.split("/").at(-1)!;
    const result: Record<string, unknown> = {
      list_sessions: [session], resume_session: session, runtime_status: { connected: true, acceptingWork: true },
      session_state: { sessionId: session.sessionId, processing: false, mode: "interactive" }, session_processing: false,
      queue_items: { items: [], steeringMessages: [] }, agent_tasks: { sessionId: session.sessionId, tasks: [] },
      get_session_profile: { sessionId: session.sessionId, profile: null, applying: false, configurationBlocked: false, requiresReconnect: false, error: null },
      pending_permissions: [], pending_interactions: [], subagent_context: [], git_repository: { isRepository: false },
      session_history_window: { events, hasMore: false, cursor: "", loadedPages: 1, humanMessages: 0 },
    };
    return command in result ? route.fulfill({ json: result[command] }) : route.fulfill({ status: 404, body: `Unexpected ${command}` });
  });
  await page.goto("/?session=rendering");
  await expect(page.locator(".parent-session-view .composer textarea")).toBeEnabled();
  return { requests, emit: (item: ReturnType<typeof event>) => page.evaluate((item) =>
    window.dispatchEvent(new CustomEvent("code-fixture", { detail: { type: "session_event", sessionId: "rendering", event: item } })), item) };
}

test("fenced source is highlighted locally with exact raw-source switching and safe unknown-language fallback", async ({ page }) => {
  const js = "const value = '<script>alert(1)</script>';\n  console.log(value);\n";
  const unknown = "one\n  two\n\nthree <img src=x>\n";
  const { requests } = await setup(page, [event("answer", "assistant.message", {
    content: `Inline \`const x\` stays inline.\n\n\`\`\`js\n${js}\`\`\`\n\n\`\`\`unknown-language\n${unknown}\`\`\``,
  })]);
  const block = page.locator(".code-block[data-language='javascript']");
  await block.scrollIntoViewIfNeeded();
  await expect(block.locator(".hljs-keyword")).toContainText("const");
  await expect(block.locator("pre code")).toHaveText(js);
  await expect(block.locator("script,img")).toHaveCount(0);
  await block.getByRole("checkbox", { name: "Show raw source" }).check();
  await expect(block.locator(".hljs-keyword")).toHaveCount(0);
  expect(await block.locator("pre code").textContent()).toBe(js);
  await block.getByRole("checkbox", { name: "Show raw source" }).uncheck();
  await expect(block.locator(".hljs-keyword")).toHaveCount(1);
  const other = page.locator(".code-block[data-language='unknown-language']");
  await other.scrollIntoViewIfNeeded();
  expect(await other.locator("pre code").textContent()).toBe(unknown);
  await expect(other.locator("img")).toHaveCount(0);
  expect(requests.some((url) => url.includes("highlight.worker"))).toBe(true);
  expect(requests.some((url) => url.includes("renderMermaid"))).toBe(false);
});

test("PowerShell execution output keeps line breaks and indentation while raw output preserves the complete payload", async ({ page }) => {
  const command = '$n = 1\nWrite-Output "hello"\n\n  # keep indentation';
  const output = "Name    Value\nfirst   1\nsecond  2\n\n  Indented detail\n<script>not executable</script>";
  const result = { output, exitCode: 0 };
  const { requests } = await setup(page, [
    event("start", "tool.execution_start", { toolCallId: "shell", toolName: "powershell", arguments: { command } }),
    event("end", "tool.execution_complete", { toolCallId: "shell", success: true, result }),
  ]);
  await page.locator(".tool-card .timeline-disclosure").click();
  const args = page.locator(".detail-block").filter({ has: page.getByRole("heading", { name: "Arguments", exact: true }) });
  await args.scrollIntoViewIfNeeded();
  await expect(args.locator(".code-block[data-language='powershell'] .hljs-built_in")).not.toHaveCount(0);
  expect(await args.locator("pre code").textContent()).toBe(command);
  const resultBlock = page.locator(".detail-block").filter({ has: page.getByRole("heading", { name: "Result", exact: true }) });
  await resultBlock.scrollIntoViewIfNeeded();
  expect(await resultBlock.locator("pre code").textContent()).toBe(output);
  await expect(resultBlock.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  await resultBlock.getByRole("checkbox", { name: "Show raw output" }).check();
  expect(await resultBlock.locator("pre code").textContent()).toBe(JSON.stringify(result, null, 2));
  await resultBlock.getByRole("checkbox", { name: "Show raw output" }).uncheck();
  expect(await resultBlock.locator("pre code").textContent()).toBe(output);
  await expect(resultBlock.locator("script")).toHaveCount(0);
  expect(requests.some((url) => /set_|send_message|execute_command/.test(new URL(url).pathname))).toBe(false);
});

test("slash command text keeps soft line breaks and JSON output gets readable syntax formatting", async ({ page }) => {
  const text = "First line\nSecond line\n  Indented line";
  await setup(page, [
    event("cmd", "command.result", { command: "/fixture", result: { text, extra: "visible in raw output" } }),
    event("json-start", "tool.execution_start", { toolCallId: "json", toolName: "fixture", arguments: {} }),
    event("json-end", "tool.execution_complete", { toolCallId: "json", result: '{"ok":true,"count":3}' }),
  ]);
  await page.locator(".command-result > summary").click();
  const command = page.locator(".command-result-content");
  await expect(command.locator("pre")).toHaveCSS("white-space", "pre-wrap");
  expect(await command.locator("pre code").textContent()).toBe(text);
  await command.getByRole("checkbox", { name: "Show raw output" }).check();
  await expect(command.locator("pre")).toContainText('"extra": "visible in raw output"');
  await page.locator(".tool-card .timeline-disclosure").click();
  const result = page.locator(".detail-block").filter({ has: page.getByRole("heading", { name: "Result", exact: true }) });
  await result.scrollIntoViewIfNeeded();
  await expect(result.locator(".hljs-attr")).toHaveCount(2);
  expect(await result.locator("pre code").textContent()).toBe('{\n  "ok": true,\n  "count": 3\n}');
  await result.getByRole("checkbox", { name: "Show raw output" }).check();
  expect(await result.locator("pre code").textContent()).toBe('{"ok":true,"count":3}');
});

test("Mermaid renders locally with a raw-source checkbox and responds to theme changes", async ({ page }) => {
  const source = "flowchart LR\n  Start --> Finish\n";
  const { requests } = await setup(page, [event("diagram", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByRole("img", { name: "Mermaid diagram" }).locator("svg")).toBeVisible({ timeout: 20000 });
  await expect(block.locator("svg")).toContainText("Start");
  await expect(block.locator("svg")).toContainText("Finish");
  const before = await block.locator("svg").getAttribute("id");
  await block.getByRole("checkbox", { name: "Show raw source" }).check();
  expect(await block.locator("pre code").textContent()).toBe(source);
  await expect(block.locator("svg")).toHaveCount(0);
  await block.getByRole("checkbox", { name: "Show raw source" }).uncheck();
  await expect(block.locator("svg")).toHaveAttribute("id", before!);
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; });
  await expect(block.locator("svg")).not.toHaveAttribute("id", before!);
  expect(requests.every((url) => new URL(url).hostname === "127.0.0.1")).toBe(true);
});

test("nested Mermaid subgraphs render with node styling and preserve the original source", async ({ page }) => {
  const source = `flowchart TB
    subgraph Worker["Worker node — outbound path"]
        subgraph Guest["Guest A"]
            App["Workload"]
            NIC["Guest NIC<br/>169.254.0.2"]
            App --> NIC
        end
        subgraph Shim["Host: sandbox network namespace A"]
            TAP["tap0"]
            SNAT["Forward + SNAT<br/>source → 192.168.0.10"]
            Veth["Shim veth"]
            TAP --> SNAT --> Veth
        end
        subgraph Root["Host: root network namespace"]
            Bridge["Shared internal bridge<br/>host gateway: 192.168.0.1"]
            Rules["Kernel rules"]
            NodeAgent["Node agent"]
            subgraph Proxy["Proxy process — shared per node"]
                DNS["DNS listener — FEATURE BRANCH<br/>bound to bridge gateway address"]
                Upstream["Allowed custom-network DNS query:<br/>new socket + sandbox A's mark"]
                DNS --> Upstream
            end
            Routing["Host policy routing<br/>mark A → A's routing table"]
            TunnelBridge["Tunnel bridge<br/>next hop: A's tunnel namespace"]
            Bridge --> Rules
            Rules -->|"Eligible port-53 traffic: REDIRECT"| DNS
            Rules -->|"Non-intercepted traffic: mark A"| Routing
            NodeAgent -.->|"launches"| Proxy
            Upstream --> Routing
            Routing --> TunnelBridge
        end
        subgraph Tunnel["Host: per-sandbox tunnel network namespace A"]
            TunnelVeth["Tunnel veth"]
            TUN["Route to tunnel device<br/>SNAT to tunnel address"]
            Client["Tunnel client"]
            TunnelVeth --> TUN --> Client
        end
        NIC -->|"virtio-net"| TAP
        Veth -->|"veth pair"| Bridge
        TunnelBridge -->|"A's veth pair"| TunnelVeth
    end
    Client -->|"TLS tunnel"| Service["Tunnel service"]
    Service --> Resolver["Customer network<br/>DNS resolver"]
    style DNS fill:#fff3cd,stroke:#9a6700,color:#000
`;
  const { requests } = await setup(page, [event("styled-diagram", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  const svg = block.locator(".diagram-view svg");
  await expect(svg).toBeVisible({ timeout: 20000 });
  const node = svg.locator("g.node[id*='flowchart-DNS-']");
  await expect(node.locator(".label-container")).toHaveCSS("fill", "rgb(255, 243, 205)");
  await expect(node.locator(".label-container")).toHaveCSS("stroke", "rgb(154, 103, 0)");
  await expect(svg).toContainText("DNS resolver");
  await expect(block.locator(".code-block-error")).toHaveCount(0);
  await block.getByRole("checkbox", { name: "Show raw source" }).check();
  expect(await block.locator("pre code").textContent()).toBe(source);
  expect(requests.every((url) => new URL(url).hostname === "127.0.0.1")).toBe(true);
});

test("unsafe node style reports the actual rejection rather than an unexplained diagram failure", async ({ page }) => {
  const source = "flowchart LR\n A-->B\n style A fill:url(https://diagram-external.invalid/style.svg)\n";
  const { requests } = await setup(page, [event("unsafe-style", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByRole("status")).toContainText("Styles cannot load external resources");
  expect(await block.locator("pre code").textContent()).toBe(source);
  await expect(block.locator(".diagram-view")).toHaveCount(0);
  expect(requests.some((url) => url.includes("diagram-external.invalid"))).toBe(false);
});

test("Mermaid class definitions and link styles retain their rendered appearance", async ({ page }) => {
  const source = `flowchart LR
 A:::highlight --> B
 classDef highlight fill:#fff3cd,stroke:#9a6700,color:#000
 linkStyle 0 stroke:#ff0000,stroke-width:4px
`;
  await setup(page, [event("classes", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  const svg = block.locator(".diagram-view svg");
  await expect(svg).toBeVisible();
  await expect(svg.locator("g.node.highlight .label-container")).toHaveCSS("fill", "rgb(255, 243, 205)");
  await expect(svg.locator("path.flowchart-link")).toHaveCSS("stroke", "rgb(255, 0, 0)");
  await expect(svg.locator("path.flowchart-link")).toHaveCSS("stroke-width", "4px");
});

test("streaming diagrams wait for completion and stale renders cannot replace a new source", async ({ page }) => {
  const content = "```mermaid\nflowchart LR\n  One --> Two\n```";
  const { requests, emit } = await setup(page, [
    event("start", "assistant.message_start", { messageId: "msg" }),
    event("delta", "assistant.message_delta", { messageId: "msg", content }),
  ]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block).toContainText("Diagram will render when the response finishes.");
  await page.waitForTimeout(300);
  expect(requests.some((url) => url.includes("renderMermaid"))).toBe(false);
  await emit(event("done", "assistant.message", { messageId: "msg", content: "```mermaid\nflowchart LR\n  Latest --> Final\n```" }));
  await expect(block.locator("svg")).toContainText("Latest", { timeout: 20000 });
  await expect(block.locator("svg")).not.toContainText("One");
});

test("invalid and unsafe Mermaid inputs remain escaped source with a visible error and no external requests", async ({ page }) => {
  await page.route("https://diagram-external.invalid/**", (route) => route.abort());
  const sources = ["this is not a diagram", 'flowchart LR\n  A@{ img: "https://diagram-external.invalid/tracker.svg" }',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B'];
  const { requests } = await setup(page, [event("invalid", "assistant.message", { content: sources.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n\n") })]);
  const blocks = page.locator(".diagram-block");
  for (let i = 0; i < sources.length; i++) {
    const block = blocks.nth(i);
    await block.scrollIntoViewIfNeeded();
    await expect(block.getByRole("status")).toContainText("showing source", { timeout: 20000 });
    expect(await block.locator("pre code").textContent()).toBe(sources[i] + "\n");
    await expect(block.locator("svg,iframe,img,script")).toHaveCount(0);
  }
  expect(requests.some((url) => url.includes("diagram-external.invalid"))).toBe(false);
});

test("oversized code stays readable without highlighter work and fits phone widths", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const source = "x".repeat(101000) + "\n";
  const { requests } = await setup(page, [event("large", "assistant.message", { content: `\`\`\`javascript\n${source}\`\`\`` })]);
  const block = page.locator(".code-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block).toContainText("Large block: showing source without highlighting.");
  expect(await block.locator("pre code").textContent()).toBe(source);
  expect(requests.some((url) => url.includes("highlight.worker"))).toBe(false);
  expect(await block.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect((await block.locator("label").boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test("collapsed command output does not load diagrams and selecting raw while loading prevents a late render", async ({ page }) => {
  let pending: Route | undefined;
  await page.route("**/assets/renderMermaid-*.js", (route) => { pending = route; });
  const source = "flowchart LR\n  Closed --> Open\n";
  const result = { text: "```mermaid\n" + source + "```" };
  const { requests } = await setup(page, [event("cmd", "command.result", { command: "/diagram", result })]);
  await expect(page.locator(".command-result > summary")).toBeVisible();
  expect(requests.some((url) => url.includes("renderMermaid"))).toBe(false);
  await page.locator(".command-result > summary").click();
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect.poll(() => !!pending).toBe(true);
  await block.getByRole("checkbox", { name: "Show raw source" }).check();
  await pending!.fulfill({ response: await pending!.fetch() });
  await page.waitForTimeout(300);
  await expect(block.locator("svg")).toHaveCount(0);
  expect(await block.locator("pre code").textContent()).toBe(source);
  await block.getByRole("checkbox", { name: "Show raw source" }).uncheck();
  await expect(block.locator("svg")).toContainText("Open");
});

test("failed renderer loading leaves source visible with an explicit diagnostic", async ({ page }) => {
  await page.route("**/assets/renderMermaid-*.js", (route) => route.abort());
  const source = "flowchart LR\n A-->B\n";
  await setup(page, [event("diagram", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByRole("status")).toContainText("Could not render this diagram");
  expect(await block.locator("pre code").textContent()).toBe(source);
  await block.getByRole("checkbox", { name: "Show raw source" }).check();
  await expect(block.getByRole("status")).toHaveCount(0);
});
