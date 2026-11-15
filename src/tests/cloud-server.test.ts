import { expect, test } from "vitest";
import { cloud, ID } from "./cloud.js";

test.for([
  ["GET", `/v1/skill-changes/${ID}/reviews`],
  ["POST", `/v1/hook-changes/${ID}/merg`],
  ["POST", `/v1/git-connections/${ID}/pulls/7/review`],
  ["DELETE", `/v1/git-connections/${ID}`],
])(
  "rejects unexpected Cloud request %j even when a feature catches it",
  async ([method, path], t) => {
    const server = await cloud(t);
    await expect(
      server.run(["skills", "search"], {
        searchCatalog: async () => {
          await fetch(
            new Request(`http://127.0.0.1:9${path}`, { method }),
          ).catch(() => undefined);

          return [];
        },
      }),
    ).rejects.toThrow(`Unexpected Cloud request: ${method}`);
  },
);
