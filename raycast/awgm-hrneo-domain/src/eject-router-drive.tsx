import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
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
  parseRouterPartitions,
  RouterPartition,
  runRouterCommand,
} from "./router-storage";

function formatSize(bytes?: number): string | undefined {
  if (!bytes || !Number.isFinite(bytes)) return undefined;
  if (bytes >= 1024 ** 4) return (bytes / 1024 ** 4).toFixed(2) + " TB";
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.round(bytes / 1024 ** 2) + " MB";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default function EjectRouterDrive() {
  const [partitions, setPartitions] = useState<RouterPartition[]>([]);
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  async function refresh() {
    setLoading(true);
    setError(undefined);
    try {
      const allPartitions = await getRouterPartitions();
      setPartitions(allPartitions.filter((partition) => partition.mounted));
      setLocks(await getDriveLockStates(allPartitions));
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

  async function disconnect(partition: RouterPartition) {
    if (isDriveLocked(partition, locks)) {
      await showToast({ style: Toast.Style.Failure, title: "Drive is locked", message: "Unlock it in drive settings first." });
      return;
    }

    const usage = partition.uses.length ? "\n\nCurrently used by: " + partition.uses.join(", ") + "." : "";
    const accepted = await confirmAlert({
      title: "Disconnect " + partition.label + "?",
      message: "This unmounts this partition while leaving its USB device connected. Services using it may stop working until you reconnect the partition." + usage,
      icon: Icon.Eject,
      primaryAction: { title: "Disconnect", style: Alert.ActionStyle.Destructive },
    });
    if (!accepted) return;

    await showToast({ style: Toast.Style.Animated, title: "Disconnecting " + partition.label });
    let requestError: unknown;
    try {
      const response = await runRouterCommand("ndmc -c 'no system mount " + partition.filesystem + "'");
      if (/failed|error|cannot|not found/.test(response.toLowerCase())) {
        throw new Error(response.trim() || "The router did not confirm the disconnect request.");
      }
    } catch (reason) {
      requestError = reason;
    }

    let disconnected = false;
    let verificationError: unknown;
    const verificationAttempts = requestError ? 3 : 10;
    for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
      await delay(1000);
      try {
        const remaining = parseRouterPartitions(await runRouterCommand("ndmc -c 'show media'"));
        if (!remaining.some((candidate) => candidate.uuid === partition.uuid && candidate.mounted)) {
          disconnected = true;
          break;
        }
        verificationError = undefined;
      } catch (reason) {
        verificationError = reason;
      }
    }

    if (disconnected) {
      await showToast({ style: Toast.Style.Success, title: "Partition disconnected", message: partition.label + " · USB device remains connected" });
      await refresh();
    } else if (verificationError) {
      await showToast({
        style: Toast.Style.Failure,
        title: requestError ? "Could not confirm disconnect" : "Disconnect requested; could not verify",
        message: requestError
          ? "The router's SSH connection failed, so the partition may already be disconnected. Refresh the list to check its status."
          : "The router accepted the request, but its partition status could not be checked. Refresh the list to confirm.",
      });
    } else if (requestError) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Could not disconnect " + partition.label,
        message: requestError instanceof Error ? requestError.message : "The router returned an error.",
      });
    } else {
      await showToast({
        style: Toast.Style.Failure,
        title: "Partition is still mounted",
        message: "The router still reports " + partition.label + " as mounted.",
      });
    }
  }

  return (
    <List isLoading={loading} searchBarPlaceholder="Find a drive">
      {error ? (
        <List.EmptyView title="Could not read router storage" description={error} />
      ) : partitions.length === 0 && !loading ? (
        <List.EmptyView title="No mounted partitions" description="The router did not report any mounted USB partitions." />
      ) : (
        partitions.map((partition) => {
          const locked = isDriveLocked(partition, locks);
          const details = [
            "Mounted",
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
                  {!locked && <Action title="Disconnect Drive" icon={Icon.Eject} onAction={() => void disconnect(partition)} />}
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
