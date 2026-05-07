const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const WORLD = {
  width: 5200,
  height: 3800
};

const TICK_RATE = 30;
const SNAPSHOT_RATE = 20;
const PLAYER_RADIUS = 18;
const BULLET_RADIUS = 5;
const MAX_NAME_LENGTH = 16;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

const clients = new Map();
const players = new Map();
const bullets = new Map();
const cars = createCars();

let nextBulletId = 1;
let lastTick = Date.now();
let snapshotAccumulator = 0;
let tickTimer = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const id = createId();
  const spawn = getSpawnPoint();
  const player = {
    id,
    name: `Pilot ${String(id).slice(0, 4)}`,
    color: pickColor(players.size),
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    health: 100,
    score: 0,
    deaths: 0,
    inCar: false,
    carId: null,
    respawnTimer: 0,
    fireCooldown: 0,
    input: defaultInput()
  };

  players.set(id, player);
  clients.set(id, {
    id,
    socket,
    buffer: Buffer.alloc(0),
    alive: true
  });

  send(id, {
    type: "welcome",
    id,
    world: WORLD,
    tickRate: TICK_RATE
  });

  socket.on("data", (chunk) => readSocketFrames(id, chunk));
  socket.on("close", () => removeClient(id));
  socket.on("error", () => removeClient(id));
});

function start(port = PORT) {
  if (tickTimer) {
    return server;
  }

  server.listen(port, HOST, () => {
    const address = server.address();
    const activePort = address && typeof address === "object" ? address.port : port;
    console.log(`Neon Ridge Arena is running at http://localhost:${activePort}`);
  });

  lastTick = Date.now();
  tickTimer = setInterval(stepWorld, 1000 / TICK_RATE);
  return server;
}

function stop(callback) {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  for (const client of clients.values()) {
    client.alive = false;
    try {
      client.socket.destroy();
    } catch {
      // Socket is already gone.
    }
  }

  clients.clear();
  players.clear();
  bullets.clear();

  if (server.listening) {
    server.close(callback);
    return;
  }

  if (callback) {
    callback();
  }
}

function stepWorld() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  snapshotAccumulator += dt;

  updateWorld(dt);

  if (snapshotAccumulator >= 1 / SNAPSHOT_RATE) {
    snapshotAccumulator = 0;
    broadcast({
      type: "snapshot",
      time: now,
      world: WORLD,
      players: Array.from(players.values()).map(serializePlayer),
      cars: cars.map(serializeCar),
      bullets: Array.from(bullets.values()).map(serializeBullet)
    });
  }
}

if (require.main === module) {
  start();
}

module.exports = {
  server,
  start,
  stop
};

function updateWorld(dt) {
  for (const player of players.values()) {
    player.fireCooldown = Math.max(0, player.fireCooldown - dt);

    if (player.health <= 0) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) {
        respawnPlayer(player);
      }
      continue;
    }

    const input = player.input || defaultInput();
    player.angle = sanitizeAngle(input.angle);

    if (player.inCar && input.exit) {
      exitCar(player);
    }

    if (!player.inCar && input.interact) {
      tryEnterNearestCar(player);
    }

    if (!player.inCar) {
      movePlayerOnFoot(player, input, dt);
    }
  }

  for (const car of cars) {
    updateCar(car, dt);
  }

  for (const player of players.values()) {
    if (player.health <= 0 || !player.input) {
      continue;
    }

    if (player.input.shooting) {
      shoot(player);
    }
  }

  for (const bullet of Array.from(bullets.values())) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;

    if (
      bullet.life <= 0 ||
      bullet.x < 0 ||
      bullet.y < 0 ||
      bullet.x > WORLD.width ||
      bullet.y > WORLD.height
    ) {
      bullets.delete(bullet.id);
      continue;
    }

    for (const target of players.values()) {
      if (target.id === bullet.ownerId || target.health <= 0) {
        continue;
      }

      const dx = target.x - bullet.x;
      const dy = target.y - bullet.y;
      const hitRadius = target.inCar ? 30 : PLAYER_RADIUS;

      if (dx * dx + dy * dy <= (hitRadius + BULLET_RADIUS) ** 2) {
        damagePlayer(target, bullet.ownerId, 18);
        bullets.delete(bullet.id);
        break;
      }
    }
  }

  for (const player of players.values()) {
    if (player.inCar) {
      const car = cars.find((item) => item.id === player.carId);
      if (car) {
        player.x = car.x;
        player.y = car.y;
      }
    }

    if (player.input) {
      player.input.interact = false;
      player.input.exit = false;
    }
  }
}

