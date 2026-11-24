import { servePanelLauncher } from './panel-launcher.mjs';

try {
  await servePanelLauncher();
} catch (error) {
  // Concurrent requests can start workers before the first one claims the pipe.
  if (error.code !== 'EADDRINUSE') process.exitCode = 1;
}
