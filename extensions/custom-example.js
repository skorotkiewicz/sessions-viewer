'use strict';

// Copy this file, set enabled to true, and normalize your harness into the
// viewer's { summary, events, parseErrors } shape. Extensions are trusted local
// JavaScript and may use any storage format.
module.exports = {
  enabled: false,
  id: 'custom',
  label: 'Custom Harness',
  defaultRoot: '~/.custom-harness/sessions',
  rootEnv: 'CUSTOM_SESSIONS_DIR',

  async listSessions({ root }) {
    void root;
    return { sessions: [], errors: [] };
  },

  async loadSession({ root, id }) {
    void root;
    void id;
    return null;
  },
};
