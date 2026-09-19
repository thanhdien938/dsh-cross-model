export const CAPABILITY_STATUS = Object.freeze({ PROVED: 'PROVED', UNPROVEN: 'UNPROVEN', ERROR: 'ERROR' });

const freezeProfile = (profile) => Object.freeze({
  ...profile,
  capabilities: Object.freeze({ ...profile.capabilities }),
});

export const PROVEN_SESSION_CAPABILITY_MATRIX = Object.freeze({
  codex: freezeProfile({
    product: 'Codex', version: '0.147.0', transport: 'app-server',
    capabilities: {
      resume_existing: 'PROVED', send_next_turn: 'PROVED', stream_events: 'PROVED',
      interrupt_active_turn: 'ERROR', concurrent_client_safe: 'UNPROVEN', ui_live_refresh: 'UNPROVEN',
    },
  }),
  'claude-code': freezeProfile({
    product: 'Claude Code', version: '2.1.233', transport: 'cli',
    capabilities: {
      resume_existing: 'PROVED', send_next_turn: 'PROVED', stream_events: 'PROVED',
      interrupt_active_turn: 'UNPROVEN', concurrent_client_safe: 'UNPROVEN', ui_live_refresh: 'UNPROVEN',
    },
  }),
  grok: freezeProfile({
    product: 'Grok Build', version: '1.0.4', transport: 'ACP stdio',
    capabilities: {
      resume_existing: 'PROVED', send_next_turn: 'PROVED', stream_events: 'PROVED',
      interrupt_active_turn: 'PROVED', concurrent_client_safe: 'UNPROVEN', ui_live_refresh: 'UNPROVEN',
    },
  }),
  opencode: freezeProfile({
    product: 'OpenCode', version: '1.18.18', transport: 'CLI + server HTTP/SSE',
    capabilities: {
      resume_existing: 'PROVED', send_next_turn: 'PROVED', stream_events: 'PROVED',
      interrupt_active_turn: 'PROVED', concurrent_client_safe: 'PROVED', ui_live_refresh: 'UNPROVEN',
    },
  }),
});

export function getProvenBackendProfile(backend) {
  const profile = PROVEN_SESSION_CAPABILITY_MATRIX[backend];
  if (!profile) throw new Error(`unknown proven backend: ${backend}`);
  return profile;
}

export function backendsProving(capability) {
  return Object.entries(PROVEN_SESSION_CAPABILITY_MATRIX)
    .filter(([, profile]) => profile.capabilities[capability] === CAPABILITY_STATUS.PROVED)
    .map(([backend]) => backend)
    .sort();
}

export function backendProves(backend, capability) {
  return getProvenBackendProfile(backend).capabilities[capability] === CAPABILITY_STATUS.PROVED;
}
