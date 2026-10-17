# Language service extraction map

Inventory at `72e13c8` (2026-10-17), for `plugins-todo.md` 2.1. Scope: Core
`server.ts`, `workspace-state.ts`, `tools.ts`, `websocket-output.ts`, protocol
`index.ts`, and all non-test Desktop renderer sources, including CSS. References
are grouped by responsibility below; ranges include imports, types, call sites,
labels and cleanup for that responsibility. Line numbers are navigation hints.
Search: `rg -n -i 'java|jdt|maven'` over those paths; `javascript`/`JavaScript`
substring matches are not Java dependencies. Tests remain regression evidence,
not extraction targets. No source behavior changes are proposed by this note.

| Class | Meaning | Treatment |
| --- | --- | --- |
| L: language-specific | Maven/JDK/JDT, JVM classes, Java syntax or configuration | Keep inside the Java implementation or its declared configuration UI. |
| N: generic-but-named-Java | Reusable operation/data/UI with Java names or assumptions at its boundary | Generalize the boundary and dispatch by language/capability. |
| S: genuinely shared | Transport, lifecycle, persistence machinery or multi-language presentation | Reuse; replace the embedded Java hook rather than duplicate the machinery. |

## Core and wire protocol

Paths in this table are relative to `packages/`.

| File / references | Class | Coupling and extraction boundary |
| --- | --- | --- |
| `core/src/server.ts:27–28,68–69,542–555` | N; L for concrete constructors | `SessionServices.java/jdt` and per-workspace creation bind every connection to Java. Registry creates services for the workspace; Java owns construction and the build → JDT rebuild hook. |
| `server.ts:545–551` | N | Output, exit, debug-state and semantic-change events are emitted with Java names; preserve root IDs, ordering and socket guards with language-tagged events. |
| `server.ts:554,723,733–741,782,847` | S | Failed connection/task-switch cleanup, service replacement and dispatch context must iterate registry instances; preserve disposal on every existing failure path. |
| `server.ts:1286–1298` | L for Maven load/config; N for tools/options/source-root/tree | All project/configuration routes directly call `java`. Wrap existing implementations, retain `java.*` aliases while migrating callers. |
| `server.ts:1299–1323` | N; L for main-class/type completion payloads | Workspace symbols, run-target listing, run-config add/select, build/run/stop, all five debug routes, checks and type suggestions. Keep class names and Maven launch details in Java extras; aggregate symbols through the registry. |
| `server.ts:1325–1328` | N | Completion, definition, references and semantic tokens dispatch straight to `jdt`; use a generic LSP host with a Java launch spec. |
| `server.ts:1582–1584` | S; L for fields | Workspace path relocation knows `pomPath`, source roots and output paths. Keep relocation machinery shared; delegate service-owned configuration path rewriting. |
| `core/src/workspace-state.ts:5,93–100` | S | Workspace validation/persistence hard-codes `javaProject/javaBreakpoints`; add a versioned per-language state envelope and migrate legacy keys. |
| `workspace-state.ts:116–125` | N + L | Path/line breakpoint validation is reusable; `.java` filtering and mandatory qualified `className` are Java-specific. Do not just rename this shape to a generic breakpoint. |
| `workspace-state.ts:176–231` | L; S for validation primitives | `validateJavaProjectOptions`, `javaArgumentList`, `rejectUnknownJavaFields`, `validateRunConfiguration`: Maven type/POM/goals/JDK/VM arguments/main class belong to Java. Safe paths, bounded argument lists, environment and unknown-field rejection remain reusable. |
| `core/src/tools.ts:12,25–54,115–116` | L | Tool IDs, Temurin platform/archive/checksum/entry definitions, JDT version/dependency and `java()` executable convenience accessor belong to Java's tool contribution. |
| `tools.ts:14–23,56 onward` | S | `ToolSpec`, downloads, checksum verification, extraction, dependency installation, status and atomic publication already accept a tool list. Reuse rather than make a language installer. |
| `core/src/websocket-output.ts:13` | S | Coalescing policy lists `java.semantic.changed`; generalize the event key without coalescing process output/exit/debug events accidentally. |
| `protocol/src/index.ts:148–149` | N | `WorkspaceOptions.javaProject/javaBreakpoints` require compatibility migration, not immediate deletion. |
| `index.ts:256–284` | L; N for common launch fields | `JavaProjectOptions`, `JavaRunConfiguration`, `JavaToolCheck`, `javaConfigurationPath`, `JavaMainClass`, `JavaBreakpoint`: Maven/JVM schema. Name/ID/arguments/environment/workdir/tool-check results can form shared envelopes. |
| `index.ts:285–304` | N + L | `JavaDebugVariable/State` are mostly reusable; class/method/object ID, string variable references and `JavaApplyChangesResult` class lists need adapter translation or typed Java extras. They are not already DAP types. |
| `index.ts:305–314` | N; L for `JavaTypeSuggestion` | Diagnostics, rooted diagnostics/locations, LSP range/completion/location and semantic tokens are generic data; qualified Java import suggestions stay Java. `WorkspaceSymbol/RootedWorkspaceSymbol` are already S. |
| `index.ts:316–331` | N + L | Tree/path/source-root metadata can generalize; `package` grouping and `JavaFileType` class/interface/enum/record/annotation flags are Java contribution metadata. |
| `index.ts:631–715,999–1023` | N + L | All 25 `java.*` operation definitions and registry entries: project/config/tools (7), symbols (1), main/run-config (3), build/run/stop (3), debug (5), checks/type suggestions (2), LSP (4). Introduce `language` IDs and keep aliases; Maven/main-class/type-import operations need typed extras. |
| `index.ts:745–747` | L | `JAVA_NOT_CONFIGURED`, `MAVEN_PROJECT_INVALID`, `JAVA_PROCESS_FAILED`: retain legacy errors for aliases; define neutral service errors for new routes. |
| `index.ts:775–778,790` | N | Four Java event types and `ServerEvent` union membership become language-tagged events; root affinity stays shared. |

