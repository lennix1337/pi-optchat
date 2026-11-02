import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Agent, type AgentMessage, type QueueMode } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';

/**
 * How queued steering messages reach the model. Notices that arrive while a model call runs wait in Pi's steering
 * queue; `one-at-a-time` (Pi's default) hands over one per model turn, so each notice costs its own model call. This
 * measures it offline, with the faux provider (no network): the same notices as one batch cost one call.
 */
const NOTICES = ['[gitwatch] #56 ready', '[optchat-report] CI verde', '[subagent] pronto'];

async function runWith(steeringMode: QueueMode | 'single', notices = NOTICES) {
  const core = createFauxCore({});
  core.setResponses(Array.from({ length: notices.length + 2 }, (_, i) => fauxAssistantMessage(`resposta ${i}`)));
  const user = (text: string): AgentMessage => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }) as AgentMessage;
  let agent!: Agent;
  let modelCalls = 0;
  const streamFn: typeof core.streamSimple = (model, context, options) => {
    modelCalls++;
    // The notices arrive while the first model call is running.
    if (modelCalls === 1) {
      if (steeringMode === 'single') agent.steer(user(notices.join('\n\n')));
      else for (const notice of notices) agent.steer(user(notice));
    }
    return core.streamSimple(model, context, options);
  };
  agent = new Agent({ streamFn, steeringMode: steeringMode === 'single' ? 'one-at-a-time' : steeringMode, initialState: { model: core.getModel(), systemPrompt: '', tools: [] } });
  await agent.prompt(user('primeira pergunta') as never);
  const texts = agent.state.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content));
  return { modelCalls, noticesInContext: NOTICES.filter(n => texts.some(t => t.includes(n))).length };
}

test('one-at-a-time (Pi default): three notices queued during one model call cost three more model calls', async () => {
  const got = await runWith('one-at-a-time');
  assert.equal(got.modelCalls, 1 + NOTICES.length, 'the first call, then one call per queued notice');
  assert.equal(got.noticesInContext, NOTICES.length, 'every notice still reaches the model');
});

test('all: the queued notices reach the model together, in one call', async () => {
  const got = await runWith('all');
  assert.equal(got.modelCalls, 2, 'the first call, then one call with all three');
  assert.equal(got.noticesInContext, NOTICES.length);
});

test('one combined steer message: the same notices also cost one call under one-at-a-time', async () => {
  const got = await runWith('single');
  assert.equal(got.modelCalls, 2);
  assert.equal(got.noticesInContext, NOTICES.length);
});
