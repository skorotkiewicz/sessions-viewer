'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function expandHome(value) {
  return value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : path.resolve(value);
}

function parseJsonl(source) {
  const records = [];
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, error: error.message });
    }
  }
  return { records, errors };
}

async function findJsonlFiles(root) {
  const found = [];
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(fullPath);
    }
  }
  await walk(root);
  return found.sort();
}

async function readJsonlFile(sourceFile) {
  const [source, stat] = await Promise.all([
    fs.readFile(sourceFile, 'utf8'),
    fs.stat(sourceFile),
  ]);
  return { ...parseJsonl(source), stat };
}

module.exports = { expandHome, findJsonlFiles, parseJsonl, readJsonlFile };
