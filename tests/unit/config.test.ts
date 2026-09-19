/**
 * @file Root unit — framework config helpers (`hostTargets`).
 *
 * `hostTargets` is the single source of the default `config.targets`: the one desktop
 * target the running host can actually package. Mobile is always opt-in (a mac can
 * package iOS, but only when the consumer asks for it).
 */
import { describe, expect, it } from "vitest";
import { hostTargets } from "../../src/config";

describe("hostTargets", () => {
  it("maps each supported host platform to its own desktop target", () => {
    expect(hostTargets("darwin")).toEqual(["macos"]);
    expect(hostTargets("win32")).toEqual(["windows"]);
    expect(hostTargets("linux")).toEqual(["linux"]);
  });

  it("returns an empty list for a host with no packaging target", () => {
    expect(hostTargets("freebsd")).toEqual([]);
    expect(hostTargets("aix")).toEqual([]);
    expect(hostTargets("sunos")).toEqual([]);
  });

  it("never infers a mobile target from the host platform", () => {
    const inferred = [
      ...hostTargets("darwin"),
      ...hostTargets("win32"),
      ...hostTargets("linux"),
      ...hostTargets("freebsd")
    ];

    expect(inferred).not.toContain("ios");
    expect(inferred).not.toContain("android");
  });
});
