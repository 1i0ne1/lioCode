// liocode server — zero-dependency Node server.
//
// Runs the LOCAL tools (shell + filesystem) that make the agent aware of your
// computer, and serves the browser UI. The browser loads Puter.js from CDN
// and drives the selected model with tool calling; tool calls are forwarded
// here to execute inside the active project folder.
//
// Run:  liocode                 (auto port: 8000, then 8001, 8002, ...)
//        liocode --port 4321    (use 4321 exactly)
//        node server.js
//
// No API key: the browser handles Puter login via Puter.js.

import http from "node:http";
import { execSync, spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, relative, join, basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "127.0.0.1";
const BASE_PORT = Number(process.env.PORT) || 8000;
const PORT_EXPLICIT = process.env.LIOCODE_PORT_EXPLICIT === "1";
const NO_OPEN = process.env.LIOCODE_NO_OPEN === "1";
const MAX_PORT_ATTEMPTS = 50;

// ---- Project registry -------------------------------------------------------
const CONFIG_DIR = join(homedir(), ".liocode");
const CONFIG_FILE = join(CONFIG_DIR, "projects.json");

let projects = [];
let activeProjectId = null;
let activeProjectRoot = process.cwd();

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function canonicalDirectory(input) {
  let p = String(input == null ? "" : input).trim();
  if (!p) throw new Error("path is required");
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith(`~\\`)) p = join(homedir(), p.slice(2));
  if (!isAbsolute(p)) p = resolve(activeProjectRoot, p);
  const real = realpathSync(p);
  if (!statSync(real).isDirectory()) throw new Error("not a directory");
  return real;
}

function projectIdFor(path) {
  return "proj_" + createHash("sha1").update(path).digest("hex").slice(0, 12);
}

function projectNameFor(path) {
  return basename(path) || path;
}

function publicProject(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    addedAt: p.addedAt,
    lastOpenedAt: p.lastOpenedAt,
  };
}

function saveProjectConfig() {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      CONFIG_FILE,
      JSON.stringify({ projects, activeId: activeProjectId }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Could not save project registry:", error.message);
  }
}

function addProject(path, { activate = true, persist = true } = {}) {
  const real = canonicalDirectory(path);
  let project = projects.find((p) => p.path === real);
  if (!project) {
    project = {
      id: projectIdFor(real),
      name: projectNameFor(real),
      path: real,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    projects.push(project);
  } else {
    project.name = projectNameFor(real);
    project.lastOpenedAt = Date.now();
  }
  if (activate) {
    activeProjectId = project.id;
    activeProjectRoot = project.path;
  }
  if (persist) saveProjectConfig();
  return project;
}

function loadProjectConfig() {
  let config = null;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    // First run or unreadable config — fall back to the launch directory.
  }

  if (config && Array.isArray(config.projects)) {
    projects = config.projects
      .filter((p) => p && typeof p.path === "string" && isDirectory(p.path))
      .map((p) => {
        const real = realpathSync(p.path);
        return {
          id: typeof p.id === "string" ? p.id : projectIdFor(real),
          name: projectNameFor(real),
          path: real,
          addedAt: Number(p.addedAt) || Date.now(),
          lastOpenedAt: Number(p.lastOpenedAt) || Date.now(),
        };
      });
    // Drop duplicate paths from older configs.
    projects = projects.filter(
      (p, index) => projects.findIndex((other) => other.path === p.path) === index
    );
    activeProjectId = projects.some((p) => p.id === config.activeId) ? config.activeId : null;
  }

  // The folder liocode was launched from is the project the user intends to
  // work in. Register it (unless it is the home directory) and make it active.
  const launchDir = process.cwd();
  if (launchDir !== homedir()) {
    try {
      const realLaunch = realpathSync(launchDir);
      const existing = projects.find((p) => p.path === realLaunch);
      if (existing) {
        activeProjectId = existing.id;
        activeProjectRoot = existing.path;
        existing.lastOpenedAt = Date.now();
      } else {
        addProject(realLaunch, { activate: true, persist: false });
      }
    } catch {
      // Ignore an unreadable launch directory and keep the previous project.
    }
  }

  if (!projects.length) {
    addProject(launchDir, { persist: false });
    saveProjectConfig();
  }

  const active = projects.find((p) => p.id === activeProjectId) || projects[0];
  activeProjectId = active.id;
  activeProjectRoot = active.path;
  saveProjectConfig();
}

function projectsPayload() {
  const active = projects.find((p) => p.id === activeProjectId) || projects[0] || null;
  return {
    projects: projects.map(publicProject),
    activeProjectId: active ? active.id : null,
    activeProject: active ? publicProject(active) : null,
    root: activeProjectRoot,
  };
}

