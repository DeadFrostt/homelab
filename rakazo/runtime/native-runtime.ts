import path from "node:path";

/** Explicit host-Docker identity for a supervisor running in a containerd pod.
 * Never infer this from a pod HOSTNAME or fabricate Docker container inspection.
 */
export type NativeStorage =
  | { kind: "docker-volume"; name: string; hostPath: string }
  | { kind: "bind"; hostPath: string };
export type NativeRuntime = { kind: "kubernetes"; storage: NativeStorage };

export function resolveNativeRuntime(env: Record<string, string | undefined>): NativeRuntime | undefined {
  const kind = env.SANDBOX_RUNTIME;
  if (!kind || kind === "docker") {
    if (env.SANDBOX_DATA_VOLUME || env.SANDBOX_DATA_HOST_PATH || env.SANDBOX_SCREEN_NETWORK === "routed") {
      throw new Error("native storage/routed screens require SANDBOX_RUNTIME=kubernetes");
    }
    return undefined;
  }
  if (kind !== "kubernetes") throw new Error("unsupported SANDBOX_RUNTIME");
  if (env.SANDBOX_SCREEN_NETWORK !== "routed") throw new Error("kubernetes requires routed screens");
  if (env.SANDBOX_COMPUTER_EGRESS !== "restricted") throw new Error("kubernetes requires restricted computer egress");
  if (env.SANDBOX_CONTROL_VIA_LOOPBACK === "true") throw new Error("routed computers must not publish control ports");
  const hostPath = env.SANDBOX_DATA_HOST_PATH;
  if (!hostPath || !path.isAbsolute(hostPath) || path.normalize(hostPath) !== hostPath || hostPath === "/") {
    throw new Error("SANDBOX_DATA_HOST_PATH must be an explicit normalized absolute data path");
  }
  const name = env.SANDBOX_DATA_VOLUME;
  if (name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) {
    throw new Error("invalid SANDBOX_DATA_VOLUME");
  }
  return { kind, storage: name ? { kind: "docker-volume", name, hostPath } : { kind: "bind", hostPath } };
}

export function nativeStorageIdentity(storage: NativeStorage): string {
  return storage.kind === "docker-volume" ? `volume:${storage.name}` : `path:${storage.hostPath}`;
}

/** Validate an existing local Docker volume, without creating anything. */
export function assertNativeVolume(storage: NativeStorage, volume: { Name?: string; Driver?: string; Mountpoint?: string }) {
  if (storage.kind !== "docker-volume") return;
  if (volume.Name !== storage.name || volume.Driver !== "local" || volume.Mountpoint !== storage.hostPath) {
    throw new Error("native data descriptor does not match the existing local Docker volume");
  }
}

/** A PVC migration must not resume a child still writing an old Docker volume. */
export function nativeBindHomeMatches(mounts: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | undefined, homePath: string): boolean {
  const homes = mounts?.filter((mount) => mount.Destination === "/home/rakazo") ?? [];
  return homes.length === 1 && homes[0]?.Type === "bind" && homes[0]?.Source === homePath && homes[0]?.RW === true;
}
