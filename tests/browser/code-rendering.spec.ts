import { test, expect, type Page, type Route } from "@playwright/test";

const event = (id: string, type: string, data: Record<string, unknown>) => ({ id, type, timestamp: "", data });
async function setup(page: Page, events: ReturnType<typeof event>[], model = "model") {
  const session = { sessionId: "rendering", title: "Rendering fixture", cwd: "Q:\\fixture", model,
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

test("tool-first turns show Copilot above its tools during streaming and after reload", async ({ page }, testInfo) => {
  const prompt = event("u", "user.message", { content: "Inspect before answering." });
  const model = event("model", "session.start", { model: "reported-model" });
  const tool = event("tool", "tool.execution_start", { toolCallId: "view", toolName: "view", arguments: { path: "example.txt" } });
  let reloadedEvents = [model, prompt, tool];
  const { emit } = await setup(page, reloadedEvents, "reported-model");
  const transcript = page.locator(".parent-session-view .transcript");
  const heading = transcript.locator(".assistant-activity-heading");
  await expect(heading).toContainText("Copilot");
  await expect(heading).toContainText("reported-model");
  await expect(transcript.locator(".message.assistant")).toHaveCount(0);
  const userBottom = (await transcript.locator(".message.user").boundingBox())!;
  const assistant = (await heading.boundingBox())!;
  const firstTool = (await transcript.locator(".tool-card").boundingBox())!;
  expect(assistant.y).toBeGreaterThanOrEqual(userBottom.y + userBottom.height);
  expect(assistant.y + assistant.height).toBeLessThanOrEqual(firstTool.y);
  await expect(transcript.locator(".message.user .tool-card")).toHaveCount(0);

  const reason = event("r", "assistant.reasoning", { content: "Actual summary after inspecting." });
  const answer = event("a", "assistant.message", { content: "Inspection complete.", model: "reported-model" });
  await emit(reason);
  await emit(answer);
  await expect(transcript.locator(".message.assistant")).toContainText("Inspection complete.");
  await expect(transcript.locator(".message-role").filter({ hasText: "Copilot" })).toHaveCount(1);
  await expect(transcript.locator(".reasoning-row .message-avatar")).toHaveClass(/placeholder/);
  await expect(transcript.locator(".message.assistant .message-avatar")).toHaveClass(/placeholder/);
  reloadedEvents = [...reloadedEvents, reason, answer];
  await page.route("**/api/session_history_window", (route) => route.fulfill({
    json: { events: reloadedEvents, hasMore: false, cursor: "", loadedPages: 1, humanMessages: 1 },
  }));
  await page.reload();
  await expect(heading).toContainText("reported-model");
  await expect(transcript.locator(".message-role").filter({ hasText: "Copilot" })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("tool-first-heading.png") });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await transcript.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await emit(event("u2", "user.message", { content: "Inspect again." }));
  await emit(event("t2", "tool.execution_start", { toolCallId: "glob", toolName: "glob", arguments: { pattern: "*.txt" } }));
  await expect(transcript.locator(".assistant-activity-heading")).toHaveCount(2);
  await expect(transcript.locator(".message-role").filter({ hasText: "Copilot" })).toHaveCount(2);
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

test("Mermaid init applies spacing and step curves per diagram while preserving raw source", async ({ page }) => {
  const graph = 'flowchart TB\nsubgraph Container[" "]\nA-->B\nA-->C\nend\nstyle Container fill:none,stroke:none\n';
  const source = '%%{init: {"flowchart": {"curve": "stepAfter", "nodeSpacing": 35, "rankSpacing": 65}}}%%\n' + graph;
  const { requests, emit } = await setup(page, [event("layout", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const configured = page.locator(".diagram-block").first();
  await configured.scrollIntoViewIfNeeded();
  const svg = configured.locator("svg");
  await expect(svg).toBeVisible();
  const configuredPaths = await svg.locator("path.flowchart-link").evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  expect(configuredPaths.length).toBe(2);
  expect(configuredPaths.every((path) => path && !/[CQ]/i.test(path))).toBe(true);
  const height = await svg.evaluate((element) => element.viewBox.baseVal.height);
  await expect(svg.locator(".cluster > rect")).toHaveCSS("fill", "none");
  await configured.getByRole("checkbox", { name: "Show raw source" }).check();
  expect(await configured.locator("pre code").textContent()).toBe(source);
  await configured.getByRole("checkbox", { name: "Show raw source" }).uncheck();

  await emit(event("default-layout", "assistant.message", { content: "```mermaid\n" + graph + "```" }));
  const following = page.locator(".diagram-block").nth(1);
  await following.scrollIntoViewIfNeeded();
  const defaultSvg = following.locator("svg");
  await expect(defaultSvg).toBeVisible();
  expect(await defaultSvg.evaluate((element) => element.viewBox.baseVal.height)).not.toBe(height);
  const defaultPaths = await defaultSvg.locator("path.flowchart-link").evaluateAll((paths) => paths.map((path) => path.getAttribute("d")));
  expect(defaultPaths.some((path) => path && /[CQ]/i.test(path))).toBe(true);
  expect(requests.every((url) => new URL(url).hostname === "127.0.0.1")).toBe(true);
});

test("Mermaid init cannot override security or load resources and reports the rejected configuration", async ({ page }) => {
  const source = '%%{init: {"flowchart": {"curve":"stepAfter"}, "themeCSS":"@import url(https://diagram-external.invalid/a.css);", "securityLevel":"loose"}}%%\nflowchart LR\nA-->B\n';
  const { requests } = await setup(page, [event("unsafe-config", "assistant.message", { content: "```mermaid\n" + source + "```" })]);
  const block = page.locator(".diagram-block");
  await block.scrollIntoViewIfNeeded();
  await expect(block.getByRole("status")).toContainText("Diagram configuration only supports flowchart layout settings");
  await expect(block.locator("svg")).toHaveCount(0);
  expect(await block.locator("pre code").textContent()).toBe(source);
  expect(requests.some((url) => url.includes("diagram-external.invalid"))).toBe(false);
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

test("apply_patch shows file operations and diff colors with exact raw arguments and no repository calls", async ({ page }, testInfo) => {
  const patch = "*** Begin Patch\r\n*** Update File: src/old.ts\r\n*** Move to: src/new.ts\r\n@@ function render\r\n context\r\n-before\r\n+after <script>not executable</script>\r\n*** Add File: added.txt\r\n+first\r\n+\r\n+third\r\n*** Delete File: deleted.txt\r\n*** End Patch\r\n";
  const args = { input: patch, explanation: "Extra argument stays inspectable" };
  const { requests } = await setup(page, [
    event("patch-start", "tool.execution_start", { toolCallId: "patch", toolName: "functions.apply_patch", arguments: args }),
    event("patch-end", "tool.execution_complete", { toolCallId: "patch", success: true, result: "Applied the requested patch." }),
  ]);
  await expect(page.getByRole("region", { name: "Patch request", exact: true })).toHaveCount(0);
  await page.locator(".tool-card .timeline-disclosure").click();
  const preview = page.getByRole("region", { name: "Patch request", exact: true });
  await expect(preview.locator(".patch-file")).toHaveCount(3);
  await expect(preview.locator(".patch-summary")).toContainText("3 files");
  await expect(preview.locator(".patch-file").first().locator("summary")).toContainText("src/old.ts → src/new.ts");
  await expect(preview.locator(".patch-summary")).toContainText("+4 −1");
  await expect(preview).toContainText("Delete file; contents are not included in the patch.");
  const diff = preview.getByRole("region", { name: "Patch for src/old.ts", exact: true });
  await expect(diff.locator(".add")).toContainText("+after <script>not executable</script>");
  await expect(diff.locator(".delete")).toHaveText("-before");
  await expect(diff.locator(".git-diff-number")).toHaveCount(0);
  const before = await diff.locator(".add").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(before).not.toBe(await diff.locator(".delete").evaluate((element) => getComputedStyle(element).backgroundColor));
  await expect(preview.locator("script")).toHaveCount(0);
  await preview.getByText("Other arguments", { exact: true }).click();
  await expect(preview.locator(".patch-extra")).toContainText("Extra argument stays inspectable");
  await preview.getByRole("checkbox", { name: "Show raw patch" }).check();
  expect(await preview.locator("pre code").textContent()).toBe(JSON.stringify(args, null, 2));
  await preview.getByRole("checkbox", { name: "Show raw patch" }).uncheck();
  await expect(preview.locator(".patch-file")).toHaveCount(3);
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "light" ? "dark" : "light"; });
  await expect(diff.locator(".add")).not.toHaveCSS("background-color", before);
  await preview.locator(".patch-file").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("apply-patch-diff.png") });
  await page.setViewportSize({ width: 320, height: 844 });
  await preview.locator(".patch-file").first().scrollIntoViewIfNeeded();
  expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const selector = preview.locator(".patch-file").first().locator("summary");
  await selector.focus();
  await selector.press("Enter");
  await expect(diff).toHaveCount(0);
  await selector.press("Enter");
  await expect(diff).toBeVisible();
  expect(requests.some((url) => /\/api\/(?:git_diff|git_workspace|execute_command|send_message|set_)/.test(url))).toBe(false);
});

test("patch argument streaming uses raw text until complete and failures never claim edits were applied", async ({ page }) => {
  const { emit } = await setup(page, [
    event("delta", "assistant.tool_call_delta", { toolCallId: "patch", toolName: "apply_patch", inputDelta: "*** Begin Patch\n*** Update File: file.txt\n" }),
  ]);
  await page.locator(".tool-card .timeline-disclosure").click();
  const preview = page.getByRole("region", { name: "Patch request", exact: true });
  await expect(preview).toContainText("Receiving patch arguments...");
  await expect(preview.locator(".patch-file")).toHaveCount(0);
  const patch = "*** Begin Patch\n*** Update File: file.txt\n@@\n-before\n+after\n*** End Patch\n";
  await emit(event("start", "tool.execution_start", { toolCallId: "patch", toolName: "apply_patch", arguments: patch }));
  await expect(preview.locator(".patch-file")).toHaveCount(1);
  await emit(event("failed", "tool.execution_complete", { toolCallId: "patch", success: false, error: "Context not found" }));
  await expect(preview).toContainText("Patch tool failed. These are the requested edits");
  await expect(page.locator(".tool-card.failed")).toContainText("Context not found");
  await preview.getByRole("checkbox", { name: "Show raw patch" }).check();
  expect(await preview.locator("pre code").textContent()).toBe(patch);
});

test("patch previews paginate long changes and fall back without losing malformed input", async ({ page }) => {
  const large = "*** Begin Patch\n*** Add File: many.txt\n" + "+line\n".repeat(250) + "*** End Patch";
  const malformed = "*** Begin Patch\n*** Update File: file.txt\nmissing line prefix\n*** End Patch";
  await setup(page, [
    event("first", "tool.execution_start", { toolCallId: "first", toolName: "apply_patch", arguments: large }),
    event("second", "tool.execution_start", { toolCallId: "second", toolName: "apply_patch", arguments: malformed }),
  ]);
  await page.locator(".tool-card .timeline-disclosure").first().click();
  const first = page.getByRole("region", { name: "Patch request", exact: true }).first();
  await expect(first.locator(".git-diff-line")).toHaveCount(200);
  await first.getByRole("button", { name: "Show more lines (50 remaining)", exact: true }).click();
  await expect(first.locator(".git-diff-line")).toHaveCount(250);
  await page.locator(".tool-card .timeline-disclosure").nth(1).click();
  const second = page.getByRole("region", { name: "Patch request", exact: true }).nth(1);
  await expect(second.getByRole("status")).toContainText("Could not interpret the complete patch");
  await expect(second.locator(".patch-file")).toHaveCount(0);
  expect(await second.locator("pre code").textContent()).toBe(malformed);
});

test("patch file groups load on demand and move-only, empty additions and deletions remain explicit", async ({ page }) => {
  const patch = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** Add File: empty.txt\n"
    + Array.from({ length: 10 }, (_, index) => `*** Delete File: old-${index}.txt\n`).join("") + "*** End Patch";
  await setup(page, [event("files", "tool.execution_start", { toolCallId: "files", toolName: "apply_patch", arguments: { patch } })]);
  await page.locator(".tool-card .timeline-disclosure").click();
  const preview = page.getByRole("region", { name: "Patch request", exact: true });
  await expect(preview.locator(".patch-file")).toHaveCount(10);
  await expect(preview).toContainText("Move only; no content changes.");
  await expect(preview).toContainText("Create an empty file.");
  await preview.getByRole("button", { name: "Show more files (2 remaining)" }).click();
  await expect(preview.locator(".patch-file")).toHaveCount(12);
  await expect(preview.locator(".patch-summary")).toContainText("Deleted-file contents not included in counts");
  await expect(preview.getByRole("button", { name: /Show more files/ })).toHaveCount(0);
});
