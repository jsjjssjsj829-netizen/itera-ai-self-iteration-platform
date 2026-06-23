const http = require("node:http");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.SANDBOX_PROVIDER_PORT || 8794);
const HOST = process.env.SANDBOX_PROVIDER_HOST || "127.0.0.1";
const TOKEN = String(process.env.SANDBOX_PROVIDER_TOKEN || process.env.VERCEL_SANDBOX_TOKEN || "").trim();
const PRIVATE_NETWORK = /^true$/i.test(process.env.SANDBOX_PROVIDER_PRIVATE_NETWORK || "");
const RUNTIME = String(process.env.SANDBOX_PROVIDER_RUNTIME || (process.env.VERCEL_SANDBOX_TOKEN ? "vercel" : "local-process"));
const STRICT_CLONE = /^true$/i.test(process.env.SANDBOX_PROVIDER_STRICT_CLONE || "");
const COMMAND_TIMEOUT_MS = Number(process.env.SANDBOX_COMMAND_TIMEOUT_MS || 60000);
const GIT_CLONE_TIMEOUT_MS = Number(process.env.SANDBOX_GIT_CLONE_TIMEOUT_MS || 20000);
const MAX_BODY_BYTES = Number(process.env.SANDBOX_MAX_BODY_BYTES || 2_000_000);

function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function authOk(req) {
  if (PRIVATE_NETWORK && !TOKEN) return true;
  const header = String(req.headers.authorization || "");
  return Boolean(TOKEN && header === `Bearer ${TOKEN}`);
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
  }
  return raw ? JSON.parse(raw) : {};
}