## Desktop

Paths are relative to `packages/desktop/src/renderer/`. All Java-bearing renderer
files are covered below, including incidental multi-language maps and styling.

| File / references | Class | Coupling and extraction boundary |
| --- | --- | --- |
| `client.ts` | S | No Java references: `CoreClient.request<T>` and event transport are already generic and root-aware. Callers, not a new transport, migrate to the new protocol. |
| `model.ts:1`; `task-panel-state.ts:2,24`; `command-registry.ts:3–4` | N | Fixed `java` panel IDs, saved side-view validation, `Java` command category and `java.configuration` command. Descriptor-driven commands/panels need saved-layout/shortcut migration. |
| `DebugVariable.tsx:3–9` | N | Variable tree, paging/retry/loading and inspection callback only depend on Java names/types and the `java.debug.variables` result. Reuse with generic variable/reference types. |
| `debug-editor.tsx:4–86` | N + L | Hover/widget/decorations and paused-state handling are reusable. Identifier/field/index parsing, implicit `this`, dotted field matching and `applyingChanges` assume JVM-like inspection; make evaluation/inspection capabilities explicit. |
| `ProblemsPanel.tsx:3–8,49–54` | N | Rooted diagnostic type and Java labels gate an otherwise shared filter/list/navigation panel; show diagnostics from all capable services with source labels. |
| `ProjectTree.tsx:3,62–81,178–191` | N + L | `javaNodes/javaMetadata/javaType` enrich the filesystem tree. Source/test roots and metadata merging are reusable; Java type icons are language-specific. Preserve compaction boundaries and file selection. |
| `JavaFileIcon.tsx:2–15`; `FileKindIcon.tsx:2–11` | L | Java extension branch, Coffee fallback and Java type badges. Contribute icon metadata through the language descriptor; keep generic file-icon fallback. |
| `JavaPanel.tsx:5–121` | N + L | Log/status, run/debug controls, variables and resizing are reusable. Maven/Java labels, option/run-config shape and class hot-swap results are Java-specific; capability-gate build/run/debug/apply-changes. |
| `JavaConfigurationDialog.tsx:3–180` | L | `.settings/java.json`, Maven/POM/JDK/build/source/output fields, JVM launch profiles, main-class choices, schema/template checks and four configuration/tools/main-class requests. Keep Java schema/UI behind the contribution; reuse generic revision-aware file editing. |
| `SettingsMenu.tsx:52,62`; `ToolsPanel.tsx:10,46` | N for copy; S for controls | Java-only tool help/search text; actual install/update/delete listing is already generic. Render service-supplied descriptions. |
| `DetachedEditor.tsx:7`; `FindInFilesDialog.tsx:10–11`; `CommitBlockDiff.tsx`; `GitCompareDialog.tsx`; `GitConflictWorkspace.tsx`; `GitHistoryDialog.tsx`; `GitLogPanel.tsx`; `GitStashDialog.tsx` | S | Multi-language extension → Monaco ID maps include Java. Centralize a descriptor-backed resolver while retaining built-in syntax fallback; no Java runtime dependency. |
| `AiPanel.tsx:215` | S | `.java` in a multi-language text-attachment whitelist; independent of language services. |
| `EditorStatusBar.tsx:7`; JavaScript worker calls/maps elsewhere | S | `JavaScript` substring search hits, not Java coupling. |
| `styles.css:138–146,294–295,458–460,727–733,849–876,1283–1311,1935–1946` | L for Java icons/tokens; N for panels/forms | Java type/semantic colors stay contributed styles; source-root, toolbar, process-panel and configuration-form classes can be shared. All remaining Java selectors fall in these groups. |
| `workspace.css:11–23,261–262,360,468–516`; `theme.ts:88` | N; S for theme comment | Java-named toolbar/panel layout and responsive rules are generic; theme palette attribution is only a comment. |

