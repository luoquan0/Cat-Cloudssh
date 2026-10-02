import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base || ""))
  throw new Error("Pass the reviewed 40-character baseline commit");
const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cloudssh-types-"));
const baseline = path.join(temporary, "baseline");
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
function diagnostics(directory) {
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      "--noEmit",
      "--incremental",
      "false",
      "--pretty",
      "false",
      "-p",
      "tsconfig.app.json",
    ],
    { cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const records = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*?)\((\d+),(\d+)\): error TS(\d+): (.*)$/.exec(line);
    if (match) {
      let file = match[1].replaceAll("\\", "/");
      if (path.isAbsolute(file))
        file = path.relative(directory, file).replaceAll("\\", "/");
      current = {
        file,
        code: match[4],
        message: match[5],
        position: `${match[2]}:${match[3]}`,
      };
      records.push(current);
    } else if (current && line.trim()) current.message += `\n${line.trim()}`;
  }
  if (result.status !== 0 && records.length === 0)
    throw new Error(
      `Type checker failed without diagnostics: ${output.slice(-4000)}`,
    );
  return { records, output };
}
try {
  execFileSync("git", ["worktree", "add", "--detach", baseline, base], {
    stdio: "pipe",
  });
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(baseline, "node_modules"),
    "dir",
  );
  const previous = diagnostics(baseline);
  const next = diagnostics(root);
  const key = (record) => `${record.file}\n${record.code}\n${record.message}`;
  const counts = new Map();
  for (const record of previous.records)
    counts.set(key(record), (counts.get(key(record)) || 0) + 1);
  const added = [];
  const agentFiles =
    /(?:RuntimePanelAgent|PanelRuntimeBridge|RuntimeToolCard|panel-runtime-api|PanelAgentPanel|AdminPanelAgentSection|panel-agent-api|WorkspaceUtilityRail)\.(?:tsx?|ts)$/;
  for (const record of next.records) {
    const count = counts.get(key(record)) || 0;
    if (!count || agentFiles.test(record.file)) added.push(record);
    else counts.set(key(record), count - 1);
  }
  fs.mkdirSync(".type-reports", { recursive: true });
  fs.writeFileSync(".type-reports/baseline.txt", previous.output);
  fs.writeFileSync(".type-reports/candidate.txt", next.output);
  console.log(`Full frontend baseline diagnostics: ${previous.records.length}`);
  console.log(`Full frontend candidate diagnostics: ${next.records.length}`);
  console.log(
    `New diagnostics or diagnostics in Agent integration files: ${added.length}`,
  );
  if (previous.records.length)
    console.log(
      "The repository already has frontend type errors. This gate is NOT a claim that the full frontend type check passes.",
    );
  if (added.length) {
    for (const record of added)
      console.error(
        `${record.file}:${record.position} TS${record.code} ${record.message}`,
      );
    process.exitCode = 1;
  }
} finally {
  try {
    execFileSync("git", ["worktree", "remove", "--force", baseline], {
      stdio: "pipe",
    });
  } catch {
    /* Preserve the original diagnostic failure. */
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
