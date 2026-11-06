import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The repository is in English. The exceptions are the trigger words in
 * SKILL.md's description, which name the request in several languages so the
 * skill is found whatever language the user writes in, and the trigger evals,
 * which ask in those languages.
 */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((file) => /\.(md|ts|mjs|js|json|ya?ml)$/.test(file))
  // Captured chain responses are data: a token may well have a Chinese name.
  // The trigger evals ask in four languages on purpose.
  .filter((file) => !/(^|\/)fixtures\//.test(file) && !file.startsWith("evals/"));

const text = (file: string) => {
  const content = readFileSync(file, "utf8");
  return file === "kton/SKILL.md"
    ? content.replace(/^description: .*$/m, "")
    : content;
};

describe("the repository's language", () => {
  it("lists the files it checks", () => {
    expect(files).toContain("kton/SKILL.md");
  });

  it.each(files)("%s has no Chinese text", (file) => {
    const lines = text(file)
      .split("\n")
      .flatMap((line, i) => (CJK.test(line) ? [`${i + 1}: ${line}`] : []));
    expect(lines).toEqual([]);
  });
});