function parseSafeCommand(command) {
  const raw = String(command || "").trim();
  if (!raw) throw new Error("Command is empty.");
  if (/[|;&<>`]/.test(raw) || /\$\(/.test(raw)) throw new Error(`Command is not allowed: ${raw}`);
  const parts = raw.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => part.replace(/^["']|["']$/g, "")) || [];
  const program = String(parts[0] || "");
  const args = parts.slice(1);
  const lowerProgram = program.toLowerCase();

  if (lowerProgram === "echo") return { file: "node", args: ["-e", `console.log(${JSON.stringify(args.join(" "))})`], command: raw };
  if (lowerProgram === "node") return { file: "node", args, command: raw };
  if (["npm", "npm.cmd"].includes(lowerProgram)) {
    const safeNpm =
      args[0] === "test" ||
      (args[0] === "install" && args.length <= 1) ||
      (args[0] === "run" && ["lint", "build", "test:e2e", "test:performance"].includes(args[1]));
    if (!safeNpm) throw new Error(`NPM command is not allowed: ${raw}`);
    const safeArgs = args[0] === "install" ? ["install", "--ignore-scripts"] : args;
    if (process.platform === "win32") return { file: "cmd.exe", args: ["/c", "npm.cmd", ...safeArgs], command: raw };
    return { file: "npm", args: safeArgs, command: raw };
  }
  if (lowerProgram === "git" && args[0] === "diff" && args[1] === "--stat") {
    return { file: "git", args, command: raw };
  }
  throw new Error(`Command is not in the sandbox allowlist: ${raw}`);
}

function runCommand(command, cwd) {
  const parsed = parseSafeCommand(command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(parsed.file, parsed.args, {
      cwd,
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        CI: "1",
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        HOME: path.join(cwd, ".home"),
        USERPROFILE: path.join(cwd, ".home"),
      },
    });
    let output = "";
    const timer = setTimeout(() => {
      output += "\nCommand timed out.";
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, status: "failed", output: error.message, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        status: code === 0 ? "passed" : "failed",
        output: output.trim() || (code === 0 ? "Command completed." : `Command exited with ${code}.`),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function shouldSkipCommand(command, cwd) {
  const raw = String(command || "").trim().toLowerCase();
  const isNpmValidation = raw === "npm test" || raw === "npm.cmd test" || raw.startsWith("npm run ") || raw.startsWith("npm.cmd run ");
  if (!isNpmValidation) return null;
  const packageJson = path.join(cwd, "package.json");
  if (fsSync.existsSync(packageJson)) return null;
  return {
    command,
    status: "skipped",
    output: "Skipped npm validation because this repository has no package.json. Non-Node projects should configure repository-specific validation commands.",
    durationMs: 0,
  };
}

async function tryCloneRepository(repository, workspace) {
  const url = String(repository?.url || "");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/i.test(url)) return { cloned: false, reason: "Repository URL is not a GitHub HTTPS URL." };
  const args = ["-c", "credential.helper=", "-c", "core.askPass=", "clone", "--depth", "1"];
  if (repository.defaultBranch) args.push("--branch", String(repository.defaultBranch));
  args.push(url, workspace);
  const result = await new Promise((resolve) => {
    let settled = false;
    const child = spawn("git", args, {
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_ASKPASS: "echo",
        SSH_ASKPASS: "echo",
      },
    });
    let output = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      output += "\ngit clone timed out in non-interactive mode.";
      child.kill("SIGKILL");
      resolve({ code: 124, output });
    }, GIT_CLONE_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, output: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  return result.code === 0 ? { cloned: true } : { cloned: false, reason: result.output.trim() || "git clone failed" };
}

async function ensureWorkspace(payload) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "itera-sandbox-"));
  const workspace = path.join(base, "repo");
  await fs.mkdir(workspace, { recursive: true });
  const clone = payload.probe ? { cloned: false, reason: "probe" } : await tryCloneRepository(payload.repository || {}, workspace);
  if (!clone.cloned && STRICT_CLONE && !payload.probe) {
    const error = new Error(`Repository clone failed: ${clone.reason}`);
    error.status = 422;
    throw error;
  }
  return { base, workspace, clone };
}

function patchAppendix(payload, patchFile) {
  const marker = `Itera AI sandbox patch: ${payload.patchProposalId || "proposal"}`;
  const added = String(patchFile.diff || "")
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  return `\n\n/*\n${marker}\nIntent: ${patchFile.intent || "Generated patch validation"}\n*/\n${added ? `${added}\n` : ""}`;
}

async function applyPatchFiles(payload, workspace) {
  const written = [];
  for (const patchFile of payload.patchFiles || []) {
    const relativePath = String(patchFile.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!relativePath || relativePath.includes("..")) continue;
    const target = path.join(workspace, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const previous = fsSync.existsSync(target) ? await fs.readFile(target, "utf8") : "";
    const marker = `Itera AI sandbox patch: ${payload.patchProposalId || "proposal"}`;
    if (!previous.includes(marker)) {
      await fs.writeFile(target, `${previous}${patchAppendix(payload, patchFile)}`, "utf8");
    }
    written.push(relativePath);
  }
  await fs.mkdir(path.join(workspace, ".itera"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".itera", "sandbox-payload.json"), JSON.stringify(payload, null, 2), "utf8");
  return written;
}

async function runLocalProvider(payload) {
  const { base, workspace, clone } = await ensureWorkspace(payload);
  try {
    const changedFiles = await applyPatchFiles(payload, workspace);
    const commands = Array.isArray(payload.commands) && payload.commands.length ? payload.commands : ["echo sandbox-probe"];
    const commandResults = [];
    for (const command of commands) {
      const skipped = await shouldSkipCommand(command, workspace);
      commandResults.push(skipped || (await runCommand(command, workspace)));
    }
    const failed = commandResults.some((item) => item.status === "failed");
    return {
      id: `sandbox-provider-${randomUUID().slice(0, 8)}`,
      status: failed ? "failed" : "passed",
      mode: clone.cloned ? "external-http-provider:git-workspace" : "external-http-provider:contract",
      commandResults,
      changedFiles,
      logs: [
        clone.cloned ? "Repository cloned into isolated provider workspace." : `Repository clone skipped/failed: ${clone.reason}`,
        `Applied ${changedFiles.length} patch file(s).`,
        ...commandResults.map((item) => `[${item.status}] ${item.command}\n${item.output}`),
      ].join("\n\n"),
    };
  } finally {
    if (!/^true$/i.test(process.env.SANDBOX_PROVIDER_KEEP_WORKSPACES || "")) {
      await fs.rm(base, { recursive: true, force: true });
    }
  }
}

async function runVercelProvider(payload) {
  let Sandbox;
  try {
    ({ Sandbox } = await import("@vercel/sandbox"));
  } catch {
    const error = new Error("Optional package @vercel/sandbox is not installed. Run npm install @vercel/sandbox in the provider deployment or use SANDBOX_PROVIDER_RUNTIME=local-process.");
    error.status = 501;
    throw error;
  }
  const source = payload.repository?.url
    ? { type: "git", url: payload.repository.url, depth: 1 }
    : undefined;
  const sandbox = await Sandbox.create({
    runtime: process.env.VERCEL_SANDBOX_RUNTIME || "node24",
    source,
    env: { CI: "1", npm_config_ignore_scripts: "true" },
  });
  try {
    const payloadPath = ".itera/sandbox-payload.json";
    await sandbox.mkDir(".itera");
    await sandbox.writeFiles([{ path: payloadPath, content: Buffer.from(JSON.stringify(payload, null, 2)) }]);
    for (const patchFile of payload.patchFiles || []) {
      const filePath = String(patchFile.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!filePath || filePath.includes("..")) continue;
      await sandbox.writeFiles([{ path: filePath, content: Buffer.from(patchAppendix(payload, patchFile)) }]);
    }
    const commandResults = [];
    const commands = Array.isArray(payload.commands) && payload.commands.length ? payload.commands : ["echo sandbox-probe"];
    for (const command of commands) {
      const parsed = parseSafeCommand(command);
      const startedAt = Date.now();
      const result = await sandbox.runCommand(parsed.file, parsed.args);
      const output = `${await result.stdout()}${await result.stderr?.().catch(() => "") || ""}`.trim();
      commandResults.push({
        command,
        status: result.exitCode === 0 || result.code === 0 ? "passed" : "failed",
        output: output || "Command completed.",
        durationMs: Date.now() - startedAt,
      });
    }
    const failed = commandResults.some((item) => item.status === "failed");
    return {
      id: sandbox.sandboxId || `vercel-sandbox-${randomUUID().slice(0, 8)}`,
      status: failed ? "failed" : "passed",
      mode: "vercel-sandbox",
      commandResults,
      logs: commandResults.map((item) => `[${item.status}] ${item.command}\n${item.output}`).join("\n\n"),
    };
  } finally {
    await sandbox.stop();
  }
}

async function handleRun(req, res) {
  if (!authOk(req)) {
    json(res, 401, { error: "Unauthorized sandbox provider request" });
    return;
  }
  try {
    const payload = await parseBody(req);
    const result = RUNTIME === "vercel" ? await runVercelProvider(payload) : await runLocalProvider(payload);
    json(res, 200, result);
  } catch (error) {
    json(res, error.status || 500, {
      error: error.message || "Sandbox provider failed",
      status: "failed",
      mode: RUNTIME === "vercel" ? "vercel-sandbox" : "external-http-provider",
    });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      ok: true,
      service: "itera-sandbox-provider",
      runtime: RUNTIME,
      privateNetwork: PRIVATE_NETWORK,
      authRequired: Boolean(TOKEN),
      time: new Date().toISOString(),
    });
    return;
  }
  if (req.method === "POST" && req.url === "/run") {
    await handleRun(req, res);
    return;
  }
  json(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Itera sandbox provider listening on http://${HOST}:${PORT}`);
});
