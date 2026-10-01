import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeToolCall } from "../../types/panel-runtime.js";

/** An intentionally small read-only allowlist, not a shell parser or sandbox. */
export function needsApproval(call: RuntimeToolCall): boolean {
  if(call.name!=="run_command") return false;
  if(call.arguments.risk==="high") return true;
  const command=String(call.arguments.command ?? "").trim();
  if(!command || /[\n\r;&|<>$`\\(){}\[\]*?!'\"]/.test(command)) return true;
  const words=command.split(/\s+/);
  const executable=words[0];
  if(executable.includes("/")) return true;
  if(["pwd","whoami","uname","uptime","hostname","date","df","free","ps","ls","stat","cat","head","tail","wc","grep"].includes(executable)) return false;
  if(executable==="docker" && ["ps","images","version","info","inspect","logs"].includes(words[1])) return false;
  if(executable==="systemctl" && ["status","show","is-active","is-enabled"].includes(words[1])) return false;
  return true;
}

export class ProgressWatchdog {
  private previous="";
  private repeats=0;
  private lastRequest=0;
  constructor(private threshold=5,private requestSpacingMs=1000) {}
  // No maximum number of tool rounds. Repeated polling of a live job is progress-neutral.
  observe(call:RuntimeToolCall,result:Record<string,unknown>):boolean {
    if(call.name==="read_job_output" && ["starting","running"].includes(String(result.status))) { this.repeats=0;return false; }
    const meaningful={name:call.name,targetId:call.arguments.targetId,command:call.arguments.command,jobId:call.arguments.jobId,status:result.status,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr,error:result.error};
    const hash=crypto.createHash("sha256").update(JSON.stringify(meaningful)).digest("hex");
    this.repeats=hash===this.previous?this.repeats+1:1;
    this.previous=hash;
    return this.repeats>=this.threshold;
  }
  async beforeModel(signal:AbortSignal) {
    const wait=this.lastRequest+this.requestSpacingMs-Date.now();
    if(wait>0) await delay(wait,undefined,{signal});
    signal.throwIfAborted();this.lastRequest=Date.now();
  }
}

export function redactEvidence(text:string):string {
  return text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,"[REDACTED_PRIVATE_KEY]")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s]+/gi,"$1[REDACTED]")
    .replace(/\b(password|passwd|token|api[_-]?key|secret)(\s*[=:]\s*)[^\s]+/gi,"$1$2[REDACTED]")
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g,"")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"");
}
