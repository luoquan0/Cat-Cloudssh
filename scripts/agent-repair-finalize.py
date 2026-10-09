from pathlib import Path


def replace(name, before, after):
    p = Path(name)
    s = p.read_text()
    if after in s: return
    if s.count(before) != 1: raise RuntimeError(f'{name}: anchor count {s.count(before)}: {before[:75]}')
    p.write_text(s.replace(before, after))


p = Path('src/backend/hosts/terminal/index.ts')
s = p.read_text()
if 'import { StringDecoder } from "node:string_decoder";' not in s:
    s = 'import { StringDecoder } from "node:string_decoder";\n' + s
p.write_text(s)
replace(str(p), '              const boundSessionId = currentSessionId;', '              const boundSessionId = currentSessionId;\n              const terminalUtf8Decoder = new StringDecoder("utf8");')
replace(str(p), 'const utf8String = data.toString("utf-8");', 'const utf8String = terminalUtf8Decoder.write(data);')

replace('src/backend/panel-runtime/model.ts',
    "Commands run in the user's selected live interactive SSH shell under an exclusive Agent write lease. The existing shell cwd and environment are inherited, and command-side cd/export may persist into later shared-shell commands. The human terminal is visibly the same PTY and manual input is temporarily locked while an Agent command is running. Do not launch interactive editors, pagers, password prompts, or full-screen programs. Use short bounded shell commands and inspect results before mutating.",
    "Commands use a protected non-interactive child sh on the selected live SSH PTY under an exclusive Agent write lease. The current human shell directory and exported environment are inherited. Command-side cd/export, exit, exec and shell options affect only the child, NOT the human login shell or the next command. Use cwd for subsequent jobs. The terminal must be idle at a POSIX shell prompt. Standard input is closed; never launch interactive editors, pagers, shells, password prompts or full-screen programs. Cancellation without a completion marker requires manual inspection and a new terminal before further Agent writes. Rebooting, killing the SSH server, changing networking, or terminating the parent intentionally can still disconnect the session. Use bounded commands and report uncertainty rather than replaying unknown mutations.")
replace('src/backend/panel-runtime/model.ts',
    "Execute a command over an independent non-interactive SSH exec channel, NOT the user's terminal. Returns jobId and real status; running does not mean success. Poll read_job_output until finished. cwd and environment are NOT inherited from previous commands or the user's terminal. Mutating/unknown commands require user approval.",
    "Execute one bounded non-interactive command using the execution mode described in the system context. Returns jobId and real status; running is not success. Poll read_job_output until finished. Set cwd explicitly when needed; command-side cd/export never persist to the next job. Mutating/unknown commands follow the user's approval mode.")

panel = Path('src/ui/sidebar/PanelAgentPanel.tsx')
s = panel.read_text()
s = s.replace('与一个已连接终端共享同一 shell、cwd 和环境变量。', '共享终端显示，继承当前目录与已导出环境；命令在子 Shell 执行，不改变或退出你的主 Shell。')
panel.write_text(s)

# All release manifests and deployment examples use one version.
for name in ['package.json', 'package-lock.json', 'docker/docker-compose.cloudssh.yml', 'scripts/cloudssh-verify-restore.sh', 'docs/CLOUDSSH-UPDATES.md']:
    p = Path(name)
    s = p.read_text()
    if '2.6.0-cloudssh.69' not in s:
        if '2.6.0-cloudssh.68' not in s: raise RuntimeError(f'Missing version in {name}')
        p.write_text(s.replace('2.6.0-cloudssh.68', '2.6.0-cloudssh.69'))

replace('docker/docker-compose.cloudssh.yml',
    '      CLOUDSSH_AGENT_ALLOW_HTTP: "${CLOUDSSH_AGENT_ALLOW_HTTP:-false}"',
    '      CLOUDSSH_AGENT_ALLOW_HTTP: "${CLOUDSSH_AGENT_ALLOW_HTTP:-false}"\n      CLOUDSSH_AGENT_HTTP_POLICY_LOCKED: "${CLOUDSSH_AGENT_HTTP_POLICY_LOCKED:-false}"')

