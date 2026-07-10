import { ToolDefinition } from '../registry.js';
import { actorToolDefinitions } from './actorTools.js';
import { itemToolDefinitions } from './itemTools.js';
import { skillToolDefinitions } from './skillTools.js';
import { mapToolDefinitions } from './mapTools.js';
import { battleToolDefinitions } from './battleTools.js';
import { classToolDefinitions } from './classTools.js';
import { commonEventToolDefinitions } from './commonEventTools.js';
import { moveToolDefinitions } from './moveTools.js';
import { pluginToolDefinitions } from './pluginTools.js';
import { tileToolDefinitions } from './tileTools.js';
import { catalogToolDefinitions } from './catalogTools.js';
import { systemToolDefinitions } from './systemTools.js';
import { listToolDefinitions } from './listTools.js';
import { validationToolDefinitions } from './validationTools.js';

/**
 * Every tool the server exposes, gathered from the per-domain tool modules.
 * Kept in its own side-effect-free module so it can be imported by both the
 * server entry point and the tests without booting the stdio server.
 */
export const allToolDefinitions: ToolDefinition[] = [
  ...actorToolDefinitions,
  ...itemToolDefinitions,
  ...skillToolDefinitions,
  ...mapToolDefinitions,
  ...battleToolDefinitions,
  ...classToolDefinitions,
  ...commonEventToolDefinitions,
  ...moveToolDefinitions,
  ...pluginToolDefinitions,
  ...tileToolDefinitions,
  ...catalogToolDefinitions,
  ...systemToolDefinitions,
  ...listToolDefinitions,
  ...validationToolDefinitions,
];
