'use strict';
/**
 * fgmp.js — FlightGear Multiplayer Protocol (UDP) packet builder
 *
 * Packet layout (all numerics big-endian / XDR):
 *   T_MsgHdr    32 bytes  magic + version + msgId + len + addr + port + callsign[8]
 *   T_PositionMsg 256 bytes  model[96] + time[24] + lag[24] + pos(3d) + orient(9f)
 *                             + linVel(3f) + angVel(3f) + linAcc(3f) + angAcc(3f) + lag(f)
 *   Properties  N×12 bytes  propId(u32) + type(u32) + value(f32)
 */

const dgram = require('dgram');

// ── Constants ─────────────────────────────────────────────────────────────────
const MAGIC      = 0x46474653;  // "FGFS"
const PROTO_VER  = 0x00010001;
const POS_DATA_ID = 7;

// WGS-84
const WGS84_A  = 6378137.0;
const WGS84_E2 = 0.00669437999014;

// ── Coordinate math ───────────────────────────────────────────────────────────

/** Geodetic (WGS-84) → ECEF XYZ in metres. */
function geodeticToECEF(latDeg, lonDeg, altM) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const N   = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
  return [
    (N + altM) * Math.cos(lat) * Math.cos(lon),
    (N + altM) * Math.cos(lat) * Math.sin(lon),
    (N * (1 - WGS84_E2) + altM) * Math.sin(lat),
  ];
}

function mm(A, B) {  // 3×3 matrix multiply
  return Array.from({ length: 3 }, (_, i) =>
    Array.from({ length: 3 }, (_, j) =>
      A[i].reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
}
const Rx = a => { const [c,s]=[Math.cos(a),Math.sin(a)]; return [[1,0,0],[0,c,-s],[0,s,c]]; };
const Ry = a => { const [c,s]=[Math.cos(a),Math.sin(a)]; return [[c,0,s],[0,1,0],[-s,0,c]]; };
const Rz = a => { const [c,s]=[Math.cos(a),Math.sin(a)]; return [[c,-s,0],[s,c,0],[0,0,1]]; };

/**
 * HPR (degrees) + geodetic position → 3×3 body→ECEF rotation matrix (row-major).
 * Heading: CW from North. Pitch: nose-up +. Roll: right-wing-down +.
 */
function hprToECEFMatrix(latDeg, lonDeg, hdgDeg, pitchDeg, rollDeg) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const h   = hdgDeg  * Math.PI / 180;
  const p   = pitchDeg * Math.PI / 180;
  const r   = rollDeg  * Math.PI / 180;
  const [sLat, cLat, sLon, cLon] = [Math.sin(lat), Math.cos(lat), Math.sin(lon), Math.cos(lon)];

  // ENU→ECEF: columns = local East, North, Up in ECEF
  const R_enu = [
    [-sLon,       cLon,        0   ],
    [-sLat*cLon, -sLat*sLon,   cLat],
    [ cLat*cLon,  cLat*sLon,   sLat],
  ];
  // body→ENU: heading(Rz) @ pitch(Rx) @ roll(Ry)
  const R_b2enu = mm(Rz(-h), mm(Rx(p), Ry(-r)));
  return mm(R_enu, R_b2enu);
}

/**
 * Estimate ECEF velocity (m/s) from the last two track points.
 * track: [{lat, lon, alt, dt}, ...]  dt = ISO-8601 string
 * Returns [vx, vy, vz] or [0,0,0].
 */
function estimateVelocity(track) {
  if (track.length < 2) return [0, 0, 0];
  const p1 = track[track.length - 2];
  const p2 = track[track.length - 1];
  const dtSec = (new Date(p2.dt) - new Date(p1.dt)) / 1000;
  if (dtSec <= 0 || dtSec > 120) return [0, 0, 0];
  const [x1,y1,z1] = geodeticToECEF(p1.lat, p1.lon, p1.alt || 0);
  const [x2,y2,z2] = geodeticToECEF(p2.lat, p2.lon, p2.alt || 0);
  return [(x2-x1)/dtSec, (y2-y1)/dtSec, (z2-z1)/dtSec];
}

/**
 * Derive heading+pitch (degrees) from an ECEF velocity vector.
 * Mirrors Cesium's velocityReference="#position".
 */
function velocityToHPR(vx, vy, vz, latDeg, lonDeg) {
  const lat = latDeg * Math.PI / 180;
  const lon = lonDeg * Math.PI / 180;
  const [sLat, cLat, sLon, cLon] = [Math.sin(lat), Math.cos(lat), Math.sin(lon), Math.cos(lon)];
  const vE = -sLon*vx + cLon*vy;
  const vN = -sLat*cLon*vx - sLat*sLon*vy + cLat*vz;
  const vU =  cLat*cLon*vx + cLat*sLon*vy + sLat*vz;
  const hdg   = (Math.atan2(vE, vN) * 180 / Math.PI + 360) % 360;
  const pitch = Math.atan2(vU, Math.sqrt(vE**2 + vN**2)) * 180 / Math.PI;
  return [hdg, pitch];
}

// ── Packet builder ────────────────────────────────────────────────────────────

function propFloat(id, val) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(id,  0);
  b.writeUInt32BE(4,   4);   // type = FLOAT
  b.writeFloatBE(val,  8);
  return b;
}
function propInt(id, val) {
  const b = Buffer.alloc(12);
  b.writeUInt32BE(id,  0);
  b.writeUInt32BE(1,   4);   // type = INT
  b.writeUInt32BE(val, 8);
  return b;
}

