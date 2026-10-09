/**
 * Session-scope inference lives in @yapa/core (shared with the Claude Code
 * hooks); re-exported here so plugin imports stay stable.
 *
 * @module yapa/scope
 */
export { detectCollection, type CollectionDetection } from '@yapa/core';
