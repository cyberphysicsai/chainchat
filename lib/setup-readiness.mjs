// Configuration readiness is deliberately separate from a successful model call.
// This projection returns no credentials, endpoint URLs, local paths or history.
const label = (value, limit = 160) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit) : '';
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export function setupReadiness({ runtime, provider, agent, agentId = null, selected = false, canonicalSkill,
  timechainError = null, checkedAt = new Date().toISOString() } = {}) {
  const native = runtime?.backend === 'openclaw';
  // Keep the complete provider identifier for the browser's exact model binding.
  // Both direct and native provider validators accept up to 200 characters.
  const modelId = typeof provider?.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(provider.model)
    ? provider.model : '';
  const configured = provider?.configured === true && !!modelId;
  const tier = provider?.provider === 'native' ? 'native' : 'byok';
  const dormant = agent?.runtime?.mode === 'dormant';
  const verified = selected && agent?.verified === true && !timechainError &&
    /^[a-f0-9]{64}$/.test(agent?.genesis?.hash || '') &&
    /^[a-f0-9]{64}$/.test(agent?.head?.hash || '') &&
    Number.isSafeInteger(agent?.head?.index) && agent.head.index >= 0;
  const chainHeld = agent?.locked === true || agent?.paused === true && !dormant;
  const canonicalVerified = hash(canonicalSkill?.commit) && canonicalSkill?.immutableTurnSnapshot === true &&
    ['packaged-canonical', 'publisher-cache'].includes(canonicalSkill?.origin);
  const checks = {
    connection: { ready: true },
    runtime: { ready: native && runtime?.running === true && runtime?.healthy === true && runtime?.enforcementHealthy === true,
      configured: native, backend: native ? 'openclaw' : 'direct',
      version: label(runtime?.version, 40), running: native && runtime?.running === true,
      startOnFirstChat: false, restartOnNextChat: native && runtime?.running !== true,
      reason: !native ? 'NOT_INSTALLED' : runtime?.running !== true ? 'RUNTIME_STOPPED' :
        runtime?.healthy !== true || runtime?.enforcementHealthy !== true ? 'RUNTIME_UNHEALTHY' : null },
    model: { ready: configured, configured, tier,
      provider: label(provider?.provider, 40), model: modelId,
      connectionTested: false },
    timechain: { ready: !!verified && !chainHeld, selected: !!selected, verified: !!verified,
      agentId: selected ? label(agentId, 128) || null : null, name: label(agent?.genesis?.name, 80),
      headHash: verified ? agent.head.hash : null,
      blockHeight: verified && Number.isSafeInteger(agent?.head?.index) && agent.head.index >= 0 ? agent.head.index : null,
      error: timechainError ? 'CHAIN_CHECK_FAILED' : agent?.locked === true ? 'CHAIN_LOCKED' :
        agent?.paused === true && !dormant ? 'CHAIN_PAUSED' : null },
    proof: { ready: canonicalVerified, required: true, verified: canonicalVerified,
      commit: canonicalVerified ? canonicalSkill.commit : null },
  };
  const nextStep = ['runtime', 'model', 'timechain', 'proof'].find(key => !checks[key].ready) || 'complete';
  return { version: 1, checkedAt, setupReady: nextStep === 'complete', nextStep, checks,
    memoryPaused: dormant,
    modelConnectionTested: false, inferencePerformed: false };
}
