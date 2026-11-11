import { test } from "node:test";
import assert from "node:assert/strict";
import { assetPage } from "../ui/asset-list.js";
import { renderCatalog } from "../ui/assets.js";
import { table } from "../ui/format.js";
import { createProgram } from "../program.js";
import { CommanderError } from "commander";

const rows = Array.from({ length: 65 }, (_, n) => ({
  id: String(n),
  kind: "skill" as const,
  name: `skill-${String(n).padStart(2, "0")}`,
  origin: { type: n % 2 ? "team" : "org", slug: "engineering", id: "x" },
  version: {
    number: 2,
    description: n % 2 ? "React code review" : "General conventions",
  },
}));

test("asset browsing bounds output, sorts before paging, and combines origin and keyword filters", () => {
  const options = { page: 2, limit: 20 };
  const result = assetPage([...rows].reverse(), options);
  assert.equal(result.total, 65);
  assert.deepEqual(result.rows, rows.slice(20, 40));
  const filtered = assetPage(rows, {
    ...options,
    page: 1,
    origin: "team/engineering",
    search: "react review",
  });
  assert.equal(filtered.total, 32);
  assert.ok(filtered.rows.every((r) => r.origin.type === "team"));
  const rendered = renderCatalog(
    rows,
    options,
    "barndog skills search",
    new Set(),
  ).join("\n");
  assert.match(rendered, /Showing 21–40 of 65/);
  assert.match(rendered, /barndog skills search --page 3/);
  assert.doesNotMatch(rendered, /skill-40/);
});

test("a truncated cell keeps its styling", () => {
  const [line] = table([["\u001b[2mlong description\u001b[22m"]], {
    indent: 0,
    width: 8,
  });
  assert.equal(line, "\u001b[2mlong de…\u001b[22m");
  const [boundary] = table(
    [["\u001b[1mabcdefg\u001b[22m\u001b[2mhijkl\u001b[22m"]],
    {
      indent: 0,
      width: 8,
    },
  );
  assert.equal(boundary, "\u001b[1mabcdefg\u001b[22m\u001b[2m…\u001b[22m");
});

test("the version column only appears when something has a version number", () => {
  const options = { page: 1, limit: 20 };
  const render = (list: typeof rows) =>
    renderCatalog(list, options, "barndog skills search", new Set()).join("\n");
  const hashed = {
    ...rows[0]!,
    version: { ...rows[0]!.version, label: "1e708e1" },
  };
  const local = render([hashed]);
  assert.doesNotMatch(local, /Ver|1e708e1/);
  assert.match(local, /General conventions/);
  const mixed = render([hashed, rows[1]!]);
  assert.match(mixed, /Ver/);
  assert.match(mixed, /v2/);
  assert.doesNotMatch(mixed, /1e708e1/);
});

test("list output escapes terminal control sequences and reports empty pages clearly", () => {
  const text = renderCatalog(
    [{ ...rows[0]!, name: "evil\u001b[31m" }],
    { page: 1, limit: 20 },
    "barndog skills search",
    new Set(),
  ).join("\n");
  assert.ok(text.includes("evil\\u001b[31m"));
  assert.match(
    renderCatalog(
      rows,
      { page: 9, limit: 20 },
      "barndog skills search",
      new Set(),
    )[0]!,
    /Page 9 is empty/,
  );
});