/**
 * Build a complete FG MP POS_DATA UDP packet.
 * @param {string} callsign   max 7 chars
 * @param {string} model      FG model path e.g. "Aircraft/A320neo/A320neo.xml"
 * @param {number} lat/lon    decimal degrees
 * @param {number} altM       altitude in metres
 * @param {number} hdg/pitch/roll  degrees
 * @param {number[]} vel      [vx, vy, vz] ECEF m/s
 * @returns {Buffer}
 */
function buildPosPacket({ callsign, model, lat, lon, altM,
                          hdg = 0, pitch = 0, roll = 0,
                          vel = [0, 0, 0] }) {
  // ── Position body: 256 bytes ───────────────────────────────────────────
  const body = Buffer.alloc(256, 0);
  Buffer.from(model, 'ascii').copy(body, 0, 0, 96);   // model[96]
  // time[24] + lag[24] stay zero
  const [ex, ey, ez] = geodeticToECEF(lat, lon, altM);
  body.writeDoubleBE(ex, 144);
  body.writeDoubleBE(ey, 152);
  body.writeDoubleBE(ez, 160);

  const R    = hprToECEFMatrix(lat, lon, hdg, pitch, roll);
  const flat = R.flatMap(row => row);
  let off = 168;
  for (const v of flat) { body.writeFloatBE(v, off); off += 4; }   // orient[9] = 36 bytes

  // linear vel (offset 204)
  body.writeFloatBE(vel[0], 204);
  body.writeFloatBE(vel[1], 208);
  body.writeFloatBE(vel[2], 212);
  // angular vel, lin acc, ang acc, lag all zero (offsets 216–255)

  // ── Properties ────────────────────────────────────────────────────────
  const props = Buffer.concat([
    propInt(100, 2),                          // protocol-version = 2
    propFloat(200, altM * 3.28084),           // altitude-ft
    propFloat(10001, 1.0),                    // gear[0..3] down
    propFloat(10002, 1.0),
    propFloat(10003, 1.0),
    propFloat(10004, 1.0),
  ]);

  // ── Header: 32 bytes ──────────────────────────────────────────────────
  const totalLen = 32 + 256 + props.length;
  const hdr = Buffer.alloc(32, 0);
  hdr.writeUInt32BE(MAGIC,       0);
  hdr.writeUInt32BE(PROTO_VER,   4);
  hdr.writeUInt32BE(POS_DATA_ID, 8);
  hdr.writeUInt32BE(totalLen,   12);
  // reply_addr = 0 (16..19), reply_port = 5000 (20..23)
  hdr.writeUInt32BE(5000,       20);
  Buffer.from(callsign.slice(0, 7), 'ascii').copy(hdr, 24);

  return Buffer.concat([hdr, body, props]);
}

// ── UDP sender ────────────────────────────────────────────────────────────────

class FGMPSender {
  constructor(host, port) {
    this.host   = host;
    this.port   = port;
    this._sock  = dgram.createSocket('udp4');
    this._sock.unref();   // don't prevent process exit
  }

  send(packet) {
    this._sock.send(packet, this.port, this.host);
  }

  close() { this._sock.close(); }
}

module.exports = {
  geodeticToECEF, hprToECEFMatrix, estimateVelocity, velocityToHPR,
  buildPosPacket, FGMPSender,
};
