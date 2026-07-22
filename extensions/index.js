'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadExtensions(directory = __dirname) {
  const extensions = new Map();
  const files = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.js') && name !== 'index.js')
    .sort();

  for (const file of files) {
    const extension = require(path.join(directory, file));
    if (extension.enabled === false) continue;
    for (const key of ['id', 'label', 'defaultRoot', 'listSessions', 'loadSession']) {
      if (!extension[key]) throw new Error(`${file}: extension is missing ${key}`);
    }
    if (extensions.has(extension.id)) {
      throw new Error(`${file}: duplicate extension id ${extension.id}`);
    }
    extensions.set(extension.id, extension);
  }

  return extensions;
}

module.exports = { loadExtensions };
