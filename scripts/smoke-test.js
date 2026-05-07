const crypto = require("crypto");
const http = require("http");
const net = require("net");
const { server, start, stop } = require("../server");

let settled = false;
const timer = setTimeout(() => {
  finish(1, "Timed out waiting for the server to answer.");
}, 7000);

server.on("listening", () => {
  testHttp(server.address().port);
});

start(0);

function testHttp(port) {
  http.get(`http://127.0.0.1:${port}/`, (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      if (res.statusCode !== 200 || !body.includes("Neon Ridge Arena")) {
        finish(1, `Unexpected HTTP response: ${res.statusCode}`);
        return;
      }
      testWebSocket(port);
    });
  }).on("error", (error) => finish(1, error.message));
}

function testWebSocket(port) {
  const key = crypto.randomBytes(16).toString("base64");
  const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
    socket.write([
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      ""
    ].join("\r\n"));
  });

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const text = buffer.toString("latin1");
    if (!text.includes("\r\n\r\n")) {
      return;
    }

    if (!text.includes("101 Switching Protocols")) {
      finish(1, "WebSocket upgrade failed.");
      return;
    }

    socket.destroy();
    finish(0, "HTTP and WebSocket smoke tests passed.");
  });
  socket.on("error", (error) => finish(1, error.message));
}

function finish(code, message) {
  if (settled) {
    return;
  }

  settled = true;
  clearTimeout(timer);
  console.log(message);
  stop(() => {
    process.exit(code);
  });
}
