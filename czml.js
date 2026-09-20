'use strict';

/**
 * CZML generator — JavaScript port of czml.cpp + Coordinates::orientation()
 *
 * Mirrors the key decisions from the original C++ code:
 *  - ADS-B / AIS style (no predictedTrack):  forwardExtrapolationType = EXTRAPOLATE
 *  - Satellite style  (has predictedTrack):   no extrapolation, full time-series
 *  - Orientation: explicit HPR → quaternion, or velocityReference="#position"
 *  - Orientation forwardExtrapolationType always HOLD (prevent spinning)
 */

// ── Coordinate math (replaces util/coordinates.h Coordinates::orientation) ─────
/**
 * Convert geodetic position + heading/pitch/roll (degrees) into a
 * ECEF unit quaternion that Cesium's `unitQuaternion` property expects.
 *
 * Algorithm:
 *  1. Build ENU→ECEF rotation for the surface point (lon, lat)
 *  2. Apply heading (yaw around local Up, clockwise from North)
 *     then pitch (rotation around local East, nose up positive)
 *     then roll  (rotation around local North, right wing down positive)
 *  3. Combine into a single quaternion.
 *
 * Matches sdrangel's util/coordinates.cpp Coordinates::orientation().
 */
function hprToECEFQuaternion(lon, lat, _alt, headingDeg, pitchDeg, rollDeg) {
  const d2r = Math.PI / 180;
  const λ   = lon * d2r;
  const φ   = lat * d2r;
  const h   = headingDeg * d2r;
  const p   = pitchDeg   * d2r;
  const r   = rollDeg    * d2r;

  // ENU basis vectors in ECEF
  // East:  [-sin λ,        cos λ,       0      ]
  // North: [-sin φ cos λ, -sin φ sin λ,  cos φ ]
  // Up:    [ cos φ cos λ,  cos φ sin λ,  sin φ ]
  const sinLon = Math.sin(λ), cosLon = Math.cos(λ);
  const sinLat = Math.sin(φ), cosLat = Math.cos(φ);

  // ENU → ECEF rotation matrix (columns are E, N, U)
  const R = [
    [-sinLon,          cosLon,          0      ],
    [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    [ cosLat * cosLon,  cosLat * sinLon, sinLat],
  ];

  // Heading: rotate around local Up (Z in ENU) clockwise from North
  // In ENU convention heading 0 = North = Y-axis, so we rotate about +Z by -h
  const qH = axisAngleQ([0, 0, 1], -h);

  // Pitch: rotate around local East (X in ENU), nose up = positive
  const qP = axisAngleQ([1, 0, 0],  p);

  // Roll: rotate around local North (Y in ENU), right wing down = positive
  const qR = axisAngleQ([0, 1, 0], -r);

  // Local orientation: roll → pitch → heading (applied right-to-left)
  const qLocal = qMul(qH, qMul(qP, qR));

  // ENU→ECEF rotation as a quaternion
  const qECEF = matToQ(R);

  // Final ECEF quaternion
  const q = qMul(qECEF, qLocal);
  return normalize(q);
}

function axisAngleQ(axis, angle) {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

function qMul([x1,y1,z1,w1], [x2,y2,z2,w2]) {
  return [
    w1*x2 + x1*w2 + y1*z2 - z1*y2,
    w1*y2 - x1*z2 + y1*w2 + z1*x2,
    w1*z2 + x1*y2 - y1*x2 + z1*w2,
    w1*w2 - x1*x2 - y1*y2 - z1*z2,
  ];
}

function matToQ(m) {
  // 3×3 rotation matrix → quaternion (Shepperd method)
  const trace = m[0][0] + m[1][1] + m[2][2];
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m[2][1] - m[1][2]) * s;
    y = (m[0][2] - m[2][0]) * s;
    z = (m[1][0] - m[0][1]) * s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s;
    y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s;
    y = 0.25 * s;                 z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s;
    y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  return [x, y, z, w];
}

function normalize([x, y, z, w]) {
  const n = Math.sqrt(x*x + y*y + z*z + w*w);
  return [x/n, y/n, z/n, w/n];
}

// ── CZML helpers ─────────────────────────────────────────────────────────────

const HEIGHT_REFS = ['NONE', 'CLAMP_TO_GROUND', 'RELATIVE_TO_GROUND', 'NONE'];

/** The mandatory CZML document packet (sent once to initialise the clock). */
function czmlDocumentPacket() {
  const now  = new Date().toISOString();
  const stop = new Date(Date.now() + 3600_000).toISOString();
  return {
    id: 'document',
    version: '1.0',
    clock: {
      interval: `${now}/${stop}`,
      currentTime: now,
      range: 'UNBOUNDED',
    },
  };
}

/**
 * Convert an item from the store into a CZML entity packet.
 *
 * @param {Object} item  — the entity from EntityStore
 * @returns {Object|null}  CZML packet (without the `command` wrapper)
 */
function toCZML(item) {
  const id = item.name;
  if (!id) return null;

  const packet = { id };

  const fixed = !!item.fixedPosition;
  const altRef = item.altitudeReference || 0;
  const heightRef = HEIGHT_REFS[altRef] || 'NONE';

  // ── Position ──────────────────────────────────────────────────────────────
  const hasPredicted  = item.predictedTrack && item.predictedTrack.length > 0;
  const autoTrack     = item._autoTrack || [];
  const hasMultiPoint = autoTrack.length > 1 || hasPredicted;

  let coords;

  if (!fixed && hasPredicted) {
    // Satellite mode: historical + predicted time-series
    coords = [];
    for (const pt of autoTrack) {
      coords.push(pt.dt, pt.lon, pt.lat, pt.alt);
    }
    // Predicted track is appended in reverse (matching czml.cpp)
    const pred = [...item.predictedTrack].reverse();
    for (const pt of pred) {
      coords.push(pt.dt, pt.lon, pt.lat, pt.alt);
    }
  } else if (!fixed && hasMultiPoint) {
    // ADS-B / AIS mode: accumulate time-series from autoTrack
    coords = [];
    for (const pt of autoTrack) {
      coords.push(pt.dt, pt.lon, pt.lat, pt.alt);
    }
  } else {
    // Single position (fixed or first-seen)
    const dt = item.positionDateTime;
    coords = dt
      ? [dt, item.lon, item.lat, item.alt || 0]
      : [item.lon, item.lat, item.alt || 0];
  }

  const position = { cartographicDegrees: coords };

  if (!fixed) {
    const extrapolateSecs = item.extrapolateSecs ?? 60;

    if (hasPredicted) {
      // Satellites: no extrapolation (it goes crazy)
      // interpolation left at Cesium default (LINEAR)
    } else {
      // ADS-B / AIS: extrapolate linearly until next update arrives
      if (hasMultiPoint && extrapolateSecs > 0) {
        position.forwardExtrapolationType = 'EXTRAPOLATE';
        position.forwardExtrapolationDuration = extrapolateSecs;
        // Linear only — HERMITE/LAGRANGE can diverge wildly on ground stops
      } else {
        position.forwardExtrapolationType = 'HOLD';
      }
    }
  }

  packet.position = position;

  // ── Orientation ───────────────────────────────────────────────────────────
  if (!fixed) {
    if (item.useHeadingPitchRoll) {
      // Explicit HPR: convert to ECEF unit quaternion
      const [x, y, z, w] = hprToECEFQuaternion(
        item.lon, item.lat, item.alt || 0,
        item.heading || 0, item.pitch || 0, item.roll || 0
      );
      const qArr = item.orientationDateTime
        ? [item.orientationDateTime, x, y, z, w]
        : [x, y, z, w];
      packet.orientation = {
        unitQuaternion: qArr,
        forwardExtrapolationType: 'HOLD',   // prevent spinning when stale
        forwardExtrapolationDuration: item.extrapolateSecs ?? 60,
      };
    } else {
      // Auto-orient along velocity vector (ships, APRS, etc.)
      packet.orientation = { velocityReference: '#position' };
    }
  }

  // ── Point ─────────────────────────────────────────────────────────────────
  const pointColor = item.pointColor || [0, 160, 255, 255];
  packet.point = {
    pixelSize: 8,
    color: { rgba: pointColor },
    heightReference: heightRef,
    show: item.showPoint !== false,
  };

  // ── Model (glTF) or Billboard (image) ────────────────────────────────────
  const modelUrl = item.model ? `/3d/${item.model}` : null;
  if (modelUrl) {
    packet.model = {
      gltf: modelUrl,
      incrementallyLoadTextures: false,   // avoid flash while textures load
      heightReference: heightRef,
      runAnimations: false,               // controlled via playAnimation command
      show: item.showModel !== false,
      minimumPixelSize: item.modelMinPixelSize || 0,
      maximumScale: 20000,
    };
    if (item.modelAltitudeOffset) {
      packet.model.nodeTransformations = {
        node0: { translation: { cartesian: [0, item.modelAltitudeOffset, 0] } }
      };
    }
  } else if (item.image) {
    packet.billboard = {
      image: item.image,
      heightReference: heightRef,
      verticalOrigin: 'BOTTOM',
    };
  }

  // ── Label ─────────────────────────────────────────────────────────────────
  const label = item.label || item.name;
  packet.label = {
    text: label,
    show: item.showLabel !== false,
    scale: item.labelScale || 1.0,
    pixelOffset: { cartesian2: [1, 0] },
    eyeOffset: { cartesian: [0, item.labelAltitudeOffset || 0, 0] },
    verticalOrigin: 'BASELINE',
    horizontalOrigin: 'LEFT',
    heightReference: heightRef,
  };

  // ── Path (ground track) ───────────────────────────────────────────────────
  if (!fixed) {
    const trackColor = item.trackColor || [255, 255, 0, 180];
    packet.path = {
      width: 3,
      material: { solidColor: { color: { rgba: trackColor } } },
      show: item.showTrack !== false,
    };
  }

  // ── Description / popup text ──────────────────────────────────────────────
  if (item.text) {
    packet.description = item.text.replace(/\n/g, '<br>');
  }

  // ── Availability window ───────────────────────────────────────────────────
  if (!fixed && item.availableUntil) {
    const first = autoTrack[0]?.dt || new Date().toISOString();
    packet.availability = `${first}/${item.availableUntil}`;
  }

  // Custom CLIP_TO_GROUND flag (workaround for Cesium bug #4049)
  if (altRef === 3) {
    packet.altitudeReference = 'CLIP_TO_GROUND';
  }

  return packet;
}

module.exports = { czmlDocumentPacket, toCZML, hprToECEFQuaternion };
