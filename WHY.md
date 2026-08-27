# Why VibeEditor Exists

VibeEditor started as a tool I wanted for my own day-to-day work.

The problem is simple: my corporate laptop is slow, while I have access to a much more powerful remote server. Running a heavyweight IDE locally is painful, and even remote IDE setups can still be surprisingly resource-hungry on the client.

So VibeEditor follows a different model:

> **The development machine is the server. The local app is just the control surface.**

The repository, terminals, language servers, agents, builds, tests, and task state live close to the compute. The laptop only needs to provide a responsive UI.

This also means the same development environment can be reached from anywhere without rebuilding the entire working setup on every machine.

## Tasks are workspaces

Most real development work is not a clean sequence of:

1. start task
2. finish task
3. merge task
4. start the next one

In practice, several tickets are usually active at the same time.

One may be blocked. Another may be waiting for QA. Another may need a small follow-up. A fourth may be the thing currently being implemented.

In a large monolith, switching between those tasks usually means reconstructing context:

- switching or restoring branches
- reopening files
- finding the right terminals
- restarting commands
- remembering what was already tried
- finding notes and HTTP requests
- restoring the AI conversation
- figuring out the current Git state

VibeEditor treats each task as a persistent workspace instead.

A workspace can keep its own:

- Git worktree and branch
- open files
- terminals
- AI conversations
- Git state
- notes and Markdown files
- HTTP requests
- task-specific context

Switching tasks should therefore mean switching workspaces, not rebuilding mental and technical context.

> **A task is more than a branch.**

## AI-first, not AI-only

AI agents are becoming the default way I perform many small and medium coding tasks.

VibeEditor is designed around that reality.

The normal flow is often:

1. give the agent a task
2. let it inspect and modify the code
3. review the diff
4. run tests
5. inspect logs
6. make a small manual edit if needed
7. send more instructions
8. continue

The editor, terminals, Git tools, `.http` files, executable Markdown, debugger integration, and other development tools exist so that a human can immediately take over whenever necessary.

VibeEditor is not built around the assumption that an autonomous agent will always finish the task correctly.

Instead:

> **The agent is the default worker. The human keeps full control of the workspace.**

Agents are also intentionally not the center of the architecture.

Providers can change. Models can change. Agent runtimes can change.

The workspace should survive all of them.

> **Agents are ephemeral. Workspaces are durable.**

## Remote-first by design

VibeEditor is not trying to stream a traditional heavyweight IDE from another machine.

The remote server owns the development state and performs the expensive work. The desktop application talks to that environment and provides the interaction layer.

This makes the architecture useful for:

- weak corporate laptops
- large monorepositories
- remote development servers
- private or internal infrastructure
- development environments that are expensive to reproduce locally
- working from multiple physical locations
- long-running terminals, builds, and agents that should survive the client

The important state belongs with the project and the compute, not with one laptop.

> **The server owns the state. The client owns the interaction.**

## VibeEditor is not trying to replace every IDE

There are tasks for which a heavyweight IDE is exactly the right tool.

Deep debugging, profiling, advanced refactoring, framework-specific tooling, and complex language analysis are areas where mature IDEs such as IntelliJ IDEA are extremely valuable.

VibeEditor does not need to recreate all of that.

Its primary use case is different: handling many task-sized development contexts efficiently.

For a difficult debugging or profiling session, opening a JetBrains IDE can be the right choice.

For a queue of smaller tickets, reviews, fixes, experiments, and AI-assisted changes, VibeEditor is intended to be the faster place to live.

A useful way to think about the distinction is:

> **Traditional IDEs optimize for depth inside one development context.  
> VibeEditor optimizes for throughput across many development contexts.**

## Jira and task automation

The workspace model also makes external task systems a natural integration point.

The long-term direction for the internal MCP layer is to connect systems such as Jira so that development workspaces can be created and populated automatically.

For example, starting a ticket could eventually create a workspace with:

- the appropriate Git worktree and branch
- the ticket description and metadata
- relevant project context
- terminals
- an AI session
- task-specific files or notes

The ticket then becomes a durable handle for the entire development context rather than just a text description in a project tracker.

Conceptually:

```text
Jira ticket
    |
    v
Vibe workspace
    |
    +-- Git worktree / branch
    +-- terminals
    +-- editor state
    +-- AI sessions
    +-- HTTP requests
    +-- notes
    +-- tests / logs
    +-- Git diff
```

The goal is not automation for its own sake.

The goal is to reduce the cost of starting, pausing, resuming, and switching real development work.

## The core idea

VibeEditor exists because modern development work is increasingly a collection of parallel, long-lived task contexts running on machines more powerful than the laptop in front of us.

The project is built around a few simple ideas:

- compute should stay close to the code
- development state should survive the client
- tasks should be first-class workspaces
- switching tasks should restore the whole context
- AI agents should be easy to use and easy to replace
- humans should always be able to inspect, edit, run, debug, and intervene
- heavyweight IDEs should remain available when deeper tooling is actually needed

In short:

> **Your development machine is the server.  
> Your tasks are workspaces.  
> Your agents are workers.**
