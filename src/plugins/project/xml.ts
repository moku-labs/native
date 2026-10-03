/**
 * @file project plugin — XML text escaping, shared by the two XML files this plugin writes
 * into: the `Info.ios.plist` sidecar and the Android manifest.
 */

/**
 * XML's five predefined entities. `&` goes first, so the ampersand of an entity written
 * by a later step is never escaped a second time.
 */
const XML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&apos;"]
];

/**
 * Escapes text for an XML element body or a quoted attribute value. A value lands
 * verbatim in a generated file, where an unescaped `<` or `"` would end the element or
 * the attribute around it.
 *
 * @param text - The raw value.
 * @returns The value with `& < > " '` written as entities.
 * @example
 * ```ts
 * escapeXml(`Tom & "Jerry"`); // "Tom &amp; &quot;Jerry&quot;"
 * ```
 */
export function escapeXml(text: string): string {
  let escaped = text;
  for (const [pattern, entity] of XML_ESCAPES) {
    escaped = escaped.replace(pattern, entity);
  }
  return escaped;
}