function movePlayerOnFoot(player, input, dt) {
  const xAxis = Number(input.right) - Number(input.left);
  const yAxis = Number(input.down) - Number(input.up);
  const length = Math.hypot(xAxis, yAxis) || 1;
  const sprint = input.sprint ? 1.25 : 1;
  const speed = 210 * sprint;

  player.x = clamp(player.x + (xAxis / length) * speed * dt, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
  player.y = clamp(player.y + (yAxis / length) * speed * dt, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);
}

function updateCar(car, dt) {
  const driver = car.driverId ? players.get(car.driverId) : null;
  const input = driver && driver.health > 0 ? driver.input : null;

  if (!driver || driver.health <= 0) {
    car.driverId = null;
  }

  if (input) {
    const throttle = Number(input.up) - Number(input.down) * 0.65;
    const steer = Number(input.right) - Number(input.left);
    const maxSpeed = input.sprint ? 620 : 500;

    car.speed += throttle * 640 * dt;
    car.speed = clamp(car.speed, -260, maxSpeed);

    if (input.brake) {
      car.speed *= Math.pow(0.18, dt);
    }

    const turnStrength = clamp(Math.abs(car.speed) / 260, 0.2, 1);
    const reverseFactor = car.speed >= 0 ? 1 : -1;
    car.angle += steer * 2.7 * turnStrength * reverseFactor * dt;
  }

  car.speed *= Math.pow(input ? 0.88 : 0.35, dt);
  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;

  if (car.x < 36 || car.x > WORLD.width - 36) {
    car.x = clamp(car.x, 36, WORLD.width - 36);
    car.speed *= -0.35;
  }

  if (car.y < 28 || car.y > WORLD.height - 28) {
    car.y = clamp(car.y, 28, WORLD.height - 28);
    car.speed *= -0.35;
  }
}

function shoot(player) {
  if (player.fireCooldown > 0) {
    return;
  }

  const muzzle = player.inCar ? 42 : 30;
  const bulletSpeed = player.inCar ? 880 : 760;
  const spread = (Math.random() - 0.5) * 0.035;
  const angle = player.angle + spread;

  let baseVx = 0;
  let baseVy = 0;
  if (player.inCar) {
    const car = cars.find((item) => item.id === player.carId);
    if (car) {
      baseVx = Math.cos(car.angle) * car.speed;
      baseVy = Math.sin(car.angle) * car.speed;
    }
  }

  const bullet = {
    id: nextBulletId++,
    ownerId: player.id,
    x: player.x + Math.cos(angle) * muzzle,
    y: player.y + Math.sin(angle) * muzzle,
    vx: Math.cos(angle) * bulletSpeed + baseVx * 0.25,
    vy: Math.sin(angle) * bulletSpeed + baseVy * 0.25,
    life: 0.9,
    color: player.color
  };

  bullets.set(bullet.id, bullet);
  player.fireCooldown = player.inCar ? 0.14 : 0.2;
}

function tryEnterNearestCar(player) {
  let nearest = null;
  let nearestDistance = Infinity;

  for (const car of cars) {
    if (car.driverId) {
      continue;
    }

    const distance = Math.hypot(car.x - player.x, car.y - player.y);
    if (distance < nearestDistance) {
      nearest = car;
      nearestDistance = distance;
    }
  }

  if (!nearest || nearestDistance > 105) {
    return;
  }

  nearest.driverId = player.id;
  nearest.speed *= 0.45;
  player.inCar = true;
  player.carId = nearest.id;
  player.x = nearest.x;
  player.y = nearest.y;
}

function exitCar(player) {
  const car = cars.find((item) => item.id === player.carId);
  if (!car) {
    player.inCar = false;
    player.carId = null;
    return;
  }

  car.driverId = null;
  player.inCar = false;
  player.carId = null;
  player.x = clamp(car.x - Math.sin(car.angle) * 54, PLAYER_RADIUS, WORLD.width - PLAYER_RADIUS);
  player.y = clamp(car.y + Math.cos(car.angle) * 54, PLAYER_RADIUS, WORLD.height - PLAYER_RADIUS);
}

function damagePlayer(target, attackerId, amount) {
  target.health = Math.max(0, target.health - amount);

  if (target.health > 0) {
    return;
  }

  target.deaths += 1;
  target.respawnTimer = 2.4;

  if (target.inCar) {
    exitCar(target);
  }

  const attacker = players.get(attackerId);
  if (attacker && attacker.id !== target.id) {
    attacker.score += 1;
  }
}

function respawnPlayer(player) {
  const spawn = getSpawnPoint();
  player.x = spawn.x;
  player.y = spawn.y;
  player.health = 100;
  player.respawnTimer = 0;
  player.inCar = false;
  player.carId = null;
}

function createCars() {
  const spots = [
    [540, 470, 0.15],
    [990, 910, 1.45],
    [1610, 620, 0.05],
    [2300, 880, 3.05],
    [2960, 420, 1.65],
    [3730, 830, 0.15],
    [4480, 610, 2.75],
    [710, 1840, 0.02],
    [1420, 2510, 3.12],
    [2290, 1920, 1.62],
    [3180, 2660, 0.05],
    [4300, 2210, 3.04],
    [4700, 3300, 1.45],
    [2440, 3360, 0.05]
  ];

  const colors = [
    "#ef4444",
    "#22c55e",
    "#3b82f6",
    "#f59e0b",
    "#14b8a6",
    "#e11d48",
    "#8b5cf6"
  ];

  return spots.map(([x, y, angle], index) => ({
    id: `car-${index + 1}`,
    x,
    y,
    angle,
    speed: 0,
    driverId: null,
    color: colors[index % colors.length]
  }));
}

function getSpawnPoint() {
  const spawns = [
    { x: 350, y: 320 },
    { x: 1020, y: 340 },
    { x: 1890, y: 420 },
    { x: 3200, y: 380 },
    { x: 4770, y: 480 },
    { x: 600, y: 1350 },
    { x: 1640, y: 1640 },
    { x: 2800, y: 1480 },
    { x: 4110, y: 1530 },
    { x: 560, y: 3060 },
    { x: 2050, y: 3120 },
    { x: 3540, y: 3290 },
    { x: 4760, y: 3150 }
  ];

  return spawns[Math.floor(Math.random() * spawns.length)];
}

function sanitizeMessage(message, id) {
  if (!message || typeof message !== "object") {
    return;
  }

  const player = players.get(id);
  if (!player) {
    return;
  }

  if (message.type === "join") {
    player.name = sanitizeName(message.name || player.name);
    player.color = sanitizeColor(message.color || player.color);
    return;
  }

  if (message.type !== "input") {
    return;
  }

  const input = message.input || {};
  player.input = {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    sprint: Boolean(input.sprint),
    brake: Boolean(input.brake),
    shooting: Boolean(input.shooting),
    interact: Boolean(input.interact),
    exit: Boolean(input.exit),
    angle: sanitizeAngle(input.angle)
  };
}

function sanitizeName(name) {
  return String(name)
    .replace(/[^\w .-]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH) || "Player";
}

function sanitizeColor(color) {
  const value = String(color);
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "#38bdf8";
}

function sanitizeAngle(angle) {
  const value = Number(angle);
  return Number.isFinite(value) ? value : 0;
}

function defaultInput() {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    sprint: false,
    brake: false,
    shooting: false,
    interact: false,
    exit: false,
    angle: 0
  };
}

function serializePlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    x: Math.round(player.x),
    y: Math.round(player.y),
    angle: Number(player.angle.toFixed(3)),
    health: Math.round(player.health),
    score: player.score,
    deaths: player.deaths,
    inCar: player.inCar,
    carId: player.carId,
    respawnTimer: Math.max(0, Number(player.respawnTimer.toFixed(2)))
  };
}

function serializeCar(car) {
  return {
    id: car.id,
    x: Math.round(car.x),
    y: Math.round(car.y),
    angle: Number(car.angle.toFixed(3)),
    speed: Math.round(car.speed),
    driverId: car.driverId,
    color: car.color
  };
}

function serializeBullet(bullet) {
  return {
    id: bullet.id,
    ownerId: bullet.ownerId,
    x: Math.round(bullet.x),
    y: Math.round(bullet.y),
    color: bullet.color
  };
}

function readSocketFrames(id, chunk) {
  const client = clients.get(id);
  if (!client || !client.alive) {
    return;
  }

  client.buffer = Buffer.concat([client.buffer, chunk]);

  while (client.buffer.length >= 2) {
    const first = client.buffer[0];
    const second = client.buffer[1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (client.buffer.length < offset + 2) {
        return;
      }
      payloadLength = client.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (client.buffer.length < offset + 8) {
        return;
      }
      const high = client.buffer.readUInt32BE(offset);
      const low = client.buffer.readUInt32BE(offset + 4);
      if (high !== 0 || low > 1024 * 1024) {
        removeClient(id);
        return;
      }
      payloadLength = low;
      offset += 8;
    }

    const maskBytes = masked ? 4 : 0;
    if (client.buffer.length < offset + maskBytes + payloadLength) {
      return;
    }

    let payload = client.buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLength);

    if (masked) {
      const mask = client.buffer.subarray(offset, offset + 4);
      const unmasked = Buffer.alloc(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      payload = unmasked;
    }

    client.buffer = client.buffer.subarray(offset + maskBytes + payloadLength);

    if (opcode === 0x8) {
      removeClient(id);
      return;
    }

    if (opcode === 0x9) {
      sendPong(client.socket, payload);
      continue;
    }

    if (opcode !== 0x1) {
      continue;
    }

    try {
      sanitizeMessage(JSON.parse(payload.toString("utf8")), id);
    } catch {
      removeClient(id);
      return;
    }
  }
}

