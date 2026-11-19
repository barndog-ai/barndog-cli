import { expect, test } from "vitest";
import { convertServer, parseMcpText } from "../features/mcps/import.js";
import { CliError } from "../errors.js";

for (const wrapper of ["mcpServers", "servers", "root"] as const) {
  test(`MCP input accepts ${wrapper} maps and filters by requested name`, () => {
    const servers = {
      one: { command: "node" },
      two: { url: "https://example.test/mcp" },
      ignored: 42,
    };

    const text = JSON.stringify(
      wrapper === "root" ? servers : { [wrapper]: servers },
    );

    expect(parseMcpText(text).map((server) => server.name)).toEqual([
      "one",
      "two",
    ]);

    expect(parseMcpText(text, "two").map((server) => server.name)).toEqual([
      "two",
    ]);

    expect(() => parseMcpText(text, "missing")).toThrow(
      /^No MCP server named missing in that JSON\. It has one, two\.$/,
    );
  });
}

test("a name that isn't in the JSON is an error naming what is there, with a fix", () => {
  const text = JSON.stringify({
    mcpServers: { github: { command: "gh" }, linear: { url: "https://x" } },
  });

  const error: unknown = (() => {
    try {
      parseMcpText(text, "linaer");
    } catch (caught) {
      return caught;
    }
  })();

  expect(error).toBeInstanceOf(CliError);
  expect(error).toMatchObject({
    message: "No MCP server named linaer in that JSON. It has github, linear.",
    hint: "Run it again with one of those names",
  });
});

test("MCP input errors distinguish broken JSON, empty maps and unnamed servers", () => {
  for (const value of [null, [], 4, {}, { servers: { invalid: {} } }]) {
    expect(() => parseMcpText(JSON.stringify(value))).toThrow(
      "No MCP servers found",
    );
  }

  expect(() => parseMcpText("{")).toThrow("isn't valid JSON");
  expect(() => parseMcpText('{"command":"node"}')).toThrow("without a name");
  expect(parseMcpText('{"one":{"command":"node"}}', "renamed")[0]!.name).toBe(
    "renamed",
  );
});

for (const [given, expected] of [
  [undefined, "fixture MCP server"],
  ["", "fixture MCP server"],
  ["   ", "fixture MCP server"],
  [42, "fixture MCP server"],
  ["Reads tickets", "Reads tickets"],
] as const) {
  test(`MCP conversion describes a server given ${JSON.stringify(given)} as ${JSON.stringify(expected)}`, () => {
    const { definition } = convertServer({
      name: "fixture",
      server: { command: "node", description: given },
    });

    expect(definition.description).toBe(expected);
  });
}

test("MCP conversion turns every environment value into a reference and keeps literals out of the definition", () => {
  const result = convertServer({
    name: "fixture",
    server: {
      command: "node",
      args: ["--api-key", 12],
      env: { TOKEN: "Bearer ${TOKEN}", LITERAL: "private-value" },
      env_vars: ["FORWARDED", 2],
    },
  });

  expect(result.definition).toMatchObject({
    transport: "stdio",
    args: ["--api-key", "12"],
    environment: {
      TOKEN: { secretRef: "TOKEN" },
      LITERAL: { secretRef: "LITERAL" },
      FORWARDED: { secretRef: "FORWARDED" },
    },
  });

  // The value never reaches the definition; it's handed back so the caller can ask whether to keep it.
  expect(JSON.stringify(result.definition)).not.toContain("private-value");
  expect(result.literals).toStrictEqual([
    { key: "LITERAL", variable: "LITERAL", value: "private-value" },
  ]);

  expect(
    convertServer({ name: "fixture", server: { command: "node", args: {} } })
      .definition,
  ).toMatchObject({ args: [] });
});

test("the --description option replaces the server's own description", () => {
  expect(
    convertServer(
      { name: "fixture", server: { command: "node", description: "Own" } },
      "Given",
    ).definition.description,
  ).toBe("Given");
});

test("HTTP conversion handles alternate header formats and OAuth declarations", () => {
  const result = convertServer({
    name: "fixture",
    server: {
      httpUrl: "https://example.test/mcp",
      http_headers: { Literal: "value" },
      env_http_headers: { Forwarded: "ENV_HEADER", Ignored: 3 },
      bearer_token_env_var: "BEARER",
    },
  });

  expect(result.definition).toMatchObject({
    transport: "http",
    authentication: "environment",
    headers: {
      Literal: { secretRef: "FIXTURE_LITERAL" },
      Forwarded: { secretRef: "ENV_HEADER" },
      Authorization: { secretRef: "BEARER" },
    },
  });

  for (const server of [
    { url: "https://example.test/mcp", auth: {} },
    { url: "https://example.test/mcp", oauth: true },
  ]) {
    expect(
      convertServer({ name: "fixture", server }).definition.authentication,
    ).toBe("native-oauth");
  }

  expect(() =>
    convertServer(
      { name: "fixture", server: { command: "node" } },
      undefined,
      true,
    ),
  ).toThrow("only HTTP");

  for (const type of ["ws", "sse"]) {
    expect(() =>
      convertServer({
        name: "fixture",
        server: { type, url: "https://example.test" },
      }),
    ).toThrow("transport");
  }

  expect(() =>
    convertServer({ name: "fixture", server: { type: 1, url: 3 } }),
  ).toThrow(
    new CliError(
      'fixture can\'t be added: its url must be text, such as "https://example.com/mcp".',
    ),
  );
});
