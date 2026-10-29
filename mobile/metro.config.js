const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Domain types and the token JSON remain shared without a second package.
config.watchFolders = [
  path.resolve(__dirname, '../web/src/lib'),
  path.resolve(__dirname, '../web/src/design'),
  path.resolve(__dirname, '../shared/i18n'),
  path.resolve(__dirname, '../server/internal/i18n'),
];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
module.exports = config;
