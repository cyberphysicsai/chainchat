import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerCommand } from '../public/chat-commands.js';

test('reviewed goal and skill turns take the native chat pipeline without a control probe', () => {
  for (const command of ['/goal start Inspect the fixture', '/goal Continue the review', '/GOAL SET A new objective',
    '/goal create Multi-line\nobjective', '/goal resume With an operator note', '/skill review Examine the plan']) {
    assert.deepEqual(composerCommand(command), {
      command, name: command.slice(1).split(' ')[0].toLowerCase(), path: '/api/chat', interrupt: false,
    });
  }
});

test('controls and unknown slash commands stay in the guarded command endpoint', () => {
  for (const command of ['/help', '/status', '/goal', '/goal status', '/goal edit Revise this', '/goal complete',
    '/goal clear', '/goal blocked Waiting for feedback', '/compact Use the verified findings', '/reset', '/t low',
    '/queue status', '/context detail', '/usage cost', '/tools', '/models', '/config', '/bash whoami', '/exec whoami',
    '/not-a-command Run this anyway']) {
    const route = composerCommand(command);
    assert.equal(route?.path, '/api/openclaw/command', command);
    assert.equal(route.command, command);
    assert.equal(route.interrupt, false);
  }
});

test('only exact stop and goal pause may interrupt an active request', () => {
  for (const command of [' /Stop  ', '/goal PAUSE', '/goal\t pause']) {
    assert.equal(composerCommand(command)?.interrupt, true);
  }
  for (const command of ['/stop other', '/goal pause with a note', '/goal resume']) {
    assert.equal(composerCommand(command)?.interrupt, false);
  }
});

test('shell examples, fenced commands and ordinary prose remain ordinary messages', () => {
  for (const message of ['', '/', '!whoami', '! /bash', 'echo hello', '`/goal status`',
    '```text\n/goal start example\n```', 'Tell me how /compact works.', '/path/to/example']) {
    assert.equal(composerCommand(message), null, message);
  }
});
