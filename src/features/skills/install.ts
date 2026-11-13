import { matchesOrigin } from "../collaboration/remote.js";
import { homedir } from "node:os";
import {
  readSettings,
  saveSettings,
  upgradeSettings,
  SetupRequiredError,
} from "../../config/settings.js";
import { catalog } from "./remote.js";
import { sync } from "./sync.js";
import { only } from "../../lookup.js";

export async function installSkill(
  name: string,
  origin: string,
  home = homedir(),
) {
  const settings = await readSettings(home);
  if (!settings) throw new SetupRequiredError();
  const next = upgradeSettings(settings);
  const { connection } = next;
  if (!connection)
    throw new Error("Connect with barndog init --server <url> first");
  const skill = only(
    (await catalog(connection, home)).filter(
      (skill) =>
        skill.name === name && matchesOrigin(skill.origin, origin, connection),
    ),
  );
  if (!skill)
    throw new Error(`Skill not found or ambiguous: ${origin}/${name}`);
  if (
    next.skills.some((entry) => entry.id === skill.id && entry.kind !== "api")
  )
    throw new Error("Skill ID conflicts with a local selection");
  next.skills = next.skills.filter((entry) => entry.id !== skill.id);
  next.skills.push({ kind: "api", id: skill.id, enabled: true });
  const events = await sync(undefined, home, next);
  await saveSettings(next, home);
  return events;
}
