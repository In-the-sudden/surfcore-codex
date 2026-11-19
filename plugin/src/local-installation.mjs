import { join, resolve } from 'node:path';
import { dataDirectory } from './role-storage.mjs';

export const voiceRoot = resolve(process.env.SURFCORE_VOICE_ROOT || join(dataDirectory, 'voice'));
export function snowLumaDirectory() {
  return resolve(process.env.SURFCORE_SNOWLUMA_DIR || join(dataDirectory, 'SnowLuma'));
}
