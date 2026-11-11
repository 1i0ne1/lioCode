// Qwen 3.8 Max agent running in Node.js via Puter.js.
// The model calls local tools (shell, filesystem) that execute on YOUR machine,
// which is how Qwen becomes "aware of your computer" and your terminal.
//
// Run:  node agent.js
// On first run your browser opens for Puter login (Google OAuth);
// the auth token is passed back automatically. No API key needed.

import { init, getAuthToken } from "@heyputer/puter.js/src/init.cjs";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import readline from "node:readline";

// Auth: use PUTER_AUTH_TOKEN if set (backend/CI), otherwise open your browser
// for Puter login (Google OAuth) and pass the token back automatically.
const authToken = process.env.PUTER_AUTH_TOKEN || (await getAuthToken());
const puter = init(authToken);

// ---- Local tools (these run on your machine, not in the cloud) ----
const tools = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run a shell command on the local machine and return its output. Use for running scripts, listing files, git, npm, etc. Commands run in the project directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          cwd: { type: "string", description: "Optional working directory" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file on the local machine.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (absolute or relative to project root)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file on the local machine, creating directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
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
      description: "List files and folders in a directory on the local machine.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path" },
        },
        required: ["path"],
      },
    },
  },
];

function runTool(name, args) {
  try {
    switch (name) {
      case "run_shell": {
        const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
        const out = execSync(args.command, { cwd, maxBuffer: 10 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
        return out.toString();
      }
      case "read_file": {
        return readFileSync(resolve(args.path), "utf8");
      }
      case "write_file": {
        const p = resolve(args.path);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args.content);
        return `Wrote ${args.content.length} bytes to ${p}`;
      }
      case "list_directory": {
        const p = resolve(args.path);
        return readdirSync(p)
          .map((f) => {
            const full = resolve(p, f);
            const s = statSync(full);
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

// ---- Agent loop ----
const systemPrompt =
  "You are an elite software agent with direct access to the user's computer via local tools. " +
  "You can run shell commands, read/write files, and list directories. Use run_shell to explore, " +
  "read_file/write_file to edit code, and iterate until the task is complete. Be concise and technical. " +
  "When you have finished, summarize what you did.";

const messages = [{ role: "system", content: systemPrompt }];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function turn(userText) {
  messages.push({ role: "user", content: userText });

  let keepGoing = true;
  while (keepGoing) {
    const response = await puter.ai.chat(messages, {
      model: "qwen/qwen3.8-max",
      tools,
      toolChoice: "auto",
    });

    const msg = response.message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        const result = runTool(call.function.name, args);
        console.log(`\n[tool] ${call.function.name} -> ${result.slice(0, 200)}${result.length > 200 ? "..." : ""}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    } else {
      keepGoing = false;
      console.log(`\nQwen: ${msg.content}`);
    }
  }
}

async function main() {
  console.log("Qwen 3.8 Max Agent (local tools enabled). Type 'exit' to quit.\n");
  while (true) {
    const input = (await ask("You: ")).trim();
    if (!input || input.toLowerCase() === "exit") break;
    try {
      await turn(input);
    } catch (e) {
      console.error("Error:", e.message);
    }
    console.log();
  }
  rl.close();
}

main();