// ---- Local tools (these run on YOUR machine, not in the cloud) ---------------
function resolveInsideProject(input) {
  const abs = resolve(activeProjectRoot, input == null || input === "" ? "." : String(input));
  const rel = relative(activeProjectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the active project: ${input}`);
  }
  return abs;
}

const MAX_TOOL_OUTPUT = 32 * 1024 * 1024;
const SHELL_TIMEOUT = 120000;

function runShell(command, cwd, signal) {
  return new Promise((resolveShell) => {
    let output = "";
    let truncated = false;
    let timedOut = false;
    let cancelled = false;

    // On POSIX, run each command in its own process group so cancelling or
    // timing out kills the whole tree, not just the shell that spawned it.
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(String(command), {
      cwd,
      shell: true,
      detached: useProcessGroup,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTree = () => {
      if (useProcessGroup && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall through to child.kill if the group is already gone.
        }
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // The process already exited.
      }
    };

    const append = (chunk) => {
      if (truncated) return;
      output += chunk.toString();
      if (output.length > MAX_TOOL_OUTPUT) {
        truncated = true;
        output = output.slice(0, MAX_TOOL_OUTPUT);
        killTree();
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, SHELL_TIMEOUT);

    const onAbort = () => {
      cancelled = true;
      killTree();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolveShell(`Tool error: ${error.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (cancelled) return resolveShell("Tool cancelled by user.");
      if (timedOut) return resolveShell("Tool execution timed out after 120 seconds.");
      if (truncated) output += "\n…[output truncated]";
      if (code !== 0) output += `\n[exit code ${code}]`;
      resolveShell(output);
    });
  });
}

