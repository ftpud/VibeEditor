# Continuous integration

The CI workflow runs on `ubuntu-latest` and `macos-latest` with Node.js 22 and
24. The root package declares Node `>=22.12.0`; Node 22 and 24 cover the
supported runtime versions used for CI. Each platform performs a lockfile-based
install (`npm ci`), production build, root typecheck, separate Gateway
typecheck, dependency audit, and the full workspace test suite (`npm test`).
Java 21 is installed for Java service checks, and each job has a 30-minute limit.

The macOS job checks path and filesystem behavior that Linux cannot expose.
The Core suite also contains subprocess lifecycle tests explicitly limited to
Linux (`project-processes.test.ts`, `managed-processes.test.ts`) and a Linux-only
`/proc` lifecycle test (`workflow-app-proc.test.ts`); Vitest reports those as
skipped on macOS by design.

The checks run against source tests only. Core explicitly excludes generated
build tests through its source include pattern. Required runtime/toolchain
versions are declared in the root and workspace package manifests. The CI matrix
and exact checks are defined in `.github/workflows/ci.yml`. CI also runs the
isolated restart soak described in [release operations](RELEASE_OPERATIONS.md#isolated-restart-soak).
