from pathlib import Path


def replace(name, before, after):
    p = Path(name)
    s = p.read_text()
    if after in s: return
    if s.count(before) != 1: raise RuntimeError(f'{name}: anchor {s.count(before)}: {before[:80]}')
    p.write_text(s.replace(before, after))


name = 'src/backend/panel-runtime/jobs.ts'
p = Path(name)
s = p.read_text()
start = s.index('  private async executeSharedTerminal(')
end = s.index('  private async execute(', start)
part = s[start:end]
if 'let commandDispatched = false;' not in part:
    part = part.replace('    let timedOut = false;', '    let timedOut = false;\n    let commandDispatched = false;', 1)
    part = part.replace('      await this.authorize(owner, target);', '      await this.authorize(owner, target);\n      signal.throwIfAborted();', 1)
    part = part.replace('          stream.write(wrapper);', '          signal.throwIfAborted();\n          commandDispatched = true;\n          stream.write(wrapper);', 1)
    part = part.replace('      if (job.exitCode === null) {', '      if (commandDispatched && job.exitCode === null) {', 1)
    # Cancellation before dispatch must never type Ctrl-C into a human shell.
    part = part.replace('          if (settled || abortTimer) return;', '          if (settled || abortTimer) return;\n          if (!commandDispatched) { finish(signal.reason); return; }', 1)
    # Retain the undecided output suffix on an interrupted job, but do not
    # expose a partial internal completion marker as application output.
    part = part.replace('          settled = true;\n          if (abortTimer)', '''          settled = true;
          if (state === "capturing") {
            let tail = carry + decoder.end();
            carry = "";
            for (let size = Math.min(tail.length, endPrefix.length); size > 0; size -= 1) {
              if (endPrefix.startsWith(tail.slice(-size))) {
                tail = tail.slice(0, -size);
                break;
              }
            }
            append(tail);
          }
          if (abortTimer)''', 1)
    s = s[:start] + part + s[end:]
    p.write_text(s)

replace('src/backend/panel-runtime/model.test.ts',
    '  expect(prompt).toContain("same PTY");\n  expect(prompt).toContain("cwd and environment are inherited");',
    '  expect(prompt).toContain("selected live SSH PTY");\n  expect(prompt).toContain("protected non-interactive child sh");\n  expect(prompt).toContain("directory and exported environment are inherited");\n  expect(prompt).toContain("NOT the human login shell or the next command");\n  expect(prompt).toContain("Standard input is closed");')

# Teach the standalone client that the server may be configured through the
# new administrative UI; --allow-http still never grants server-side access.
p = Path('skills/cloudssh-agent/SKILL.md')
s = p.read_text()
addition = '''从 .69 起，实例管理员也可以在网页“管理 → Agent 设置 → Agent 内网 HTTP”\n保存开关和来源 CIDR，无需修改 Docker 环境变量。界面配置不会由升级自动开启；\n客户端仍必须显式传入 `--allow-http`。收到 `426 HTTPS_REQUIRED` 时应让管理员\n核对服务端实际识别的来源地址及允许范围，不得伪造转发头。\n\n'''
if addition not in s: s = s.replace('平台传输分三种：\n', addition + '平台传输分三种：\n', 1)
p.write_text(s)
print('Guarded pre-dispatch cancellation and retained interrupted output suffixes')