notes = Path('RELEASE_NOTES.md')
s = notes.read_text()
item = '- Added administrator-only persistent Agent LAN HTTP controls with source CIDR validation, same-origin checks, recent MFA and durable audit. The setting applies immediately to Agent API requests without weakening unrelated administrative transport rules.\n- Protected shared-PTY Agent commands from exiting the human login shell: a non-interactive child inherits cwd and exported environment while keeping exit, exec and shell options local. Long scripts and terminal control bytes are encoded; ambiguous cancellation prevents further automatic writes to that terminal.\n- Fixed mirrored terminal output with streaming UTF-8 decoding, consistent CRLF line endings, preserved multiline commands, job labels and filtered cursor/clipboard control sequences.\n'
if item not in s: s = s.replace('<!-- UPDATE_LOG -->\n\n', '<!-- UPDATE_LOG -->\n\n' + item, 1)
notes.write_text(s)

runtime = Path('docs/PANEL-AGENT-RUNTIME.md')
s = runtime.read_text()
s = s.replace(s.splitlines()[0], '# Panel Agent runtime - 2.6.0-cloudssh.69', 1)
section = '''\n## .69 protected shared terminal and readable mirrors\n\nShared-terminal tasks continue to use the selected SSH PTY, but run in a protected\nnon-interactive child `sh`, not `eval` in the human login shell. The child inherits\nthe human shell's cwd and exported environment. Its `cd`, `export`, shell options,\n`exit` and `exec` do not alter the parent or persist to subsequent tasks. Use the\n`cwd` tool argument for later commands. This intentionally replaces the unsafe\n`.61` same-shell state behavior. The parent must be an idle POSIX shell, not an\neditor, pager or interactive application. Standard input is closed for Agent tasks.\n\nLong scripts are encoded into bounded ASCII terminal input lines, preserving\nheredocs, quoting and Unicode without sending command-embedded control characters\nto the terminal driver. Terminal settings are restored after a completed task.\nStopping/timing out never destroys the user's SSH transport. If no completion\nmarker arrives after cancellation, further Agent writes to that terminal are\nblocked: inspect manually and create a new SSH terminal, or use isolated execution.\nCommands are never automatically replayed. This is not a shell security sandbox:\nrebooting, stopping SSH/networking, or intentionally killing the parent can still\ndisconnect a terminal.\n\nMirroring remains display-only. It uses streaming UTF-8, CRLF-normalized text,\nmultiline command formatting and job labels, and removes cursor/clipboard control\nsequences that could corrupt the human terminal display. stdout/stderr follow their\nobserved arrival order; separate SSH streams cannot reconstruct an ordering that\nthe remote process did not preserve.\n'''
if '## .69 protected shared terminal' not in s: s = s.replace('\n', '\n' + section, 1)
runtime.write_text(s)

guide = Path('docs/CLOUDSSH.md')
s = guide.read_text()
section = '''\n### 管理界面配置 Agent 内网 HTTP（.69 起）\n\n实例管理员可以在“管理 → Agent 设置 → Agent 内网 HTTP”中开启开关并填写\n客户端的来源 CIDR。优先使用单个地址 `/32` 或最小可信网段；界面显示的是\n服务端实际识别的来源，不是 SSH 目标地址。仅允许受控内网/VPN 网段，不允许\n公网地址、`0.0.0.0/0` 或格式不完整的 CIDR。保存需要同源网页操作、近期 MFA\n及成功落盘的审计；可从真实内网 HTTP 地址显式完成首次开启。\n\n设置写入现有持久化 settings 数据库，保存成功后立即生效，不用重建容器。\n尚未通过界面保存时仍使用原有环境变量；已保存的界面配置优先。部署者可设置\n`CLOUDSSH_AGENT_HTTP_POLICY_LOCKED=true` 强制锁定环境变量，禁止界面覆盖。\n该开关只改变独立 Agent API 传输准入，不取消设备审批、签名、防重放或项目权限，\n也不放宽凭据导出等其他管理员接口的 HTTPS 策略。HTTP 仍不提供链路加密。\n\nSkill 客户端仍需显式 `--allow-http`。HTTP 策略和 SSH 命令自动执行开关是\n不同功能；升级本身不会自动批准设备，也不会替你启用 HTTP。\n'''
if '### 管理界面配置 Agent 内网 HTTP' not in s:
    s = s.replace('### Agent 传输模式', section + '\n### Agent 传输模式', 1)
guide.write_text(s)
print('Prepared .69 contract, model guidance and UTF-8 terminal output')