### `App.tsx` responsibility map

| References (including associated imports/state) | Class | Coupling and destination |
| --- | --- | --- |
| `11–91,205,309–324,390–407,428,465` | N + L | Java component/type imports, fixed panel names, options/tree/run/debug/diagnostics/import/usages state and refs. Store service state by language/session; retain Java-only import/config data in its contribution. Extension maps are S. |
| `416–420,485–489,754–759,814–854,1005–1017,1078–1090,1167–1184,1634–1641,1710–1752,2890–2896` | S + L | Restore/save/reset/dispose on root/task changes, saved panel height, debounced checks and filesystem/config reload. Java configuration filename and `.java` tests become service hooks; keep root/generation guards and persistence machinery. |
| `951–963` | N | Four Java event handlers append output, end runs, update debug state/open panel, invalidate semantic decoration; dispatch by language and root. |
| `2124–2192,2341–2357,2475–2479,2928,3015–3020,3060–3173` | N | Bottom/side panel exclusion, resize, availability and toolbar/tree/debug/problems rendering depend on `javaOptions`. Use declared capabilities and instance IDs, not Java presence. Includes both classic and focused layouts. |
| `2254–2273,2301–2306,2328–2337,2777,3194–3195,3232` | N + L | Project refresh, rename/delete refresh and source-root actions generalize. `pom.xml` detection, Maven loader and config dialog are Java-specific contributions. |
| `2360–2406,2461–2464,2943,3165` | N + L | Save dirty files before launch, build/run/stop/debug/apply-changes/inspect/select requests and configuration command. Reuse shared run-config/process services; Java supplies launch/hot-swap details. |
| `2410–2429` | L + N | Breakpoint decoration/update is reusable; deriving `className` from package/file and persisting JVM breakpoints is Java-specific. |
| `2449–2458,2502–2530,3222` | N | Diagnostics markers/opening, symbol search, definition/usages navigation are generic but request `java.*`, label source `Maven` and use Java types. Preserve multi-root navigation history. |
| `2546–2565,3221` | L | Package/import regexes, `java.lang` exclusion and qualified-name import chooser belong to Java. Prefer LSP additional edits where possible. |
| `2586–2640` | S + N | `javaLanguageDisposables` also owns cursor tracking, Git context/gutter handlers, HTTP actions and TS/JS markers: extract generic editor lifecycle before relocating Java providers. Debug hover is currently `.java`-gated. |
| `2641–2711` | L + N | Java lexical/semantic decoration, completion provider/action, definition/reference gestures and delayed refresh: generic LSP plumbing plus Java token styles/registration. Language descriptors choose registration and styling. |
| `3346–3358` | N + L | Local `JavaProjectTree` renderer duplicates tree concerns; package grouping/type icons stay Java metadata, expansion/navigation/source-root display can be shared. |

