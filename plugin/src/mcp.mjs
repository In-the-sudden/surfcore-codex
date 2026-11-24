import { createInterface } from 'node:readline';
import { activateCharacter, characterContext, createCharacter, listCharacters, remember } from './store.mjs';
import { openSurfcorePanel } from './panel-launcher.mjs';

const protocolVersions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const string = { type: 'string' };
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

async function getCharacterContext() {
  const context = await characterContext();
  return {
    ...context,
    sharedConcepts: context.sharedConcepts.map(({ originScope, sourceIds, ...concept }) => concept),
  };
}

const tools = [
  { name: 'open_surfcore_panel', description: '仅在用户要求打开 SurfCore for Codex 控制台时调用。在本机启动或复用控制台，并用默认浏览器打开。', inputSchema: object(), run: openSurfcorePanel },
  { name: 'list_characters', description: '列出角色和当前角色 ID', inputSchema: object(), run: listCharacters, readOnly: true },
  { name: 'get_character_context', description: '读取当前角色卡和该角色在 Codex 的记忆', inputSchema: object(), run: getCharacterContext, readOnly: true },
  { name: 'activate_character', description: '切换到已有角色', inputSchema: object({ id: string }, ['id']), run: ({ id }) => activateCharacter(id) },
  { name: 'create_character', description: '用指定 ID 和人设创建角色', inputSchema: object({ id: string, persona: string }, ['id', 'persona']), run: ({ id, persona }) => createCharacter(id, persona) },
  { name: 'remember', description: '保存用户明确要求该角色长期记住的内容', inputSchema: object({ id: string, text: string }, ['id', 'text']), run: ({ id, text }) => remember(id, text) },
];

function send(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
}

async function dispatch({ id, method, params }) {
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      return send(id, {
        protocolVersion: protocolVersions.has(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'surfcore-roles', version: '0.1.1' },
      });
    case 'ping':
      return send(id, {});
    case 'tools/list':
      return send(id, { tools: tools.map(({ run, readOnly, ...tool }) => ({
        ...tool, annotations: { readOnlyHint: !!readOnly, destructiveHint: false, openWorldHint: false },
      })) });
    case 'tools/call': {
      const tool = tools.find(({ name }) => name === params?.name);
      if (!tool) return send(id, null, { code: -32602, message: 'Unknown tool' });
      try {
        const result = await tool.run(params.arguments ?? {});
        return send(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        return send(id, { isError: true, content: [{ type: 'text', text: error.message }] });
      }
    }
    default:
      return send(id, null, { code: -32601, message: 'Unknown method' });
  }
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    await dispatch(JSON.parse(line));
  } catch {
    send(null, null, { code: -32700, message: 'Invalid JSON-RPC message' });
  }
}
