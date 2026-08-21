import type { Dict } from "./ru";

export const en: Dict = {
  app: {
    language: "Language",
  },
  servers: {
    title: "Servers",
    add: "Add server",
    empty: "No servers yet",
    connect: "Connect",
    filter: "Filter",
    hostKeyUnknown: "Unknown host",
    hostKeyPrompt: "Key fingerprint: {fingerprint}. Trust this host?",
  },
  overview: {
    cpu: "CPU",
    memory: "Memory",
    disk: "Disk",
    network: "Network",
    uptime: "Uptime",
    waiting: "Waiting for second sample",
  },
  projects: {
    title: "Projects",
    running: "Running",
    stopped: "Down",
    unknown: "Unknown",
    restart: "Restart",
    confirmRestart: "Restart {name}?",
    showAll: "Show system units",
  },
  logs: {
    title: "Logs",
    filter: "Filter",
    pause: "Pause",
    resume: "Resume",
    empty: "No logs yet",
  },
  errors: {
    disconnected: "Disconnected, data from {time}",
    authFailed: "Key rejected",
    jumpFailed: "Bastion {host} is not responding",
    actionFailed: "{name} did not come up within 30 seconds",
  },
};
