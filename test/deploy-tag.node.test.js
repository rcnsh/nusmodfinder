// @ts-check
// The annotated `deploy/*` and `rollback/*` tags (scripts/deploy-tag.mjs): their names, their
// `key: value` annotation, and the lookup by version id that rollback uses. Nothing is pushed.
import { describe, expect, it } from 'vitest';
import { findVersionTag, parseTagFields, tagArgs, tagName } from '../scripts/deploy-tag.mjs';
import { TAG_FETCH } from './deploy-fakes.node.mjs';

describe('deploy and rollback tags', () => {
  it('are named <kind>/<UTC yyyymmddThhmmssZ>-<version id, first 8>', () => {
    expect(tagName('deploy', new Date('2026-11-12T10:15:30.456Z'), '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d')).toBe('deploy/20261112T101530Z-9b1c2d3e');
    expect(tagName('rollback', new Date('2026-01-02T03:04:05Z'), 'b0834844-f6fd-4bb9-838d-a45927c195fb')).toBe('rollback/20260102T030405Z-b0834844');
  });

  it('carry their fields as `key: value` paragraphs that read back, skipping null ones', () => {
    const args = tagArgs('deploy/20261112T101530Z-9b1c2d3e', 'abc', 'deploy 9b1c2d3e', { versionId: 'v', previousVersionId: null, dataVersion: 'd', startupMs: 21 });
    expect(args).toEqual(['tag', '-a', 'deploy/20261112T101530Z-9b1c2d3e', 'abc', '-m', 'deploy 9b1c2d3e', '-m', 'versionId: v', '-m', 'dataVersion: d', '-m', 'startupMs: 21']);
    const message = 'deploy 9b1c2d3e\n\nversionId: v\n\ndataVersion: d\n\nstartupMs: 21\n';
    expect(parseTagFields(message)).toEqual({ versionId: 'v', dataVersion: 'd', startupMs: '21' });
  });

  it('finds the tag naming a version by its first 8, with its commit and fields, preferring deploy/ over rollback/', async () => {
    const V = 'b0834844-f6fd-4bb9-838d-a45927c195fb';
    /** @type {string[][]} */
    const calls = [];
    /** @type {import('../scripts/deploy.mjs').Exec} */
    const exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd, ...args].join(' ');
      if (key === TAG_FETCH) return { code: 0, stdout: '' };
      if (key.startsWith('git for-each-ref --format=%(refname:short)%09%(*objectname)')) {
        return { code: 0, stdout: `rollback/20261112T090000Z-b0834844\tcccc\ndeploy/20261111T235933Z-b0834844\tb75ac190\ndeploy/20261111T183946Z-f8aefeab\t8e24b21d\n` };
      }
      if (key === 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844') {
        return { code: 0, stdout: `deploy b0834844 (back-filled)\n\nversionId: ${V}\n\ndataVersion: d820d578cf81\n` };
      }
      throw new Error(`unexpected ${key}`);
    };
    expect(await findVersionTag({ exec, versionId: V })).toEqual({
      name: 'deploy/20261111T235933Z-b0834844', commit: 'b75ac190', fields: { versionId: V, dataVersion: 'd820d578cf81' },
    });
    expect(await findVersionTag({ exec, versionId: '00000000-0000-0000-0000-000000000000' })).toBeNull();
  });
});