## Sequence and size

Estimates are engineering days for one developer familiar with this repository,
including regression checks; they are planning ranges, not a measured schedule.
The existing Java implementation is about 1,440 non-test lines across `java.ts`,
configuration/file-type/caches and `jdtls.ts`; wrap it first instead of rewriting it.

| Step | Estimated size | Completion evidence / principal risk |
| --- | --- | --- |
| 2.2 contract + registry | 2–3 days | Descriptor/capabilities, detection, configuration/tree/run/debug contracts and LSP launch spec; distinguish generic types from JVM extras. |
| 2.3 neutral protocol + aliases | 1–2 days | 25 operation pairs, four events, root routing and error compatibility; keep protocol registry/handshake consistent. |
| 2.4 Java adapter + lifecycle/state | 2–4 days | Existing Java/JDT behavior unchanged; preserve `.settings/java.json`, state migration, task/root cleanup, rebuild/semantic events and run-config/process integration. |
| 2.5 renderer migration | 3–5 days | Largest surface (`App.tsx` plus ~20 supporting files/styles); both layouts, debugger, persisted panels/shortcuts, multi-root navigation and Monaco disposal work with capability flags. |
| 2.6 second built-in + contract correction | 2–4 days | Minimal Node/TypeScript or Python implementation exercises detection/LSP and unsupported-capability UI; test that no Java service starts for that workspace. |
| Integration/validation reserve | 1–2 days | Build/typechecks including Gateway; unchanged Java/JDT/debug regression tests, protocol alias tests and renderer tests. JDK/debug integration may need host prerequisites. |
| Part 2 total | **11–20 days** | Roughly 25–35 production files touched plus new adapters/registry/tests; scope depends on second-language run/debug support. Part 3 is a separate estimate after two implementations exist. |

Keep filesystem/process ownership on Core. Introduce types/registry first, then
Core routing, then Desktop callers. Reuse `run-configs.ts`, `project-processes.ts`
and tool installation infrastructure; avoid a parallel launch/install path.
Defer an executable plugin loader until Java and the second built-in have tested
the interface. An open question for 2.2 is typed built-in extras versus a
schema-validated extension payload; renaming JVM fields alone will not settle it.

## Desktop language contributions

The **Languages** button and **Open Language Tools** command discover services
through `language.list` for the current root/task. Each descriptor contributes
project-tree, configuration and run-target commands to the command palette;
unsupported controls are omitted. The shared tools view uses `language.*` for
project trees, revision-checked configuration editing, source roots, run targets,
run configurations, build/run/stop and debugger inspection/stepping. Process
output and debugger state are kept separately by language and filtered by root.
Dirty editor files are saved before a launch. Changing roots or tasks discards
the old tools view and ignores its pending responses.

`capabilities.runConfigurations` and `capabilities.sourceRoots` are optional,
independent capabilities. Java advertises both; Node advertises neither because
its npm-script runner has no saved run configurations or source-root editor.
Services that support run configurations return `runConfigurations` (entries with
`id` and `name`) and `selectedRunConfigurationId` in `language.options` and in
add/select results. Other options remain opaque to the shared view.

Java's Maven configuration form, import actions, JVM breakpoint metadata and
HotSwap result details remain Java-specific views. Their reusable output toolbar
is capability-gated. The generic bottom-panel identity is `languageOutput`, with
migration of the saved `java` panel preference; legacy `java.configuration`
shortcuts migrate to the descriptor command `language.java.configuration`.
Remote renderer code is still deferred as described in `docs/PLUGINS.md`; language
plugins use the shared controls without loading UI bundles.
