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

The earlier release-readiness review identified macOS `/var` versus
`/private/var` path aliases, a case-only rename expectation, and a fixture that
assumed `/root` exists. The current working tree normalizes several temporary
path fixtures with `realpath`, uses a temporary directory for task-control
tests, and checks the case-preserved directory entry after a case-only rename.
The macOS CI job will provide the needed platform confirmation.

The checks run against source tests only. Core explicitly excludes generated
build tests through its source include pattern. Required runtime/toolchain
versions are Node 22.12+ (CI tests majors 22 and 24), Electron 44, Vitest 4,
and happy-dom 20. Gateway enforces a single application instance so concurrent
windows use one serialized state writer. Core task mutations also coordinate
across processes through repository ownership locks. Other Core stores still
need a complete cross-process consistency review before stable release.
