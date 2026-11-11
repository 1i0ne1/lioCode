# lioCode

**A local-first coding agent workspace for your own machine.**

lioCode pairs a monochrome, Deluxe360-inspired workspace with a zero-dependency Node server. The agent runs in your browser through [Puter.js](https://js.puter.com/) and uses local tools — shell commands, file reads, file writes and directory listing — that execute inside the project folder you open.

No API keys are stored in this repository. Model access uses your signed-in Puter account.

---

## Why lioCode

- **Your folder is the context.** Open a folder once and every new agent session works inside it. Switch projects from the floating project tree whenever you need another codebase.
- **Local tools, visible work.** Every shell command and file edit is streamed into a collapsible activity block with live elapsed time, tool duration and a final completion time.
- **Project-driven history.** Sessions are grouped under their project folders. Close a session without losing it, delete a session permanently, or close a project and reopen it later from **Closed projects**.
- **A prompt rail, not a wall of text.** The right-hand rail is a VS Code-style minimap of prompts. Each tick has a state and completion time; click any tick to jump.
- **Monochrome by design.** A black glass shell, hairline rules, serif display headings and monochrome accents. No color noise while you work.
- **All Puter models and capacities.** The model picker loads the tool-capable model catalogue from Puter, groups it by provider, and labels capacities such as **Max**, **Pro**, **Plus**, **Flash** and **Mini**. Standard, Prime and Ultra service speeds are available where the provider supports them.
- **No build step. No dependencies.** `server.js` uses only Node's standard library and serves the single-file UI.

---

## Quick start

### Requirements

- Node.js **18 or newer**
- A modern browser
- A [Puter](https://puter.com/) account (for model access)

### Run from source

```bash
git clone https://github.com/1i0ne1/lioCode.git
cd lioCode
./liocode
```

The launcher starts the workspace at:

```text
http://127.0.0.1:8000/
```

If port 8000 is busy, lioCode automatically tries **8001, 8002, …** and does not stop an existing server.

To choose an exact port:

```bash
./liocode --port 1024
```

An explicit port fails fast if it is already occupied.

### Run with npm

```bash
npm start
```

There is nothing to install: the server has zero runtime dependencies.

### Install the launcher

```bash
./liocode --install
```

This copies the application to `~/.local/bin/liocode_project` and creates the `liocode` command in `~/.local/bin`. Run `liocode` from any project folder to make that folder the active project.

Remove the installation with:

```bash
./liocode --remove
```

---

## Using lioCode

1. Open a project folder with **Open project folder** or the project switcher in the top bar.
2. Sign in with Puter the first time the agent is used. The session is saved in your browser.
3. Ask for a task. The agent can inspect the project, run commands, edit files and verify its work.
4. Use **Cancel session** or `Esc` to stop a running turn.
5. Use the prompt rail on the right to jump through the session, and **Collapse activity** to fold every agent activity block at once.

### Working with projects

- Each project folder owns a group of sessions in the sidebar.
- **+** on a project starts a new session in that project.
- The project **⋯** menu offers **Close project** and **Delete project**.
  - **Close project** hides it from the open list but keeps everything. Reopen it later from **Closed projects**. The last open project cannot be closed until another folder is open.
  - **Delete project** removes it from the agent registry and deletes its saved sessions from this browser. Files on disk are never touched.
- A **closed session** leaves project history intact. A **deleted session** is removed permanently from browser storage.

### Where data lives

| Data | Location |
| --- | --- |
| Project registry | `~/.liocode/projects.json` |
| Conversations and settings | Browser `localStorage` |
| Project files | Your own folders, untouched by lioCode |

---

## How it works

```text
┌──────────────────────────────┐
│ Browser                      │
│  index.html                  │
│  ├─ Puter.js model calls     │
│  ├─ agent loop / tools       │
│  └─ project + session state  │
└──────────────┬───────────────┘
               │ same-origin HTTP
┌──────────────▼───────────────┐
│ Local Node server (server.js)│
│  ├─ project registry         │
│  ├─ run_shell                │
│  ├─ read_file / write_file   │
│  └─ list_directory           │
└──────────────┬───────────────┘
               │
        your active project folder
```

### Built with Puter.js

The browser loads Puter.js at runtime and calls models through your Puter account. The local server never holds a model API key. That keeps the integration portable: any tool-capable model exposed by Puter can be selected from the picker, including larger-capacity variants.

If Puter.js is unavailable, lioCode shows the sign-in/setup state instead of breaking the workspace.

### Local tool sandbox

- The server binds to `127.0.0.1` by default.
- Shell commands and file operations are constrained to the active project root; paths that escape it are rejected.
- Mutating API requests require a same-origin browser request and JSON content type.
- Running shell commands are killed when a turn is cancelled or times out.
- No telemetry, analytics or remote logging is built in.

---

## Project structure

```text
lioCode/
├── index.html      # UI, styling, agent loop and Puter.js integration
├── server.js       # zero-dependency local server and tools
├── liocode         # launcher, port selection and install helper
├── setup.html      # standalone setup/help page
├── agent.js        # experimental terminal runner (optional)
├── package.json
├── README.md
└── LICENSE
```

`agent.js` is an optional experimental command-line runner that imports `@heyputer/puter.js` directly. The main workspace does **not** depend on it and runs with no npm dependencies.

---

## License

MIT — free to use, modify, distribute and build on. See [LICENSE](LICENSE).

---

Made for working locally, with the model in the browser and the code on your machine.
