import { readFile } from 'node:fs/promises';
import { activateCharacter, createCharacter, listCharacters, remember } from './store.mjs';
import { createMessageHandler, sampleEvent, startOneBot } from './bridge.mjs';
import { runCodex } from './codex.mjs';
import { startPanel } from './panel.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  let result;
  switch (command) {
    case 'panel': {
      const panel = await startPanel({ maintainVoiceCache: true });
      console.log('用桌面浏览器打开控制台：' + panel.url);
      break;
    }
    case 'list':
      result = await listCharacters();
      break;
    case 'activate':
      result = await activateCharacter(args[0]);
      break;
    case 'create':
      result = await createCharacter(args[0], await readFile(args[1], 'utf8'));
      break;
    case 'remember':
      result = await remember(args[0], args.slice(1).join(' '));
      break;
    case 'probe':
      result = await runCodex({ role: { persona: '你是测试角色。' }, probe: true });
      break;
    case 'demo':
    case 'demo-codex': {
      const handler = createMessageHandler({
        owner: '10002', selfId: '10001', simulated: true,
        generate: command === 'demo-codex' ? runCodex : async ({ role, message }) =>
          '[' + role.name + ' / 模拟] ' + message + '（该角色有 ' + role.recent.length + ' 条近期演示对话）',
        deliver: async () => {},
      });
      result = await handler(sampleEvent(args.join(' ')));
      if (!result) throw new Error('请输入 1–2000 字符的测试消息。');
      break;
    }
    case 'qq': {
      if (args.some((arg) => arg !== '--send')) throw new Error('QQ 模式只接受 --send 选项。');
      await runCodex({ role: { persona: '你是测试角色。' }, probe: true });
      await startOneBot({
        owner: process.env.SURFCORE_QQ_OWNER, selfId: process.env.SURFCORE_QQ_BOT,
        admins: (process.env.SURFCORE_QQ_ADMINS || '').split(',').map((id) => id.trim()).filter(Boolean),
        groups: (process.env.SURFCORE_QQ_GROUPS || '').split(',').map((id) => id.trim()).filter(Boolean),
        wsUrl: process.env.SURFCORE_ONEBOT_WS || 'ws://127.0.0.1:3001',
        httpUrl: process.env.SURFCORE_ONEBOT_HTTP || 'http://127.0.0.1:3000',
        wsToken: process.env.SURFCORE_ONEBOT_WS_TOKEN || process.env.SURFCORE_ONEBOT_TOKEN,
        httpToken: process.env.SURFCORE_ONEBOT_HTTP_TOKEN || process.env.SURFCORE_ONEBOT_TOKEN,
        generate: runCodex, send: args.includes('--send'), autonomousMedia: true,
      });
      break;
    }
    default:
      throw new Error('命令：panel | list | activate ID | create ID 人设文件 | remember ID 文字 | demo 文字 | demo-codex 文字 | probe | qq [--send]');
  }
  if (result !== undefined) console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
