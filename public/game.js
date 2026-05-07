const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
const minimap = document.getElementById("minimap");
const mapCtx = minimap.getContext("2d");

const joinPanel = document.getElementById("joinPanel");
const nameInput = document.getElementById("nameInput");
const colorSwatches = document.getElementById("colorSwatches");
const healthFill = document.getElementById("healthFill");
const scoreText = document.getElementById("scoreText");
const statusText = document.getElementById("statusText");
const vehicleText = document.getElementById("vehicleText");
const playersText = document.getElementById("playersText");

const COLORS = ["#38bdf8", "#f97316", "#22c55e", "#e879f9", "#facc15", "#fb7185", "#2dd4bf", "#a78bfa"];
const WORLD_FALLBACK = { width: 5200, height: 3800 };
const DPR_LIMIT = 2;

const keys = new Set();
const mouse = {
  x: 0,
  y: 0,
  down: false,
  worldX: 0,
  worldY: 0
};

let ws = null;
let connected = false;
let myId = null;
let selectedColor = COLORS[Math.floor(Math.random() * COLORS.length)];
let world = WORLD_FALLBACK;
let players = [];
let cars = [];
let bullets = [];
let lastSnapshotAt = performance.now();
let camera = { x: world.width / 2, y: world.height / 2 };
let interactPressed = false;
let exitPressed = false;
let joined = false;
let backgroundPattern = null;

const roads = [
  { x: 0, y: 730, w: 5200, h: 150 },
  { x: 0, y: 2020, w: 5200, h: 170 },
  { x: 0, y: 3190, w: 5200, h: 145 },
  { x: 800, y: 0, w: 150, h: 3800 },
  { x: 2260, y: 0, w: 165, h: 3800 },
  { x: 3940, y: 0, w: 155, h: 3800 }
];

const buildings = [
  { x: 210, y: 1030, w: 350, h: 250, color: "#536271" },
  { x: 1110, y: 1050, w: 480, h: 300, color: "#6d5d4c" },
  { x: 1730, y: 260, w: 420, h: 260, color: "#455666" },
  { x: 2660, y: 1090, w: 520, h: 330, color: "#5d6370" },
  { x: 3320, y: 510, w: 380, h: 280, color: "#70585c" },
  { x: 4270, y: 1090, w: 570, h: 390, color: "#4b6270" },
  { x: 330, y: 2310, w: 460, h: 330, color: "#6a634d" },
  { x: 1220, y: 2790, w: 550, h: 310, color: "#4f6573" },
  { x: 2660, y: 2400, w: 430, h: 380, color: "#64526c" },
  { x: 3420, y: 2870, w: 390, h: 300, color: "#58685a" },
  { x: 4290, y: 2570, w: 520, h: 350, color: "#69584b" }
];

const trees = createTrees();
const crates = createCrates();

initColorSwatches();
resizeCanvas();
connect();
requestAnimationFrame(render);
setInterval(sendInput, 1000 / 30);

window.addEventListener("resize", resizeCanvas);

window.addEventListener("keydown", (event) => {
  keys.add(event.code);

  if (event.code === "KeyF") {
    interactPressed = true;
  }

  if (event.code === "KeyE") {
    exitPressed = true;
  }

  if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    event.preventDefault();
  }
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

canvas.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  mouse.x = event.clientX - rect.left;
  mouse.y = event.clientY - rect.top;
});

canvas.addEventListener("mousedown", () => {
  mouse.down = true;
});

window.addEventListener("mouseup", () => {
  mouse.down = false;
});

joinPanel.addEventListener("submit", (event) => {
  event.preventDefault();
  joined = true;
  joinPanel.classList.add("is-hidden");
  sendJoin();
  canvas.focus();
});

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.addEventListener("open", () => {
    connected = true;
    statusText.textContent = "Online";
    if (joined) {
      sendJoin();
    }
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "welcome") {
      myId = message.id;
      world = message.world || WORLD_FALLBACK;
      camera = { x: world.width / 2, y: world.height / 2 };
      return;
    }

    if (message.type === "snapshot") {
      world = message.world || world;
      players = message.players || [];
      cars = message.cars || [];
      bullets = message.bullets || [];
      lastSnapshotAt = performance.now();
    }
  });

  ws.addEventListener("close", () => {
    connected = false;
    statusText.textContent = "Offline";
    setTimeout(connect, 1100);
  });

  ws.addEventListener("error", () => {
    connected = false;
    statusText.textContent = "Offline";
  });
}

