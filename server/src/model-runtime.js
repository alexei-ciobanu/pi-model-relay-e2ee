import { statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

function fileSignature(path) {
  try {
    const stat = statSync(path);
    return `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${path}:missing`;
  }
}

export function createRelayModelRuntimeManager(options = {}) {
  const agentDir = options.agentDir ?? getAgentDir();
  const authPath = options.authPath ?? join(agentDir, "auth.json");
  const modelsPath = options.modelsPath ?? join(agentDir, "models.json");
  const modelsStorePath = options.modelsStorePath ?? join(agentDir, "models-store.json");
  const createRuntime =
    options.createRuntime ??
    (() =>
      ModelRuntime.create({
        authPath,
        modelsPath,
        modelsStorePath,
        modelRefreshTimeoutMs: options.modelRefreshTimeoutMs ?? 15_000,
      }));
  const paths = [authPath, modelsPath, modelsStorePath];
  let runtime;
  let signature;
  let pending;

  const currentSignature = () => paths.map(fileSignature).join("|");

  async function reload(nextSignature) {
    const nextRuntime = await createRuntime();
    runtime = nextRuntime;
    signature = nextSignature;
    return nextRuntime;
  }

  return {
    paths: { authPath, modelsPath, modelsStorePath },
    async getRuntime() {
      const nextSignature = currentSignature();
      if (runtime && signature === nextSignature) return runtime;
      pending ??= reload(nextSignature).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}
