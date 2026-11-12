// @ts-check
// Phase 7 7B: the annotated `deploy/*` and `rollback/*` tags (scripts/deploy-tag.mjs): their
// names, their `key: value` annotation, the lookup by version id that rollback uses, and the
// two back-filled tags (`b0834844` on `a23601d`, `f8aefeab` on `0b5f360`, both at data version
// d820d578cf81), printed as the exact commands the lead runs after the merge. Nothing is pushed.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BACKFILL, backfillCommands, findVersionTag, parseTagFields, tagArgs, tagName } from '../scripts/deploy-tag.mjs';
import { TAG_FETCH } from './deploy-fakes.js';

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
        return { code: 0, stdout: `rollback/20261112T090000Z-b0834844\tcccc\ndeploy/20261111T235933Z-b0834844\ta23601de\ndeploy/20261111T183946Z-f8aefeab\t0b5f360c\n` };
      }
      if (key === 'git for-each-ref --format=%(contents) refs/tags/deploy/20261111T235933Z-b0834844') {
        return { code: 0, stdout: `deploy b0834844 (back-filled)\n\nversionId: ${V}\n\ndataVersion: d820d578cf81\n` };
      }
      throw new Error(`unexpected ${key}`);
    };
    expect(await findVersionTag({ exec, versionId: V })).toEqual({
      name: 'deploy/20261111T235933Z-b0834844', commit: 'a23601de', fields: { versionId: V, dataVersion: 'd820d578cf81' },
    });
    expect(await findVersionTag({ exec, versionId: '00000000-0000-0000-0000-000000000000' })).toBeNull();
  });
});

describe('the back-filled tags', () => {
  it('name the two Phase 6 versions on their commits, at their promote times, both back-filled at d820d578cf81', () => {
    expect(BACKFILL.map((b) => [b.name, b.commit, b.fields.versionId, b.fields.previousVersionId, b.fields.dataVersion, b.fields.backfilled])).toEqual([
      ['deploy/20261111T183946Z-f8aefeab', '0b5f360c7faea8424215b4d4ddde81ebb1d850ff', 'f8aefeab-49c4-4548-b994-73bc6bae4f86', '59986aa3-48d9-4344-8f5d-29e095709ca6', 'd820d578cf81', 'true'],
      ['deploy/20261111T235933Z-b0834844', 'a23601de0b15934960bfef1d8b56ab3e80fa5587', 'b0834844-f6fd-4bb9-838d-a45927c195fb', 'f8aefeab-49c4-4548-b994-73bc6bae4f86', 'd820d578cf81', 'true'],
    ]);
  });

  it('their data version is each commit\'s own src/data-version.json', () => {
    for (const b of BACKFILL) {
      const committed = JSON.parse(execFileSync('git', ['show', `${b.commit}:src/data-version.json`], { encoding: 'utf8' })).version;
      expect(b.fields.dataVersion, b.name).toBe(committed);
    }
  });

  it('print as exact `git tag -a … && git push origin <tag>` commands with the promote time as the tag date', () => {
    const cmds = backfillCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toBe("GIT_COMMITTER_DATE='2026-11-11T18:39:46Z' git tag -a deploy/20261111T183946Z-f8aefeab 0b5f360c7faea8424215b4d4ddde81ebb1d850ff"
      + " -m 'deploy f8aefeab (back-filled)' -m 'versionId: f8aefeab-49c4-4548-b994-73bc6bae4f86' -m 'previousVersionId: 59986aa3-48d9-4344-8f5d-29e095709ca6'"
      + " -m 'commit: 0b5f360c7faea8424215b4d4ddde81ebb1d850ff' -m 'dataVersion: d820d578cf81' -m 'startupMs: 2' -m 'backfilled: true'"
      + " -m 'source: docs/evidence/phase6/remote-ops.md' && git push origin refs/tags/deploy/20261111T183946Z-f8aefeab");
    expect(cmds[1]).toMatch(/^GIT_COMMITTER_DATE='2026-11-11T23:59:33Z' git tag -a deploy\/20261111T235933Z-b0834844 a23601de0b15934960bfef1d8b56ab3e80fa5587 /);
    expect(cmds[1]).toMatch(/ && git push origin refs\/tags\/deploy\/20261111T235933Z-b0834844$/);
  });
});
