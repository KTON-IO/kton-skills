import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The words KTON never uses about itself (references/wording.md, from the KTON
 * comms playbook): kept out of everything the skill says, its script's
 * output strings, its reference pages and the repository's own pages.
 * wording.md and SKILL.md's rules, which name them, are the exceptions.
 */
const BANNED = [
  /institutional/i,
  /guarantee/i,
  /risk[- ]free/i,
  /\bsafest\b/i,
  /redeem any ?time/i,
  /never (been )?paused/i,
  /time ?lock/i,
  /decentrali[sz]ed validator/i,
  /highest (yield|apy|return)/i,
  /\bhipo\b|tonstakers/i,
  /all audit fixes/i,
];

const files = [
  ...readdirSync("src").map((name) => join("src", name)),
  ...readdirSync("kton/references")
    .filter((name) => name !== "wording.md")
    .map((name) => join("kton/references", name)),
  "README.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "VERIFICATION.md",
  "docs/DESIGN.md",
];

describe("the skill's words", () => {
  it.each(files)("%s says none of the banned things", (file) => {
    const text = readFileSync(file, "utf8");
    const found = BANNED.filter((word) => word.test(text)).map(String);
    expect(found).toEqual([]);
  });
});