async function runTool(name, args, signal) {
  try {
    switch (name) {
      case "run_shell": {
        const cwd = args.cwd ? resolveInsideProject(args.cwd) : activeProjectRoot;
        if (!isDirectory(cwd)) throw new Error("cwd is not a directory");
        return await runShell(args.command, cwd, signal);
      }
      case "read_file": {
        const p = resolveInsideProject(args.path);
        return readFileSync(p, "utf8");
      }
      case "write_file": {
        const p = resolveInsideProject(args.path);
        mkdirSync(dirname(p), { recursive: true });
        const content = String(args.content == null ? "" : args.content);
        writeFileSync(p, content);
        return `Wrote ${content.length} bytes to ${relative(activeProjectRoot, p)}`;
      }
      case "list_directory": {
        const p = resolveInsideProject(args.path);
        return readdirSync(p)
          .map((f) => {
            const s = statSync(resolve(p, f));
            return `${f}${s.isDirectory() ? "/" : ""} (${s.size} bytes)`;
          })
          .join("\n");
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Tool error: ${e.message}`;
  }
}

const toolDefs = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a shell command on the user's local machine and return its stdout. Commands run inside the active project folder.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: {
            type: "string",
            description: "Optional working directory relative to the active project root",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file inside the active project folder.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the active project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file inside the active project folder, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the active project root" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and folders inside the active project folder.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to the active project root" },
        },
        required: ["path"],
      },
    },
  },
];

// ---- HTTP helpers -----------------------------------------------------------
function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, tests)
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isJsonRequest(req) {
  const contentType = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  return contentType === "application/json";
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk.toString();
      if (body.length > limit) {
        tooLarge = true;
        body = "";
        rejectBody(Object.assign(new Error("request body too large"), { statusCode: 413 }));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      if (!body.trim()) return resolveBody({});
      try {
        resolveBody(JSON.parse(body));
      } catch {
        rejectBody(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", rejectBody);
  });
}

function guardApi(req, res) {
  if (!isSameOrigin(req)) {
    sendError(res, 403, "cross-origin requests are not allowed");
    return false;
  }
  return true;
}

function requireJson(req, res) {
  if (!isJsonRequest(req)) {
    sendError(res, 415, "Content-Type must be application/json");
    return false;
  }
  return true;
}

// ---- Request handler --------------------------------------------------------
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  // Project registry ----------------------------------------------------------
  if (pathname === "/api/projects" && req.method === "GET") {
    if (!guardApi(req, res)) return;
    sendJson(res, 200, projectsPayload());
    return;
  }

  if (pathname === "/api/projects/browse" && req.method === "GET") {
    if (!guardApi(req, res)) return;
    try {
      const requested = url.searchParams.get("path") || homedir();
      const dir = canonicalDirectory(requested);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: join(dir, entry.name),
          hidden: entry.name.startsWith("."),
        }))
        .sort((a, b) => {
          if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 1000);
      sendJson(res, 200, {
        path: dir,
        parent: dirname(dir) === dir ? null : dirname(dir),
        entries,
      });
    } catch (error) {
      sendError(res, 400, error.message);
    }
    return;
  }

  if (pathname === "/api/projects/open" && req.method === "POST") {
    if (!guardApi(req, res) || !requireJson(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const project = addProject(body.path, { activate: true, persist: true });
      sendJson(res, 200, { project: publicProject(project), ...projectsPayload() });
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message);
    }
    return;
  }

  if (pathname === "/api/projects/select" && req.method === "POST") {
    if (!guardApi(req, res) || !requireJson(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const project = projects.find((p) => p.id === body.id);
      if (!project) return sendError(res, 404, "project not found");
      activeProjectId = project.id;
      activeProjectRoot = project.path;
      project.lastOpenedAt = Date.now();
      saveProjectConfig();
      sendJson(res, 200, projectsPayload());
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message);
    }
    return;
  }

  if (pathname === "/api/projects/remove" && req.method === "POST") {
    if (!guardApi(req, res) || !requireJson(req, res)) return;
    try {
      const body = await readJsonBody(req);
      projects = projects.filter((p) => p.id !== body.id);
      if (!projects.length) addProject(process.cwd(), { persist: false });
      if (activeProjectId === body.id) {
        const next =
          projects.slice().sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0] ||
          projects[0];
        activeProjectId = next.id;
        activeProjectRoot = next.path;
      }
      saveProjectConfig();
      sendJson(res, 200, projectsPayload());
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message);
    }
    return;
  }

  // Local tools ---------------------------------------------------------------
  if (pathname === "/tool" && req.method === "POST") {
    if (!guardApi(req, res) || !requireJson(req, res)) return;
    try {
      const body = await readJsonBody(req, 10 * 1024 * 1024);
      const controller = new AbortController();
      // Stop a running shell command when the browser cancels the turn.
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      const result = await runTool(body.name, body.args || {}, controller.signal);
      if (!res.writableEnded && !res.destroyed) {
        sendJson(res, 200, { result, root: activeProjectRoot });
      }
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        sendError(res, error.statusCode || 400, error.message);
      }
    }
    return;
  }

  if (pathname === "/tooldefs" && req.method === "GET") {
    if (!guardApi(req, res)) return;
    sendJson(res, 200, toolDefs);
    return;
  }

  if (pathname === "/api/health" && req.method === "GET") {
    if (!guardApi(req, res)) return;
    sendJson(res, 200, {
      ok: true,
      root: activeProjectRoot,
      project: projects.find((p) => p.id === activeProjectId) || null,
    });
    return;
  }

  // UI ------------------------------------------------------------------------
  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(resolve(__dirname, "index.html"), "utf8"));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

// ---- Port selection & startup ----------------------------------------------
function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      console.error("Request failed:", error);
      if (!res.headersSent) {
        sendError(res, error.statusCode || 500, error.message || "internal server error");
      } else {
        try {
          res.end();
        } catch {}
      }
    });
  });
}

function openBrowser(url) {
  if (NO_OPEN) return;
  try {
    if (process.platform === "win32") execSync(`start "" "${url}"`, { stdio: "ignore", shell: true });
    else if (process.platform === "darwin") execSync(["open", url], { stdio: "ignore" });
    else execSync(["xdg-open", url], { stdio: "ignore" });
  } catch {
    // best effort; the server works without it
  }
}

function listenOn(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

async function start() {
  loadProjectConfig();

  let port = BASE_PORT;
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const server = createServer();
    try {
      await listenOn(server, port);
      const url = `http://${HOST}:${port}/`;
      console.log(`liocode server running at ${url}`);
      console.log(`active project: ${activeProjectRoot}`);
      console.log("local tools: run_shell, read_file, write_file, list_directory");
      openBrowser(url);
      return;
    } catch (error) {
      try {
        server.close();
      } catch {}
      if (error.code === "EADDRINUSE") {
        if (PORT_EXPLICIT) {
          console.error(`Port ${port} is already in use. Choose another port with --port.`);
          process.exit(1);
        }
        console.log(`Port ${port} is in use, trying ${port + 1}...`);
        port++;
        continue;
      }
      console.error("Could not start liocode server:", error.message);
      process.exit(1);
    }
  }
  console.error(`No free port found between ${BASE_PORT} and ${BASE_PORT + MAX_PORT_ATTEMPTS - 1}.`);
  process.exit(1);
}

start();
