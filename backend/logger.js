const { createLogger, format, transports } = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const fmt = format.printf(({ level, message, timestamp }) =>
  `[${timestamp.slice(11,19)}] ${level}: ${message}`
);

const logger = createLogger({
  level: 'info',
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), format.timestamp(), fmt),
    }),
    new transports.DailyRotateFile({
      filename: path.join(__dirname, '../logs/scalper-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: format.combine(format.timestamp(), format.json()),
    }),
  ],
});

const tradeLogger = createLogger({
  level: 'info',
  transports: [
    new transports.DailyRotateFile({
      filename: path.join(__dirname, '../logs/trades-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxFiles: '30d',
      format: format.combine(format.timestamp(), format.json()),
    }),
  ],
});

module.exports = { logger, tradeLogger };
