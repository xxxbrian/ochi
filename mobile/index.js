// Hermes provides date/number formatting but lacks Locale and PluralRules.
require('@formatjs/intl-locale/polyfill-force.js');
require('@formatjs/intl-pluralrules/polyfill-force.js');
require('@formatjs/intl-pluralrules/locale-data/en.js');
require('@formatjs/intl-pluralrules/locale-data/zh.js');

require('expo-router/entry');
