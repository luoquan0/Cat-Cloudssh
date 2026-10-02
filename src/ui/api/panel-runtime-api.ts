import axios from "axios";
import { authApi } from "@/main-axios";
import type {
  RuntimeRun,
  RuntimeSnapshot,
  RuntimeThread,
  StartRuntimeInput,
} from "@/types/panel-runtime";
const prefix = "/panel-agent/runtime";
const options = { timeout: 30000 };
export type JobOutput = {
  jobId: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  hasMore: boolean;
  error?: string | null;
};
async function request<T>(operation: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await operation()).data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as
        | { error?: string; code?: string }
        | undefined;
      throw Object.assign(
        new Error(
          data?.error ||
            "Agent 请求暂时失败，任务可能仍在后端运行；请重试确认状态",
        ),
        { code: data?.code, status: error.response?.status },
      );
    }
    throw error;
  }
}
export const runtimeApi = {
  start: (input: StartRuntimeInput & { confirmLegacyImport?: boolean }) =>
    request<{ run: RuntimeRun }>(() =>
      authApi.post(`${prefix}/runs`, input, options),
    ),
  active: () =>
    request<{ run: RuntimeRun | null }>(() =>
      authApi.get(`${prefix}/active`, options),
    ),
  run: (id: string) =>
    request<{ run: RuntimeRun }>(() =>
      authApi.get(`${prefix}/runs/${encodeURIComponent(id)}`, options),
    ),
  snapshot: (id: string, after?: number) =>
    request<RuntimeSnapshot>(() =>
      authApi.get(`${prefix}/threads/${encodeURIComponent(id)}`, {
        ...options,
        params: after === undefined ? {} : { after },
      }),
    ),
  list: (offset = 0) =>
    request<{
      threads: Omit<RuntimeThread, "summary">[];
      nextOffset: number | null;
    }>(() =>
      authApi.get(`${prefix}/threads`, { ...options, params: { offset } }),
    ),
  remove: (id: string) =>
    request<{ deleted: boolean }>(() =>
      authApi.delete(`${prefix}/threads/${encodeURIComponent(id)}`, options),
    ),
  cancel: (id: string) =>
    request<{ run: RuntimeRun }>(() =>
      authApi.post(
        `${prefix}/runs/${encodeURIComponent(id)}/cancel`,
        {},
        options,
      ),
    ),
  resume: (id: string) =>
    request<{ run: RuntimeRun }>(() =>
      authApi.post(
        `${prefix}/runs/${encodeURIComponent(id)}/resume`,
        {},
        options,
      ),
    ),
  approve: (id: string, toolCallId: string, approved: boolean) =>
    request<{ accepted: boolean }>(() =>
      authApi.post(
        `${prefix}/runs/${encodeURIComponent(id)}/approval`,
        { toolCallId, approved },
        options,
      ),
    ),
  output: (
    id: string,
    cursors: {
      stdoutOffset?: number;
      stderrOffset?: number;
      tail?: boolean;
    } = {},
  ) =>
    request<JobOutput>(() =>
      authApi.get(`${prefix}/jobs/${encodeURIComponent(id)}/output`, {
        ...options,
        params: cursors,
      }),
    ),
};