function sendJoin() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify({
    type: "join",
    name: nameInput.value || "Racer",
    color: selectedColor
  }));
}

function sendInput() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !myId) {
    return;
  }

  const me = getMe();
  const center = getScreenCenter();
  const referenceX = me ? me.x : camera.x;
  const referenceY = me ? me.y : camera.y;
  mouse.worldX = camera.x - center.x + mouse.x;
  mouse.worldY = camera.y - center.y + mouse.y;
  const angle = Math.atan2(mouse.worldY - referenceY, mouse.worldX - referenceX);

  ws.send(JSON.stringify({
    type: "input",
    input: {
      up: keys.has("KeyW") || keys.has("ArrowUp"),
      down: keys.has("KeyS") || keys.has("ArrowDown"),
      left: keys.has("KeyA") || keys.has("ArrowLeft"),
      right: keys.has("KeyD") || keys.has("ArrowRight"),
      sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
      brake: keys.has("Space"),
      shooting: mouse.down,
      interact: interactPressed,
      exit: exitPressed,
      angle
    }
  }));

  interactPressed = false;
  exitPressed = false;
}

function render(now) {
  requestAnimationFrame(render);

  const me = getMe();
  const center = getScreenCenter();
  const target = getCameraTarget(me);
  const snapAge = Math.min((now - lastSnapshotAt) / 1000, 0.5);
  const smoothing = 1 - Math.pow(0.001, Math.min(snapAge + 0.016, 0.05));

  camera.x += (target.x - camera.x) * smoothing;
  camera.y += (target.y - camera.y) * smoothing;
  camera.x = clamp(camera.x, center.x, world.width - center.x);
  camera.y = clamp(camera.y, center.y, world.height - center.y);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(getDpr(), getDpr());
  ctx.translate(Math.round(center.x - camera.x), Math.round(center.y - camera.y));
  drawWorld();
  drawBullets();
  drawCars();
  drawPlayers();
  drawAimLine(me);
  ctx.restore();

  drawVignette();
  drawMinimap(me);
  updateHud(me);
}

function drawWorld() {
  if (!backgroundPattern) {
    backgroundPattern = createGroundPattern();
  }

  ctx.fillStyle = backgroundPattern;
  ctx.fillRect(0, 0, world.width, world.height);

  ctx.fillStyle = "rgba(255,255,255,0.035)";
  for (let x = 0; x <= world.width; x += 260) {
    ctx.fillRect(x, 0, 2, world.height);
  }
  for (let y = 0; y <= world.height; y += 260) {
    ctx.fillRect(0, y, world.width, 2);
  }

  for (const road of roads) {
    drawRoad(road);
  }

  drawWater();

  for (const crate of crates) {
    drawCrate(crate);
  }

  for (const tree of trees) {
    drawTree(tree);
  }

  for (const building of buildings) {
    drawBuilding(building);
  }

  ctx.strokeStyle = "rgba(255,255,255,0.38)";
  ctx.lineWidth = 18;
  ctx.strokeRect(0, 0, world.width, world.height);
}

