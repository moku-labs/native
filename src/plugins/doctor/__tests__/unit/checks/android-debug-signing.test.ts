import path from "node:path";
import { describe, expect, it } from "vitest";
import { debugKeystorePath, resolveDebugKeystore } from "../../../../project/mobile/signing";
import { androidDebugSigningCheck } from "../../../checks/android-debug-signing";
import { createCheckInput, createEnv, createFs } from "./fixtures";

/** The debug keystore under a POSIX home. */
const KEYSTORE = path.join("/home/me", ".android", "debug.keystore");

describe("androidDebugSigningCheck.appliesTo", () => {
  it("applies to android only (bug: noise on iOS-only runs)", () => {
    const { global } = createCheckInput();
    expect(androidDebugSigningCheck.appliesTo("android", global)).toBe(true);
    expect(androidDebugSigningCheck.appliesTo("ios", global)).toBe(false);
    expect(androidDebugSigningCheck.appliesTo("host", global)).toBe(false);
  });
});

describe("androidDebugSigningCheck.run", () => {
  it("passes when the keystore exists and names it with the adb install steps", async () => {
    const input = createCheckInput({
      target: "android",
      env: createEnv({ HOME: "/home/me" }),
      fs: createFs({ files: { [KEYSTORE]: "" } })
    });

    const result = await androidDebugSigningCheck.run(input);

    expect(result).toMatchObject({
      id: "android-debug-signing",
      target: "android",
      status: "pass"
    });
    expect(result.message).toContain(KEYSTORE);
    expect(result.message).toContain("adb install -r");
    expect(result.message).toContain("adb pair");
    expect(result.message).toContain("adb connect");
  });

  it("warns, not fails, with the keytool fix-it when the keystore is missing (bug: store-only users blocked)", async () => {
    const input = createCheckInput({ target: "android", env: createEnv({ HOME: "/home/me" }) });

    const result = await androidDebugSigningCheck.run(input);

    expect(result.status).toBe("warn");
    expect(result.fixIt).toContain("keytool -genkeypair");
    expect(result.fixIt).toContain(KEYSTORE);
    // Doctor only reports: it never generates the keystore itself.
    expect(input.probe).not.toHaveBeenCalled();
  });

  it("looks under USERPROFILE when HOME is unset (bug: Windows host)", async () => {
    const keystore = path.join(String.raw`C:\Users\me`, ".android", "debug.keystore");
    const input = createCheckInput({
      target: "android",
      env: createEnv({ USERPROFILE: String.raw`C:\Users\me` }),
      fs: createFs({ files: { [keystore]: "" } })
    });

    const result = await androidDebugSigningCheck.run(input);

    expect(result.status).toBe("pass");
  });

  it("warns, not throws, when no home directory is set at all", async () => {
    const result = await androidDebugSigningCheck.run(
      createCheckInput({ target: "android", env: createEnv() })
    );

    expect(result.status).toBe("warn");
    expect(result.fixIt).toContain("keytool -genkeypair");
  });

  it("reports the keystore project signs with when HOME is empty (bug: doctor's own `??` home rule drifted from the build's)", async () => {
    const env = createEnv({ HOME: "", USERPROFILE: "/home/me" });
    // The path the debug signing patch writes into the Gradle config for this environment.
    const signedWith = debugKeystorePath(env);

    const result = await androidDebugSigningCheck.run(createCheckInput({ target: "android", env }));

    expect(signedWith).toBe(KEYSTORE);
    expect(result.status).toBe("warn");
    expect(result.message).toContain(`at ${signedWith},`);
    expect(result.fixIt).toBe(resolveDebugKeystore(env).createCommand);
  });
});
