import type { Tab } from "@/types/ui-types";

export function conversationDefaultTarget(
  tabs: Tab[],
  activeTabId: string,
  hostId: number | null | undefined,
): Tab | undefined {
  // Undefined is the legacy panel. A persisted conversation may only select
  // its own server automatically; a missing SSH terminal requires a choice.
  if (hostId === undefined)
    return tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  if (hostId === null) return undefined;
  return (
    tabs.find(
      (tab) => tab.id === activeTabId && Number(tab.host?.id) === hostId,
    ) ?? tabs.find((tab) => Number(tab.host?.id) === hostId)
  );
}
