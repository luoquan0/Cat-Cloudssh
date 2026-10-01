import { totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { RuntimeError } from "./store.js";
export type MemoryObservation = { heapUsed: number; heapLimit: number; rss: number; rssLimit: number; available: number; reserve: number };
export function observeRuntimeMemory(): MemoryObservation {
  const usage = process.memoryUsage();
  const physical = Math.min(totalmem(), process.constrainedMemory() || totalmem());
  const configured = Number(process.env.PANEL_AGENT_RSS_LIMIT_BYTES);
  return { heapUsed: usage.heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss: usage.rss, rssLimit: Number.isSafeInteger(configured) && configured > 0 ? configured : Math.floor(physical * 0.8), available: process.availableMemory(), reserve: Math.min(64 * 1024 * 1024, Math.floor(physical * 0.05)) };
}
export function ensureRuntimeMemory(observation = observeRuntimeMemory()): void {
  if (observation.heapUsed >= observation.heapLimit * 0.85 || observation.rss >= observation.rssLimit || observation.available < observation.reserve) {
    throw new RuntimeError(503, "MEMORY_PRESSURE", "服务器内存压力过高，Agent 已暂停新增执行。原记录保留；请检查容器内存、日志和数据库容量后继续");
  }
}
