// Nx plugin entry point (05, PKG-1). Listed in nx.json as
// { "plugin": "nx-s3-serverless-cache", "options": { ... } }.
import { createPreTasksExecution } from './plugin.js';

export type { PluginOptions } from './options.js';

export const name = 'nx-s3-serverless-cache';

export const preTasksExecution = createPreTasksExecution();
