const path = require('node:path');

const interpreter = process.env.AGENTS_CHAT_NODE;
if (!interpreter || !path.isAbsolute(interpreter)) {
  throw new Error('AGENTS_CHAT_NODE must be the validated absolute Node.js executable');
}

module.exports = {
  apps: [{
    name: 'agents-chat',
    script: 'scripts/start-pm2.mjs',
    interpreter,
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    env: {
      NODE_ENV: 'production',
      npm_config_cache: '/home/xujx/.npm-user-cache',
    },
  }],
};