function drawRoad(road) {
  ctx.fillStyle = "#25313a";
  ctx.fillRect(road.x, road.y, road.w, road.h);
  ctx.fillStyle = "rgba(255,255,255,0.09)";
  ctx.fillRect(road.x, road.y, road.w, 4);
  ctx.fillRect(road.x, road.y + road.h - 4, road.w, 4);

  ctx.strokeStyle = "rgba(244,211,94,0.8)";
  ctx.lineWidth = 5;
  ctx.setLineDash([38, 44]);
  ctx.beginPath();
  if (road.w > road.h) {
    ctx.moveTo(road.x, road.y + road.h / 2);
    ctx.lineTo(road.x + road.w, road.y + road.h / 2);
  } else {
    ctx.moveTo(road.x + road.w / 2, road.y);
    ctx.lineTo(road.x + road.w / 2, road.y + road.h);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawWater() {
  ctx.save();
  ctx.fillStyle = "#1f6070";
  ctx.beginPath();
  ctx.ellipse(4630, 365, 430, 190, -0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.restore();
}

function drawBuilding(building) {
  ctx.save();
  ctx.translate(building.x, building.y);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.fillRect(14, 18, building.w, building.h);
  ctx.fillStyle = building.color;
  ctx.fillRect(0, 0, building.w, building.h);
  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, building.w, building.h);

  ctx.fillStyle = "rgba(255,255,255,0.12)";
  for (let x = 24; x < building.w - 30; x += 62) {
    ctx.fillRect(x, 28, 30, 12);
    ctx.fillRect(x, building.h - 42, 30, 12);
  }

  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(24, 58, building.w - 48, 12);
  ctx.restore();
}

function drawTree(tree) {
  ctx.save();
  ctx.translate(tree.x, tree.y);
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(6, 8, tree.r * 0.9, tree.r * 0.7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2b7a52";
  ctx.beginPath();
  ctx.arc(0, 0, tree.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3da86b";
  ctx.beginPath();
  ctx.arc(-tree.r * 0.3, -tree.r * 0.25, tree.r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCrate(crate) {
  ctx.save();
  ctx.translate(crate.x, crate.y);
  ctx.rotate(crate.angle);
  ctx.fillStyle = "rgba(0,0,0,0.2)";
  ctx.fillRect(-crate.w / 2 + 8, -crate.h / 2 + 8, crate.w, crate.h);
  ctx.fillStyle = "#9b6a3d";
  ctx.fillRect(-crate.w / 2, -crate.h / 2, crate.w, crate.h);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3;
  ctx.strokeRect(-crate.w / 2, -crate.h / 2, crate.w, crate.h);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.moveTo(-crate.w / 2, -crate.h / 2);
  ctx.lineTo(crate.w / 2, crate.h / 2);
  ctx.moveTo(crate.w / 2, -crate.h / 2);
  ctx.lineTo(-crate.w / 2, crate.h / 2);
  ctx.stroke();
  ctx.restore();
}

function drawCars() {
  for (const car of cars) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    ctx.fillStyle = "rgba(0,0,0,0.26)";
    roundRect(ctx, -43, -22, 92, 50, 8);
    ctx.fill();

    ctx.fillStyle = "#111820";
    roundRect(ctx, -38, -27, 76, 54, 7);
    ctx.fill();

    ctx.fillStyle = car.color || "#3b82f6";
    roundRect(ctx, -34, -22, 68, 44, 7);
    ctx.fill();

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    roundRect(ctx, -8, -17, 20, 34, 5);
    ctx.fill();

    ctx.fillStyle = "#071016";
    ctx.fillRect(-30, -31, 18, 8);
    ctx.fillRect(12, -31, 18, 8);
    ctx.fillRect(-30, 23, 18, 8);
    ctx.fillRect(12, 23, 18, 8);

    ctx.fillStyle = "#ffe08a";
    ctx.fillRect(31, -15, 6, 9);
    ctx.fillRect(31, 6, 6, 9);

    if (car.driverId) {
      ctx.strokeStyle = "rgba(255,255,255,0.72)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 35, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function drawPlayers() {
  const sorted = [...players].sort((a, b) => Number(a.inCar) - Number(b.inCar));

  for (const player of sorted) {
    if (player.health <= 0) {
      drawRespawnMarker(player);
      continue;
    }

    if (player.inCar) {
      drawCarRider(player);
      continue;
    }

    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.strokeStyle = "#101820";
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(32, 0);
    ctx.stroke();
    ctx.strokeStyle = player.color;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(34, 0);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.fillStyle = "rgba(0,0,0,0.24)";
    ctx.beginPath();
    ctx.ellipse(4, 7, 20, 15, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = player.id === myId ? "#ffffff" : "rgba(255,255,255,0.65)";
    ctx.lineWidth = player.id === myId ? 4 : 2;
    ctx.stroke();
    ctx.restore();

    drawNameplate(player, player.x, player.y - 34);
  }
}

function drawCarRider(player) {
  const car = cars.find((item) => item.id === player.carId);
  if (!car) {
    return;
  }

  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(player.angle);
  ctx.strokeStyle = "#0b1218";
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(42, 0);
  ctx.stroke();
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(44, 0);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.arc(car.x, car.y, 9, 0, Math.PI * 2);
  ctx.fill();

  drawNameplate(player, car.x, car.y - 48);
}

function drawRespawnMarker(player) {
  drawNameplate(player, player.x, player.y - 28, `Respawn ${player.respawnTimer.toFixed(1)}`);
}

function drawNameplate(player, x, y, override) {
  const text = override || player.name;
  ctx.save();
  ctx.font = "700 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const width = Math.max(56, ctx.measureText(text).width + 16);
  ctx.fillStyle = "rgba(6, 10, 14, 0.72)";
  roundRect(ctx, x - width / 2, y - 12, width, 24, 6);
  ctx.fill();
  ctx.fillStyle = "#f8fbff";
  ctx.fillText(text, x, y);

  if (!override) {
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    roundRect(ctx, x - 28, y + 17, 56, 6, 3);
    ctx.fill();
    ctx.fillStyle = player.health > 48 ? "#55e08e" : "#ff4f64";
    roundRect(ctx, x - 28, y + 17, 56 * clamp(player.health / 100, 0, 1), 6, 3);
    ctx.fill();
  }

  ctx.restore();
}

function drawBullets() {
  for (const bullet of bullets) {
    ctx.save();
    ctx.fillStyle = bullet.color || "#ffffff";
    ctx.shadowColor = bullet.color || "#ffffff";
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(bullet.x, bullet.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawAimLine(me) {
  if (!me || me.health <= 0) {
    return;
  }

  const originX = me.x;
  const originY = me.y;
  const angle = Math.atan2(mouse.worldY - originY, mouse.worldX - originX);
  const endX = originX + Math.cos(angle) * 80;
  const endY = originY + Math.sin(angle) * 80;

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(mouse.worldX, mouse.worldY, 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawVignette() {
  const dpr = getDpr();
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const gradient = ctx.createRadialGradient(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2,
    canvas.clientWidth * 0.15,
    canvas.clientWidth / 2,
    canvas.clientHeight / 2,
    canvas.clientWidth * 0.75
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.28)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  ctx.restore();
}

function drawMinimap(me) {
  const dpr = getDpr();
  const width = minimap.clientWidth;
  const height = minimap.clientHeight;

  if (minimap.width !== Math.floor(width * dpr) || minimap.height !== Math.floor(height * dpr)) {
    minimap.width = Math.floor(width * dpr);
    minimap.height = Math.floor(height * dpr);
  }

  mapCtx.save();
  mapCtx.scale(dpr, dpr);
  mapCtx.clearRect(0, 0, width, height);
  mapCtx.fillStyle = "rgba(11,17,23,0.92)";
  mapCtx.fillRect(0, 0, width, height);

  const scale = Math.min(width / world.width, height / world.height);
  const ox = (width - world.width * scale) / 2;
  const oy = (height - world.height * scale) / 2;

  mapCtx.fillStyle = "#2f513d";
  mapCtx.fillRect(ox, oy, world.width * scale, world.height * scale);

  mapCtx.fillStyle = "#27323b";
  for (const road of roads) {
    mapCtx.fillRect(ox + road.x * scale, oy + road.y * scale, road.w * scale, road.h * scale);
  }

  mapCtx.fillStyle = "rgba(255,255,255,0.24)";
  for (const building of buildings) {
    mapCtx.fillRect(ox + building.x * scale, oy + building.y * scale, building.w * scale, building.h * scale);
  }

  for (const car of cars) {
    mapCtx.fillStyle = car.driverId ? "#ffffff" : car.color;
    mapCtx.fillRect(ox + car.x * scale - 2, oy + car.y * scale - 2, 4, 4);
  }

  for (const player of players) {
    mapCtx.fillStyle = player.id === myId ? "#ffffff" : player.color;
    mapCtx.beginPath();
    mapCtx.arc(ox + player.x * scale, oy + player.y * scale, player.id === myId ? 4 : 3, 0, Math.PI * 2);
    mapCtx.fill();
  }

  if (me) {
    mapCtx.strokeStyle = "rgba(255,255,255,0.6)";
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(
      ox + (camera.x - canvas.clientWidth / 2) * scale,
      oy + (camera.y - canvas.clientHeight / 2) * scale,
      canvas.clientWidth * scale,
      canvas.clientHeight * scale
    );
  }

  mapCtx.restore();
}

function updateHud(me) {
  const health = me ? clamp(me.health, 0, 100) : 0;
  healthFill.style.width = `${health}%`;
  scoreText.textContent = me ? `${me.score} / ${me.deaths}` : "0 / 0";
  playersText.textContent = `${players.length} online`;
  vehicleText.textContent = me && me.inCar ? "In vehicle" : "On foot";

  if (!connected) {
    statusText.textContent = "Offline";
  } else if (!joined) {
    statusText.textContent = "Ready";
  } else {
    statusText.textContent = "Online";
  }
}

function getCameraTarget(me) {
  if (!me) {
    return camera;
  }

  const lookAhead = 70;
  return {
    x: me.x + Math.cos(me.angle) * lookAhead,
    y: me.y + Math.sin(me.angle) * lookAhead
  };
}

function getMe() {
  return players.find((player) => player.id === myId);
}

function getScreenCenter() {
  return {
    x: canvas.clientWidth / 2,
    y: canvas.clientHeight / 2
  };
}

function resizeCanvas() {
  const dpr = getDpr();
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

function getDpr() {
  return Math.min(window.devicePixelRatio || 1, DPR_LIMIT);
}

function createGroundPattern() {
  const patternCanvas = document.createElement("canvas");
  const patternCtx = patternCanvas.getContext("2d");
  patternCanvas.width = 180;
  patternCanvas.height = 180;
  patternCtx.fillStyle = "#244735";
  patternCtx.fillRect(0, 0, 180, 180);
  patternCtx.fillStyle = "rgba(255,255,255,0.035)";

  for (let i = 0; i < 70; i += 1) {
    const x = (i * 47) % 180;
    const y = (i * 83) % 180;
    patternCtx.fillRect(x, y, 2 + (i % 4), 2 + (i % 3));
  }

  patternCtx.strokeStyle = "rgba(0,0,0,0.05)";
  patternCtx.lineWidth = 1;
  for (let x = 0; x <= 180; x += 45) {
    patternCtx.beginPath();
    patternCtx.moveTo(x, 0);
    patternCtx.lineTo(x, 180);
    patternCtx.stroke();
  }
  for (let y = 0; y <= 180; y += 45) {
    patternCtx.beginPath();
    patternCtx.moveTo(0, y);
    patternCtx.lineTo(180, y);
    patternCtx.stroke();
  }

  return ctx.createPattern(patternCanvas, "repeat");
}

function createTrees() {
  const points = [];
  for (let i = 0; i < 95; i += 1) {
    const x = 120 + ((i * 571) % 4960);
    const y = 120 + ((i * 347) % 3560);
    const onRoad = roads.some((road) => x > road.x - 80 && x < road.x + road.w + 80 && y > road.y - 80 && y < road.y + road.h + 80);
    const inBuilding = buildings.some((building) => x > building.x - 80 && x < building.x + building.w + 80 && y > building.y - 80 && y < building.y + building.h + 80);
    if (!onRoad && !inBuilding) {
      points.push({ x, y, r: 18 + (i % 4) * 5 });
    }
  }
  return points;
}

function createCrates() {
  return [
    { x: 650, y: 620, w: 68, h: 46, angle: 0.15 },
    { x: 1340, y: 1510, w: 92, h: 42, angle: -0.2 },
    { x: 2030, y: 2260, w: 64, h: 64, angle: 0.35 },
    { x: 3000, y: 720, w: 84, h: 52, angle: 0.7 },
    { x: 3840, y: 1800, w: 78, h: 48, angle: -0.4 },
    { x: 4540, y: 3410, w: 96, h: 48, angle: 0.18 },
    { x: 1860, y: 3420, w: 110, h: 42, angle: -0.16 },
    { x: 4820, y: 1700, w: 74, h: 74, angle: 0.52 }
  ];
}

function initColorSwatches() {
  colorSwatches.innerHTML = "";
  for (const color of COLORS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.style.setProperty("--swatch", color);
    button.setAttribute("aria-label", color);
    if (color === selectedColor) {
      button.classList.add("is-selected");
    }
    button.addEventListener("click", () => {
      selectedColor = color;
      for (const item of colorSwatches.querySelectorAll(".swatch")) {
        item.classList.remove("is-selected");
      }
      button.classList.add("is-selected");
    });
    colorSwatches.appendChild(button);
  }
}

function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
