import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSubmitTaskPayload } from '../electron/main/services/submitTaskPayload';

const composerSource = fs.readFileSync(path.resolve(__dirname, '../src/components/Composer.tsx'), 'utf8');

describe('P14-R2.1 task-file durability preserves explicit Desktop intent', () => {
  it('serializes DIRECT explicitly when task-file mode is enabled', () => {
    expect(composerSource).toContain("durability === 'DIRECT' && !useTaskFile");

    const payload = buildSubmitTaskPayload({
      body: '',
      pmProfileId: 'pm-1',
      taskFile: { ref: 'abc123', path: 'tasks/dsh/CANARY.md' },
      lifecycle: { durability: 'DIRECT' },
    });

    expect(payload).toEqual({
      body: '',
      pm_profile_id: 'pm-1',
      task_file: { ref: 'abc123', path: 'tasks/dsh/CANARY.md' },
      durability: 'DIRECT',
    });
  });

  it.each(['DURABLE_LOCAL', 'DURABLE_REMOTE'] as const)(
    'preserves task-file %s exactly',
    (durability) => {
      const payload = buildSubmitTaskPayload({
        body: '',
        pmProfileId: 'pm-1',
        taskFile: { ref: 'abc123', path: 'tasks/dsh/CANARY.md' },
        lifecycle: { durability },
      });
      expect(payload.durability).toBe(durability);
    },
  );

  it('leaves legacy typed-text DIRECT omission unchanged', () => {
    const payload = buildSubmitTaskPayload({ body: 'plain task', pmProfileId: 'pm-1' });
    expect(payload).toEqual({ body: 'plain task', pm_profile_id: 'pm-1' });
    expect('durability' in payload).toBe(false);
  });

  it('does not alter the task-file/council refusal boundary', () => {
    expect(composerSource).toContain("{mode === 'SINGLE' && (");
    expect(composerSource).toContain("if (mode === 'COUNCIL' && useTaskFile) setUseTaskFile(false)");
  });
});
