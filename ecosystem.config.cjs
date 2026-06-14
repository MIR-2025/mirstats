// PM2 process config. Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'mirstats',
      script: './app.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production', NODE_NO_WARNINGS: '1' },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      time: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      kill_timeout: 5000,
    },
  ],
};
