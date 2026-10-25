import {
  Action,
  ActionPanel,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import React, { useEffect, useState } from "react";
import {
  getDriveLockStates,
  getRouterPartitions,
  isDriveLocked,
  RouterPartition,
  setDriveLocked,
} from "./router-storage";

function formatSize(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes)) return undefined;
  if (bytes >= 1024 ** 4) return (bytes / 1024 ** 4).toFixed(2) + " TB";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.round(bytes / 1024 ** 2) + " MB";
}

export default function DriveSettings() {
  const [partitions, setPartitions] = useState<RouterPartition[]>([]);
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      const current = await getRouterPartitions();
      setPartitions(current);
      setLocks(await getDriveLockStates(current));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read storage devices from The router.");
      setPartitions([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function toggleLock(partition: RouterPartition) {
    const locked = !isDriveLocked(partition, locks);
    try {
      await setDriveLocked(partition, locked);
      setLocks((current) => ({ ...current, [partition.uuid]: locked }));
      await showToast({
        style: Toast.Style.Success,
        title: locked ? "Drive locked" : "Drive unlocked",
        message: partition.label + (locked ? " is protected from accidental disconnects." : " can now be disconnected."),
      });
    } catch (reason) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not update drive lock",
        message: reason instanceof Error ? reason.message : "Raycast could not save this drive's lock state.",
      });
    }
  }

  return (
    <List isLoading={loading} searchBarPlaceholder="Find a drive to lock">
      {error ? (
        <List.EmptyView title="Could not read router storage" description={error} />
      ) : partitions.length === 0 && !loading ? (
        <List.EmptyView title="No USB partitions found" description="The router did not report any USB storage partitions." />
      ) : (
        partitions.map((partition) => {
          const locked = isDriveLocked(partition, locks);
          const details = [
            partition.mounted ? "Mounted" : "Disconnected",
            formatSize(partition.size),
          ].filter(Boolean);

          return (
            <List.Item
              key={partition.uuid}
              title={partition.label}
              icon={locked ? Icon.Lock : Icon.HardDrive}
              accessories={details.map((text) => ({ text }))}
              actions={
                <ActionPanel>
                  <Action
                    title={locked ? "Unlock Drive" : "Lock Drive"}
                    icon={locked ? Icon.LockUnlocked : Icon.Lock}
                    onAction={() => void toggleLock(partition)}
                  />
                  <Action title="Refresh Drives" icon={Icon.ArrowClockwise} onAction={() => void refresh()} />
                </ActionPanel>
              }
            />
          );
        })
      )}
    </List>
  );
}
