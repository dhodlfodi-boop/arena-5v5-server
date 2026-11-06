import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const PORT = Number(process.env.PORT || 8787);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-in-production';
const MAX_PLAYERS = 10;
const ROOM_CODE = 'DEMO5V5';
const POINT_REWARDS = { win: 500, loss: 150, mvp: 250, promotion: 1000 };
const PASS_COSTS = { basic: 30000, standard: 40000, pro: 50000 };
const PASS_LIMITS = { basic: { weapons: 4, skins: 3 }, standard: { weapons: 6, skins: 5 }, pro: { weapons: Infinity, skins: Infinity } };
const WEAPON_STATS = { pulse_rifle: { damage: 34, range: 260 }, ember_smg: { damage: 24, range: 190 }, nova_rifle: { damage: 42, range: 320 }, void_cannon: { damage: 70, range: 420 } };
const ABILITY_STATS = { scan: { cooldownMs: 12000, durationMs: 3500, radius: 420 }, smoke: { cooldownMs: 18000, durationMs: 8000, radius: 110 } };
const ITEM_CATALOG = {
  weapons: [
    { id: 'pulse_rifle', name: 'Pulse Rifle', pass: 'basic' }, { id: 'ember_smg', name: 'Ember SMG', pass: 'basic' },
    { id: 'frost_shotgun', name: 'Frost Shotgun', pass: 'basic' }, { id: 'orbit_pistol', name: 'Orbit Pistol', pass: 'basic' },
    { id: 'nova_rifle', name: 'Nova Rifle', pass: 'standard' }, { id: 'viper_lmg', name: 'Viper LMG', pass: 'standard' },
    { id: 'aether_bow', name: 'Aether Bow', pass: 'standard' }, { id: 'ion_blade', name: 'Ion Blade', pass: 'standard' },
    { id: 'zenith_carbine', name: 'Zenith Carbine', pass: 'standard' }, { id: 'comet_launcher', name: 'Comet Launcher', pass: 'standard' },
    { id: 'void_cannon', name: 'Void Cannon', pass: 'pro' }
  ],
  skins: [
    { id: 'neon_grid', name: 'Neon Grid', pass: 'basic' }, { id: 'crimson_flux', name: 'Crimson Flux', pass: 'basic' },
    { id: 'arctic_glass', name: 'Arctic Glass', pass: 'basic' }, { id: 'gold_signal', name: 'Gold Signal', pass: 'standard' },
    { id: 'violet_core', name: 'Violet Core', pass: 'standard' }, { id: 'solar_bloom', name: 'Solar Bloom', pass: 'standard' },
    { id: 'holo_storm', name: 'Holo Storm', pass: 'standard' }, { id: 'black_halo', name: 'Black Halo', pass: 'standard' },
    { id: 'infinite_prism', name: 'Infinite Prism', pass: 'pro' }
  ]
};
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'arena-5v5', rooms: rooms.size, time: new Date().toISOString() }));
app.get('/config', (_req, res) => res.json({ roomCode: ROOM_CODE, maxPlayers: MAX_PLAYERS, passCosts: PASS_COSTS, itemCatalog: ITEM_CATALOG, mobileAndPc: true }));

function newRoom(code) {
  return { code, mode: 'war', phase: 'lobby', round: 1, score: { red: 0, blue: 0 }, kills: { red: 0, blue: 0 }, objective: { x: 500, y: 300, owner: null, progress: 0 }, effects: [], players: new Map(), createdAt: Date.now() };
}
const room = newRoom(ROOM_CODE);
rooms.set(ROOM_CODE, room);