function send(id, message) {
  const client = clients.get(id);
  if (!client || !client.alive) {
    return;
  }

  sendFrame(client.socket, Buffer.from(JSON.stringify(message), "utf8"), 0x1);
}

function broadcast(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  for (const client of clients.values()) {
    if (client.alive) {
      sendFrame(client.socket, payload, 0x1);
    }
  }
}

function sendPong(socket, payload) {
  sendFrame(socket, payload, 0xA);
}

function sendFrame(socket, payload, opcode) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  socket.write(Buffer.concat([header, payload]));
}

function removeClient(id) {
  const client = clients.get(id);
  if (!client) {
    return;
  }

  client.alive = false;
  try {
    client.socket.destroy();
  } catch {
    // Socket is already gone.
  }

  const player = players.get(id);
  if (player && player.inCar) {
    exitCar(player);
  }

  for (const car of cars) {
    if (car.driverId === id) {
      car.driverId = null;
    }
  }

  clients.delete(id);
  players.delete(id);
}

function createId() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return crypto.randomBytes(12).toString("hex");
}

function pickColor(index) {
  const colors = [
    "#38bdf8",
    "#f97316",
    "#22c55e",
    "#e879f9",
    "#facc15",
    "#fb7185",
    "#2dd4bf",
    "#a78bfa"
  ];

  return colors[index % colors.length];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
