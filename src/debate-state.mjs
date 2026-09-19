import { buildContextPacket } from './context-packet.mjs';

export class DebateState {
  constructor({ task, constraints = [] }) {
    if (!task?.trim()) throw new Error('task is required');
    this.task = task.trim();
    this.constraints = [...constraints];
    this.messages = [];
  }

  add({ actor, text, round }) {
    if (!actor || !text?.trim()) throw new Error('actor and text are required');
    this.messages.push({ actor, text: text.trim(), round, at: new Date().toISOString() });
  }

  messagesBy(actor) {
    return this.messages.filter((m) => m.actor === actor).map((m) => m.text);
  }

  messagesExcept(actor) {
    return this.messages.filter((m) => m.actor !== actor).map((m) => `${m.actor}:\n${m.text}`);
  }

  packetFor({ actor, role, round }) {
    return buildContextPacket({
      task: this.task,
      constraints: this.constraints,
      role,
      round,
      ownPrevious: this.messagesBy(actor),
      peerMessages: this.messagesExcept(actor),
    });
  }

  toJSON() {
    return { task: this.task, constraints: this.constraints, messages: this.messages };
  }
}