function safeName(value) {
  return String(value || 'Player').replace(/[^a-zA-Z0-9가-힣 _-]/g, '').slice(0, 18) || 'Player';
}
function passRank(pass) { return { none: 0, basic: 1, standard: 2, pro: 3 }[pass] ?? 0; }
function allowedItems(p, type) {
  if (p.role === 'admin' || p.pass === 'pro') return ITEM_CATALOG[type];
  const limit = PASS_LIMITS[p.pass]?.[type] || 0;
  return ITEM_CATALOG[type].slice(0, limit);
}
function itemUnlocked(p, item, type) { return allowedItems(p, type).some(candidate => candidate.id === item.id); }
function inventoryFor(p) {
  return {
    weapons: allowedItems(p, 'weapons'),
    skins: allowedItems(p, 'skins'),
    equipped: p.equipped
  };
}
function playerView(p) {
  return { id: p.id, name: p.name, team: p.team, x: p.x, y: p.y, hp: p.hp, alive: p.alive, points: p.points, rank: p.rank, pass: p.pass, role: p.role, equipped: p.equipped, kills: p.kills, deaths: p.deaths };
}
function getPass(points) {
  if (points >= PASS_COSTS.pro) return 'pro';
  if (points >= PASS_COSTS.standard) return 'standard';
  if (points >= PASS_COSTS.basic) return 'basic';
  return 'none';
}
function send(ws, message) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); }
function broadcast(r, message) { for (const p of r.players.values()) send(p.ws, message); }
function state(r) {
  return { type: 'state', room: r.code, mode: r.mode, phase: r.phase, round: r.round, score: r.score, kills: r.kills, objective: r.objective, effects: r.effects, players: [...r.players.values()].map(playerView), capacity: MAX_PLAYERS };
}
function broadcastState(r) { broadcast(r, state(r)); }
function assignTeam(r) {
  const red = [...r.players.values()].filter(p => p.team === 'red').length;
  const blue = [...r.players.values()].filter(p => p.team === 'blue').length;
  return red <= blue ? 'red' : 'blue';
}
function notice(r, text, level = 'info') { broadcast(r, { type: 'notice', level, text }); }
function award(p, amount, reason) {
  if (p.role === 'admin') return; // admin wallet is infinite and cannot pollute player economy
  p.points += amount;
  p.pass = getPass(p.points);
  send(p.ws, { type: 'wallet', points: p.points, pass: p.pass, delta: amount, reason });
  sendInventory(p);
}
function sendInventory(p) { send(p.ws, { type: 'inventory', inventory: inventoryFor(p) }); }
function equipItem(p, type, itemId) {
  const item = ITEM_CATALOG[type]?.find(candidate => candidate.id === itemId);
  if (!item || !itemUnlocked(p, item, type)) return send(p.ws, { type: 'notice', level: 'error', text: '현재 게임패스에서 잠긴 아이템입니다.' });
  p.equipped[type] = item.id;
  send(p.ws, { type: 'loadout', equipped: p.equipped });
  broadcastState(room);
}
function resetRound(r) {
  for (const p of r.players.values()) {
    p.hp = 100; p.alive = true;
    p.x = p.team === 'red' ? 80 : 920;
    p.y = 120 + ((Number(p.id.slice(-4), 16) || 0) % 4) * 100;
  }
}
function startRound(r) { r.phase = 'live'; resetRound(r); broadcastState(r); notice(r, `라운드 ${r.round} 시작`); }
function resolveShot(shooter) {
  if (room.phase !== 'live' || !shooter.alive) return;
  const stats = WEAPON_STATS[shooter.equipped.weapons] || WEAPON_STATS.pulse_rifle;
  const target = [...room.players.values()]
    .filter(p => p.team !== shooter.team && p.alive)
    .map(p => ({ p, d: Math.hypot(p.x - shooter.x, p.y - shooter.y) }))
    .filter(hit => hit.d <= stats.range)
    .sort((a, b) => a.d - b.d)[0]?.p;
  broadcast(room, { type: 'event', event: 'shot', by: shooter.id, weapon: shooter.equipped.weapons, x: shooter.x, y: shooter.y, target: target?.id || null });
  if (!target) return;
  target.hp = Math.max(0, target.hp - stats.damage);
  if (target.hp > 0) return broadcast(room, { type: 'hit', by: shooter.id, target: target.id, damage: stats.damage, hp: target.hp });
  target.alive = false; target.deaths += 1; shooter.kills += 1; room.kills[shooter.team] += 1;
  broadcast(room, { type: 'kill', killer: shooter.name, victim: target.name, team: shooter.team, weapon: shooter.equipped.weapons });
  if (room.kills[shooter.team] >= 10) return endRound(room, shooter.team);
  setTimeout(() => { if (room.players.has(target.id) && room.phase === 'live') { target.hp = 100; target.alive = true; target.x = target.team === 'red' ? 80 : 920; target.y = 120 + (target.deaths % 4) * 100; broadcast(room, { type: 'respawn', id: target.id }); broadcastState(room); } }, 2500);
}
function useAbility(p, name) {
  const spec = ABILITY_STATS[name];
  if (!spec || room.phase !== 'live' || !p.alive) return send(p.ws, { type: 'ability_denied', name, reason: '전투 중 살아있는 상태에서만 사용할 수 있습니다.' });
  const now = Date.now(); const readyAt = p.abilityReady[name] || 0;
  if (now < readyAt) return send(p.ws, { type: 'ability_denied', name, reason: '쿨타임 중입니다.', remainingMs: readyAt - now });
  p.abilityReady[name] = now + spec.cooldownMs;
  send(p.ws, { type: 'ability_cooldown', name, cooldownMs: spec.cooldownMs });
  if (name === 'scan') {
    const revealed = [...room.players.values()].filter(t => t.team !== p.team && t.alive && Math.hypot(t.x - p.x, t.y - p.y) <= spec.radius).map(t => t.id);
    broadcast(room, { type: 'ability', name, owner: p.id, team: p.team, x: p.x, y: p.y, durationMs: spec.durationMs, revealed });
    return;
  }
  const effect = { id: crypto.randomUUID(), name, owner: p.id, team: p.team, x: p.x, y: p.y, radius: spec.radius, expiresAt: now + spec.durationMs };
  room.effects.push(effect); broadcast(room, { type: 'ability', name, effect }); broadcastState(room);
  setTimeout(() => { room.effects = room.effects.filter(item => item.id !== effect.id); broadcastState(room); }, spec.durationMs);
}
function updateObjective(r) {
  if (r.phase !== 'live') return;
  const counts = { red: 0, blue: 0 };
  for (const p of r.players.values()) if (p.alive && Math.hypot(p.x - r.objective.x, p.y - r.objective.y) < 110) counts[p.team] += 1;
  const team = counts.red === counts.blue ? r.objective.owner : (counts.red > counts.blue ? 'red' : 'blue');
  if (!team) return;
  r.objective.owner = team;
  r.objective.progress = Math.min(100, Math.max(0, r.objective.progress + (counts[team] ? 2 : -1)));
  if (r.objective.progress >= 100) endRound(r, team);
}
function endRound(r, winner) {
  if (r.phase !== 'live') return;
  r.phase = 'round_end'; r.score[winner] += 1;
  r.objective.progress = 0; r.objective.owner = null; r.kills.red = 0; r.kills.blue = 0;
  for (const p of r.players.values()) award(p, p.team === winner ? POINT_REWARDS.win : POINT_REWARDS.loss, `round_${winner}`);
  broadcastState(r); notice(r, `${winner.toUpperCase()} 팀 라운드 승리`, 'success');
  setTimeout(() => { if (r.phase === 'round_end') { r.round += 1; startRound(r); } }, 3500);
}
function parseCommand(text) { const m = String(text).trim().match(/^\/(\S+)(?:\s+([^]*))?$/); return m ? { command: m[1].toLowerCase(), args: (m[2] || '').trim() } : null; }
function adminCommand(p, raw) {
  const c = parseCommand(raw);
  if (!c) return send(p.ws, { type: 'notice', level: 'error', text: '관리자 명령어는 /로 시작해야 합니다.' });
  const target = c.args.split(/\s+/)[0];
  if (c.command === 'help') return send(p.ws, { type: 'notice', text: '/giftpoints <id> <amount> <reason> | /suspend <id> <minutes> <reason> | /roundend red|blue | /bots 10' });
  if (c.command === 'giftpoints') {
    const amount = Number(c.args.split(/\s+/)[1]); const t = room.players.get(target);
    if (!t || !Number.isInteger(amount) || amount <= 0 || amount > 100000) return send(p.ws, { type: 'notice', level: 'error', text: '대상 또는 포인트가 올바르지 않습니다.' });
    award(t, amount, 'admin_gift');
    notice(room, `${t.name}에게 ${amount.toLocaleString()}P가 지급되었습니다.`);
    return;
  }
  if (c.command === 'suspend') {
    const minutes = Number(c.args.split(/\s+/)[1]); const t = room.players.get(target);
    if (!t || !Number.isFinite(minutes) || minutes < 1 || minutes > 10080) return send(p.ws, { type: 'notice', level: 'error', text: '대상 또는 정지 시간이 올바르지 않습니다.' });
    t.suspendedUntil = Date.now() + minutes * 60000; send(t.ws, { type: 'moderation', action: 'suspend', minutes }); t.ws.close(4003, 'account suspended');
    return;
  }
  if (c.command === 'roundend' && ['red', 'blue'].includes(target)) return endRound(room, target);
  if (c.command === 'bots') return notice(room, '봇 자동 생성은 다음 단계에서 연결할 수 있습니다. 현재는 실제 WebSocket 클라이언트 좌석을 사용합니다.');
  send(p.ws, { type: 'notice', level: 'error', text: '알 수 없는 명령어입니다. /help를 입력하세요.' });
}

