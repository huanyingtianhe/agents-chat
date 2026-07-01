module.exports = {
  apps: [{
    name: 'agents-chat',
    script: 'npm',
    args: 'run start',
    cwd: '/home/xujx/wa/agents-chat',
    env: {
      NODE_ENV: 'production',
      npm_config_cache: '/home/xujx/.npm-user-cache',
    },
  }],
};
