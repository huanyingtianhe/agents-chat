module.exports = {
  apps: [{
    name: 'agents-chat',
    script: 'scripts/start-server.mjs',
    interpreter: process.execPath,
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    env: {
      NODE_ENV: 'production',
      npm_config_cache: '/home/xujx/.npm-user-cache',
    },
  }],
};
