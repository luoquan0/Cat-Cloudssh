import fs from "node:fs";
function edit(file, transform) { fs.writeFileSync(file, transform(fs.readFileSync(file, "utf8"))); }
function replace(source, before, after) { if (!source.includes(before)) throw new Error(`Final runtime anchor missing: ${before.slice(0, 90)}`); return source.replace(before, after); }
edit("src/backend/panel-runtime/jobs.ts", source => {
  source = replace(source, 'readonly root = path.resolve(process.env.DATA_DIR || "./db/data", "panel-agent-output"),', 'readonly root = path.resolve(process.env.PANEL_AGENT_OUTPUT_DIR || path.join(process.env.DATA_DIR || "./db/data", "panel-agent-output")),');
  source = replace(source, '    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });', `    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.root);
    requireValue(directory.isDirectory() && !directory.isSymbolicLink(), 409, "INVALID_OUTPUT_DIRECTORY", "日志目录必须是独立普通目录");
    await fs.chmod(this.root, 0o700);`);
  source = replace(source, '  const client = new Client();', `  const fingerprint = (host as unknown as Record<string, unknown>).hostKeyFingerprint;
  requireValue(typeof fingerprint === "string" && fingerprint.length > 0, 409, "HOST_KEY_NOT_PINNED", "请先通过网页终端核对并保存目标服务器 Host Key");
  const client = new Client();`);
  source = replace(source, '    const timeout = Number(call.arguments.timeoutSeconds ?? 600);', '    const defaultTimeout = Math.max(1, Math.min(86400, Math.floor(positiveSetting("PANEL_AGENT_COMMAND_TIMEOUT_MS", 600000) / 1000)));\n    const timeout = Number(call.arguments.timeoutSeconds ?? defaultTimeout);');
  source = replace(source, 'Number.isFinite(timeout) && timeout >= 1', 'Number.isSafeInteger(timeout) && timeout >= 1');
  source = replace(source, '    await this.store.saveJob(owner, job);\n    signal.throwIfAborted();', `    try { await this.store.saveJob(owner, job); }
    catch { const failure = new RuntimeError(503, "JOB_PERSISTENCE_FAILED", "工具执行意图保存失败，未建立 SSH 任务"); this.failures.set(run.id, failure); throw failure; }
    signal.throwIfAborted();`);
  return source;
});
edit("src/backend/panel-runtime/policy.ts", source => replace(source, 'jobId: call.name === "run_command" ? undefined : call.arguments.jobId,', 'jobId: call.name === "cancel_job" ? call.arguments.jobId : undefined,'));
edit("src/backend/panel-runtime/model.ts", source => source.replace(',parallel_tool_calls:false', ''));
edit("src/ui/sidebar/PanelRuntimeBridge.ts", source => replace(source, '  working: boolean;', '  working: boolean;\n  blocked?: boolean;'));
edit("src/ui/sidebar/PanelAgentPanel.tsx", source => replace(source, '  const sendDisabled = adminConfigMissing || modelMissing || !settings;', '  const sendDisabled = adminConfigMissing || modelMissing || !settings || Boolean(runtimeBridge?.blocked);'));
edit("src/ui/sidebar/RuntimePanelAgent.tsx", source => replace(source, 'messages, setMessages, working: busy || !initialized || active, initialTargetIds:', 'messages, setMessages, working: busy || !initialized || active, blocked: Boolean(pending.current), initialTargetIds:'));
edit("src/ui/tests/sidebar/RuntimePanelAgent.test.tsx", source => replace(source, ' } } };\n}\nasync function ready()', ' } } } as unknown as Tab;\n}\nasync function ready()'));
edit("docs/PANEL-AGENT-RUNTIME.md", source => replace(source, '| `PANEL_AGENT_OUTPUT_DIR` |', '| `PANEL_AGENT_CONCURRENT_JOBS` | 8 | Concurrent independent SSH channels |\n| `PANEL_AGENT_JOB_LOG_BYTES` | 536870912 | Per-job physical log safeguard |\n| `PANEL_AGENT_LOG_BYTES` | 4294967296 | Global physical log safeguard |\n| `PANEL_AGENT_OUTPUT_DIR` |'));
console.log("Runtime safety boundaries and compact UI integration finalized.");
