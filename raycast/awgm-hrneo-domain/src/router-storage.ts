import { LocalStorage, getPreferenceValues } from "@raycast/api";
import { execFile } from "node:child_process";

export type RouterPartition = {
  uuid: string;
  filesystem: string;
  label: string;
  product: string;
  mounted: boolean;
  port?: string;
  version?: string;
  size?: number;
  uses: string[];
};

const LOCKS_KEY = "locked-router-filesystems";
const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "RemoteCommand=none", "-o", "RequestTTY=no"];

export function runRouterCommand(command: string): Promise<string> {
  const host = getPreferenceValues<{ routerSshHost?: string }>().routerSshHost?.trim();
  if (!host || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(host)) {
    return Promise.reject(new Error("Set a valid Router SSH Host in AWGE settings."));
  }
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/ssh", [...SSH_OPTIONS, "--", host, command], { timeout: 15000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new Error("Could not connect to the router over SSH. Check the configured SSH host and key in Terminal."));
        return;
      }
      resolve(stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""));
    });
  });
}

function field(block: string, name: string): string | undefined {
  const line = block.match(new RegExp("^[ \\t]*" + name + ":[ \\t]*(.*?)[ \\t]*$", "m"));
  return line?.[1]?.trim() || undefined;
}

export function parseRouterPartitions(output: string): RouterPartition[] {
  const mediaHeaders = [...output.matchAll(/^[ \t]*media:[ \t]*$/gm)];
  const partitions: RouterPartition[] = [];

  for (let index = 0; index < mediaHeaders.length; index += 1) {
    const start = mediaHeaders[index].index! + mediaHeaders[index][0].length;
    const end = mediaHeaders[index + 1]?.index ?? output.length;
    const mediaBlock = output.slice(start, end);
    const mediaName = field(mediaBlock, "name");
    const port = field(mediaBlock, "port");
    if (!mediaName || !/^[A-Za-z0-9_-]+$/.test(mediaName) || !port) continue;

    const product = [field(mediaBlock, "manufacturer"), field(mediaBlock, "product")].filter(Boolean).join(" ") || mediaName;
    const headers = [...mediaBlock.matchAll(/^[ \t]*partition:[ \t]*$/gm)];
    for (let partIndex = 0; partIndex < headers.length; partIndex += 1) {
      const partStart = headers[partIndex].index! + headers[partIndex][0].length;
      const partEnd = headers[partIndex + 1]?.index ?? mediaBlock.length;
      const part = mediaBlock.slice(partStart, partEnd);
      const uuid = field(part, "uuid");
      if (!uuid || !/^[A-Za-z0-9_-]+$/.test(uuid)) continue;

      const uses = [...part.matchAll(/^[ \t]*used-by:[ \t]*(.*?)[ \t]*$/gm)]
        .map((match) => match[1].trim())
        .filter((value, valueIndex, values) => value && values.indexOf(value) === valueIndex);
      const rawSize = field(part, "total");
      partitions.push({
        uuid,
        filesystem: uuid + ":",
        label: field(part, "label") ?? uuid,
        product,
        mounted: field(part, "state")?.toUpperCase() === "MOUNTED",
        port,
        version: field(mediaBlock, "version"),
        size: rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : undefined,
        uses,
      });
    }
  }

  return partitions;
}

export async function getRouterPartitions(): Promise<RouterPartition[]> {
  return parseRouterPartitions(await runRouterCommand("ndmc -c 'show media'"));
}

type DriveLocks = Record<string, boolean>;

async function readDriveLocks(): Promise<DriveLocks> {
  const raw: unknown = await LocalStorage.getItem<string>(LOCKS_KEY);
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, locked]) => typeof locked === "boolean")) as DriveLocks;
  } catch {
    return {};
  }
}

export async function getDriveLockStates(partitions: RouterPartition[]): Promise<DriveLocks> {
  const stored = await readDriveLocks();
  const states: DriveLocks = {};
  for (const partition of partitions) {
    states[partition.uuid] = typeof stored[partition.uuid] === "boolean"
      ? stored[partition.uuid]
      : true;
  }
  return states;
}

export function isDriveLocked(partition: RouterPartition, states: DriveLocks): boolean {
  return states[partition.uuid] ?? true;
}

export async function setDriveLocked(partition: RouterPartition, locked: boolean): Promise<void> {
  const stored = await readDriveLocks();
  await LocalStorage.setItem(LOCKS_KEY, JSON.stringify({ ...stored, [partition.uuid]: locked }));
}
