import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentSkills, additionalSkillContext } from '../lib/agent-skills.mjs';

const document = (name, body = 'Write a short, grounded answer.') =>
  `---\nname: ${name}\nmetadata: {requires: {env: [PRIVATE_INSTALL_MARKER]}}\n---\n${body}\n`;
const sha = text => createHash('sha256').update(text).digest('hex');
const choice = ({ id, sha256 }) => ({ id, sha256 });
const equip = (registry, owner, revision, skills) => registry.select(owner, { revision, skills, acknowledged: true });
async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-agent-skills-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'catalogue');
  return { parent, directory, registry: createAgentSkills({ directory, roots: [] }) };
}

test('a local import pins exact bytes, reveals metadata only, and equips only the chosen agent', async t => {
  const { directory, registry } = await fixture(t);
  const text = document('concise-notes');
  const imported = await registry.importSkill({ text, acknowledged: true });
  assert.deepEqual(Object.keys(imported).sort(), ['id', 'name', 'sha256', 'source']);
  assert.equal(imported.sha256, sha(text));
  assert.deepEqual(await registry.importSkill({ text, acknowledged: true }), imported);
  assert.equal((await registry.list('agent-a')).skills[0].status, 'available');
  assert.deepEqual(await registry.snapshot('agent-a'), { revision: 'none', skills: [] });

  const result = await equip(registry, 'agent-a', 'none', [choice(imported)]);
  const restarted = createAgentSkills({ directory });
  const snapshot = await restarted.snapshot('agent-a');
  assert.equal(result.revision, snapshot.revision);
  assert.equal(snapshot.skills[0].text, text);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.skills) && Object.isFrozen(snapshot.skills[0]));
  assert.deepEqual(await restarted.snapshot('agent-b'), { revision: 'none', skills: [] });
  const context = additionalSkillContext(snapshot.skills);
  assert.match(context, /Write a short, grounded answer\./);
  assert.doesNotMatch(context, /PRIVATE_INSTALL_MARKER/);
  assert.throws(() => additionalSkillContext([{ ...snapshot.skills[0], text: text + 'altered' }]), { code: 'ADDITIONAL_SKILL_INVALID' });
});

test('concurrent drafts, changed bytes, and missing documents require explicit re-equipping', async t => {
  const { directory, registry } = await fixture(t);
  const name = 'risk-check', original = document(name), replacement = document(name, 'Review assumptions again.');
  const imported = await registry.importSkill({ text: original, acknowledged: true });
  const drafts = await Promise.allSettled([equip(registry, 'agent', 'none', [choice(imported)]), equip(registry, 'agent', 'none', [choice(imported)])]);
  const [saved] = drafts.filter(item => item.status === 'fulfilled');
  assert.equal(drafts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(drafts.find(item => item.status === 'rejected').reason.code, 'ADDITIONAL_SKILLS_STALE');
  const file = path.join(directory, 'imported', name, 'SKILL.md');
  await fs.writeFile(file, replacement);
  const updated = (await registry.list('agent')).skills[0];
  assert.equal(updated.status, 'changed');
  assert.equal(updated.selectedSha256, sha(original));
  assert.equal(updated.sha256, sha(replacement));
  await assert.rejects(registry.snapshot('agent'), { code: 'ADDITIONAL_SKILLS_CHANGED' });
  await assert.rejects(equip(registry, 'agent', saved.value.revision, [choice(imported)]), { code: 'ADDITIONAL_SKILLS_CHANGED' });
  const reviewed = await equip(registry, 'agent', saved.value.revision, [choice(updated)]);
  await assert.rejects(registry.assertCurrent('agent', saved.value.revision), { code: 'ADDITIONAL_SKILLS_STALE' });
  assert.equal((await registry.snapshot('agent')).skills[0].text, replacement);
  await fs.unlink(file);
  const missing = (await registry.list('agent')).skills[0];
  assert.equal(missing.status, 'missing');
  assert.equal(missing.sha256, null);
  assert.equal(missing.selectedSha256, sha(replacement));
  await assert.rejects(registry.snapshot('agent'), { code: 'ADDITIONAL_SKILLS_CHANGED' });
  await equip(registry, 'agent', reviewed.revision, []);
  assert.deepEqual((await registry.snapshot('agent')).skills, []);
});

test('invalid documents, duplicate names, and linked skill content stay outside the admitted library', async t => {
  const { parent, directory, registry } = await fixture(t);
  for (const text of [document('poi'), document('con'), document('../outside'), document('oversize', 'x'.repeat(32768)),
    '---\nname: a\nname: b\n---\nDuplicate names.', document('unicode', '\ud800')]) {
    await assert.rejects(registry.importSkill({ text, acknowledged: true }), { code: 'ADDITIONAL_SKILL_INVALID' });
  }
  await assert.rejects(registry.importSkill({ text: document('unreviewed') }), { code: 'ADDITIONAL_SKILL_INVALID' });
  const first = await registry.importSkill({ text: document('same-name'), acknowledged: true });
  await assert.rejects(registry.importSkill({ text: document('same-name', 'Replacement.'), acknowledged: true }), { code: 'ADDITIONAL_SKILL_CONFLICT' });
  const external = path.join(parent, 'trusted-root');
  const folder = path.join(external, first.name);
  await fs.mkdir(external, { mode: 0o700 });
  await fs.mkdir(folder, { mode: 0o700 });
  const externalFile = path.join(folder, 'SKILL.md');
  await fs.writeFile(externalFile, document(first.name), { mode: 0o600 });
  const rooted = createAgentSkills({ directory, roots: [{ directory: external, source: 'local' }] });
  assert.deepEqual((await rooted.list('agent')).skills, []);
  await assert.rejects(equip(rooted, 'agent', 'none', [choice(first)]), { code: 'ADDITIONAL_SKILLS_CHANGED' });
  await fs.link(externalFile, path.join(folder, 'hardlink.md'));
  assert.equal((await rooted.list('agent')).skills[0].id, first.id, 'Only the eligible imported copy remains.');
});
