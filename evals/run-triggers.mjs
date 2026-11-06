// Trigger evals: does Claude Code call the kton skill when it should, and
// only then? Each prompt runs headless in a project that has the skill
// installed (`npx skills add <this repo> -a claude-code -y`), with the shell
// and every writing tool off, so the skill can be chosen but nothing runs.
// It uses the signed-in Claude Code account; each prompt is one short run.
//
//   node evals/run-triggers.mjs <project-with-the-skill>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const project = process.argv[2];
if (!project) throw new Error("usage: node evals/run-triggers.mjs <project-with-the-skill>");
const prompts = JSON.parse(readFileSync(new URL("./triggers.json", import.meta.url), "utf8"));

let passed = 0;
for (const { expect, lang, prompt } of prompts) {
  const run = spawnSync(
    "claude",
    ["-p", prompt, "--output-format", "stream-json", "--verbose", "--max-turns", "2",
      "--no-session-persistence", "--allowedTools", "Skill", "Read",
      "--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Agent"],
    { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 },
  );
  const skills = [];
  for (const line of (run.stdout ?? "").split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "assistant") continue;
    for (const part of event.message.content ?? []) {
      if (part.type === "tool_use" && part.name === "Skill") skills.push(part.input.skill);
    }
  }
  const triggered = skills.includes("kton");
  const ok = triggered === (expect === "trigger");
  if (ok) passed += 1;
  console.log(`${ok ? "pass" : "FAIL"}  ${expect.padEnd(10)} ${lang.padEnd(5)} ${prompt}  [${skills.join(", ")}]`);
}
console.log(`${passed}/${prompts.length} as expected`);
process.exit(passed === prompts.length ? 0 : 1);
