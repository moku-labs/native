/**
 * @file doctor plugin — checks/ registry barrel: every Check the doctor API iterates over
 * (the providers pattern, spec/15 §1).
 */
import { androidCheck } from "./android";
import { completenessCheck } from "./completeness";
import { crossRepoCorsCheck, crossRepoDeepLinkCheck } from "./cross-repo";
import { iosPlatformCheck } from "./ios-platform";
import { iosToolsCheck } from "./ios-tools";
import { nodeCheck } from "./node";
import { rustupCheck } from "./rustup";
import { signingCheck } from "./signing";
import { tauriCliCheck } from "./tauri-cli";
import type { Check } from "./types";
import { versionsCheck } from "./versions";
import { webScriptCheck } from "./web-script";
import { xcodeCheck } from "./xcode";

/**
 * Every registered check, in a stable order (drives report/emission order when multiple
 * checks apply to the same scope). One module per concern, added here and nowhere else.
 */
export const CHECKS: readonly Check[] = [
  nodeCheck,
  tauriCliCheck,
  rustupCheck,
  xcodeCheck,
  iosToolsCheck,
  iosPlatformCheck,
  androidCheck,
  signingCheck,
  completenessCheck,
  versionsCheck,
  webScriptCheck,
  crossRepoCorsCheck,
  crossRepoDeepLinkCheck
];