test("list shows installed, then disabled, then available, and filters each", async () => {
  const onMachine = (
    id: string,
    state: "installed" | "disabled" | "pending",
  ) => ({
    id,
    kind: "skill" as const,
    name: id,
    installedName: id,
    origin: "org",
    via: ["org"],
    state,
    harnesses: [],
    paths: [],
  });
  const catalogRow = (id: string) => ({
    ...rows[0]!,
    id,
    name: id,
  });
  const items = [
    onMachine("off", "disabled"),
    onMachine("on", "installed"),
    onMachine("soon", "pending"),
  ];
  const run = async (
    args: string[],
    catalog: () => Promise<ReturnType<typeof catalogRow>[]> = async () => [
      catalogRow("zeta"),
      catalogRow("on"),
      catalogRow("alpha"),
    ],
  ) => {
    let loaded = 0;
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      searchCatalog: async () => {
        loaded++;
        return catalog();
      },
      inventory: async () => ({
        harnesses: [],
        server: null,
        knowledge: false,
        offline: null,
        items,
      }),
    }).parseAsync(["skills", "list", ...args], { from: "user" });
    return { text: lines.join("\n"), loaded };
  };
  const names = async (...args: string[]) =>
    (
      JSON.parse((await run([...args, "--json"])).text) as { name: string }[]
    ).map((item) => item.name);

  assert.deepEqual(await names(), ["on", "soon", "off", "alpha", "zeta"]);
  assert.deepEqual(await names("--installed"), ["on", "soon"]);
  assert.deepEqual(await names("--disabled"), ["off"]);
  assert.deepEqual(await names("--available"), ["alpha", "zeta"]);
  assert.deepEqual(await names("--disabled", "--available"), [
    "off",
    "alpha",
    "zeta",
  ]);
  assert.equal((await run(["--disabled"])).loaded, 0);

  const table = (await run([])).text;
  assert.match(table, /alpha .*available/);
  const paged = (await run(["--limit", "2"])).text;
  assert.match(paged, /Showing 1–2 of 5/);
  assert.match(paged, /barndog skills list --page 2/);
  assert.doesNotMatch(paged, /alpha/);
  assert.match((await run(["--page", "9"])).text, /Page 9 is empty/);

  const nothing = createProgram({
    write: (line) => emptyLines.push(line),
    writeError: () => {},
    searchCatalog: async () => [],
    inventory: async () => ({
      harnesses: [],
      server: null,
      knowledge: false,
      offline: null,
      items: [],
    }),
  });
  const emptyLines: string[] = [];
  await nothing.parseAsync(["mcp", "list"], { from: "user" });
  assert.match(emptyLines.join("\n"), /No MCP servers yet\./);
  assert.match(emptyLines.join("\n"), /barndog mcp add/);

  const failing = async () => {
    throw new Error("server down");
  };
  const partial = await run([], failing);
  assert.match(partial.text, /Couldn't load available Skills: server down/);
  assert.match(partial.text, /on .*installed/);
  await assert.rejects(run(["--available"], failing), /server down/);
});

test("search flags parse for every asset type and invalid pages fail before loading", async () => {
  let loaded = 0;
  const program = createProgram({
    write: () => {},
    writeError: () => {},
    searchCatalog: async () => {
      loaded++;
      return [];
    },
    inventory: async () => ({
      harnesses: [],
      server: null,
      knowledge: false,
      offline: null,
      items: [],
    }),
  });
  for (const kind of ["skills", "mcp", "hooks"])
    await program.parseAsync(
      [
        kind,
        "search",
        "review",
        "--origin",
        "org",
        "--page",
        "2",
        "--limit",
        "5",
      ],
      { from: "user" },
    );
  assert.equal(loaded, 3);
  for (const args of [
    ["--limit", "101"],
    ["--page", "0"],
    ["--limit", "1.5"],
  ])
    await assert.rejects(
      program.parseAsync(["skills", "search", ...args], { from: "user" }),
      CommanderError,
    );
  assert.equal(loaded, 3);
});

test("search returns the same matches as JSON and as a table", async () => {
  const catalog = ["review", "testing"].map((name) => ({
    id: name,
    kind: "skill" as const,
    name,
    origin: { type: "org", slug: "acme", id: "org" },
    version: { number: 1, description: `${name} helper` },
  }));
  const run = async (...args: string[]) => {
    const lines: string[] = [];
    await createProgram({
      write: (line) => lines.push(line),
      writeError: () => {},
      searchCatalog: async () => catalog,
      inventory: async () => ({
        harnesses: [],
        server: null,
        knowledge: false,
        offline: null,
        items: [],
      }),
    }).parseAsync(["skills", "search", "review", ...args], { from: "user" });
    return lines.join("\n");
  };
  const table = await run();
  assert.match(table, /review/);
  assert.doesNotMatch(table, /testing/);
  assert.deepEqual(
    (JSON.parse(await run("--json")) as { name: string }[]).map((r) => r.name),
    ["review"],
  );
});
