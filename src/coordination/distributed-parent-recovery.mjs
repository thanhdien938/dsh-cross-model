export function reconcileParentChildren(children = []) {
  const normalized = children.map((child) => Object.freeze({ kind: child.kind, parentId: child.parentId, childId: child.childId, taskId: child.taskId, runId: child.runId, attemptId: child.attemptId, classification: child.classification }));
  const blocking = normalized.filter((child) => !['CLEAN', 'SAFE_TO_DISPATCH'].includes(child.classification));
  const executable = normalized.filter((child) => child.classification === 'SAFE_TO_DISPATCH');
  const completed = normalized.filter((child) => child.classification === 'CLEAN');
  return Object.freeze({ canAdvance: blocking.length === 0 && executable.length === 0, blocking: Object.freeze(blocking), executable: Object.freeze(executable), completed: Object.freeze(completed) });
}
