import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function configuredDockerHost(): string | undefined {
  const fromEnv = process.env['DOCKER_HOST'];
  if (fromEnv) {
    return fromEnv;
  }
  const props = join(homedir(), '.testcontainers.properties');
  if (!existsSync(props)) {
    return undefined;
  }
  return /^\s*docker\.host\s*=\s*(\S+)/m.exec(readFileSync(props, 'utf8'))?.[1];
}

/**
 * Testcontainers needs a Docker-compatible runtime. Detect the usual ways one
 * is configured so a missing runtime reports as *skipped*, not as a confusing
 * failure — and so CI (which always has Docker) never skips silently.
 *
 * Every test file that starts a container must call this: Vitest runs files
 * in separate workers, so the environment tweak below is per file.
 */
export function containerRuntimeAvailable(): boolean {
  const host = configuredDockerHost();
  if (host) {
    // Rootless podman cannot run Testcontainers' privileged Ryuk reaper; the
    // tests stop their own containers in afterAll. testcontainers-node only
    // reads this as an environment variable, not from the properties file.
    if (host.includes('podman')) {
      process.env['TESTCONTAINERS_RYUK_DISABLED'] ??= 'true';
    }
    return true;
  }
  return ['/var/run/docker.sock', join(homedir(), '.docker/run/docker.sock')].some((p) =>
    existsSync(p),
  );
}

export function warnNoContainerRuntime(suite: string): void {
  console.warn(
    `[idempotix-prisma] No container runtime found (DOCKER_HOST, ~/.testcontainers.properties ` +
      `or a docker.sock) — skipping ${suite}.`,
  );
}
