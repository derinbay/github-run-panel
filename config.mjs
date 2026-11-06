// Settings and per-user paths shared by the server and the service installer.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

export const appDir = path.dirname(fileURLToPath(import.meta.url));

export async function loadConfig() {
  const defaults = {
    owners: [], // organisations or users to scan; empty means the account `gh` is signed in as
    port: 4747,
    intervalSeconds: 10,
    excludeRepos: [], // e.g. ["my-org/website"]
    includeArchived: false,
    sealLabels: ['security'], // issue labels that get a seal, most important first
  };
  let file = {};
  try {
    file = JSON.parse(await readFile(path.join(appDir, 'config.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read config.json, using defaults:', e.message);
  }
  const cfg = { ...defaults, ...file };
  if (process.env.OWNERS) cfg.owners = process.env.OWNERS.split(',');
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  cfg.owners = (cfg.owners || []).map((s) => String(s).trim()).filter(Boolean);
  cfg.port = Number(cfg.port) || defaults.port;
  cfg.intervalSeconds = Math.max(5, Number(cfg.intervalSeconds) || 10);
  cfg.excludeRepos = (cfg.excludeRepos || []).map((s) => String(s).toLowerCase());
  cfg.sealLabels = (cfg.sealLabels || []).map((s) => String(s).toLowerCase());
  return cfg;
}

// Where the background service keeps its PID and log file.
export function stateDir() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'github-run-panel');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Logs', 'github-run-panel');
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'github-run-panel');
}

export const pidFile = () => path.join(stateDir(), 'server.pid');
export const logFile = () => path.join(stateDir(), 'server.log');
