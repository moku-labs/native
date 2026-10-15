/**
 * @file build plugin — the `icons` phase: regenerates the icon set from the configured source
 * unless the stamp beside the set still describes it, then (android) re-applies the adaptive
 * icon inset.
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Target } from "../../config";
import type { BuildContext, BuildDeps } from "./types";

/**
 * Name of the stamp file the icons phase writes beside the generated set. An mtime
 * comparison cannot answer the question that matters — pointing `app.icon` at an OLDER file
 * is a change too — so the stamp records WHICH source the set was generated from.
 */
export const ICON_SOURCE_STAMP_FILE = ".source";

/**
 * Reads a path's modification time, treating an absent path as "no mtime" rather than
 * an error — a missing generated icon simply means the set has to be regenerated.
 *
 * @param target - The path to stat.
 * @returns The modification time in milliseconds, or undefined when the path is absent.
 * @example
 * ```ts
 * const mtime = await modifiedAt("/app/.moku/tauri/src-tauri/icons/icon.png");
 * ```
 */
async function modifiedAt(target: string): Promise<number | undefined> {
  try {
    const stats = await stat(target);
    return stats.mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Builds the stamp for one icon source: its absolute path, size and modification time. Any
 * of the three changing means the generated set no longer matches the configured icon.
 *
 * @param source - The icon source path.
 * @returns The stamp text, or undefined when the source is absent.
 * @example
 * ```ts
 * await iconSourceStamp("/app/assets/icon.png"); // "/app/assets/icon.png\n20480\n1758…"
 * ```
 */
async function iconSourceStamp(source: string): Promise<string | undefined> {
  try {
    const stats = await stat(source);
    return [path.resolve(source), stats.size, stats.mtimeMs].join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Reads the stamp a previous icons pass left, treating an absent/unreadable stamp as "never
 * generated" — the set is regenerated rather than trusted.
 *
 * @param stampPath - Path of the stamp file.
 * @returns The recorded stamp text, or undefined when there is none.
 * @example
 * ```ts
 * await readIconSourceStamp("/app/.moku/tauri/src-tauri/icons/.source");
 * ```
 */
async function readIconSourceStamp(stampPath: string): Promise<string | undefined> {
  try {
    return await readFile(stampPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Runs the `icons` phase: resolves the icon source through `project.ensureIconSource()`
 * (the configured `app.icon`, or a generated placeholder) and regenerates the full icon
 * set with `tauri.icon()`. The set is left alone ONLY when the generated
 * `src-tauri/icons/icon.png` exists, the stamp beside it still describes the current source,
 * AND this pass did not run `mobileInit` — a fresh `gen/` tree ships Tauri's own default
 * icons, which must be overwritten.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - Phase input.
 * @param opts.mobileInitRan - Whether codegen initialized the mobile tree in this pass.
 * @returns The phase detail: `"up to date"`, `"generated"` or `"placeholder"`.
 */
export async function runIcons(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: { mobileInitRan: boolean }
): Promise<{ detail: string }> {
  // Resolve the icon source and where its generated set and stamp live.
  const source = await deps.project.ensureIconSource();
  const iconsDirectory = path.join(ctx.global.projectDir, "src-tauri", "icons");
  const stampPath = path.join(iconsDirectory, ICON_SOURCE_STAMP_FILE);

  // Read what the current set was generated from, and what the source is now.
  const [generatedAt, stamp, recordedStamp] = await Promise.all([
    modifiedAt(path.join(iconsDirectory, "icon.png")),
    iconSourceStamp(source),
    readIconSourceStamp(stampPath)
  ]);

  // A set that still matches its source is kept, unless mobile init just replaced it.
  const isFresh = generatedAt !== undefined && stamp !== undefined && recordedStamp === stamp;
  if (isFresh && !opts.mobileInitRan) {
    ctx.log.debug("build:icons", { action: "skipped", source });
    return { detail: "up to date" };
  }

  // Regenerate the set and record which source it came from.
  await deps.tauri.icon({ source });
  if (stamp !== undefined) {
    await mkdir(iconsDirectory, { recursive: true });
    await writeFile(stampPath, stamp, "utf8");
  }
  ctx.log.debug("build:icons", { action: "generated", source });
  return { detail: ctx.global.app.icon ? "generated" : "placeholder" };
}

/**
 * Runs the whole `icons` phase for one target: {@link runIcons}, then on android the
 * adaptive icon inset — re-applied on every build, also when the set was up to date,
 * because `tauri icon` rewrites the launcher files the inset lives in.
 *
 * @param ctx - The build pipeline's domain context.
 * @param deps - The resolved project/tauri APIs.
 * @param opts - Phase input.
 * @param opts.target - The packaging target the icons are for.
 * @param opts.mobileInitRan - Whether codegen initialized the mobile tree in this pass.
 * @returns The phase detail of {@link runIcons}.
 */
export async function runIconsPhase(
  ctx: BuildContext,
  deps: BuildDeps,
  opts: { target: Target; mobileInitRan: boolean }
): Promise<{ detail: string }> {
  const result = await runIcons(ctx, deps, opts);
  if (opts.target === "android") await deps.project.patchMobileIcons({ target: opts.target });
  return result;
}
