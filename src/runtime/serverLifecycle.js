import { logger } from "../logger.js";

let httpServerRef = null;
let socketServerRef = null;
let closingPromise = null;

export function registerRuntimeServers({ server, io } = {}) {
  if (server) {
    httpServerRef = server;
  }
  if (io) {
    socketServerRef = io;
  }
}

export function getRuntimeServers() {
  return {
    server: httpServerRef,
    io: socketServerRef,
  };
}

export function isServerClosing() {
  return Boolean(closingPromise);
}

export async function closeRegisteredServers(options = {}) {
  const { timeoutMs = 8000 } = options;
  if (!httpServerRef && !socketServerRef) {
    return false;
  }
  if (closingPromise) {
    return closingPromise;
  }
  const httpServer = httpServerRef;
  const ioServer = socketServerRef;
  const tasks = [];
  if (ioServer?.close) {
    tasks.push(closeSocketServer(ioServer));
  }
  if (httpServer?.close) {
    tasks.push(closeHttpServer(httpServer));
  }
  if (!tasks.length) {
    httpServerRef = null;
    socketServerRef = null;
    return false;
  }
  closingPromise = new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      httpServerRef = null;
      socketServerRef = null;
      closingPromise = null;
      resolve(true);
    };
    Promise.allSettled(tasks)
      .then(done)
      .catch((err) => {
        logger.warn({ err }, "[server] Failed while draining servers");
        done();
      });
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        logger.warn(
          { timeoutMs },
          "[server] Graceful shutdown timed out, forcing close"
        );
        done();
      }, timeoutMs);
      timer.unref?.();
    }
  });
  return closingPromise;
}

function closeHttpServer(server) {
  return new Promise((resolve) => {
    try {
      server.close((err) => {
        if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
          logger.warn({ err }, "[server] Error while closing HTTP server");
        }
        resolve(true);
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    } catch (err) {
      if (err?.code !== "ERR_SERVER_NOT_RUNNING") {
        logger.warn({ err }, "[server] Failed to stop HTTP server");
      }
      resolve(false);
    }
  });
}

function closeSocketServer(ioServer) {
  return new Promise((resolve) => {
    try {
      ioServer.close(() => resolve(true));
    } catch (err) {
      logger.warn({ err }, "[server] Error while closing Socket.IO server");
      resolve(false);
    }
  });
}
