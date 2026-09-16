import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Generated } from "../model/index.js";

const manifestName = "effect-wsdl.manifest.json";
const allowedFiles = new Set(["schemas.ts", "metadata.ts", "client.ts", "index.ts", manifestName]);
const exists = async (path: string) => {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};
async function noSymlinks(path: string) {
  let current = resolve(path);
  while (true) {
    if ((await exists(current))?.isSymbolicLink())
      throw new Error("Output paths cannot contain symlinks");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
async function ownedFiles(target: string): Promise<string[]> {
  const manifest = await exists(join(target, manifestName));
  if (!manifest) return [];
  if (!manifest.isFile()) throw new Error("Invalid output manifest");
  const parsed: unknown = JSON.parse(await readFile(join(target, manifestName), "utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("format" in parsed) ||
    parsed.format !== 1 ||
    !("owned" in parsed) ||
    !Array.isArray(parsed.owned) ||
    parsed.owned.some((n: unknown) => typeof n !== "string" || !allowedFiles.has(n)) ||
    new Set(parsed.owned).size !== parsed.owned.length ||
    !parsed.owned.includes(manifestName)
  )
    throw new Error("Invalid ownership manifest");
  return parsed.owned as string[];
}

/** The CLI owns its dedicated output directory. Unowned entries are never removed. */
export async function writeOutput(
  output: string,
  generated: Generated,
  check = false,
): Promise<boolean> {
  const requested = resolve(output);
  if ((await exists(requested))?.isSymbolicLink()) throw new Error("Output cannot be a symlink");
  let ancestor = dirname(requested);
  const missing: string[] = [basename(requested)];
  while (!(await exists(ancestor))) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  // Canonicalize explicitly selected parent directories (e.g. macOS /var → /private/var).
  const target = join(await realpath(ancestor), ...missing);
  await noSymlinks(target);
  if (Object.keys(generated.files).some((n) => !allowedFiles.has(n)))
    throw new Error("Unsafe generated filename");
  const old = await exists(target);
  if (old && !old.isDirectory()) throw new Error("Output must be a directory");
  const owned = old ? await ownedFiles(target) : [];
  const entries = old ? await readdir(target) : [];
  for (const name of entries) {
    if (!owned.includes(name)) {
      if (check) return false;
      throw new Error(`Output directory contains unowned file: ${name}`);
    }
    if (!(await lstat(join(target, name))).isFile())
      throw new Error("Owned output must be regular files");
  }
  const currentNames = Object.keys(generated.files).sort();
  const unchanged =
    old &&
    JSON.stringify([...owned].sort()) === JSON.stringify(currentNames) &&
    JSON.stringify([...entries].sort()) === JSON.stringify(currentNames) &&
    (
      await Promise.all(
        currentNames.map(
          async (name) => (await readFile(join(target, name), "utf8")) === generated.files[name],
        ),
      )
    ).every(Boolean);
  if (check) return Boolean(unchanged);
  if (unchanged) return true;
  await mkdir(dirname(target), { recursive: true });
  await noSymlinks(target);
  const lock = `${target}.effect-wsdl-lock`;
  await mkdir(lock); // Atomic exclusion against concurrent generator processes.
  let stage: string | undefined;
  let backup: string | undefined;
  try {
    // Recheck after locking in case a competing writer completed during validation.
    const now = await exists(target);
    if (Boolean(now) !== Boolean(old) || (now && old && now.ino !== old.ino))
      throw new Error("Output changed concurrently; retry generation");
    stage = await mkdtemp(join(dirname(target), `.${basename(target)}-stage-`));
    for (const [name, text] of Object.entries(generated.files))
      await writeFile(join(stage, name), text, { flag: "wx" });
    if (old) {
      backup = join(lock, "previous");
      await rename(target, backup);
    }
    try {
      await rename(stage, target);
      stage = undefined;
    } catch (e) {
      if (backup) {
        await rename(backup, target);
        backup = undefined;
      }
      throw e;
    }
    if (backup) {
      await rm(backup, { recursive: true });
      backup = undefined;
    }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    // A failed rollback leaves the backup and lock for explicit recovery.
    if (!backup) await rm(lock, { recursive: true, force: true });
  }
  return true;
}