wss.on('connection', (ws, req) => {
  if (req.headers.origin && process.env.ALLOWED_ORIGINS && !process.env.ALLOWED_ORIGINS.split(',').includes(req.headers.origin)) return ws.close(1008, 'origin not allowed');
  let player = null;
  const timer = setTimeout(() => { if (!player) ws.close(4000, 'join timeout'); }, 8000);
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'invalid_json' }); }
    if (!player) {
      if (msg.type !== 'join') return;
      if (room.players.size >= MAX_PLAYERS) return send(ws, { type: 'error', message: 'room_full' });
      const id = crypto.randomUUID(); const role = msg.adminToken && msg.adminToken === ADMIN_TOKEN ? 'admin' : 'user';
      player = { id, ws, name: safeName(msg.name), team: assignTeam(room), x: 0, y: 0, hp: 100, alive: true, points: role === 'admin' ? 0 : Number(msg.points) || 0, pass: role === 'admin' ? 'pro' : getPass(Number(msg.points) || 0), rank: 'Bronze', role, kills: 0, deaths: 0, abilityReady: { scan: 0, smoke: 0 }, lastAction: 0, suspendedUntil: 0, equipped: { weapons: role === 'admin' ? 'void_cannon' : 'pulse_rifle', skins: role === 'admin' ? 'infinite_prism' : 'neon_grid' } };
      room.players.set(id, player); clearTimeout(timer);
      send(ws, { type: 'welcome', id, room: room.code, role, points: player.points, pass: player.pass, inventory: inventoryFor(player), equipped: player.equipped, controls: { pc: 'WASD + mouse/touch buttons', mobile: '터치 방향키 + FIRE' } });
      notice(room, `${player.name}님이 ${player.team.toUpperCase()} 팀에 참가했습니다.`);
      if (room.phase === 'lobby' && room.players.size >= 2) startRound(room); else broadcastState(room);
      return;
    }
    if (player.suspendedUntil > Date.now()) return;
    if (msg.type === 'input') {
      const now = Date.now(); if (now - player.lastAction < 25) return; player.lastAction = now;
      const dx = Math.max(-1, Math.min(1, Number(msg.dx) || 0)); const dy = Math.max(-1, Math.min(1, Number(msg.dy) || 0));
      player.x = Math.max(20, Math.min(980, player.x + dx * 18)); player.y = Math.max(20, Math.min(580, player.y + dy * 18));
      if (msg.fire) { player.lastShot = now; resolveShot(player); }
      return;
    }
    if (msg.type === 'equip') return equipItem(player, msg.itemType, msg.itemId);
    if (msg.type === 'inventory') return sendInventory(player);
    if (msg.type === 'ability') return useAbility(player, msg.name);
    if (msg.type === 'admin') {
      if (player.role !== 'admin') return send(player.ws, { type: 'notice', level: 'error', text: '관리자 전용 명령어입니다.' });
      return adminCommand(player, msg.command);
    }
    if (msg.type === 'ready' && room.phase === 'lobby') return broadcastState(room);
  });
  ws.on('close', () => { if (player) { room.players.delete(player.id); notice(room, `${player.name}님이 나갔습니다.`, 'warning'); broadcastState(room); } });
});
setInterval(() => { if (room.phase !== 'lobby') broadcastState(room); }, 50);
setInterval(() => updateObjective(room), 500);
server.listen(PORT, '0.0.0.0', () => console.log(`Arena 5v5 listening on http://0.0.0.0:${PORT}`));
