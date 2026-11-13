import { browserCommand } from "../shared/browser.js";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { login, logout, authStatus } from "../features/auth/session.js";
import { configuredServer } from "../features/auth/session.js";
import { readCredentials } from "../features/auth/credentials.js";
import { LoginRequiredError } from "../features/auth/transport.js";
import { CliError } from "../errors.js";
import { promptServer } from "./connection.js";
import {
  bad,
  bold,
  dim,
  fields,
  heading,
  hint,
  humanize,
  json,
  ok,
  warn,
} from "./format.js";

export async function openBrowser(url: string) {
  const { command, args } = browserCommand(url);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Unable to open browser")),
    );
  });
}

export type Output = {
  write: (message: string) => void;
  json?: boolean;
};

function describeIdentity(context: {
  developer: { name: string; slug: string; role: string };
  organization: { name: string; slug: string };
}) {
  return `${bold(context.developer.name)} ${dim(`@${context.developer.slug}`)} · ${context.organization.name}`;
}

export async function runLogin(
  options: {
    server?: string;
    browser: boolean;
    home?: string;
    force?: boolean;
  },
  write: (message: string) => void,
) {
  const server =
    options.server ??
    (await configuredServer(options.home)) ??
    (process.stdin.isTTY && process.stdout.isTTY
      ? await promptServer()
      : undefined);

  if (server && !options.force) {
    const current = await authStatus(options.home, server).catch((error) => {
      if (error instanceof LoginRequiredError) {
        return undefined;
      }

      throw error;
    });

    if (current) {
      write(
        `${ok("✔")} Already signed in as ${describeIdentity(current.context)}`,
      );

      write(dim(`  ${current.server}`));
      write("");
      write(
        hint("barndog logout", "Tip") +
          dim(
            "  to switch accounts, or barndog login --force to sign in again",
          ),
      );

      return;
    }
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await login({
      server,
      home: options.home,
      signal: controller.signal,
      verification: async (details) => {
        write(`\n${heading("sign-in")}\n`);
        write(`Verification code: ${bold(details.userCode)}`);
        write(`Open ${details.url} and confirm this code.`);
        if (options.browser) {
          await openBrowser(details.browserUrl).catch(() =>
            write("Open the verification URL above to continue."),
          );
        }
      },
    });

    write("");
    write(`${ok("✔")} Signed in as ${describeIdentity(result.context)}`);
    write(hint("barndog init"));
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Sign-in cancelled", { cause: error });
    }

    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new CliError(
        "Sign-in expired before it was confirmed.",
        "barndog login",
        {
          cause: error,
        },
      );
    }

    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

export async function runLogout(write: (message: string) => void) {
  const result = await logout();
  write(
    result.revoked
      ? `${ok("✔")} Signed out of ${result.server}.`
      : `${warn("!")} Removed the local credential, but ${result.server} did not confirm the session was revoked.`,
  );
}

export async function showAuthStatus(
  output: Output,
  home = homedir(),
): Promise<void> {
  const { write } = output;
  let result: Awaited<ReturnType<typeof authStatus>>;
  try {
    result = await authStatus(home);
  } catch (error) {
    if (!(error instanceof LoginRequiredError)) {
      throw error;
    }

    const server = await configuredServer(home).catch(() => undefined);
    if (output.json) {
      write(json({ signedIn: false, server: server ?? null }));
    } else {
      write(`${bad("✖")} Not signed in${server ? ` to ${server}` : ""}.`);
      write(`  ${hint(server ? "barndog login" : "barndog init", "Fix")}`);
    }

    process.exitCode = 1;

    return;
  }

  const credential = (await readCredentials(home)).servers[result.server];
  if (output.json) {
    write(
      json({
        signedIn: true,
        server: result.server,
        expiresAt: credential?.expiresAt ?? null,
        ...result.context,
      }),
    );

    return;
  }

  const { developer, organization } = result.context;
  write(`${ok("✔")} Signed in`);
  write("");
  for (const line of fields([
    ["Name", developer.name],
    ["Handle", `@${developer.slug}`],
    [
      "Organization",
      organization.slug === organization.name
        ? organization.name
        : `${organization.name} ${dim(`(${organization.slug})`)}`,
    ],
    ["Role", humanize(developer.role)],
    ["Workspace", result.server],
    [
      "Session",
      credential
        ? `expires ${new Date(credential.expiresAt).toLocaleString()}`
        : undefined,
    ],
  ])) {
    write(line);
  }
}
