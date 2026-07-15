import { ToolDefinition } from '../registry.js';
import { actorToolDefinitions } from './actorTools.js';
import { itemToolDefinitions } from './itemTools.js';
import { skillToolDefinitions } from './skillTools.js';
import { mapToolDefinitions } from './mapTools.js';
import { battleToolDefinitions } from './battleTools.js';
import { classToolDefinitions } from './classTools.js';
import { stateToolDefinitions } from './stateTools.js';
import { commonEventToolDefinitions } from './commonEventTools.js';
import { moveToolDefinitions } from './moveTools.js';
import { eventCommandToolDefinitions } from './eventCommandTools.js';
import { eventPageToolDefinitions } from './eventPageTools.js';
import { pluginToolDefinitions } from './pluginTools.js';
import { tileToolDefinitions } from './tileTools.js';
import { catalogToolDefinitions } from './catalogTools.js';
import { paintToolDefinitions } from './paintTools.js';
import { objectToolDefinitions } from './objectTools.js';
import { tilesetToolDefinitions } from './tilesetTools.js';
import { systemToolDefinitions } from './systemTools.js';
import { assetToolDefinitions } from './assetTools.js';
import { listToolDefinitions } from './listTools.js';
import { validationToolDefinitions } from './validationTools.js';
import { batchToolDefinitions } from './batchTools.js';

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
  ...stateToolDefinitions,
  ...commonEventToolDefinitions,
  ...moveToolDefinitions,
  ...eventCommandToolDefinitions,
  ...eventPageToolDefinitions,
  ...pluginToolDefinitions,
  ...tileToolDefinitions,
  ...catalogToolDefinitions,
  ...paintToolDefinitions,
  ...objectToolDefinitions,
  ...tilesetToolDefinitions,
  ...systemToolDefinitions,
  ...assetToolDefinitions,
  ...listToolDefinitions,
  ...validationToolDefinitions,
  ...batchToolDefinitions,
];
