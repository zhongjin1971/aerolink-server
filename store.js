'use strict';

/**
 * In-memory store for map entities.
 *
 * Each entity is keyed by `name` (unique id).
 * Track history is accumulated here, matching the C++ MapItem::updateTrack() logic.
 */
class EntityStore {
  constructor() {
    // Map<id, entity>
    this._items = new Map();
  }

  /**
   * Add or update an entity.
   * If track is not supplied, we auto-accumulate one from successive positions.
   *
   * @param {Object} item  — see API schema in README
   */
  upsert(item) {
    const id = item.name;
    const existing = this._items.get(id);

    if (!existing) {
      // First time we see this entity: initialise track
      const entity = { ...item };
      if (!entity.fixedPosition && !entity.track) {
        // Start auto-track with the initial position
        entity._autoTrack = [{ lat: item.lat, lon: item.lon, alt: item.alt || 0, dt: item.positionDateTime || new Date().toISOString() }];
      }
      this._items.set(id, entity);
      return entity;
    }

    // Merge: accumulate auto-track if no explicit track supplied
    const entity = { ...existing, ...item };

    if (!entity.fixedPosition && !item.track) {
      const track = existing._autoTrack || [];
      const last  = track[track.length - 1];
      const newPt = { lat: item.lat, lon: item.lon, alt: item.alt || 0, dt: item.positionDateTime || new Date().toISOString() };

      // Only append if position or time actually changed (mirrors C++ dedup logic)
      if (!last || last.lat !== newPt.lat || last.lon !== newPt.lon || last.alt !== newPt.alt) {
        track.push(newPt);
        // Keep last 500 points to bound memory
        if (track.length > 500) track.shift();
      }
      entity._autoTrack = track;
    }

    this._items.set(id, entity);
    return entity;
  }

  remove(id) {
    this._items.delete(id);
  }

  clear() {
    this._items.clear();
  }

  get(id) {
    return this._items.get(id);
  }

  all() {
    return [...this._items.values()];
  }
}

module.exports = { EntityStore };
