const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

/** Only ASCII octal data crosses the terminal line discipline. Physical lines
 * stay short: long scripts, CR, Ctrl-C and heredocs cannot become parent input. */
export function buildSharedTerminalCommand(
  command: string,
  cwd: string | undefined,
  token: string,
): string {
  if (!/^[a-f0-9]{32}$/.test(token))
    throw new Error("Invalid command frame token");
  const script = cwd ? `cd -- ${quote(cwd)} &&\n${command}` : command;
  const encoded = Array.from(
    Buffer.from(script, "utf8"),
    (byte) => `\\0${byte.toString(8).padStart(3, "0")}`,
  ).join("");
  const argument = (encoded.match(/.{1,640}/g) || [""]).map(quote).join("\\\n");
  const tty = `__cloudssh_tty_${token}`;
  const status = `__cloudssh_status_${token}`;
  return (
    `command printf '\\033]777;cloudssh-agent-begin=${token}\\007'; ` +
    `${tty}=$(command stty -g 2>/dev/null) || :; ` +
    `if command sh -c "$(command printf '%b' ${argument})" </dev/null; ` +
    `then ${status}=0; else ${status}=$?; fi; ` +
    `if [ -n "$${tty}" ]; then command stty "$${tty}" 2>/dev/null || :; fi; ` +
    `command printf '\\033]777;cloudssh-agent-end=${token};status=%s\\007' "$${status}"; ` +
    `unset ${tty} ${status}\r`
  );
}
