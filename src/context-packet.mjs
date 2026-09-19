export function buildContextPacket({ task, role, round, ownPrevious = [], peerMessages = [], constraints = [] }) {
  if (!task?.trim()) throw new Error('task is required');
  if (!role?.trim()) throw new Error('role is required');
  if (!Number.isInteger(round) || round < 1) throw new Error('round must be a positive integer');

  const sections = [
    '# CROSS-MODEL DEBATE CONTEXT',
    `Role: ${role}`,
    `Round: ${round}`,
    '',
    '## Original task',
    task.trim(),
  ];

  if (constraints.length) {
    sections.push('', '## Constraints', ...constraints.map((x) => `- ${String(x).trim()}`));
  }
  if (ownPrevious.length) {
    sections.push('', '## Your previous positions', ...ownPrevious.map((x, i) => `### Previous ${i + 1}\n${String(x).trim()}`));
  }
  if (peerMessages.length) {
    sections.push('', '## Peer arguments you MUST address', ...peerMessages.map((x, i) => `### Peer ${i + 1}\n${String(x).trim()}`));
  }

  sections.push(
    '',
    '## Required response discipline',
    '- Address the peer arguments explicitly; do not restart from zero.',
    '- Preserve valid points from earlier rounds unless new evidence invalidates them.',
    '- State what changed in your position and why.',
    '- End with a concise CURRENT_POSITION section suitable for relay to another model.'
  );

  return sections.join('\n');
}
