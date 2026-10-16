# Vibe Editor

> **VibeEditor is an experimental testbed for remote-first, AI-first IDE ideas—not a production-ready product.**

VibeEditor is a place to explore what a remote-first, AI-first development environment can become when features can be vibecoded and implemented quickly. It is deliberately hackable rather than finished: the repository provides a working foundation, but anyone can fork it, replace parts of it, or build whatever workflow and IDE experience they want on top.

The experiment is built around a simple idea from [WHY.md](WHY.md): **the development machine is the server, and the local app is the control surface**.

Each task has its own workspace with files, terminals, AI conversations, and notes, so you can switch tasks and return to where you left off. Let an agent work, review its changes, or take over yourself.

**Vibe Editor is self-configurable.** Customize settings, agent presets, and workflows to fit how you work. Open its source as a workspace and use the built-in AI agents to help change the editor itself.

This is an actively developed experiment. Expect rough edges and breaking changes; it currently runs from source.

<img width="2940" height="1912" alt="Vibe Editor desktop interface" src="https://github.com/user-attachments/assets/1a1cfd39-f127-4e07-b843-e4b8a8c71d90" />

## First run

Use **Vibe Gateway** to launch the editor. It handles remote installation, builds, updates, and the SSH connection for you.

You need Node.js 22.12+, npm, and Git on your local machine. For a remote workspace, you also need a Unix-like server with SSH access, Node.js 22.12+, npm, Git, and an existing project directory. See the [full requirements](docs/TECHNICAL_GUIDE.md#quick-start-vibe-gateway-recommended) if installation fails or your machine needs additional system tools.

On your local machine:

```bash
git clone https://github.com/ftpud/VibeEditor.git
cd VibeEditor
VIBE_SKIP_JDTLS=1 npm install
npm run build
npm run gateway
```

The install command above is for Bash or a compatible shell and skips the optional Java tooling. For Java setup or another shell, see the [technical guide](docs/TECHNICAL_GUIDE.md#optional-capabilities).

In Gateway:

1. **Add a connection** with your SSH host, username, and password or key. Use **Test connection** to verify it and trust the server fingerprint. For key authentication, the server must already accept your public key.
2. **Add a workspace** pointing to the absolute path of your existing project directory on the server.
3. Click **Start server**, wait for setup to finish, then click **Start client**.

Keep Gateway open while you use the editor; it maintains the SSH connection. To open it again later, run `npm run gateway` from this checkout.

On macOS, you can try it locally instead: choose **This Mac**, select a local project directory, then use **Start server** and **Start client**.

To use AI agents, authenticate your chosen provider on the machine running the workspace. See [AI provider setup](docs/TECHNICAL_GUIDE.md#optional-capabilities).

## More

- [Technical guide](docs/TECHNICAL_GUIDE.md): detailed setup, troubleshooting, development commands, architecture, and security.
- [Features](FEATURES.md) and [feature guides](docs/README.md).
- [Why Vibe Editor exists](WHY.md).

Available under the [MIT License](LICENSE.md).

Early Access packaging and the manual **Bundle Create** action are documented in [Early Access bundles](docs/EARLY_ACCESS.md).
