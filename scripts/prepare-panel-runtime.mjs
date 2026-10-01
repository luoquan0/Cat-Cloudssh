import fs from "node:fs";
function edit(path, transform) { fs.writeFileSync(path, transform(fs.readFileSync(path, "utf8"))); }
function replace(source, from, to) {
  if (!source.includes(from)) throw new Error(`Integration anchor missing: ${from.slice(0, 90)}`);
  return source.replace(from, to);
}
edit("src/backend/panel-runtime/runtime.ts", source => replace(source,
  '      if (this.store.hasRun(owner, input.requestId)) return (await this.store.start(owner, input)).run;\n      requireValue(this.executions.size < positiveSetting("PANEL_AGENT_CONCURRENT_RUNS", 8),',
  '      const existing = this.store.hasRun(owner, input.requestId);\n      requireValue(existing || this.executions.size < positiveSetting("PANEL_AGENT_CONCURRENT_RUNS", 8),'));
edit("src/backend/panel-runtime/store.ts", source => {
  source = replace(source, '  async flush() { await this.persist(); }', `  async flush() { await this.persist(); }
  hasRun(owner: string, id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM panel_runtime_runs WHERE id=? AND user_id=?").get(id, owner));
  }`);
  source = replace(source, '    this.run(owner,run.id);\n    this.db.transaction', '    requireValue(this.run(owner,run.id).threadId === run.threadId, 409, "RUN_SCOPE", "Run thread changed");\n    this.db.transaction');
  source = replace(source, '      for(const row of rows) {\n        const run:RuntimeRun=JSON.parse(row.payload);', `      for(const row of rows) {
        const run:RuntimeRun=JSON.parse(row.payload);
        for (const call of run.pending) this.insertMessage(run.threadId, { id: crypto.randomUUID(), role: "tool", toolCallId: call.id, name: call.name, content: JSON.stringify({ status: "interrupted", error: "Backend restarted; execution result unknown. Inspect job status before repeating work." }) });
        run.pending = [];`);
  source = replace(source, 'this.db.prepare("SELECT id,payload FROM panel_runtime_jobs").all()', `this.db.prepare("SELECT id,payload FROM panel_runtime_jobs WHERE json_extract(payload,'$.status') IN ('starting','running')").all()`);
  return source;
});
edit("src/backend/panel-runtime/jobs.ts", source => {
  source = replace(source, 'export class OutputSpool {', `export async function waitAtMost(done: Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(signal.reason || new Error("Cancelled"));
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener("abort", abort, { once: true });
    done.then(() => finish(), finish);
    if (signal.aborted) abort();
  });
}
export class OutputSpool {`);
  source = source.replace('import { setTimeout as delay } from "node:timers/promises";\n', '');
  source = replace(source, '  async create(id: string) {', `  async remove(ids: string[]) {
    await this.init();
    for (const id of ids) for (const stream of ["stdout", "stderr"] as const) {
      const filename = this.filename(id, stream);
      try {
        const stat = await fs.lstat(filename);
        requireValue(stat.isFile(), 409, "INVALID_OUTPUT_FILE", "Output is not a regular file");
        await fs.unlink(filename);
        this.used = Math.max(0, this.used - stat.size);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  async create(id: string) {`);
  source = replace(source, '  private live = new Map<string, LiveJob>();', `  private live = new Map<string, LiveJob>();
  private failures = new Map<string, RuntimeError>();
  checkHealthy(runId: string) { const error = this.failures.get(runId); if (error) throw error; }
  clearFailure(runId: string) { this.failures.delete(runId); }`);
  source = replace(source, '    const persisted = this.store.run(owner, run.id);', '    this.checkHealthy(run.id);\n    const persisted = this.store.run(owner, run.id);');
  source = replace(source, '      catch { job.status = "interrupted"; job.error = "状态保存失败，结果需人工核对"; }', '      catch { job.status = "interrupted"; job.error = "状态保存失败，结果需人工核对"; this.failures.set(job.runId, new RuntimeError(503, "JOB_PERSISTENCE_FAILED", job.error)); }');
  source = replace(source, '    await Promise.race([done, delay(1200, undefined, { signal })]);\n    return { ...job };', '    await waitAtMost(done, 1200, signal);\n    this.checkHealthy(run.id);\n    return { ...job };');
  source = replace(source, '        const abort = () => {\n          try { stream?.signal("TERM");', '        const abort = () => {\n          if (settled || closeTimer) return;\n          try { stream?.signal("TERM");');
  source = replace(source, '          const receive = (kind:', '          let pendingBytes = 0;\n          const receive = (kind:');
  source = replace(source, '            channel.pause();\n            channel.stderr.pause();', `            if (signal.aborted) return;
            pendingBytes += data.length;
            if (pendingBytes > 8 * 1024 * 1024) { outputFailed = true; controller.abort(new Error("Output write backlog exceeded memory safety window")); return; }
            channel.pause();
            channel.stderr.pause();`);
  source = replace(source, '}).finally(() => { if (!signal.aborted) { channel.resume(); channel.stderr.resume(); } });', '}).finally(() => { pendingBytes -= data.length; if (!signal.aborted) { channel.resume(); channel.stderr.resume(); } });');
  source = replace(source, '    let job = this.store.job(owner, id);', '    this.checkHealthy(run.id);\n    let job = this.store.job(owner, id);');
  source = replace(source, 'if (active) { await Promise.race([active.done, delay(wait * 1000, undefined, { signal })]); job = { ...active.job }; }', 'if (active) { await waitAtMost(active.done, wait * 1000, signal); this.checkHealthy(run.id); job = { ...active.job }; }');
  source = replace(source, '    const stdout = await this.spool.read', `    if (args.maxBytes !== undefined) {
      const requested = Number(args.maxBytes);
      requireValue(Number.isSafeInteger(requested) && requested >= 128, 400, "INVALID_OUTPUT_SIZE", "Output page size invalid");
      maxBytes = Math.min(maxBytes, requested);
    }
    const stdout = await this.spool.read`);
  source = replace(source, 'this.running(runId).map(item => Promise.race([item.done, delay(20000, undefined, { signal })]))', 'this.running(runId).map(item => waitAtMost(item.done, 20000, signal))');
  return source;
});
edit("src/backend/panel-runtime/model.ts", source => {
  source = 'import crypto from "node:crypto";\n' + source;
  source = replace(source, 'tail:{type:"boolean"},waitSeconds:', 'tail:{type:"boolean"},maxBytes:{type:"integer",minimum:128,description:"Optional smaller output page; the runtime also applies remaining model context budget."},waitSeconds:');
  return source;
});
edit("src/backend/database/routes/panel-agent.ts", source => {
  source = `import { createRuntimeRouter } from "../../panel-runtime/router.js";
import { createCurrentPanelRuntime, authorizeRuntimeSession, authorizeRuntimeTarget } from "../../panel-runtime/service.js";
import type { RuntimeModelConfig } from "../../panel-runtime/model.js";
` + source;
  source = replace(source, '  maxTokens: number;\n  toolRoundLimit:', '  maxTokens: number;\n  contextWindowTokens?: number;\n  toolRoundLimit:');
  source = replace(source, '    toolRoundLimit: 20,', '    contextWindowTokens: 32768,\n    toolRoundLimit: 20,');
  source = replace(source, '    toolRoundLimit: Math.round(', '    contextWindowTokens: Math.round(numberInRange(value.contextWindowTokens, 32768, 4096, 2000000)),\n    toolRoundLimit: Math.round(');
  source = replace(source, '  const fetchImpl = dependencies.fetchImpl ?? fetch;\n', `  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const runtimeConfig = async (): Promise<RuntimeModelConfig> => ({
    ...await readStoredSettings(dependencies.settings),
    apiKey: process.env.PANEL_AGENT_API_KEY || (await dependencies.settings.get(PANEL_AGENT_API_KEY)) || "",
  });
  let backgroundRuntime: ReturnType<typeof createCurrentPanelRuntime> | undefined;
  router.use("/runtime", createRuntimeRouter(dependencies.authenticate, {
    runtime: () => backgroundRuntime ??= createCurrentPanelRuntime(runtimeConfig),
    config: runtimeConfig,
    session: authorizeRuntimeSession,
    target: authorizeRuntimeTarget,
  }));
`);
  return source;
});
edit("src/ui/api/panel-agent-api.ts", source => replace(source, '  maxTokens: number;\n  toolRoundLimit:', '  maxTokens: number;\n  contextWindowTokens?: number;\n  toolRoundLimit:'));
edit("src/ui/sidebar/AdminPanelAgentSection.tsx", source => replace(source, '            <div className="flex items-center justify-between gap-3 border border-border bg-background p-3">\n              <div>\n                <div className="text-xs font-semibold text-foreground">\n                  {t("admin.panelAgentMultiServer")}', `            <label className="grid gap-1 text-[11px] text-muted-foreground">
              Agent 模型上下文窗口（tokens；按服务商实际配置填写）
              <Input type="number" min="4096" max="2000000" value={settings.contextWindowTokens ?? 32768} onChange={(event) => update({ contextWindowTokens: Number(event.target.value) })} />
              <span>默认 32768 是保守值，不代表模型真实上限。不同模型可通过 PANEL_AGENT_MODEL_CONTEXT_WINDOWS 分别配置。</span>
            </label>
            <div className="flex items-center justify-between gap-3 border border-border bg-background p-3">
              <div>
                <div className="text-xs font-semibold text-foreground">
                  {t("admin.panelAgentMultiServer")}`));
for (const filename of ["package.json", "package-lock.json"]) edit(filename, source => {
  const value = JSON.parse(source); value.version = "2.6.0-cloudssh.57";
  if (value.packages?.[""]) value.packages[""].version = value.version;
  return JSON.stringify(value, null, 2) + "\n";
});
for (const filename of ["docker/docker-compose.cloudssh.yml", "docs/CLOUDSSH-UPDATES.md", "scripts/cloudssh-verify-restore.sh"]) edit(filename, source => source.replaceAll("2.6.0-cloudssh.55", "2.6.0-cloudssh.57"));
console.log("Runtime wiring applied; validation is required before publication.");
