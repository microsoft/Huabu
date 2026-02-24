import { canvasTools } from './canvas_operations.js';
import { webSearchTool } from './web_search.js';

export { webSearchTool, canvasTools };

export const tools = [webSearchTool, ...canvasTools];
