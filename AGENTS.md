# BarnDog CLI

Working notes for agents and contributors. `README.md` is for people deciding whether to use the CLI; user documentation lives at [barndog.dev/docs](https://barndog.dev/docs). This file covers how the code is organized and how its behavior is specified.

BarnDog supports macOS, Linux, and Windows, and CI runs the same checks and coverage suite on all three. On Windows, Skill links are directory junctions and credentials get a user-only ACL. Windows files have no executable bit, so a package file's flag there comes from what BarnDog last wrote at that path, else from a `#!` first line (`fileExecutable()` in `src/platform.ts`).

## Commands

```sh
pnpm install
pnpm build             # tsc -p tsconfig.build.json, then scripts/finish-build.mjs
npm link               # puts the development `barndog` on PATH
pnpm barndog sync
pnpm format            # ESLint spacing fixes, then Prettier
pnpm lint
pnpm format:check
pnpm typecheck         # tsc over src/, tests included, without emitting
pnpm knip              # unused files, exports and dependencies; test-only use doesn't count
pnpm test              # Vitest; builds dist/ first for tests that start the CLI
pnpm test:watch        # Vitest in watch mode
pnpm test:coverage     # pnpm test with V8 coverage of src/; fails below the thresholds
```

This repository uses pnpm (pinned in `packageManager`); don't commit a `package-lock.json`. pnpm refuses packages published less than a day ago; `pnpm-workspace.yaml` exempts only our own `@barndog-ai/*` scope, so a fresh `@barndog-ai/api-contract` installs at once. Don't widen that exemption for third-party packages. Before finishing a code change, run `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm knip`, and `pnpm test`. Tests in this repository use temporary home directories and mocks or local HTTP fixtures for the BarnDog API; they do not start or test against a live BarnDog service. Some tests run the built CLI as a subprocess and use real local files and Git repositories.

Server integration checks are maintained separately and are not included in this repository. Keep the public surface (commands, options, `--json` output, and the files under `~/.barndog/`) stable or change it deliberately.

`pnpm test:coverage` (what CI runs) measures V8 coverage of `src/`, tests excluded, and writes an HTML report to `coverage/`. `coverage.thresholds` in `vitest.config.ts` sit just below the measured totals, so a change that lowers coverage fails. When you fill a gap, raise the thresholds to just below the new numbers; never lower them to make a change pass. Code that only runs inside the built CLI started as a child process (such as `src/cli.ts`) isn't counted.

The command reference at [barndog.dev/docs/cli](https://barndog.dev/docs/cli) is checked against `createProgram()`: every runnable command needs documentation, and every long option must be mentioned in its command's section. Adding, renaming, or removing a command or option needs a matching docs update. The docs aren't open source, so it's maintainers' job to keep them up to date.

`BARNDOG_DEFAULT_SERVER`, set in `.env` (see `.env.example`) or the shell when running `pnpm build`, replaces the server the setup prompt offers (`src/config/build.ts`, default `https://barndog.dev`). `scripts/finish-build.mjs` writes it into `dist/config/build.js` and restores the executable bit on `dist/cli.js`.

`pnpm knip` runs [knip](https://knip.dev) twice: once over everything, then with `--production`, which leaves `src/tests/` out (`knip.json` marks the production files with `!`). So an export only a test imports is reported: delete it, stop exporting it, or test it through the code that calls it. Export a name only when another module imports it. The exceptions are a regex constant or parser that `src/tests/patterns.test.ts` table-tests (see Code style) and an error-code list that `src/tests/errors.test.ts` checks for completeness: mark it `@internal` in its doc comment and the production run skips it. A new entry script (one started by path, like `entry/knowledge-startup.ts`) goes in `knip.json` `entry`.

## Releases

The version lives only in `package.json`; `barndog --version` reads it at runtime. Every npm version has a matching `vX.Y.Z` Git tag and GitHub release, all created by `.github/workflows/release.yml`. Never run `npm publish` by hand. To release from a clean, up-to-date `main`:

```sh
npm version patch      # or minor, or prerelease --preid rc; commits and tags
git push --follow-tags
```

The workflow checks that the tag matches `package.json`, runs the full checks, publishes with npm trusted publishing and provenance, and creates a GitHub release with generated notes. A version with a prerelease suffix (`0.2.0-rc.0`) goes to the `next` dist-tag and is marked as a prerelease; everything else goes to `latest`. While the version is 0.x, a breaking change to the public surface (commands, options, `--json` output, files under `~/.barndog/`) bumps the minor version; anything else bumps the patch version. Docs describe the latest `main` and don't name a version.

Publishing has no npm token. The `barndog` package trusts `release.yml` in `barndog-ai/barndog-cli`, running in the `npm` GitHub environment (npmjs.com → `barndog` → Settings → Trusted publishing); renaming the workflow file or environment breaks publishing until that setting is updated.

## Code style

- Values defined by an outside format or protocol (Git modes, harness event names, HTTP headers, size limits) get a named constant with a comment saying where they come from.
- Use double quotes, semicolons, and two spaces for indentation (no tabs).
- Prettier handles formatting; ESLint enforces braces on every `if`, `else`, `for`, `while` and `do` body, and blank lines after import blocks, between class methods, around standalone declarations, before every `return`, and after every block, multiline expression and multiline `const`/`let`. Keep related imports and class fields grouped.
- Separate the logical steps inside a function with a blank line (validate input, then fetch, then transform, then write), so a function reads as paragraphs rather than one block. The lint rules add the mechanical blank lines; grouping statements by meaning is up to you.
- ESLint rejects nested ternaries (use a lookup object, early returns or `if` blocks), more than four parameters (take one named options object, so call sites say what each value is) and comma-chained declarations. `complexity` (over 15) is a warning on purpose: `pnpm lint` reports it without failing. Use it to pick what to split, and don't add new ones.
- Source under `src/` (not tests) is linted with type information (`recommendedTypeChecked`, plus `no-unsafe-type-assertion`, `no-non-null-assertion` and `switch-exhaustiveness-check`), so `as` casts and `!` are rejected. Reach for what already exists instead: `errorCode(error)` in `src/shared/values.ts` for Node error codes; `defined(value, message)` and `only(items)` in `src/shared/lookup.ts` for lookups the code relies on; Zod schemas for JSON, YAML and API data; `isRecord`/`asRecord`/`asStrings` in `src/shared/values.ts` for config files written by other tools; `responseData()` and `parsed()` in `src/features/server/client.ts` for API responses. Where TypeScript can't express a fact (such as `Object.fromEntries` keys), use `eslint-disable-next-line` with the reason. Tests may cast and assert.
- Prefer self-explanatory names and types. Add a comment when purpose, expectations or consequences are not clear from the code: explain why, an external constraint, a non-obvious side effect, or a required format. Exporting a member does not by itself require documentation. Put shared context in a file-level comment when that avoids repeating it on each member, and keep member comments for specific surprises. See [Names say what; comments say why](#names-say-what-comments-say-why).
- Define parsed fields in a Zod schema, validate the input once, and read the typed result. Mark fields the input may omit with `.optional()`. Avoid repeated property checks on loosely typed objects (`"key" in object`, then `object.key`): typos can compile and values remain `unknown`. Key field-specific error messages by the schema's field names (`Partial<Record<keyof z.infer<typeof schema>, string>>`) so typos fail to compile.
- Never identify an error by its message text. Throw a class (`instanceof`) or a typed code (`PackageError` with a `PackageProblemCode` in `src/errors.ts`), and map codes to wording in a `switch` or `Record` the compiler checks for exhaustiveness; `src/tests/errors.test.ts` checks every code has a friendly message. Text that only an outside source provides is read in one named place: the server's refusal code in `ApiError.message` (`serverCode()`), package codes thrown as message text by `@barndog-ai/api-contract` (`packageError()`), and Git's stderr (named, table-tested patterns such as `UNKNOWN_IDENTITY`).
- A failure the person running the CLI can cause or fix (bad input, missing setup, an unreachable server, permissions, conflicts, files changed by hand) is a `CliError`: a one-sentence message saying what happened, and as its hint the command that fixes it (`barndog pull`, `barndog login`), or a short instruction when no command does. When the fix is a command that deletes or changes something (`rm -rf …`, `chmod 600 …`), the hint says in words what to do and the `command` option holds the command, built for the platform's shell with `fixSteps()`, `removeCommand()` and friends in `src/platform.ts`; it prints as `Command:` under `Fix:`. Network failures become one in `serverFetch()`. A plain `Error` means a broken internal invariant or server contract that no command can fix; word its message as the fact that broke (`The server sent an invalid page of results`).
- Use `pnpm lint:fix` for automatic lint fixes. Generated output, dependencies, machine-local state, and canonical skill fixtures are excluded from formatting.
- A regex that is more than a fixed prefix or suffix check (`/\.git$/`, `/^error: /`) is a named constant or a small pure function with a doc comment showing the input it expects, and has a table test in `src/tests/patterns.test.ts` covering matching, non-matching and edge cases. When only that test imports it, tag its doc comment `@internal` so `pnpm knip` accepts the export. Identifier shapes and text formats used in more than one place (UUIDv4, Git object names, asset names, front matter, the YAML `name:` line, slugs, origin selectors) live once in `src/shared/patterns.ts`; import them rather than writing the pattern again. `eslint-plugin-regexp` (`recommended`) rejects buggy, ambiguous and slow patterns. Prefer string methods (`endsWith`, `indexOf`, `replaceAll`) when no pattern is needed.

When a fix reveals a mistake likely to recur, consider a simple ESLint rule that catches it without complex configuration or restricting valid code. Add it as an error and fix existing violations when it fits; do not add a warning as unfinished enforcement. Otherwise, add or refine a concise agent instruction here only when it would help prevent the same mistake. Describe the pattern and what to do, without retelling the incident or duplicating existing guidance. Do not force a lint rule or a new instruction for every fix.

### One typed function per operation; never route on a string

An operation selected by a string is invisible to the type checker: typos fail at runtime, callers cast results and assert options, and unused operations go unnoticed.

- Give every operation its own exported function. Required inputs are required parameters, and the return type says what comes back. Expose it as its own `CommandContext` member wired in `createProgram()`, and fake only that member in tests.
- Share plumbing through private helpers (`withLockedWorkspace()` in `environment/operations.ts`, `backend()` in `collaboration/index.ts`), never through a shared entry point that takes the operation's name.
- A typed union parameter is fine when the variants differ only in name, take the same options and return the same type: `changeAsset("install" | "remove" | "enable" | "disable", …)`. When a variant needs other options or returns something else, split it out.
- Warning signs: a parameter named `action`, `type` or `operation` typed `string`; an options type whose fields are all optional; `Promise<unknown>` results that callers cast with `as`; `!` on option fields; template literals that build operation names; `throw new Error(\`Unknown action: …\`)`.

### Names say what; comments say why

A comment that restates the code drifts from it and buries the comments that matter; a clearer name never drifts.

- Before writing a comment, try to make it unnecessary: rename the function or variable (`cloudConnection()` rather than `cloud()`), replace a positional boolean with a named option (`findScope(…, { forRemoval })`) or a value the function already understands (`assetId(…, change)`), or use a default parameter instead of explaining a fallback.
- Keep a comment only for what the code can't say: why something is done, a rule from outside the code (a server or harness behavior), a non-obvious consequence (`installSetAssets` doesn't follow later additions to the scope), or a units/format note on a field (`decisions` is a file path, not JSON).
- Warning signs: a comment whose words mostly repeat the identifier below it; a call site where you can't tell what a boolean argument means without opening the function (`assetId(workspace, target, true)`, unlike `setKnowledge(true)`); a comment explaining what an abbreviation or generic name (`run`, `typed`, `handle`, `data`) means.

### Define a type, then use it; never derive it from a function

A type read back from a function's signature (`Awaited<ReturnType<typeof workingStatus>>`) has no definition of its own: changing the function silently changes every user of the type, and a reader has to open the function to learn what the type is.

- Write the type first with a clear name, add a comment when its meaning needs explanation, define it beside the function and declare it in the signature (export it when another module uses it): `export type ConflictResolution = …;` then `resolveFile(…): Promise<ConflictResolution>`. The same goes for options, parameters and list elements. `CommandContext` uses the same names as the functions behind it.
- Prefer a type `@barndog-ai/api-contract` already exports (`Change`, `GitConnection`, `McpDefinition`, `HookManifest`). Otherwise use `z.infer<typeof schema>`, never Zod's internal `schema._output`; for a schema used in more than one place, export one named type and import it.
- A `const` list whose union a type needs repeats the type it serves (`Harness` in `harnesses/types.ts`, `harnesses` in `registry.ts`), rather than the type being read off the list.
- Allowed: `z.infer<typeof schema>`, and types a third-party package or the platform doesn't name (`Parameters<typeof styleText>[0]`, `typeof fetch`).

### One job per module

A file does one job you can name in a few words: a command group, a sync phase, one prompt flow. When code adds a second job, give it its own file beside the first, named for what it does (`stage.ts`, `writes.ts`, `add-hook.ts`), and keep the original as the short sequence that calls them.

## Terminal output

- Use the shared `primary()` formatter from `src/ui/theme.ts` for brand accents (`#C54836`), including the heading and interactive selection. Keep ordinary text neutral.
- Define colors as named constants in `src/ui/theme.ts`; do not hardcode color values in UI components. Use `selected()` for green checked circles and `primary()` for the cursor and other brand accents.
- Format commands shown in help, instructions, next steps, and errors consistently with bold terminal styling. For example, use `styleText('bold', 'barndog sync')` from `node:util`.
- Respect terminal capabilities and `NO_COLOR`; use the appropriate output stream when applying styling. Do not print Markdown backticks as a substitute for terminal formatting.
- Keep instructions concise and concrete. Refer to actual filenames or paths, such as `~/.barndog/config.yaml`, instead of vague terms such as "skill configuration directory."
- Use whitespace and restrained emphasis to establish hierarchy. Avoid repeating keyboard instructions already displayed by the prompt.

Commands render tables and key/value blocks through `src/ui/format.ts` and end failures with a `Fix:` command (`CliError` in `src/errors.ts`). `--json` prints the underlying data instead, and failures print `{"error":{"message","fix","command"}}` on stderr (`fix` and `command` only when present; a change that needs override decisions adds `decisions`, each `{assetId, kind, name}`) with the same exit code. Asset and set commands open a searchable picker (`src/ui/pick.ts`) only when the name is omitted in an interactive terminal; `--json`, `--no-interactive`, `CI`, or a non-TTY make missing names fail with a usage hint. Pickers draw from the right source: `install` from the catalog minus what is selected, `remove`/`disable`/`enable`/`rename` from the local inventory (`src/features/inventory/`). Bare `barndog` runs setup, as `barndog init` does, when `~/.barndog/config.yaml` doesn't exist yet and it runs in a terminal; otherwise it prints help grouped into Get started, Assets, Working copy & review, and Workspace sections.

## Architecture

Commander.js owns command parsing, argument validation, and generated help. Inquirer is responsible for interactive prompts.

```text
src/
├── cli.ts                  # Executable entry point, exit codes and process errors
├── entry/                  # Harness-executed scripts, process arguments, output and exit codes
├── program.ts              # Commander composition and dependencies
├── version.ts              # `barndog --version` report
├── commands/               # Thin command handlers and availability checks
├── features/               # Workflows, grouped by feature; no UI imports
├── harnesses/              # Native adapters, hook profiles, registry and detection
├── config/                 # Settings, installation state and build-time config
├── shared/                 # Feature-free helpers: lookups, patterns, value guards, files, locks, shell quoting
├── ui/                     # Prompts, result formatting and shared theme
└── tests/                  # Command, workflow and filesystem coverage
```

- Imports point down the layers: `commands/` → `ui/` → `features/` → `config/` → `harnesses/` → `platform.ts` and `runtime.ts` → `shared/`. `config/` imports no feature (the persisted selection, the asset kinds and their folders live in `config/selection.ts`), `ui/` imports no command (a prompt declares the members it needs rather than taking `CommandContext`), and features import no UI or command. ESLint enforces the direction (`no-restricted-imports` per layer) and rejects any import cycle between files (`import-x/no-cycle`). When two modules need each other, move what they share into a lower module, often a type into a file of its own, rather than importing back up or hiding the cycle behind a dynamic `import()`.
- Feature folders are ordered too, from the bottom up, and a feature imports only features below it, never one beside or above it:
  1. Foundations: `asset-kinds/`, `asset-selection/`, `auth/`, `native/`
  2. `server/`: the verified connection, requests, origins, paging and the environment catalog
  3. Where assets come from, and read-only server features: `workspace/`, `discovery/`, `github/`, `repositories/`, `skills/`
  4. `imports/`, `knowledge/`, `inspection/`
  5. The sync engine and Hooks: `environment/`, `hooks/`
  6. Features that sync or read what sync installed: `collaboration/`, `doctor/`, `inventory/`, `onboarding/`
  7. Workflows that end in a sync: `migration/` (migrate, move, promote), `mcps/` (including the MCP import)
  8. `catalog/`: search across every kind's catalog; `adoption/`: `barndog adopt` takes over the Skills, MCP servers and Hooks the coding tools already have

  Put a new feature folder in the lowest tier above everything it imports, and add it here. When a feature needs one beside or above it, move the shared part lower or the caller higher, as `promote()` moved to `migration/` because it ends in a local move.

- Every server call uses the contract's typed client: `apiClient(conn.server, home).GET("/v1/developers/{id}/assets", { params: { path, query } })` (`src/features/auth/transport.ts`), so the route, parameters, method and body are checked against the server's OpenAPI document. Wrap the call in `parsed(schema, …)` (`src/features/server/client.ts`) to validate what the server actually sent; the client throws `ApiError` for a refusal. Never build a `/v1/…` path from a template literal or call `fetch` or `serverFetch()` outside `features/auth/` and `features/server/`. When the route depends on the asset kind, keep one typed call per kind in a `Record` (`assetRoutes` in `server/catalog.ts`, `packageDownloads` in `workspace/packages.ts`). Package bodies are fetched with `parseAs: "stream"` and read by `unpackDownload()` (`workspace/packages.ts`), which limits download size and, when a commit is supplied, requires the response ETag to equal that commit. This rejects a response tagged with a different revision; it is not a content-hash verification or a cache freshness check.
- The rest of `src/features/server/`: `connection()` (the saved, verified Cloud connection), `RetryKey`, `scopes()`, `matchesOrigin()` and `selectOrigin()`, `allPages()` and `PAGE_SIZE` for cursor-paginated lists, and the environment catalog (`environmentCatalog()`, `getAsset()`, `selectAsset()`). It depends only on `config/`, `auth/` and `asset-kinds/`, so every feature can use it.
- `src/cli.ts` is the executable entry point and handles process exit codes and errors. `src/program.ts` constructs a fresh Commander program and wires dependencies.
- Every workflow receives a required `RuntimeContext` (`src/runtime.ts`) containing `home`, `cwd`, `env`, and `platform`. Resolve these once in `createProgram()` and pass the same context through commands, UI and features. Only `src/program.ts`, `src/cli.ts`, and `src/entry/` read ambient home/cwd/environment/platform values (`process.cwd()`, `process.env`, `process.platform`, `os.homedir()`). Put OS behavior in `src/platform.ts` and test each branch by supplying a platform. Start a program that may be a Windows `.cmd` shim (a harness CLI, an MCP server's `npx`) through `cross-spawn`, or `programOutput()` to read its output; Node's own `spawn` and `execFile` refuse `.cmd` files without a shell. Pure path helpers may take a path string. Tests use `testRuntime(temporaryHome, overrides)` and can replace cwd, env or platform without changing the process. Package paths always use `/`; convert to local paths only at filesystem boundaries and test Windows drive/UNC paths and case-insensitive containment.
- Register commands under `src/commands/` and in `createProgram()`. Keep handlers thin: parse arguments, call a workflow, and present its results. The program factory accepts injected operations and output callbacks, so parsing and help can be tested without installing anything or opening prompts. Handlers reach features through `CommandContext` (`src/commands/context.ts`), one typed member per operation; see [One typed function per operation](#one-typed-function-per-operation-never-route-on-a-string).
- Put scripts launched by a coding tool (session-start sync, knowledge context, Hook execution, and MCP launching) under `src/entry/`. An entry script reads process arguments and input, calls feature logic, and handles stdout, stderr, and exit codes. Keep reusable operations in `src/features/` so commands and tests can call them without starting a process. When an entry path changes, sync must update the registrations BarnDog owns in the coding tool's settings.
- Put reusable operations under `src/features/`, grouped by feature. Return structured results; do not import Commander, Inquirer, terminal styling, or UI modules into feature operations.
- Keep coding-tool definitions and detection under `src/harnesses/`. Shared feature code reads tool-specific settings and behavior from `HarnessAdapter` (`src/harnesses/types.ts`) through `adapters[harness]`. Use fields for differences such as settings paths and event names, and adapter functions when behavior differs. For example, `adapters[harness].hooks.entry(command)` builds each tool's Hook registration; its implementation belongs in that tool's adapter. Put formats shared by tools in `src/harnesses/formats.ts`. Iterate over `harnesses` from `registry.ts`, and use `adapters[id].name` for display. Avoid repeating tool-specific lookup tables or value-selection branches in features; a one-off behavior may still use an explicit condition.
- Keep shared asset-kind definitions (display words, command group, API route, folders, schema, manifest, and scaffold) in `assetKinds` in `src/features/asset-kinds/`. Keep facts used by only one module, and functions that need network imports, in a typed map beside their caller (`Record<AssetKind, …>` or `Record<PackageKind, …>`). Index the map by `kind` instead of repeating value-selection branches; a new kind then requires a map entry at compile time. Iterate over `assetKindList` for all assets or `packageKindList` for downloadable packages; for example, `packageKindList.map((kind) => assetKinds[kind].manifest)` lists package manifest filenames. Conditions that narrow a type or perform kind-specific behavior are fine.
- Put a helper that knows nothing about BarnDog (value guards, lookups, text patterns, shell quoting) in `src/shared/`, grouped by what it works on, and import it from there; `src/shared/` imports nothing from the rest of `src/`. A feature imports another feature only for that feature's own work (`synchronize()`, `listChanges()`), never for a general utility that happens to live there. Before writing a helper, search `src/shared/` and `@barndog-ai/api-contract` for one; when you find a general helper inside a feature, move it to `src/shared/` instead of importing it across features. Write files with `writeAtomic()` and read configuration with `fileText()` (`src/shared/files.ts`). A file that may be missing is read with `readIfExists()`, or `readJsonIfExists(path, schema)` for JSON, and any other filesystem call that may hit a missing path goes through `ifExists()`; don't write another `code === "ENOENT"` catch. Check containment with `isInside()`, and serialize work across processes with `withPidLock()` (`src/shared/lock.ts`). Commander option parsers live in `src/ui/options.ts` (`positiveInteger`).
- Define paths under `~/.barndog/` in `barndogPaths()` (`src/config/paths.ts`), and paths inside a local workspace in `localWorkspaceFiles()`. Local workspace folders remain supported, both on their own and alongside a Git or Cloud workspace. For persisted structured data, define a Zod schema, use one reader, and write through `writeAtomic()`. Do not construct these paths separately at call sites. Persisted paths and formats are part of CLI compatibility; `src/tests/paths.test.ts` pins paths, so moving one requires deliberate compatibility handling.
- Keep configuration and installation-state persistence under `src/config/` and terminal prompts and formatting under `src/ui/`.
- To test a command or feature against a Cloud workspace, use `cloud(t)` from `src/tests/cloud.ts`: a temporary signed-in home and a fake server whose replies come from the contract's schemas through `sample()` (`src/tests/sample.ts`), so a fixture can't drift from the server. `server.run([...])` runs a real command line, `server.respond()` replaces one route, and `server.requests` and `server.bodies` record what was sent. Add a new route to `defaultRoutes()` rather than stubbing `fetch` in the test.
- Tests live in `src/tests/` and run on Vitest with `expect`; use Vitest's `assert` only where a check must narrow a type. A test that starts a Node process runs the built JavaScript through `built()` in `src/tests/built.ts`. In parsing tests, inject a fake workflow and assert that command arguments and options reach it correctly, including defaults and invalid input. Test the workflow itself by calling it with fixtures and temporary directories and checking its results and file changes. Keep both levels: parsing tests verify command wiring; workflow tests verify what the operation does. Do not introduce placeholder modules for features that are not being implemented.
- The [asset selection engine](src/features/asset-selection/README.md) calculates workspace subscriptions, individual selections, exclusions, and activation for Skills, MCP configurations, and Hooks. It is a pure library; commands, settings, and native installation use it.
- The CLI talks to a BarnDog server through the typed client and shared package helpers in [`@barndog-ai/api-contract`](https://www.npmjs.com/package/@barndog-ai/api-contract). That package is generated from the server.

## Workspace sources

`barndog init` chooses where assets come from: a BarnDog server (cloud or self-hosted), one Git repository (`--repo <url>`) on any host using the developer's own credentials and no BarnDog server, or a local folder (`--local`, `~/.barndog/workspace`) with the same layout. Skills, knowledge, MCP configurations, and Hooks install from Git and local workspaces as they do from cloud, with no prompt: keeping the repository safe is the job of its maintainers and members.

`WorkspaceSource` (`src/features/workspace/source.ts`) is all sync knows about where assets come from. `cloudSource` wraps the REST API; `src/features/workspace/` (`repo-source.ts`, `format.ts`, `snapshot.ts`, `git.ts`) reads a bare clone in `~/.barndog/git/<workspaceId>.git` or a folder, through a `Snapshot` of Git object names, and builds the same catalog cloud returns. Asset IDs are hashes formatted as UUIDv4, and versions are Git tree or blob hashes. Nothing is checked out and no repository hooks run. `src/features/collaboration/workspace-git.ts` handles working copies, committing to review branches through a throwaway index. `barndog migrate --to <server>` moves a Git workspace to cloud (`src/features/migration/`). A local folder can stay active beside a Git or Cloud workspace (`src/features/workspace/overlay.ts`), and `barndog local move` copies its assets across. `barndog skills add`, `hooks add` and `mcp add` bring assets into the local folder from a repository, a harness or JSON (`src/features/imports/`). `src/commands/availability.ts` stops commands the current setup can't run, before they prompt or reach a server.

Every workspace type registers a session-start `sync --auto` in each selected harness. Git limits its fetches to one per five minutes. Cloud goes through `src/features/environment/auto-sync.ts`: at most once per five minutes it reads `/v1/environment/catalog/revision` and syncs only when that differs from the revision last delivered, recorded in `~/.barndog/cloud-check.json`. A local folder beside cloud always syncs, because it can change at any time.

## Setup

`barndog init` chooses a workspace connection, takes its server URL (`--server <url>` supplies it directly), and signs in (`--no-browser` for SSH). Setup verifies and reuses existing sessions, or starts sign-in for missing or expired ones. It shows the organization and identity before selecting harnesses and organization, membership-team, and personal assets. Local mode cannot be combined with a server. After the user confirms starting over, setup asks for the source again and only contacts a server for cloud; choosing another source removes what the old one installed. Successful sign-in is retained when setup is cancelled; saved preferences and installed assets are preserved. Re-running `init` replaces the selection with exactly what is chosen.

Harness detection lists Claude Code, Codex, Cursor, and OpenCode. It looks for executable commands on PATH and for installed desktop apps: `/Applications` and `~/Applications` on macOS, `.desktop` entries in the XDG data folders on Linux, and `%LOCALAPPDATA%\Programs` or `%ProgramFiles%` on Windows. Skill directories do not count as installation evidence. An undetected harness remains selectable. First-time setup starts with nothing checked; rerunning setup restores saved choices. Ctrl+C cancels without changing settings. Onboarding requires a terminal; noninteractive sync works after onboarding and never silently selects all harnesses.

Connected setup preselects the organization and, when the developer belongs to exactly one team, that team. Multiple membership teams start unchecked. Personal assets are an optional source. Each source offers all, recommended only, or custom selections. Personal recommendations are personal assets marked recommended in an organization or team distribution. Custom and personal choices select current individual assets; organization/team subscriptions follow matching future additions. Scopes already subscribed to (including repositories and non-member teams) are also offered, so unchecking removes them. Other repositories are not listed during init; `barndog sets list --origin repo --search <name>` finds one and `barndog sets install repo/<name>` adds it. Without `--mode`, set installation prompts for all, recommended only, or custom; noninteractive callers must pass `--mode`. Directory changes never choose or switch the team. Reopening setup restores saved choices as defaults but replaces the selection: unchecked sources, earlier individual picks outside the choices, exclusions, and disabled overrides are dropped. Shared knowledge defaults to enabled; `knowledge: false` or `barndog knowledge disable` turns it off, and setup preserves a saved disabled setting.

## Selections and settings

A set is an existing organization, team, or repository scope. Individually installing an asset records a persistent independent selection, even when a set already supplies it. Team switching replaces team subscriptions and retains other subscriptions, independent choices, exclusions, and activation overrides. `remove`, `enable`, `disable`, and `rename` exist under `skills`, `mcp`, and `hooks`; a removal also excludes an asset still supplied by a subscription. `sets switch` replaces the team or repository subscriptions of the same type. Reinstalling a scope or asset with existing overrides asks for a decision. Noninteractive callers must pass `--overrides preserve`, `--overrides clear`, or a JSON `--decisions` file containing `[{"assetId":"<uuid>","choice":"preserve"}]`.

There is one user configuration, `~/.barndog/config.yaml`. All commands apply the same machine-wide environment regardless of the current directory. The file has one shape, `Settings` in `src/config/settings.ts`, with no format version. API selections live in `environment`:

```yaml
harnesses: [claude, codex, cursor]
connection:
  server: https://your-barndog.example
  organizationId: <uuid>
  developerId: <uuid>
environment:
  subscriptions: []
  individualAssetIds: []
  excludedAssetIds: []
  disabledAssetIds: []
knowledge: true
```

`sync --config <path>` is an explicit one-shot delivery input that shares the user's installation ownership state. It does not establish project configuration or change the default preferences. The override must include `harnesses`.

`skills list`, `mcp list`, and `hooks list` show installed, then disabled, then available assets (origin, contributing sets, harnesses, state; `--paths` for locations). `--installed`, `--disabled`, and `--available` narrow the list. Catalog search (`skills search [query]`, also `mcp`/`hooks`) and `sets list` show 20 results per page by default with `--origin`, `--page`, and `--limit` (up to 100). Search and pagination filter the complete visible catalog locally; they do not install assets or change selections.

## Safe native delivery

BarnDog records only its own Skill links, MCP entries, and Hook registrations in `~/.barndog/state.json`. Sync never adopts an existing installation, even an identical one; only `barndog adopt` takes one over, by copying it and removing the original (see Adoption). Collisions and manual edits stop preflight before destination changes. JSONC comments and unrelated entries, TOML settings, native authentication data, and working copies survive updates and removal. A removed Skill link leaves its source intact. Published caches and editable working copies remain separate. Cached package modifications are rejected before reuse.

Each published Skill or Hook is materialized once into a readable, stable folder, `~/.barndog/installed/{skills,hooks}/<name>`, from the immutable commit-pinned cache in `~/.barndog/packages/` (keyed by server, organization, developer, asset ID, and commit so identities and versions never mix). Harness links point at the stable folder; new versions are mirrored into it file by file (`src/features/workspace/installed.ts`), so harness file watchers see updates. After each successful sync, `pruneCache` (`src/features/workspace/packages.ts`) deletes cached versions no installed folder uses for the current identity; other identities' caches are untouched. `state.json` records each folder's fingerprint; hand edits stop sync with a fix. Folder writes are journaled like links and files.

Skill links per harness:

| Harness     | Destination                        |
| ----------- | ---------------------------------- |
| Claude Code | `~/.claude/skills/<name>`          |
| Codex       | `~/.agents/skills/<name>`          |
| Cursor      | `~/.cursor/skills/<name>`          |
| OpenCode    | `~/.config/opencode/skills/<name>` |

Cursor support targets local Agent sessions. Cursor also discovers the shared `~/.agents/skills/` and compatibility `~/.claude/skills/` locations, so those links may already expose a Skill there; BarnDog also manages Cursor's own directory. Harness selection controls which native directories BarnDog manages; it does not prevent a harness from discovering Skills through another harness's compatibility directory. Cursor Cloud Agents and remote workers are out of scope.

OpenCode also reads `~/.claude/skills/` and `~/.agents/skills/`, and its MCP servers go under `mcp.servers` in `~/.config/opencode/opencode.jsonc`, the file it creates and reads last (`mcp.path` in its adapter); `mcp add --from` also reads its `config.json` and `opencode.json` (`mcp.files`, `mcp.imported`). It has no command hooks, so its adapter is a `PluginAdapter` (`src/harnesses/types.ts`): Hook assets are reported unsupported for it, and the session-start sync and knowledge index run from `~/.config/opencode/plugins/barndog.js`. Sync writes that file whole from its `sync` and `knowledge` entries (`src/features/native/plugin-module.ts`); it imports `barndog()` from `src/entry/opencode-plugin.ts`, which OpenCode runs in its own process. Code that handles Hooks takes a `HookHarness` and iterates `hookHarnesses`; the contract's Hook manifests name only those tools.

Synchronization stages all content, resolves the complete catalog, checks runtimes and destinations, and journals writes before applying them. Every required package is fetched and validated before harness links change; missing assets, network failures, conflicting names, or unmanaged destinations fail without replacing the installation. A later command rolls an interrupted operation forward; unexpected intervening edits stop recovery. Preserve those edits before restoring a journal's expected state. Migration backups are in `~/.barndog/migrations/`. Never discard an unresolved journal to force an installation. A user-level lock (`~/.barndog/sync.lock`) prevents concurrent syncs.

`doctor` recovers a pending sync first, then runs every check (configuration, harness detection, session, preflight, clashes, unsupported Hooks) without applying new native writes, printing a fix for each problem; it may populate the package cache. Unsupported Hook implementations are reported per harness and skipped. Codex configurations using a top-level inline `mcp_servers = { ... }` table are rejected safely; native table sections are supported. Custom `CLAUDE_CONFIG_DIR`, and nondefault `CODEX_HOME` and `XDG_CONFIG_HOME` (OpenCode) locations, are reported as unsupported before delivery.

## Adoption

`barndog adopt` (offered once by a first `barndog init`) scans each selected harness for Skills, user-level MCP servers and Hook entries that `state.json` doesn't list, copies the chosen ones into the local folder, takes the originals out of the tools and syncs so BarnDog's copies install in their place (`src/features/adoption/`). Each asset is chosen on its own, named `<harness>/<kind>/<name>` (`--only`, `--all`, `--dry-run`). A Skill or MCP server another harness has under the same name goes with it, because BarnDog installs one copy everywhere; two different copies can't both be chosen. A Skill folder moves to `~/.barndog/adoptions/<id>/skills/`; a Skill that is the user's own link is only unlinked, and its target is never touched; each settings file is copied to `settings/` beside it before its first change (`barndogPaths().adoption(id)`). A Hook entry becomes a package whose command runs a copy of its script through `${BARNDOG_HOOK_ROOT}`; a command with no script file is wrapped in a `#!/bin/sh` script, so on Windows it is skipped. `record.json` is written before anything changes and stays `pending` until the sync installed every asset; a failure undoes the adoption. `adopt list` and `adopt undo` print summaries that leave out the settings entries, which may hold literal API keys; `record.json` (mode `0600`) keeps them. `adopt undo [id] [--only …]` removes BarnDog's copies, syncs, then puts back each original, checking the disk at every step so it can finish an adoption that stopped halfway. Undo refuses when BarnDog's copy was edited since (`--force` discards the edits) or something else now sits at an original's place.

## Name clashes

Skill folder names and MCP server keys are shared namespaces per harness. `src/features/environment/names.ts` resolves clashes before staging. The asset already installed (else the most specific scope: dev, repo, team, org) keeps the name. In a terminal the user chooses to rename the new or installed asset to `<origin-type>-<origin-slug>-<name>`, skip the new one, or replace the installed one. Renames persist in `localNames` (asset ID → name) in `config.yaml`; skip and replace persist in `disabledAssetIds`. A renamed Skill's installed `SKILL.md` `name:` is rewritten to match its folder. Automatic renames are dropped once the clash is gone. Without a terminal, the newcomer is skipped for that run, the sync completes, and a `rename … --as …` fix is printed; `doctor` and `status` list unresolved clashes.

## MCP configurations

The JSON file for `mcp create`/`update` is the server's distinct MCP definition: transport `stdio` with `command`, `args`, and `environment`, or `http` (Streamable HTTP) with `url` and `headers`; plus `description`, `authentication`, and optional `sourceUrl`. Environment/header values are `{ "secretRef": "LOCAL_ENVIRONMENT_VARIABLE" }`, never credential values. Claude and Cursor receive native variable references; Codex receives native forwarding/header references and, for renamed stdio variables, a local reference-only launcher. Missing values fail locally at runtime. Native OAuth remains per harness. Claude/Codex login runs in BarnDog's neutral user directory; Cursor authentication uses its settings UI. Unchanged syncs do not log out or rewrite registrations. `--key` makes cloud writes retry exactly.

## Hooks

A Hook scaffold (`hooks create`) is a private editable working copy, not an installation. Hook collaboration reuses the Skill working-copy/review machinery with distinct Hook schemas and endpoints. `packageApi(kind, conn, runtime)` in `src/features/collaboration/api.ts` holds the routes of each kind, one typed call per operation; the working-copy and review code calls it and never names a `/v1/skills` or `/v1/hooks` route. Results keep the contract's own shape: a Hook proposal or version names its asset `hookId` in `--json` output, a Skill one `skillId` (`PackageChange` and `changeAssetId()` in `collaboration/results.ts`). Code shared by both kinds holds the asset under the neutral `assetId` (the working-copy record, `PackageUpload`), and each kind's route names it itself; never rename one kind's field into the other's. `hooks pull`, `versions`, `show`, `diff`, and `changes` provide the matching workflows. Root `push`, `pull`, `status`, `diff`, and `resolve` act on whatever the working copy holds and name no kind; `push` in a folder that isn't a working copy yet takes its kind from the one manifest file it has (`packageKindOf()` in `asset-kinds/`). Reviews live under each kind (`skills changes …`, `hooks changes …`); there is no root `changes`. Below the commands `kind` is always required: never default a package kind to Skill. Only explicit `hooks test` runs a script; publishing, pulling, and syncing never do. Choose a handler explicitly when an event has several commands. Tests inherit the caller's working directory and runtime environment, supply the chosen native JSON input, and limit time/output. A test runs the Hook in the shell its tool would: `sh` on macOS and Linux; on Windows the tool's `windowsShell` (Git Bash for Claude Code, PowerShell for Cursor and Codex; Codex releases that ran hooks in cmd.exe aren't supported). `src/features/native/hook-shell.ts` writes every command line BarnDog registers in that shell; the tool runs it.

Each manifest declares its own harness events, scripts, requirements, and compatibility. BarnDog binds `BARNDOG_HOOK_ROOT` to the stable installed package folder without translating events or changing working-directory semantics. The harness's own plugin-root variables (`rootVariables` in its hook profile, such as `CLAUDE_PLUGIN_ROOT`) are bound to the same folder. Each harness's hook profile lives in `src/harnesses/<harness>.ts`: the settings files to detect, its events, and its root variables. `hooks add` installs a Hook only for harnesses whose settings it finds and never translates between them; for the rest, `src/features/hooks/adapt.ts` writes one agent prompt (`hooks adapt` reprints it). `src/features/hooks/divergence.ts` warns when harnesses run different scripts, using `divergentHookTools` from the contract package so the workspace UI shows the same warning. Native harness trust/review requirements still apply after registration. `skills show`, `hooks show` and `mcp show` describe one asset in any workspace (origin, version, where it's installed, a Hook's events per tool) and pick it from a list when the name is omitted; `--files` or `--version` print a published version's files, which a local folder doesn't have; `hooks compatibility` reports the version-specific support matrix and unmet local requirements; explicit test success does not change the author's compatibility claims.

## Knowledge and discovery

Knowledge startup integration supplies only names and descriptions of `always` entries. Full content requires `knowledge get`; on-demand entries remain in the listing. Disabling integration removes only BarnDog's owned index registration. Discovery follows tenant visibility. Skill/Hook promotion creates a proposal for a new scope-owned asset; MCP promotion creates a separate authorized configuration. A fork into your own personal scope is published at once; other targets need a review. Original personal assets remain intact.

Repository inspection matches Git fetch remotes against web-managed `gitRemote` values. SSH/HTTPS normalize to the same credential-free host/path. No match or ambiguous mappings are reported without guessing from folder names.

## Authentication

`barndog login` prompts for the server URL on first use; `--server <origin>` supplies it directly, and later logins reuse the saved server. The browser opens the server's sign-in page; the user confirms that its code matches the terminal. `--no-browser` displays the URL/code without opening a browser. An existing session is reported instead of reopening the browser unless `--force` is passed. An operator must bind the user's identity to an active BarnDog developer before organization access is granted.

`auth status` / `whoami` show identity, organization, role, server and session expiry, and exit 1 when signed out. `logout` revokes the selected server's credential and removes its local copy; the saved connection remains the default server. Sessions last up to 30 days and may end earlier.

Credentials are stored in `~/.barndog/credentials.json` (mode `0600`, parent directory `0700` on POSIX; a user-only ACL on Windows), keyed by server origin. Identity-provider keys and refresh tokens stay on the server. API and package requests attach the BarnDog credential, reject redirects, and require HTTPS except for loopback development servers. Login never prints the credential. Remove API selections before switching server, organization, or developer. Authentication and network failures preserve settings and installed files. Logout and access removal cannot retract content already downloaded.

## Working copies and review

`skills pull <name> --origin <origin>` creates an editable working folder (default `./<name>`; `--directory <path>` selects another new folder) and refuses existing destinations. Origins accept `org`, `team/<slug>`, `repo/<slug>`, `dev/<slug>`, `me`, scope UUIDs, and colon selectors such as `org:<slug>`. For a new Skill, create its folder and `SKILL.md`, then run `barndog push --origin <origin>` there. No local Git repository or commits are required. Local `.git` state is excluded from uploads; symlinks and unsafe packages are rejected. Working folders are independent of installed harness packages; pull, edit, review, and push leave installation choices alone.

Reviews and merges require the revision that was inspected. Approval does not publish. Members merge under their team's or repository's approval and merger settings; defaults are one other member's approval and any member may merge. Request-changes reviews remain blocking until the requesting eligible reviewer approves the current revision. Material revisions invalidate approvals. Authors can't review their own changes. Scope admins and organization admins can bypass review thresholds; personal owners may publish their own Skills. `push --publish` requires that direct-publication authority. Normal pushes create suggestions even for admins. Authors and authorized admins may reject; rejected proposals require `push --new`.

Inline comments take `--path SKILL.md --side new --start-line 6 --end-line 6`. `--replacement-file <path>` and `--expected-file <path>` suggest a replacement using exact text files; a file's closing newline isn't part of the selected lines. `--body-file <path>` supplies longer comments, `--thread <id>` replies, `skills changes apply <id> <thread> --revision <number>` (or `hooks changes apply`) applies a current suggestion, and `changes resolve-discussion` / `changes reopen-discussion` under either kind set discussion state. Applying a suggestion creates a revision; the author runs `barndog pull` to receive it.

`barndog pull` first reconciles remote proposal edits, then merges the latest published version into the working copy. Nonconflicting text edits combine automatically. Conflicting text has base/local/remote markers; binary and modify/delete conflicts retain the local choice for explicit resolution. After editing, `barndog resolve <path>` marks a file resolved; push is blocked until every conflict is resolved. Stale proposals cannot merge, including admin merges.

Working-copy records, base/proposal snapshots, retry keys, and conflict state live under `~/.barndog/workspaces/`, keyed by canonical folder path. Commands work from the working folder or its descendants. Moving a working folder does not move its registration. Recovery snapshots under `workspaces/snapshots/` retain the pre-pull files and metadata. Interrupted local writes resume on the next working-copy command. Ambiguous upload failures retain the original submission for exact retry; definitive validation/conflict failures allow reconciliation without discarding local edits. Server or identity mismatches block remote operations.

`features/collaboration/workspace.ts` orchestrates package creation, local reconciliation, and submission. `workspace-store.ts` owns persisted records, the workspace lock, snapshots, and interrupted-write recovery. `workspace-github.ts` owns external pull-request reconciliation and submission. Changes here must keep a pending upload's retry key and payload, so an ambiguous failure still retries exactly.

## GitHub connections and mirrors

Connect, import, and transfer make GitHub authoritative. Working-copy `push` creates or revises the same external PR; `pull` reconciles PR edits and newly published main content. Pending uploads retain exact payloads and keys across ambiguous failures. `github pulls review`, `comment`, and `merge` use an inspected `--expected-commit`. Standalone `pulls create` and `revise` accept a complete `--directory`, title/body, expected commit, and retry key. Publication occurs only after canonical main is fetched and validated; `push --publish` still obeys GitHub permissions and protections.

`--mode mirror` keeps BarnDog authoritative and uses internal collaboration. Divergence requires `github resolve-mirror <id> --action <use-barndog|use-mirror|disconnect> --expected-version <uuid> --expected-remote <sha|absent> --key <retry-key>`. No mode silently changes authority or overwrites unrelated history. `github import --authority barndog` makes an independent BarnDog-owned copy with published ancestry; `--authority github` (the default) keeps connected-import behavior. `github create-repository` creates a destination and exports published history; an ambiguous create never silently adopts an existing repository.

## Native links

Deselecting a harness removes its managed links and keeps selections. `barndog harnesses enable`, `disable` and `select` (`src/features/environment/harnesses.ts`) change `harnesses` in `config.yaml` and sync at once, so a disabled tool loses every link, entry and registration BarnDog owns there, and later syncs never write to it. Sync refuses to overwrite unmanaged destinations, including links whose ownership records were lost, and never recursively deletes a skill directory.

## Live distribution check

Filesystem tests alone do not establish that a live agent discovered or used a Skill. To check native discovery, run `barndog skills add fixtures/skills/barndog-distribution-check` (it copies the Skill into the local workspace) and `barndog sync`, then in a fresh session invoke `/barndog-distribution-check` (Claude Code), `$barndog-distribution-check` (Codex), or `/barndog-distribution-check` in a local Cursor Agent chat. Each agent must read the supporting file and return:

```text
BarnDog skill distribution verified: amber-otter-729.
```

Then disable the fixture, sync, and verify in fresh sessions that it is gone; re-enable and sync to restore it. A second `barndog sync` should report links unchanged. Native discovery references: [Claude Code](https://code.claude.com/docs/en/skills), [Codex](https://developers.openai.com/codex/skills), [Cursor](https://cursor.com/docs/skills).
