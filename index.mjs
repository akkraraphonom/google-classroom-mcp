import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { googleRead } from './google-auth.mjs';
import { createClassroomServer } from './server.mjs';

await createClassroomServer(googleRead).connect(new StdioServerTransport());
