// SPIKE-1 plugin. Records what preTasksExecution sees, then sets the Nx
// remote cache variables from SPIKE_* variables. Throwaway.
const { appendFileSync } = require('node:fs');

exports.name = 'spike-plugin';

exports.preTasksExecution = async (_options, context) => {
  const record = {
    at: new Date().toISOString(),
    pid: process.pid,
    ppid: process.ppid,
    argv: process.argv.slice(1, 3),
    daemonEnv: process.env.NX_DAEMON,
    isolateEnv: process.env.NX_ISOLATE_PLUGINS,
    awsProfile: process.env.AWS_PROFILE,
    spikeMarker: process.env.SPIKE_MARKER,
    contextKeys: Object.keys(context ?? {}),
  };
  if (process.env.SPIKE_HOOK_LOG)
    appendFileSync(process.env.SPIKE_HOOK_LOG, JSON.stringify(record) + '\n');

  if (process.env.SPIKE_SET_SERVER !== undefined) {
    process.env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER = process.env.SPIKE_SET_SERVER;
  }
  if (process.env.SPIKE_SET_TOKEN !== undefined) {
    process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = process.env.SPIKE_SET_TOKEN;
  }
  // CQ-4: change the token later in the same process; if later requests still
  // carry the first token, the client read it once.
  if (process.env.SPIKE_ROTATE_TOKEN_AFTER_MS) {
    setTimeout(() => {
      process.env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = 'rotated-token';
    }, Number(process.env.SPIKE_ROTATE_TOKEN_AFTER_MS)).unref();
  }
};
