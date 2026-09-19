export interface RuntimeStatus {
  state: 'STOPPED' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'ERROR';
  pid: number | null;
  uptime: number | null;
  error: string | null;
  lastStartTime: number | null;
  lastStopTime: number | null;
}

export interface RuntimeReadiness {
  ready: boolean;
  postgres: boolean;
  sqlite: boolean;
  backends: {
    name: string;
    ready: boolean;
  }[];
  timestamp: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  branch: string | null;
  state: string;
  lastActivity: number | null;
}

export interface TimelineEntry {
  id: string;
  timestamp: number;
  category: 'USER_TELEGRAM' | 'USER_GUI' | 'PM' | 'AGENT' | 'APPROVAL' | 'RESULT' | 'SYSTEM';
  projectId: string | null;
  taskId: string | null;
  pmRunId: string | null;
  runId: string | null;
  source: string;
  summary: string;
  data: any;
}

export interface Task {
  id: string;
  projectId: string;
  state: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  owner: string;
  data: any;
}

export interface InboxItem {
  id: string;
  projectId: string;
  type: string;
  state: string;
  createdAt: number;
  data: any;
}

export interface Connection {
  backend: string;
  cliInstalled: boolean;
  cliVersion: string | null;
  authState: 'UNKNOWN' | 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'ERROR';
  dshBackend: boolean;
  health: 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  sessionKinds: string[];
  models: string[];
  processState: 'IDLE' | 'ACTIVE' | 'ERROR';
  lastCheck: number;
}

export interface LogEntry {
  timestamp: number;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  source: string;
  message: string;
}

export interface ProjectionOptions {
  limit?: number;
  offset?: number;
  since?: number;
  cursor?: string;
}
